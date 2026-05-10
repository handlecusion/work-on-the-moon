'use strict';

/**
 * codexSessionScanner — detects all currently-running `codex` CLI processes
 * on the local macOS box, maps each to its on-disk transcript at
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ISOts>-<UUIDv7>.jsonl, and produces
 * a compact summary array shaped like liveSessionScanner's output.
 *
 * Codex session layout differs from claude in two key ways:
 *   1. The session ID lives inside the jsonl head line's payload.id, not in
 *      the process argv. There is no --session-id flag to parse.
 *   2. The jsonl path encodes a date+UUID, not a cwd-derived directory. We
 *      must build an in-memory index keyed by payload.cwd to bind a running
 *      PID to its transcript.
 *
 * Process tree: /opt/homebrew/bin/codex (node wrapper) spawns a native rust
 * binary at …/node_modules/@openai/codex-darwin-arm64/…/codex. The node
 * wrapper is the "visible" PID; the rust child is the foreground TTY process.
 *
 * This module is read-only with respect to the file system: it never writes
 * to the transcripts. All process probing is done via `pgrep`, `lsof`, and
 * `ps` (no `kill`, no signals).
 *
 * Scan results are memoized for SCAN_TTL_MS to keep the API fast under
 * polling. Call `invalidateCache()` to force the next call to re-scan.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SCAN_TTL_MS      = 5 * 1000;
const TAIL_BYTES       = 64 * 1024;   // last 64KB — enough to find last role
const HEAD_BYTES       = 16 * 1024;   // first 16KB — codex session_meta includes full base_instructions blob
const TEXT_TRUNCATE    = 80;
const IDLE_THRESHOLD_S = 30;
// Walk only the last 90 days of session directories to bound the index cost.
const INDEX_LOOKBACK_DAYS = 90;
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELF_PID = process.pid;

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let _cache    = { ts: 0, data: null };
let _inflight = null;
// Separate short-lived cache for the jsonl index (cwd → [{jsonlPath, birthMs, cwd}])
let _indexCache    = { ts: 0, data: null };
const INDEX_TTL_MS = SCAN_TTL_MS;

function invalidateCache() {
  _cache      = { ts: 0, data: null };
  _indexCache = { ts: 0, data: null };
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from liveSessionScanner for consistency)
// ---------------------------------------------------------------------------

function execP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      resolve({
        err:    err    || null,
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
    const st  = fs.fstatSync(fd);
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
    const st   = fs.fstatSync(fd);
    const size = st.size;
    const len  = Math.min(maxBytes, size);
    if (len <= 0) return { text: '', truncated: false, mtime: st.mtime };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return {
      text:      buf.toString('utf8'),
      truncated: size > len,
      mtime:     st.mtime
    };
  } catch (_) {
    return { text: '', truncated: false, mtime: null };
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function truncate(str, n) {
  if (str == null) return null;
  const s = String(str).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

function summarizeArgs(cmd) {
  if (!cmd) return '';
  let s = cmd.replace(/\s+/g, ' ').trim();
  if (s.length > 160) s = s.slice(0, 157) + '…';
  return s;
}

// ---------------------------------------------------------------------------
// Process enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate candidate codex CLI PIDs.
 *
 * Returns an array of { pid, command, isNative } where `isNative` marks the
 * rust child process. Filters out:
 *   - codex-mcp-server
 *   - @upstash/ and context7 helpers
 *   - codex.system/bootstrap entries
 *   - any process whose path contains /Claude/ or /.claude/
 *   - this server's own PID
 */
