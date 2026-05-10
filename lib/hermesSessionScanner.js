'use strict';

/**
 * hermesSessionScanner — detects all currently-running Hermes Agent CLI
 * processes on the local macOS box, maps each to its on-disk transcript at
 * ~/.hermes/sessions/<sessionId>.jsonl, and produces a compact summary
 * array shaped like liveSessionScanner's output.
 *
 * Hermes session layout:
 *   1. The CLI ships as a python wrapper at /Users/ys/.local/bin/hermes
 *      that exec()s ~/.hermes/hermes-agent/venv/bin/hermes (also python).
 *      Both forms appear in `pgrep -fla python` / `pgrep -fla hermes`.
 *   2. While a session is running, hermes writes events line-by-line to
 *      ~/.hermes/sessions/<sessionId>.jsonl. The filename IS the session id
 *      (e.g. 20260510_114832_eb25c9ac.jsonl). The session_meta head line
 *      does NOT include the session id or a cwd — those come from the file
 *      name and the running process respectively.
 *   3. When the session closes, hermes rewrites the transcript as a single
 *      JSON document at session_<sessionId>.json (note the prefix). Live-
 *      detection only cares about the still-open .jsonl files.
 *
 * Other hermes invocations (gateway, MCP servers, the agent-browser native
 * binary, etc.) appear in pgrep output too — they are filtered out so only
 * interactive `hermes chat` (or `hermes -q ...`) surfaces.
 *
 * This module is read-only: it never writes to the transcripts. All process
 * probing is done via pgrep / lsof / ps.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SCAN_TTL_MS      = 5 * 1000;
const TAIL_BYTES       = 64 * 1024;
const HEAD_BYTES       = 16 * 1024;
const TEXT_TRUNCATE    = 80;
const IDLE_THRESHOLD_S = 30;
const SESSIONS_DIR = path.join(os.homedir(), '.hermes', 'sessions');
// Hermes session ids are timestamp-prefixed: YYYYMMDD_HHMMSS_<6hex>
const SESSION_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6,8}$/;
const SELF_PID = process.pid;

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let _cache    = { ts: 0, data: null };
let _inflight = null;
let _indexCache    = { ts: 0, data: null };
const INDEX_TTL_MS = SCAN_TTL_MS;

function invalidateCache() {
  _cache      = { ts: 0, data: null };
  _indexCache = { ts: 0, data: null };
}

// ---------------------------------------------------------------------------
// Helpers
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
 * Enumerate hermes CLI PIDs.
 *
 * pgrep -fla hermes catches every command line containing 'hermes', so we
 * tighten the filter ourselves:
 *   - argv0 basename must look like a hermes wrapper (hermes / python with
 *     a hermes-agent venv path / hermes_cli main module)
 *   - drop background/auxiliary modes: gateway, mcp server, daemon
 *   - drop the agent-browser native helper that hermes spawns
 *   - drop our own pid
 */
