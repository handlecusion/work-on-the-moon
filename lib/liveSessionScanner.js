'use strict';

/**
 * liveSessionScanner — detects all currently-running `claude` CLI processes
 * on the local macOS box, maps each to its on-disk transcript at
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, and produces a
 * compact summary array for the /api/sessions endpoint.
 *
 * This module is read-only with respect to the file system: it never writes
 * to the transcripts. All process probing is done via `pgrep`, `lsof`, and
 * `ps` (no `kill`, no signals).
 *
 * Scan results are memoized for SCAN_TTL_MS to keep the API fast under
 * polling. Call `invalidateCache()` to force the next call to re-scan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createClient: createCmuxClient, CmuxError } = require('./cmuxClient');
const tmuxClient = require('./tmuxClient');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SCAN_TTL_MS = 5 * 1000;
const TAIL_BYTES = 64 * 1024;        // bigger than spec's 16KB so role is found
const HEAD_BYTES = 4 * 1024;         // first ~4KB is enough for cwd/gitBranch
const FALLBACK_LOOKBACK_MS = 60 * 1000;
const IDLE_THRESHOLD_S = 30;
const TEXT_TRUNCATE = 80;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSION_ID_RE = /(?:--session-id|--continue|--resume)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SELF_PID = process.pid;

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let _cache = { ts: 0, data: null };
let _inflight = null;

function invalidateCache() {
  _cache = { ts: 0, data: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeCwd(cwd) {
  // claude CLI uses the literal `/` → `-` substitution. Leading `/` becomes
  // leading `-` (e.g. /Users/alice → -Users-alice). Do not change this scheme.
  return String(cwd || '').replace(/\//g, '-');
}

function execP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      // We treat non-zero exit as soft failure; pgrep returns 1 when there
      // are no matches, lsof returns 1 if the process is gone, etc.
      resolve({
        err: err || null,
        stdout: stdout != null ? String(stdout) : '',
        stderr: stderr != null ? String(stderr) : ''
      });
    });
  });
}

/**
 * Read the first `maxBytes` of a file as UTF-8. Returns '' on failure.
 */
function safeReadHead(filePath, maxBytes) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(maxBytes, st.size);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/**
 * Read up to the last `maxBytes` of a file as UTF-8. The first line of the
 * returned string MAY be a partial JSONL record when the file is larger than
 * `maxBytes`; callers should drop it.
 */
function safeReadTail(filePath, maxBytes) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    const size = st.size;
    const len = Math.min(maxBytes, size);
    if (len <= 0) return { text: '', truncated: false, mtime: st.mtime };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return {
      text: buf.toString('utf8'),
      truncated: size > len,
      mtime: st.mtime
    };
  } catch (_) {
    return { text: '', truncated: false, mtime: null };
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/**
 * Convert a Claude jsonl message.content into a plain text string.
 * Handles both `content: string` and `content: Array<{type, text?}>`.
 */
function parseJsonlMessageText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = [];
    for (const block of c) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        // Skip thinking — surface only user-visible text.
      }
    }
    return parts.join('\n');
  }
  return '';
}

function truncate(str, n) {
  if (str == null) return null;
  const s = String(str).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

// ---------------------------------------------------------------------------
// Process enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate candidate claude CLI PIDs.
 *
 * Returns an array of { pid, command }. Filters out:
 *   - Claude.app GUI helpers (the desktop app)
 *   - claude-monitor (separate Python utility)
 *   - claude-hook subshells (transient hook invocations)
 *   - the current node server's own pid
 */
async function enumeratePids() {
  // NOTE: macOS BSD pgrep ERE doesn't support `\s` — use POSIX char class.
  const r = await execP('pgrep', ['-fla', 'local/bin/claude|^claude$|^claude[[:space:]]']);
  if (!r.stdout) return [];
  const out = [];
  const lines = r.stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (!Number.isFinite(pid)) continue;
    if (pid === SELF_PID) continue;
    if (/Claude\.app/.test(cmd)) continue;
    // Inspect only argv[0] (the executable). The cmux-launched processes have
    // `claude-hook` embedded inside their --settings JSON blob, so we can't
    // filter on substring presence anywhere in `cmd` — we'd drop every cmux
    // session. Instead, look at the leading token only.
    const argv0 = cmd.split(/\s+/, 1)[0] || '';
    const argv0Base = argv0.replace(/^.*\//, '');
    // Drop sibling tools that share the prefix.
    if (argv0Base === 'claude-monitor' || argv0Base === 'claude-hook') continue;
    // Drop wrapper interpreters (python, zsh, etc.) — only keep things whose
    // executable itself is named exactly `claude`.
    if (argv0Base !== 'claude') continue;
    out.push({ pid, command: cmd });
  }
  return out;
}

async function probeCwd(pid) {
  const r = await execP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!r.stdout) return null;
  const lines = r.stdout.split('\n');
  for (const line of lines) {
    if (line.startsWith('n')) return line.slice(1) || null;
  }
  return null;
}