async function enumeratePids() {
  const r = await execP('pgrep', ['-fla', 'codex']);
  if (!r.stdout) return [];

  const out   = [];
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

    // Drop known noise — must match BEFORE the isNative check.
    if (/codex-mcp-server/.test(cmd))       continue;
    if (/@upstash\//.test(cmd))             continue;
    if (/context7/.test(cmd))               continue;
    if (/codex\.system[/\\]bootstrap/.test(cmd)) continue;
    if (/\/Claude\//.test(cmd))             continue;
    if (/\/.claude\//.test(cmd))            continue;

    // Determine whether this is the node wrapper or the native rust child.
    // Native binary path contains the platform-specific module suffix.
    const isNative = /codex-darwin-arm64/.test(cmd) ||
                     /aarch64-apple-darwin.*\/codex$/.test(cmd);

    // For the node wrapper, two valid shapes:
    //   "/opt/homebrew/bin/codex …"            → argv0 base == 'codex'
    //   "node /opt/homebrew/bin/codex …"       → argv0 base == 'node', argv1 base == 'codex'
    // The second shape happens when codex is launched via the npm-installed
    // wrapper script (the homebrew install shells out to node with the JS
    // entrypoint as argv1).
    if (!isNative) {
      const tokens = cmd.split(/\s+/);
      const argv0Base = (tokens[0] || '').replace(/^.*\//, '');
      if (argv0Base === 'codex') {
        // direct invocation — keep
      } else if (argv0Base === 'node' && tokens[1]) {
        const argv1Base = tokens[1].replace(/^.*\//, '');
        if (argv1Base !== 'codex') continue;
      } else {
        continue;
      }
    }

    out.push({ pid, command: cmd, isNative });
  }
  return out;
}

async function probeCwd(pid) {
  const r = await execP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!r.stdout) return null;
  for (const line of r.stdout.split('\n')) {
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

/**
 * Given a node-wrapper PID, find its native rust child via pgrep -P.
 * Returns the child PID or null.
 */
async function probeNativeChild(wrapperPid) {
  const r = await execP('pgrep', ['-P', String(wrapperPid)]);
  if (!r.stdout) return null;
  const lines = r.stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const pid = parseInt(line, 10);
    if (Number.isFinite(pid) && pid !== wrapperPid) return pid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// jsonl index — maps cwd → [{jsonlPath, birthMs}]
// ---------------------------------------------------------------------------

/**
 * Parse the session_meta head line of a codex jsonl. Returns
 * { id, cwd } or null on failure.
 */
function parseCodexHead(filePath) {
  const text = safeReadHead(filePath, HEAD_BYTES);
  if (!text) return null;
  const firstLine = text.split('\n')[0];
  if (!firstLine) return null;
  let o;
  try { o = JSON.parse(firstLine); } catch (_) { return null; }
  if (!o || o.type !== 'session_meta') return null;
  const payload = o.payload;
  if (!payload || typeof payload !== 'object') return null;
  const id  = typeof payload.id  === 'string' ? payload.id  : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  if (!id || !cwd) return null;
  return { id, cwd };
}

/**
 * Build an in-memory index: cwd → [{jsonlPath, birthMs, sessionId}].
 *
 * Walks ~/.codex/sessions/<year>/<month>/<day>/ for the last INDEX_LOOKBACK_DAYS
 * days. Uses sync fs calls on the small date tree, then reads only jsonl heads.
 * Result is cached for INDEX_TTL_MS.
 */
function buildJsonlIndex() {
  const now = Date.now();
  if (_indexCache.data && (now - _indexCache.ts) < INDEX_TTL_MS) {
    return _indexCache.data;
  }

  // Collect candidate date directories within the lookback window.
  const cutoff = new Date(now - INDEX_LOOKBACK_DAYS * 86400 * 1000);
  const dateDirs = [];

  let years;
  try { years = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch (_) { years = []; }

  for (const ye of years) {
    if (!ye.isDirectory()) continue;
    const yr = parseInt(ye.name, 10);
    if (!Number.isFinite(yr)) continue;

    let months;
    const yearDir = path.join(SESSIONS_DIR, ye.name);
    try { months = fs.readdirSync(yearDir, { withFileTypes: true }); } catch (_) { continue; }

    for (const mo of months) {
      if (!mo.isDirectory()) continue;
      const mn = parseInt(mo.name, 10);
      if (!Number.isFinite(mn)) continue;

      let days;
      const monthDir = path.join(yearDir, mo.name);
      try { days = fs.readdirSync(monthDir, { withFileTypes: true }); } catch (_) { continue; }

      for (const da of days) {
        if (!da.isDirectory()) continue;
        const dy = parseInt(da.name, 10);
        if (!Number.isFinite(dy)) continue;
        // Check if this date is within the lookback window (rough cutoff by year/month/day).
        const dirDate = new Date(yr, mn - 1, dy);
        if (dirDate < cutoff) continue;
        dateDirs.push(path.join(monthDir, da.name));
      }
    }
  }

  // Build index: cwd -> [{jsonlPath, birthMs, sessionId}]
  /** @type {Map<string, Array<{jsonlPath: string, birthMs: number, sessionId: string}>>} */
  const index = new Map();

  for (const dir of dateDirs) {
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.jsonl')) continue;
      // Filename: rollout-<ISOts>-<UUIDv7>.jsonl
      if (!f.name.startsWith('rollout-')) continue;

      const jsonlPath = path.join(dir, f.name);
      let st;
      try { st = fs.statSync(jsonlPath); } catch (_) { continue; }
      const birthMs = st.birthtime ? st.birthtime.getTime() : st.mtime.getTime();

      const meta = parseCodexHead(jsonlPath);
      if (!meta) continue;

      const { id: sessionId, cwd } = meta;
      if (!index.has(cwd)) index.set(cwd, []);
      index.get(cwd).push({ jsonlPath, birthMs, sessionId });
    }
  }

  _indexCache = { ts: now, data: index };
  return index;
}

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD/ and return the absolute path of the
 * jsonl whose filename ends in `-<sessionId>.jsonl`. Codex filenames are
 * `rollout-<ISOts>-<UUIDv7>.jsonl`. Returns null if not found. Bounded by
 * INDEX_LOOKBACK_DAYS via buildJsonlIndex; for older sessions we fall back
 * to a direct walk so the route can still locate them.
 */
function findCodexJsonlBySessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const suffix = '-' + sessionId + '.jsonl';

  // Fast path: scan the in-memory index first (last 90 days).
  try {
    const index = buildJsonlIndex();
    for (const candidates of index.values()) {
      for (const c of candidates) {
        if (c.sessionId === sessionId) return c.jsonlPath;
      }
    }
  } catch (_) { /* fall through to slow walk */ }

  // Slow path: filename match across the entire date tree (no head parse).
  let years;
  try { years = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch (_) { return null; }
  for (const ye of years) {
    if (!ye.isDirectory()) continue;
    const yearDir = path.join(SESSIONS_DIR, ye.name);
    let months;
    try { months = fs.readdirSync(yearDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const mo of months) {
      if (!mo.isDirectory()) continue;
      const monthDir = path.join(yearDir, mo.name);
      let days;
      try { days = fs.readdirSync(monthDir, { withFileTypes: true }); } catch (_) { continue; }
      for (const da of days) {
        if (!da.isDirectory()) continue;
        const dayDir = path.join(monthDir, da.name);
        let files;
        try { files = fs.readdirSync(dayDir); } catch (_) { continue; }
        for (const name of files) {
          if (name.endsWith(suffix)) return path.join(dayDir, name);
        }
      }
    }
  }
  return null;
}

/**
 * Find the best jsonl for a given (cwd, startedAtMs) pair.
 * Returns { jsonlPath, sessionId } or null.
 *
 * Priority:
 *  1. birthtime closest to startedAt (and at-or-after it, with 5s grace)
 *  2. newest birthtime among all candidates for this cwd
 */
function findJsonlForCwd(cwd, startedAtMs) {
  if (!cwd) return null;
  const index = buildJsonlIndex();
  const candidates = index.get(cwd);
  if (!candidates || candidates.length === 0) return null;

  if (startedAtMs) {
    let best = null;
    for (const c of candidates) {
      if (c.birthMs < startedAtMs - 5000) continue; // born well before this PID
      const dist = Math.abs(c.birthMs - startedAtMs);
      if (!best || dist < best.dist) best = { ...c, dist };
    }
    if (best) return { jsonlPath: best.jsonlPath, sessionId: best.sessionId };
  }

  // Fallback: newest birth time overall.
  let newest = null;
  for (const c of candidates) {
    if (!newest || c.birthMs > newest.birthMs) newest = c;
  }
  return newest ? { jsonlPath: newest.jsonlPath, sessionId: newest.sessionId } : null;
}

// ---------------------------------------------------------------------------
// Codex jsonl tail parsing
// ---------------------------------------------------------------------------

/**
 * Scan the tail of a codex jsonl for the last user/assistant text + timestamps.
 *
 * Codex event shapes we handle:
 *   {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
 *   {"type":"event_msg","payload":{"type":"agent_message","message":"..."}}  (assistant)
 *   {"type":"response_item","payload":{"type":"message","role":"assistant",...}}
 *
 * All other lines are skipped.
 */
function readCodexTailSummary(filePath) {
  const tail = safeReadTail(filePath, TAIL_BYTES);
  const out = {
    lastEntryRole:     null,
    lastUserText:      null,
    lastAssistantText: null,
    lastActivityTs:    null,
    mtime:             tail.mtime ? tail.mtime.toISOString() : null,
    mtimeMs:           tail.mtime ? tail.mtime.getTime()     : null
  };
  if (!tail.text) return out;

  let lines = tail.text.split('\n');
  // Drop a leading partial line if we didn't start at file offset 0.
  if (tail.truncated && lines.length > 0) lines = lines.slice(1);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;

    // Track most-recent timestamp regardless of event type.
    if (!out.lastActivityTs && typeof o.timestamp === 'string') {
      out.lastActivityTs = o.timestamp;
    }

    const type    = o.type;
    const payload = o.payload;

    if (type === 'event_msg' && payload && typeof payload === 'object') {
      const evType = payload.type;
      const msg    = typeof payload.message === 'string' ? payload.message : null;

      if (evType === 'user_message') {
        if (!out.lastEntryRole) out.lastEntryRole = 'user';
        if (!out.lastUserText && msg) out.lastUserText = truncate(msg, TEXT_TRUNCATE);
      } else if (evType === 'agent_message' || /assistant/.test(String(evType))) {
        if (!out.lastEntryRole) out.lastEntryRole = 'assistant';
        if (!out.lastAssistantText && msg) out.lastAssistantText = truncate(msg, TEXT_TRUNCATE);
      }
    } else if (type === 'response_item' && payload && typeof payload === 'object') {
      // {"type":"response_item","payload":{"type":"message","role":"assistant",...}}
      const role = payload.role;
      if (role === 'assistant' || role === 'user') {
        if (!out.lastEntryRole) out.lastEntryRole = role;
        // Extract text from content array if present.
        const content = payload.content;
        let text = null;
        if (Array.isArray(content)) {
          const parts = [];
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (typeof block.text === 'string') parts.push(block.text);
          }
          if (parts.length) text = parts.join('\n');
        } else if (typeof content === 'string') {
          text = content;
        }
        if (role === 'assistant' && !out.lastAssistantText && text) {
          out.lastAssistantText = truncate(text, TEXT_TRUNCATE);
        } else if (role === 'user' && !out.lastUserText && text) {
          out.lastUserText = truncate(text, TEXT_TRUNCATE);
        }
      }
    }

    if (out.lastEntryRole && out.lastUserText && out.lastAssistantText && out.lastActivityTs) {
      break; // have everything
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-PID enrichment
// ---------------------------------------------------------------------------

/**
 * Given a node-wrapper process entry, enrich it into the full session record.
 * Returns null if the process has vanished between pgrep and lsof.
 */
async function enrichWrapper(wrapperEntry, allPids) {
  try {
    // Find the native child in the already-enumerated PID list (avoids a second
    // pgrep -P call in the common single-session case, but falls back to one).
    let nativePid = null;
    const nativeFromList = allPids.find(p => p.isNative);
    if (nativeFromList) {
      // Confirm it is actually our child.
      const parentCheck = await execP('ps', ['-p', String(nativeFromList.pid), '-o', 'ppid='], {
        env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' })
      });
      const ppid = parseInt((parentCheck.stdout || '').trim(), 10);
      if (ppid === wrapperEntry.pid) nativePid = nativeFromList.pid;
    }
    if (!nativePid) {
      nativePid = await probeNativeChild(wrapperEntry.pid);
    }

    // Prefer cwd from native child (it is the foreground process and has a
    // reliable cwd fd); fall back to wrapper.
    const probePid = nativePid || wrapperEntry.pid;

    const [cwdResolved, startedAt, tty] = await Promise.all([
      probeCwd(probePid),
      probeStartedAt(wrapperEntry.pid),
      probeTty(probePid)
    ]);

    // If the process vanished between pgrep and lsof, skip it.
    if (!cwdResolved) return null;

    const startedAtMs = startedAt ? Date.parse(startedAt) : null;
    const match       = findJsonlForCwd(cwdResolved, startedAtMs);

    const sessionId = match ? match.sessionId : null;
    const jsonlPath = match ? match.jsonlPath  : null;

    let tail = {
      lastEntryRole:     null,
      lastUserText:      null,
      lastAssistantText: null,
      lastActivityTs:    null,
      mtime:             null,
      mtimeMs:           null
    };
    if (jsonlPath) {
      tail = readCodexTailSummary(jsonlPath);
    }

    let idleSeconds;
    if (tail.mtimeMs != null) {
      const diff = Date.now() - tail.mtimeMs;
      idleSeconds = diff < 0 ? 0 : Math.floor(diff / 1000);
    } else {
      idleSeconds = 0;
    }

    let busy;
    if (!sessionId || !jsonlPath) {
      busy = true; // initialization / no jsonl yet
    } else if (tail.lastEntryRole == null) {
      busy = true; // no message exchanged yet
    } else {
      const isAssistantTurnEnd = tail.lastEntryRole === 'assistant';
      const stale              = idleSeconds > IDLE_THRESHOLD_S;
      busy = !(isAssistantTurnEnd && stale);
    }

    const lastActivityTs = tail.lastActivityTs || tail.mtime;

    return {
      pid:               wrapperEntry.pid,
      nativePid:         nativePid || null,
      sessionId,
      cwd:               cwdResolved,
      gitBranch:         null,   // not stored in codex jsonl head
      jsonlPath,
      lastActivityTs,
      lastEntryRole:     tail.lastEntryRole,
      lastUserText:      tail.lastUserText,
      lastAssistantText: tail.lastAssistantText,
      busy,
      idleSeconds,
      source:            'terminal', // Wave 2 will refine to cmux/tmux
      startedAt,
      argsSummary:       summarizeArgs(wrapperEntry.command),
      tty:               tty || null,
      agent:             'codex'
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function scanCodex() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < SCAN_TTL_MS) {
    return _cache.data;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const allPids = await enumeratePids();

      // Split into wrappers and native children. We only create output entries
      // for wrappers; native children are used to find the better cwd/tty.
      const wrappers = allPids.filter(p => !p.isNative);
      const natives  = allPids.filter(p =>  p.isNative);

      const enriched = await Promise.all(wrappers.map(w => enrichWrapper(w, natives)));
      const result   = enriched.filter(Boolean);

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
  scanCodex,
  invalidateCache,
  findCodexJsonlBySessionId,
  // Exposed for tests
  _internal: {
    parseCodexHead,
    readCodexTailSummary,
    buildJsonlIndex,
    findJsonlForCwd,
    findCodexJsonlBySessionId,
    truncate,
    summarizeArgs
  }
};