async function enumeratePids() {
  const r = await execP('pgrep', ['-fla', 'hermes']);
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

    // Drop known auxiliary processes regardless of how invoked.
    if (/\bgateway\b/.test(cmd))                 continue;
    if (/\bmcp\b.*\bserver\b/.test(cmd))         continue;
    if (/agent-browser/.test(cmd))               continue;
    if (/whatsapp|slack|discord|telegram/.test(cmd)) continue;
    if (/\bgateway run\b/.test(cmd))             continue;

    // Inspect argv tokens. Accept these shapes:
    //   /Users/x/.local/bin/hermes …
    //   /Users/x/.hermes/hermes-agent/venv/bin/hermes …
    //   /Users/x/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main …
    //   /opt/homebrew/.../python … hermes …
    const tokens = cmd.split(/\s+/);
    const argv0      = tokens[0] || '';
    const argv0Base  = argv0.replace(/^.*\//, '');

    let isHermes = false;
    if (argv0Base === 'hermes') {
      isHermes = true;
    } else if (/^python(3(\.\d+)?)?$/.test(argv0Base)) {
      // python -m hermes_cli.main ...
      // python /path/to/hermes ...
      const joined = tokens.slice(1).join(' ');
      if (/(^|[\s/])hermes(\s|$)/.test(joined) ||
          /hermes_cli\.main/.test(joined) ||
          /hermes-agent\/venv\/bin\/hermes/.test(joined)) {
        isHermes = true;
      }
    }
    if (!isHermes) continue;

    // Drop subcommands that are known not to run a chat session.
    // Be conservative: only drop on explicit subcommands so direct CLI
    // invocations (`hermes`, `hermes chat`, `hermes -q ...`) stay in.
    const subRe = /\bhermes\s+(gateway|webhook|cron|kanban|hooks|doctor|setup|login|logout|auth|status|whatsapp|slack|backup|import|config|pairing|publish|completion|dashboard|logs|sessions|tools|mcp|skills|plugins|version|update|uninstall|acp|profile|insights|claw|model|fallback)\b/;
    if (subRe.test(cmd)) continue;

    out.push({ pid, command: cmd });
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

// ---------------------------------------------------------------------------
// jsonl index — currently-open `<sessionId>.jsonl` files in ~/.hermes/sessions/
// ---------------------------------------------------------------------------

/**
 * Parse the session_meta head line of a hermes jsonl. Returns
 * { platform, model } or null when the head is unreadable.
 * The session id is NOT in the payload — it lives in the file name.
 */
function parseHermesHead(filePath) {
  const text = safeReadHead(filePath, HEAD_BYTES);
  if (!text) return null;
  const firstLine = text.split('\n')[0];
  if (!firstLine) return null;
  let o;
  try { o = JSON.parse(firstLine); } catch (_) { return null; }
  if (!o || o.role !== 'session_meta') return null;
  return {
    platform: typeof o.platform === 'string' ? o.platform : null,
    model:    typeof o.model    === 'string' ? o.model    : null
  };
}

/**
 * Build an in-memory index of currently-open `<sessionId>.jsonl` files.
 * Entries: [{ jsonlPath, birthMs, mtimeMs, sessionId, platform }]
 */
function buildJsonlIndex() {
  const now = Date.now();
  if (_indexCache.data && (now - _indexCache.ts) < INDEX_TTL_MS) {
    return _indexCache.data;
  }

  let files;
  try { files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); }
  catch (_) { files = []; }

  const result = [];
  for (const f of files) {
    if (!f.isFile()) continue;
    if (!f.name.endsWith('.jsonl')) continue;
    if (f.name.startsWith('session_')) continue;   // closed-session leftover

    const sessionId = f.name.slice(0, -'.jsonl'.length);
    if (!SESSION_ID_RE.test(sessionId)) continue;

    const jsonlPath = path.join(SESSIONS_DIR, f.name);
    let st;
    try { st = fs.statSync(jsonlPath); } catch (_) { continue; }
    const birthMs = st.birthtime ? st.birthtime.getTime() : st.mtime.getTime();
    const mtimeMs = st.mtime ? st.mtime.getTime() : 0;

    const meta = parseHermesHead(jsonlPath);
    const platform = meta ? meta.platform : null;

    // Only surface CLI sessions on the home page. Telegram / slack / discord
    // sessions are observable but not project-bound or pid-attachable.
    if (platform && platform !== 'cli') continue;

    result.push({ jsonlPath, birthMs, mtimeMs, sessionId, platform });
  }

  _indexCache = { ts: now, data: result };
  return result;
}

/**
 * Find a hermes jsonl by session id. Returns the absolute path or null.
 * Used by routes/live.js when the URL carries a sid but the live scan can't
 * locate the running process.
 */
function findHermesJsonlBySessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  // First check live index.
  try {
    const idx = buildJsonlIndex();
    for (const c of idx) {
      if (c.sessionId === sessionId) return c.jsonlPath;
    }
  } catch (_) { /* fall through */ }

  // Fall through to direct probe by filename — covers in-flight files that
  // arrived after the index was last cached.
  const candidate = path.join(SESSIONS_DIR, sessionId + '.jsonl');
  try { fs.statSync(candidate); return candidate; } catch (_) { return null; }
}