async function probeTty(pid) {
  const r = await execP('ps', ['-p', String(pid), '-o', 'tty='], {
    env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' })
  });
  if (!r.stdout) return null;
  const raw = r.stdout.trim().split('\n')[0];
  if (!raw || raw === '?' || raw === '??') return null;
  // ps outputs e.g. "ttys013" — prepend /dev/ if not already absolute
  if (raw.startsWith('/')) return raw;
  return '/dev/' + raw;
}

async function probeStartedAt(pid) {
  const r = await execP('ps', ['-p', String(pid), '-o', 'lstart='], {
    env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' })
  });
  if (!r.stdout) return null;
  const raw = r.stdout.trim().split('\n')[0];
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function summarizeArgs(cmd) {
  if (!cmd) return '';
  // Strip the giant inline JSON --settings blob to keep the summary readable.
  let s = cmd.replace(/--settings\s+\{[\s\S]*?\}\s*/g, '--settings <…> ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 160) s = s.slice(0, 157) + '…';
  return s;
}

function detectSource(cmd) {
  if (!cmd) return 'terminal';
  if (/CMUX_CLAUDE_HOOK_CMUX_BIN/.test(cmd)) return 'cmux';
  return 'terminal';
}

function extractSessionId(cmd) {
  if (!cmd) return null;
  const m = SESSION_ID_RE.exec(cmd);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// jsonl scanning
// ---------------------------------------------------------------------------

function findFallbackSessionId(cwd) {
  if (!cwd) return null;
  const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const cutoff = Date.now() - FALLBACK_LOOKBACK_MS;
  let best = null;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.jsonl')) continue;
    const id = e.name.slice(0, -'.jsonl'.length);
    if (!UUID_RE.test(id)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, e.name)); } catch (_) { continue; }
    const m = st.mtime.getTime();
    if (m < cutoff) continue;
    if (!best || m > best.mtime) best = { id, mtime: m };
  }
  return best ? best.id : null;
}

function jsonlPathFor(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));
  return path.join(dir, sessionId + '.jsonl');
}

/**
 * Pull cwd / gitBranch from the head of a transcript. The very first 1–2
 * lines are usually metadata-only (no top-level cwd field), so we walk
 * forward until we find an entry that has them.
 */
function readHeadMetadata(filePath) {
  const text = safeReadHead(filePath, HEAD_BYTES);
  if (!text) return { cwd: null, gitBranch: null };
  const lines = text.split('\n');
  // Drop the last (potentially partial) line — only matters if file < HEAD_BYTES,
  // in which case the trailing line is empty anyway.
  const usable = lines.slice(0, -1);
  for (const line of usable) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && typeof o === 'object') {
      const cwd = typeof o.cwd === 'string' ? o.cwd : null;
      const gitBranch = typeof o.gitBranch === 'string' ? o.gitBranch : null;
      if (cwd || gitBranch) return { cwd, gitBranch };
    }
  }
  return { cwd: null, gitBranch: null };
}

/**
 * Scan the tail for last user/assistant message text + last role + last ts.
 */