/**
 * Match a running PID to its jsonl by birthtime proximity to the PID's
 * lstart. Hermes opens its jsonl right after process start, so we expect
 * birth ≈ startedAt within a few seconds. Returns the closest candidate
 * within +/- 60 s, otherwise null.
 */
function findJsonlForStartedAt(startedAtMs) {
  if (!startedAtMs) return null;
  const idx = buildJsonlIndex();
  if (!idx.length) return null;

  let best = null;
  for (const c of idx) {
    if (c.birthMs < startedAtMs - 5000) continue; // born well before pid started
    const dist = Math.abs(c.birthMs - startedAtMs);
    if (dist > 60_000) continue;                  // too far apart to trust
    if (!best || dist < best.dist) best = { ...c, dist };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hermes jsonl tail parsing
// ---------------------------------------------------------------------------

function readHermesTailSummary(filePath) {
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
  if (tail.truncated && lines.length > 0) lines = lines.slice(1);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;

    if (!out.lastActivityTs && typeof o.timestamp === 'string') {
      out.lastActivityTs = o.timestamp;
    }

    const role = o.role;
    if (role === 'user' || role === 'assistant') {
      if (!out.lastEntryRole) out.lastEntryRole = role;
      const text = typeof o.content === 'string' ? o.content : '';
      if (role === 'user' && !out.lastUserText && text) {
        out.lastUserText = truncate(text, TEXT_TRUNCATE);
      } else if (role === 'assistant' && !out.lastAssistantText && text) {
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
    if (!cwdResolved) return null;

    const startedAtMs = startedAt ? Date.parse(startedAt) : null;
    const match       = findJsonlForStartedAt(startedAtMs);

    const sessionId = match ? match.sessionId : null;
    const jsonlPath = match ? match.jsonlPath : null;

    let tail = {
      lastEntryRole:     null,
      lastUserText:      null,
      lastAssistantText: null,
      lastActivityTs:    null,
      mtime:             null,
      mtimeMs:           null
    };
    if (jsonlPath) {
      tail = readHermesTailSummary(jsonlPath);
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
      busy = true;
    } else if (tail.lastEntryRole == null) {
      busy = true;
    } else {
      const isAssistantTurnEnd = tail.lastEntryRole === 'assistant';
      const stale              = idleSeconds > IDLE_THRESHOLD_S;
      busy = !(isAssistantTurnEnd && stale);
    }

    const lastActivityTs = tail.lastActivityTs || tail.mtime;

    return {
      pid:               proc.pid,
      sessionId,
      cwd:               cwdResolved,
      gitBranch:         null,
      jsonlPath,
      lastActivityTs,
      lastEntryRole:     tail.lastEntryRole,
      lastUserText:      tail.lastUserText,
      lastAssistantText: tail.lastAssistantText,
      busy,
      idleSeconds,
      source:            'terminal',
      startedAt,
      argsSummary:       summarizeArgs(proc.command),
      tty:               tty || null,
      agent:             'hermes'
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function scanHermes() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < SCAN_TTL_MS) {
    return _cache.data;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const procs    = await enumeratePids();
      const enriched = await Promise.all(procs.map(enrich));
      const result   = enriched.filter(Boolean);

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
  scanHermes,
  invalidateCache,
  findHermesJsonlBySessionId,
  _internal: {
    parseHermesHead,
    readHermesTailSummary,
    buildJsonlIndex,
    findJsonlForStartedAt,
    findHermesJsonlBySessionId,
    truncate,
    summarizeArgs,
    SESSION_ID_RE
  }
};