function readTailSummary(filePath) {
  const tail = safeReadTail(filePath, TAIL_BYTES);
  const out = {
    lastEntryRole: null,
    lastUserText: null,
    lastAssistantText: null,
    lastActivityTs: null,
    mtime: tail.mtime ? tail.mtime.toISOString() : null,
    mtimeMs: tail.mtime ? tail.mtime.getTime() : null
  };
  if (!tail.text) return out;
  let lines = tail.text.split('\n');
  // Drop a leading partial line if we didn't start at file offset 0.
  if (tail.truncated && lines.length > 0) lines = lines.slice(1);
  // Walk from the end backwards and stop once we have all the things we need.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    if (!out.lastActivityTs && typeof o.timestamp === 'string') {
      out.lastActivityTs = o.timestamp;
    }
    const role = o.message && o.message.role;
    if (role === 'user' || role === 'assistant') {
      if (!out.lastEntryRole) out.lastEntryRole = role;
      const text = parseJsonlMessageText(o.message);
      if (role === 'user' && !out.lastUserText) {
        out.lastUserText = truncate(text, TEXT_TRUNCATE);
      } else if (role === 'assistant' && !out.lastAssistantText) {
        out.lastAssistantText = truncate(text, TEXT_TRUNCATE);
      }
    }
    if (out.lastEntryRole && out.lastUserText && out.lastAssistantText && out.lastActivityTs) {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-PID enrichment
// ---------------------------------------------------------------------------

async function enrich(proc) {
  try {
    const [cwdResolved, startedAt, tty] = await Promise.all([
      probeCwd(proc.pid),
      probeStartedAt(proc.pid),
      probeTty(proc.pid)
    ]);
    // If the process vanished between pgrep and lsof, drop it.
    if (!cwdResolved) return null;

    let sessionId = extractSessionId(proc.command);
    if (!sessionId) sessionId = findFallbackSessionId(cwdResolved);

    const source = detectSource(proc.command);
    const argsSummary = summarizeArgs(proc.command);

    let jsonlPath = null;
    let head = { cwd: null, gitBranch: null };
    let tail = {
      lastEntryRole: null,
      lastUserText: null,
      lastAssistantText: null,
      lastActivityTs: null,
      mtime: null,
      mtimeMs: null
    };
    if (sessionId) {
      const candidate = jsonlPathFor(cwdResolved, sessionId);
      if (candidate && fs.existsSync(candidate)) {
        jsonlPath = candidate;
        head = readHeadMetadata(jsonlPath);
        tail = readTailSummary(jsonlPath);
      }
    }

    const cwd = head.cwd || cwdResolved;
    const gitBranch = head.gitBranch || null;

    let idleSeconds;
    if (tail.mtimeMs != null) {
      const diff = Date.now() - tail.mtimeMs;
      idleSeconds = diff < 0 ? 0 : Math.floor(diff / 1000);
    } else {
      idleSeconds = 0;
    }

    let busy;
    if (!sessionId || !jsonlPath) {
      busy = true; // initialization phase
    } else if (tail.lastEntryRole == null) {
      busy = true; // no message exchanged yet — turn just started
    } else {
      const isAssistantTurnEnd = tail.lastEntryRole === 'assistant';
      const stale = idleSeconds > IDLE_THRESHOLD_S;
      busy = !(isAssistantTurnEnd && stale);
    }

    const lastActivityTs = tail.lastActivityTs || tail.mtime;

    return {
      pid: proc.pid,
      sessionId,
      cwd,
      gitBranch,
      jsonlPath,
      lastActivityTs,
      lastEntryRole: tail.lastEntryRole,
      lastUserText: tail.lastUserText,
      lastAssistantText: tail.lastAssistantText,
      busy,
      idleSeconds,
      source,
      startedAt,
      argsSummary,
      tty: tty || null
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// cmux mapping helpers
// ---------------------------------------------------------------------------

const CMUX_BUDGET_MS = 1500;
const TMUX_BUDGET_MS = 500;

/**
 * Probe cmux within a 1.5s budget using a fresh short-lived client.
 * Returns { client, lookupCwd, surfaceCache }
 * or null if cmux is unreachable or exceeds the budget.
 *
 * A fresh client is created per scan invocation so stale persistent
 * connections from the singleton never interfere with the scanner.
 * Caller is responsible for calling client.close() when done.
 *
 * cwdToWorkspace maps a cwd to the best workspace id:
 *   - single match  → use it
 *   - multiple      → pick selected:true; if none, pick first
 */
async function probeCmux() {
  const client = createCmuxClient();
  // Suppress unhandled 'error' events — socket errors after connection are
  // handled via rejected promises and should not crash the process.
  client.events.on('error', () => {});

  const work = (async () => {
    await client.connect();

    // ping — throws if unreachable
    const ok = await client.ping().catch(() => false);
    if (!ok) throw new Error('ping returned false');

    const workspaces = await client.listWorkspaces();

    // Build cwd → best-workspace-id map.
    // Group by cwd first.
    const byDir = new Map(); // cwd -> [{id, selected, idx}]
    for (let i = 0; i < workspaces.length; i++) {
      const ws = workspaces[i];
      const dir = ws.current_directory || ws.currentDirectory || null;
      if (!dir) continue;
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ id: ws.id, selected: !!ws.selected, idx: i });
    }

    // Build two maps: exact-cwd and lowercased-cwd for case-insensitive fallback.
    // macOS HFS+ is case-insensitive; lsof may return /Users/Alice/Code while cmux
    // stores /Users/alice/code — normalise both keys to lowercase so they match.
    const cwdToWorkspace = new Map();         // exact cwd → workspaceId
    const cwdToWorkspaceLower = new Map();    // lowercased cwd → workspaceId
    for (const [dir, list] of byDir) {
      const id = list.length === 1 ? list[0].id : (list.find(w => w.selected) || list[0]).id;
      cwdToWorkspace.set(dir, id);
      cwdToWorkspaceLower.set(dir.toLowerCase(), id);
    }

    // Wrap lookup: try exact first, then lowercase fallback.
    const lookupCwd = (cwd) => {
      if (!cwd) return null;
      return cwdToWorkspace.get(cwd) || cwdToWorkspaceLower.get(cwd.toLowerCase()) || null;
    };

    console.log('[scanner] cmux available (' + workspaces.length + ' workspaces)');
    return { client, lookupCwd, surfaceCache: new Map() };
  })();

  // Race against the budget
  const budget = new Promise((_, rej) =>
    setTimeout(() => {
      const err = new Error('cmux probe timeout');
      err.code = 'timeout';
      rej(err);
    }, CMUX_BUDGET_MS)
  );

  try {
    return await Promise.race([work, budget]);
  } catch (err) {
    // Best-effort close the fresh client on failure.
    client.close().catch(() => {});
    // Distinguish not_running vs timeout vs other CmuxError codes.
    const code = err.code || 'error';
    if (code === 'timeout') {
      console.log('[scanner] cmux probe timeout');
    } else if (code === 'not_running' || code === 'connect_error') {
      console.log('[scanner] cmux unavailable: not_running');
    } else {
      console.log('[scanner] cmux unavailable: ' + code + ' — ' + (err.message || err));
    }
    return null;
  }
}

/**
 * Probe tmux within a 500ms budget.
 * Returns { ttyToPane: Map<string, { socketPath, paneId }> }
 * or null if no sockets, timeout, or exception.
 */
async function probeTmux() {
  const work = (async () => {
    const sockets = tmuxClient.resolveSocketPaths();
    if (sockets.length === 0) return null;

    // ttyToPane: paneTty → { socketPath, paneId }. First match wins.
    const ttyToPane = new Map();
    let totalPanes = 0;

    for (const socketPath of sockets) {
      const panes = await tmuxClient.listPanes(socketPath);
      for (const p of panes) {
        totalPanes++;
        if (p.paneTty && !ttyToPane.has(p.paneTty)) {
          ttyToPane.set(p.paneTty, { socketPath, paneId: p.paneId });
        }
      }
    }

    if (ttyToPane.size === 0) return null;
    console.log('[scanner] tmux available (' + totalPanes + ' panes across ' + sockets.length + ' socket(s))');
    return { ttyToPane };
  })();

  const budget = new Promise((resolve) =>
    setTimeout(() => resolve(null), TMUX_BUDGET_MS)
  );

  try {
    return await Promise.race([work, budget]);
  } catch (_) {
    return null;
  }
}

/**
 * Lazily look up the surface id for a given workspace_id.
 * Memoizes results in surfaceCache. Uses the provided client instance.
 * Returns null on error.
 */
async function resolveSurface(workspaceId, surfaceCache, client) {
  if (surfaceCache.has(workspaceId)) return surfaceCache.get(workspaceId);

  let surfaceId = null;
  try {
    const surfaces = await client.listSurfaces(workspaceId);
    // Pick focused terminal surface, else first terminal, else null
    const terminals = surfaces.filter(s => s.type === 'terminal');
    const focused = terminals.find(s => s.focused);
    const picked = focused || terminals[0] || null;
    surfaceId = picked ? picked.id : null;
  } catch (_) {
    surfaceId = null;
  }

  surfaceCache.set(workspaceId, surfaceId);
  return surfaceId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function scanLive() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < SCAN_TTL_MS) {
    return _cache.data;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const procs = await enumeratePids();

      // Run per-PID enrichment, cmux probe, and tmux probe in parallel to keep
      // total latency low. Each probe has its own budget.
      const [enriched, cmuxProbe, tmuxProbe] = await Promise.all([
        Promise.all(procs.map(enrich)),
        probeCmux(),
        probeTmux()
      ]);
      const result = enriched.filter(Boolean);

      // Decorate each entry with cmux fields; close the probe client when done.
      try {
        for (const entry of result) {
          if (!cmuxProbe) {
            entry.cmuxWorkspaceId = null;
            entry.cmuxSurfaceId = null;
            entry.cmuxAvailable = false;
          } else {
            const { client, lookupCwd, surfaceCache } = cmuxProbe;
            const wsId = lookupCwd(entry.cwd);
            let sfId = null;
            if (wsId) {
              sfId = await resolveSurface(wsId, surfaceCache, client);
            }
            entry.cmuxWorkspaceId = wsId || null;
            entry.cmuxSurfaceId = sfId || null;
            entry.cmuxAvailable = !!(wsId && sfId);
          }
        }
      } finally {
        // Always close the fresh probe client to free the socket.
        if (cmuxProbe && cmuxProbe.client) {
          cmuxProbe.client.close().catch(() => {});
        }
      }

      // Decorate each entry with tmux fields.
      for (const entry of result) {
        if (tmuxProbe) {
          const match = entry.tty ? tmuxProbe.ttyToPane.get(entry.tty) : null;
          entry.tmuxAvailable = !!match;
          entry.tmuxSocketPath = match ? match.socketPath : null;
          entry.tmuxPaneId = match ? match.paneId : null;
        } else {
          entry.tmuxAvailable = false;
          entry.tmuxSocketPath = null;
          entry.tmuxPaneId = null;
        }
      }

      // Refine source using routing priority: cmux > tmux > terminal.
      for (const entry of result) {
        if (entry.source === 'cmux') {
          // already correct — cmux wins
        } else if (entry.tmuxAvailable) {
          entry.source = 'tmux';
        } else {
          entry.source = 'terminal';
        }
      }

      // Newest activity first; null lastActivityTs sinks to the bottom.
      result.sort((a, b) => {
        const ta = a.lastActivityTs ? Date.parse(a.lastActivityTs) : -Infinity;
        const tb = b.lastActivityTs ? Date.parse(b.lastActivityTs) : -Infinity;
        if (tb !== ta) return tb - ta;
        return a.pid - b.pid;
      });
      _cache = { ts: Date.now(), data: result };
      return result;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

module.exports = {
  scanLive,
  invalidateCache,
  // Exposed for tests
  _internal: {
    encodeCwd,
    parseJsonlMessageText,
    safeReadTail,
    summarizeArgs,
    detectSource,
    extractSessionId
  }
};
