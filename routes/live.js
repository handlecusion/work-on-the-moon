'use strict';

/**
 * routes/live.js — bidirectional live attach to a local Claude Code session.
 *
 *   GET  /chat-live/:sessionId         → serve chat-live.html (auth)
 *   GET  /api/live/:sessionId          → metadata JSON for that session
 *   WS   /ws/live                      → tail + cmux input attach (auth)
 *
 * WS protocol:
 *   client → server :
 *     {type:'hello', sessionId}
 *     {type:'send', text}              — forwarded via cmuxClient.sendText
 *     {type:'send_key', key}           — forwarded via cmuxClient.sendKey
 *   server → client :
 *     init / event / meta_update / process_exit / closed / error
 *
 * Send messages are routed through the cmux IPC to the surface running the
 * `claude` CLI for this session's cwd. Echo of the keystroke arrives back via
 * the jsonl tail (no optimistic rendering).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { WebSocketServer } = require('ws');

const session = require('../auth/session');
const liveSessionScanner = require('../lib/liveSessionScanner');
const liveTailer = require('../lib/liveTailer');
const cmuxClient = require('../lib/cmuxClient');
const tmuxClient = require('../lib/tmuxClient');
const jsonlNormalizer = require('../lib/jsonlNormalizer');
const codexJsonlNormalizer = require('../lib/codexJsonlNormalizer');
const codexSessionScanner = require('../lib/codexSessionScanner');
const hermesJsonlNormalizer = require('../lib/hermesJsonlNormalizer');
const hermesSessionScanner = require('../lib/hermesSessionScanner');

function pickNormalizer(agent) {
  if (agent === 'codex')  return codexJsonlNormalizer;
  if (agent === 'hermes') return hermesJsonlNormalizer;
  return jsonlNormalizer;
}

const INIT_LIMIT = 200;

const router = express.Router();

// Accept either a claude/codex UUID or a hermes timestamped id
// (YYYYMMDD_HHMMSS_<6-8 hex>).
const SESSION_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{8}_[0-9]{6}_[0-9a-f]{6,8})$/;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const META_REFRESH_MS = 10 * 1000;
const META_DEBOUNCE_MS = 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_SEND_TEXT_BYTES = 10000;
const ALLOWED_KEYS = new Set([
  'enter', 'escape', 'ctrl-c', 'ctrl-d', 'tab', 'up', 'down', 'left', 'right'
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLiveEntryBySessionId(list, sessionId) {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry && entry.sessionId === sessionId) return entry;
  }
  return null;
}

function findLiveEntryByCwd(list, cwd) {
  if (!Array.isArray(list) || !cwd) return null;
  // list is sorted lastActivityTs desc — first match is the most recent.
  for (const entry of list) {
    if (entry && entry.cwd === cwd) return entry;
  }
  return null;
}

function encodeCwd(cwd) {
  return String(cwd || '').replace(/\//g, '-');
}

function jsonlPathFor(cwd, sid) {
  if (!cwd || !sid) return null;
  return path.join(PROJECTS_DIR, encodeCwd(cwd), sid + '.jsonl');
}

/**
 * Best-effort search for a jsonl file whose name matches sessionId, even if
 * we can't find a live process. The Claude CLI encodes the cwd as a folder
 * name where every '/' becomes '-'. Without a known cwd we have to scan the
 * whole projects dir.
 */
function findJsonlPathBySessionId(sessionId) {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const fileName = sessionId + '.jsonl';
  let best = null;
  let bestMtime = -Infinity;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(PROJECTS_DIR, d.name, fileName);
    let st;
    try { st = fs.statSync(candidate); } catch (_) { continue; }
    const m = st.mtime ? st.mtime.getTime() : 0;
    if (m > bestMtime) {
      bestMtime = m;
      best = candidate;
    }
  }
  return best;
}

/**
 * Resolve a sessionId to { agent, jsonlPath, entry } by checking, in order:
 *   1. The live scanner — entries carry agent + jsonlPath directly.
 *   2. Claude jsonl tree — by far the more common case on disk.
 *   3. Codex jsonl tree — walks ~/.codex/sessions/ for `*-<sid>.jsonl`.
 *
 * Returns { agent, jsonlPath, entry } where entry may be null when the
 * process is not running but the jsonl exists. Returns null only when the
 * sessionId is unknown to all three sources.
 */
async function resolveAgentForSessionId(sessionId) {
  let live;
  try {
    live = await liveSessionScanner.scanLive();
  } catch (_) {
    live = null;
  }
  const entry = findLiveEntryBySessionId(live, sessionId);
  if (entry) {
    return {
      agent: entry.agent || 'claude',
      jsonlPath: entry.jsonlPath || null,
      entry
    };
  }

  const claudePath = findJsonlPathBySessionId(sessionId);
  if (claudePath) {
    return { agent: 'claude', jsonlPath: claudePath, entry: null };
  }

  const codexPath = codexSessionScanner.findCodexJsonlBySessionId(sessionId);
  if (codexPath) {
    return { agent: 'codex', jsonlPath: codexPath, entry: null };
  }

  const hermesPath = hermesSessionScanner.findHermesJsonlBySessionId(sessionId);
  if (hermesPath) {
    return { agent: 'hermes', jsonlPath: hermesPath, entry: null };
  }

  return null;
}

/**
 * Decode an encoded directory name back to a cwd path.
 *   '-Users-alice-Code-foo' → '/Users/alice/Code/foo'
 */
function decodeEncodedCwd(encoded) {
  if (!encoded) return null;
  // Replace every '-' that came from a '/' substitution. The original cwd
  // can't contain hyphens that weren't '/' though we can't know for sure
  // — best-effort.
  return '/' + encoded.replace(/^-/, '').split('-').join('/');
}

function buildMeta(entry, fallback) {
  if (entry) {
    return {
      pid: entry.pid,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      gitBranch: entry.gitBranch || null,
      source: entry.source,
      busy: entry.busy,
      idleSeconds: entry.idleSeconds,
      startedAt: entry.startedAt || null,
      lastActivityTs: entry.lastActivityTs || null,
      jsonlPath: entry.jsonlPath || null,
      agent: entry.agent || 'claude',
      cmuxAvailable: !!entry.cmuxAvailable,
      cmuxSurfaceId: entry.cmuxSurfaceId || null,
      cmuxWorkspaceId: entry.cmuxWorkspaceId || null,
      tmuxAvailable: !!entry.tmuxAvailable,
      tmuxSocketPath: entry.tmuxSocketPath || null,
      tmuxPaneId: entry.tmuxPaneId || null
    };
  }
  // Fallback: process not found, but we have a jsonl path.
  return {
    pid: null,
    sessionId: fallback.sessionId,
    cwd: fallback.cwd || null,
    gitBranch: null,
    source: null,
    busy: false,
    idleSeconds: null,
    startedAt: null,
    lastActivityTs: null,
    jsonlPath: fallback.jsonlPath,
    agent: fallback.agent || 'claude',
    cmuxAvailable: false,
    cmuxSurfaceId: null,
    cmuxWorkspaceId: null,
    tmuxAvailable: false,
    tmuxSocketPath: null,
    tmuxPaneId: null
  };
}

/**
 * Ensure the singleton cmux client is connected. Returns true if connected,
 * false if cmux is unavailable. Soft-fails — never throws.
 */
async function ensureCmuxConnected() {
  if (cmuxClient.isConnected()) return true;
  try {
    await cmuxClient.connect();
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

router.get('/chat-live/:sessionId', session.requireAuth, (req, res) => {
  const sid = req.params.sessionId;
  if (!SESSION_ID_RE.test(sid)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'chat-live.html'));
});

// cwd-based entry — used when the running claude process has no resolvable
// sessionId yet (e.g. `--continue` with no UUID before any message is sent).
// The :cwd param is URL-decoded by Express; we just need it to look like an
// absolute path.
router.get('/chat-live-cwd/:cwd', session.requireAuth, (req, res) => {
  const cwd = req.params.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'chat-live.html'));
});

router.get('/api/live/:sessionId', session.requireAuth, async (req, res) => {
  const sid = req.params.sessionId;
  if (!SESSION_ID_RE.test(sid)) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }

  let resolved;
  try {
    resolved = await resolveAgentForSessionId(sid);
  } catch (e) {
    return res.status(500).json({ error: 'scanLive failed: ' + e.message });
  }
  if (!resolved) {
    return res.status(404).json({ error: 'session not found' });
  }

  if (resolved.entry) {
    return res.json(buildMeta(resolved.entry, null));
  }

  // Process not running — but jsonl exists for read-only viewing.
  // For claude, derive cwd best-effort from the directory name. For codex,
  // the cwd lives inside the head's session_meta payload.
  let cwd = null;
  if (resolved.agent === 'claude') {
    const dirName = path.basename(path.dirname(resolved.jsonlPath));
    cwd = decodeEncodedCwd(dirName);
  } else if (resolved.agent === 'codex') {
    const head = codexSessionScanner._internal.parseCodexHead(resolved.jsonlPath);
    cwd = head ? head.cwd : null;
  } else if (resolved.agent === 'hermes') {
    // Hermes session_meta has no cwd; we can't recover it once the process
    // is gone. Leave null — the UI will hide cwd-dependent features.
    cwd = null;
  }
  return res.json(buildMeta(null, {
    sessionId: sid,
    cwd,
    jsonlPath: resolved.jsonlPath,
    agent: resolved.agent
  }));
});

// ---------------------------------------------------------------------------
// WS endpoint
// ---------------------------------------------------------------------------

function attachWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let urlObj;
    try {
      urlObj = new url.URL(req.url, 'http://localhost');
    } catch (_) {
      return; // let other upgrade handlers (or default) deal with it
    }
    if (urlObj.pathname !== '/ws/live') return;

    const sessionRow = session.getSessionForWS(req, urlObj);
    if (!sessionRow) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionRow);
    });
  });

  wss.on('connection', (ws, req, sessionRow) => {
    console.log('[live] connection open');

    let attached = false;
    let attachedSid = null;
    let attachedCwd = null;
    let attachedJsonlPath = null;
    let attachedAgent = 'claude';   // 'claude' or 'codex' — fixed once known
    let tailerHandle = null;
    let metaRefreshTimer = null;
    let metaDebounceTimer = null;
    let fileWaitTimer = null;
    let pendingJsonlPath = null;   // set when file doesn't exist yet
    let lastMeta = null;            // last meta we sent — used when re-emitting init after lazy attach
    let lastBroadcastBusy = null;
    let lastBroadcastIdle = null;
    let lastBroadcastPid = null;
    let lastBroadcastTmuxAvailable = null;
    let lastBroadcastTmuxSocketPath = null;
    let lastBroadcastTmuxPaneId = null;
    // Per-connection cmux state — refreshed on meta poll. surfaceId is what
    // we forward send/send_key to. cwd is captured for re-resolution.
    let cmuxState = {
      available: false,
      surfaceId: null,
      workspaceId: null
    };
    // Per-connection tmux state — fire-and-forget per call, no persistent socket.
    let tmuxState = {
      available: false,
      socketPath: null,
      paneId: null
    };
    let isAlive = true;

    function send(obj) {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }

    function closeWithError(message) {
      console.log('[live] closing with error: %s', message);
      send({ type: 'error', message });
      send({ type: 'closed', reason: message });
      try { ws.close(); } catch (_) {}
    }

    // ── Heartbeat ────────────────────────────────────────────────────
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        try { ws.terminate(); } catch (_) {}
        return;
      }
      isAlive = false;
      try { ws.ping(); } catch (_) {}
    }, HEARTBEAT_MS);

    ws.on('pong', () => { isAlive = true; });

    // ── Locate the entry for this connection (sid first, cwd fallback) ──
    function findEntryForConnection(live) {
      if (attachedSid) {
        const e = findLiveEntryBySessionId(live, attachedSid);
        if (e) return e;
      }
      if (attachedCwd) {
        return findLiveEntryByCwd(live, attachedCwd);
      }
      return null;
    }

    // ── Tailer attach helper ────────────────────────────────────────
    async function attachTailer(jsonlPath, alreadyReplayed) {
      if (tailerHandle) return;
      let firstInit = !!alreadyReplayed;
      tailerHandle = await liveTailer.attach(jsonlPath, {
        onInit: (events) => {
          if (firstInit) { firstInit = false; return; }
          // File appeared, was truncated, or replaced — re-send chunked init
          // using the latest meta we have.
          const total = events.length;
          const startIdx = Math.max(0, total - INIT_LIMIT);
          const initTranscript = events.slice(startIdx);
          console.log('[live] init re-sent (tailer onInit) transcript=%d events oldestStartIdx=%d hasEarlier=%s',
            initTranscript.length, startIdx, startIdx > 0);
          send({
            type: 'init',
            meta: lastMeta,
            transcript: initTranscript,
            oldestStartIdx: startIdx,
            hasEarlier: startIdx > 0
          });
        },
        onEvent: (ev) => {
          if (!ev) return;
          send(Object.assign({ type: 'event' }, ev));
        },
        onMtimeChange: () => {
          if (metaDebounceTimer) clearTimeout(metaDebounceTimer);
          metaDebounceTimer = setTimeout(async () => {
            metaDebounceTimer = null;
            if (ws.readyState !== ws.OPEN) return;
            liveSessionScanner.invalidateCache();
            let live2;
            try { live2 = await liveSessionScanner.scanLive(); }
            catch (_) { return; }
            const e2 = findEntryForConnection(live2);
            if (!e2) return;
            // Pick up sid if it just became known (cwd-mode).
            if (!attachedSid && e2.sessionId) attachedSid = e2.sessionId;
            const cmuxChanged2 = (!!e2.cmuxAvailable) !== cmuxState.available
                || (e2.cmuxSurfaceId || null) !== cmuxState.surfaceId
                || (e2.cmuxWorkspaceId || null) !== cmuxState.workspaceId;
            if (cmuxChanged2) {
              cmuxState = {
                available: !!e2.cmuxAvailable,
                surfaceId: e2.cmuxSurfaceId || null,
                workspaceId: e2.cmuxWorkspaceId || null
              };
            }
            const tmuxChanged2 = (!!e2.tmuxAvailable) !== tmuxState.available
                || (e2.tmuxSocketPath || null) !== tmuxState.socketPath
                || (e2.tmuxPaneId || null) !== tmuxState.paneId;
            if (tmuxChanged2) {
              tmuxState = {
                available: !!e2.tmuxAvailable,
                socketPath: e2.tmuxSocketPath || null,
                paneId: e2.tmuxPaneId || null
              };
            }
            if (e2.busy !== lastBroadcastBusy
                || e2.idleSeconds !== lastBroadcastIdle
                || cmuxChanged2
                || tmuxChanged2) {
              lastBroadcastBusy = e2.busy;
              lastBroadcastIdle = e2.idleSeconds;
              lastBroadcastTmuxAvailable = tmuxState.available;
              lastBroadcastTmuxSocketPath = tmuxState.socketPath;
              lastBroadcastTmuxPaneId = tmuxState.paneId;
              send({
                type: 'meta_update',
                busy: e2.busy,
                idleSeconds: e2.idleSeconds,
                pid: e2.pid,
                cmuxAvailable: cmuxState.available,
                cmuxSurfaceId: cmuxState.surfaceId,
                cmuxWorkspaceId: cmuxState.workspaceId,
                tmuxAvailable: tmuxState.available,
                tmuxSocketPath: tmuxState.socketPath,
                tmuxPaneId: tmuxState.paneId
              });
            }
          }, META_DEBOUNCE_MS);
        },
        onClose: () => {
          send({ type: 'closed', reason: 'transcript file removed' });
          try { ws.close(); } catch (_) {}
        }
      }, { normalizer: pickNormalizer(attachedAgent) });
    }

    // ── Wait for the jsonl file to appear, then lazy-attach ──────────
    // Used when the running claude hasn't written its first line yet, or
    // when only cwd is known (sid emerges later via scanner).
    function startFileWaitPoll() {
      if (fileWaitTimer) return;
      const POLL_MS = 1500;
      fileWaitTimer = setInterval(async () => {
        if (ws.readyState !== ws.OPEN) return;
        if (tailerHandle) {
          clearInterval(fileWaitTimer);
          fileWaitTimer = null;
          return;
        }
        // If sid is still unknown (cwd-mode), re-scan to discover it.
        if (!attachedSid && attachedCwd) {
          try {
            const live = await liveSessionScanner.scanLive();
            const e = findLiveEntryByCwd(live, attachedCwd);
            if (e) {
              lastMeta = buildMeta(e, null);
              if (e.sessionId) {
                attachedSid = e.sessionId;
                if (!pendingJsonlPath) {
                  pendingJsonlPath = e.jsonlPath || jsonlPathFor(attachedCwd, e.sessionId);
                }
              }
            }
          } catch (_) { /* keep polling */ }
        }
        // If we still have no path candidate, try a whole-tree lookup.
        if (!pendingJsonlPath && attachedSid) {
          pendingJsonlPath = findJsonlPathBySessionId(attachedSid);
        }
        if (pendingJsonlPath && fs.existsSync(pendingJsonlPath)) {
          const toAttach = pendingJsonlPath;
          pendingJsonlPath = null;
          attachedJsonlPath = toAttach;
          clearInterval(fileWaitTimer);
          fileWaitTimer = null;
          try {
            // alreadyReplayed=false → first onInit will emit a fresh init
            // replacing the empty transcript we sent at hello.
            await attachTailer(toAttach, false);
          } catch (e) {
            send({ type: 'error', message: 'tailer attach failed: ' + e.message });
          }
        }
      }, POLL_MS);
      if (fileWaitTimer.unref) fileWaitTimer.unref();
    }

    // ── Periodic meta refresh ────────────────────────────────────────
    function startMetaRefresh() {
      metaRefreshTimer = setInterval(async () => {
        if (ws.readyState !== ws.OPEN) return;
        if (!attachedSid && !attachedCwd) return;
        let live;
        try {
          live = await liveSessionScanner.scanLive();
        } catch (_) { return; }
        const entry = findEntryForConnection(live);
        // Pick up sid if it just became known (cwd-mode).
        if (entry && !attachedSid && entry.sessionId) {
          attachedSid = entry.sessionId;
        }
        // Keep lastMeta fresh so any future init re-emit carries the right
        // sessionId / cwd / pid.
        if (entry) lastMeta = buildMeta(entry, null);
        if (!entry) {
          // Process disappeared. Notify once.
          if (lastBroadcastPid != null) {
            send({ type: 'process_exit' });
            lastBroadcastPid = null;
          }
          // Flip cmux and tmux to unavailable so the input bar disables.
          const hadCmux = cmuxState.available;
          const hadTmux = tmuxState.available;
          if (hadCmux) {
            cmuxState = { available: false, surfaceId: null, workspaceId: null };
          }
          if (hadTmux) {
            tmuxState = { available: false, socketPath: null, paneId: null };
            lastBroadcastTmuxAvailable = false;
            lastBroadcastTmuxSocketPath = null;
            lastBroadcastTmuxPaneId = null;
          }
          if (hadCmux || hadTmux) {
            send({
              type: 'meta_update',
              cmuxAvailable: false,
              cmuxSurfaceId: null,
              cmuxWorkspaceId: null,
              tmuxAvailable: false,
              tmuxSocketPath: null,
              tmuxPaneId: null
            });
          }
          return;
        }
        if (lastBroadcastPid == null) lastBroadcastPid = entry.pid;

        const cmuxChanged = (!!entry.cmuxAvailable) !== cmuxState.available
            || (entry.cmuxSurfaceId || null) !== cmuxState.surfaceId
            || (entry.cmuxWorkspaceId || null) !== cmuxState.workspaceId;
        if (cmuxChanged) {
          cmuxState = {
            available: !!entry.cmuxAvailable,
            surfaceId: entry.cmuxSurfaceId || null,
            workspaceId: entry.cmuxWorkspaceId || null
          };
        }

        const tmuxChanged = (!!entry.tmuxAvailable) !== tmuxState.available
            || (entry.tmuxSocketPath || null) !== tmuxState.socketPath
            || (entry.tmuxPaneId || null) !== tmuxState.paneId;
        if (tmuxChanged) {
          tmuxState = {
            available: !!entry.tmuxAvailable,
            socketPath: entry.tmuxSocketPath || null,
            paneId: entry.tmuxPaneId || null
          };
        }

        // Broadcast a meta_update if busy/idle/pid OR cmux/tmux fields changed.
        if (entry.busy !== lastBroadcastBusy
            || entry.idleSeconds !== lastBroadcastIdle
            || entry.pid !== lastBroadcastPid
            || cmuxChanged
            || tmuxChanged) {
          lastBroadcastBusy = entry.busy;
          lastBroadcastIdle = entry.idleSeconds;
          lastBroadcastPid = entry.pid;
          lastBroadcastTmuxAvailable = tmuxState.available;
          lastBroadcastTmuxSocketPath = tmuxState.socketPath;
          lastBroadcastTmuxPaneId = tmuxState.paneId;
          send({
            type: 'meta_update',
            busy: entry.busy,
            idleSeconds: entry.idleSeconds,
            pid: entry.pid,
            cmuxAvailable: cmuxState.available,
            cmuxSurfaceId: cmuxState.surfaceId,
            cmuxWorkspaceId: cmuxState.workspaceId,
            tmuxAvailable: tmuxState.available,
            tmuxSocketPath: tmuxState.socketPath,
            tmuxPaneId: tmuxState.paneId
          });
        }
      }, META_REFRESH_MS);
      if (metaRefreshTimer.unref) metaRefreshTimer.unref();
    }

    // ── Message handler ──────────────────────────────────────────────
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        send({ type: 'error', message: 'invalid json' });
        return;
      }

      if (!attached) {
        if (!msg || msg.type !== 'hello') {
          closeWithError('expected hello as first message');
          return;
        }
        const sidArg = (typeof msg.sessionId === 'string') ? msg.sessionId : null;
        const cwdArg = (typeof msg.cwd === 'string') ? msg.cwd : null;
        console.log('[live] hello sid=%s cwd=%s', sidArg || '(none)', cwdArg || '(none)');
        if (sidArg && !SESSION_ID_RE.test(sidArg)) {
          closeWithError('invalid sessionId');
          return;
        }
        if (!sidArg && (!cwdArg || !cwdArg.startsWith('/'))) {
          closeWithError('hello requires sessionId or absolute cwd');
          return;
        }

        let live;
        try {
          live = await liveSessionScanner.scanLive();
        } catch (e) {
          closeWithError('scan failed: ' + e.message);
          return;
        }

        // Locate the running entry (claude or codex) by sid OR cwd.
        const entry = sidArg
          ? findLiveEntryBySessionId(live, sidArg)
          : findLiveEntryByCwd(live, cwdArg);

        // Resolve final identifiers.
        const resolvedSid = sidArg || (entry && entry.sessionId) || null;
        const resolvedCwd = (entry && entry.cwd) || cwdArg || null;

        // Determine agent. When the live entry is found, trust its tag.
        // Otherwise (sid-only, no live process), probe both jsonl trees.
        let agent = (entry && entry.agent) || 'claude';
        let jsonlPath = null;
        if (entry && entry.jsonlPath) {
          jsonlPath = entry.jsonlPath;
        } else if (resolvedSid) {
          // Sid given but no live entry: probe claude first, then codex.
          // (cwd-only mode hits this branch only when resolvedSid is null,
          // which is claude-specific; codex live entries always carry sid.)
          if (resolvedCwd) {
            const claudeCandidate = jsonlPathFor(resolvedCwd, resolvedSid);
            if (claudeCandidate && fs.existsSync(claudeCandidate)) {
              jsonlPath = claudeCandidate;
              agent = 'claude';
            }
          }
          if (!jsonlPath) {
            const claudePath = findJsonlPathBySessionId(resolvedSid);
            if (claudePath) {
              jsonlPath = claudePath;
              agent = 'claude';
            } else {
              const codexPath = codexSessionScanner.findCodexJsonlBySessionId(resolvedSid);
              if (codexPath) {
                jsonlPath = codexPath;
                agent = 'codex';
              } else {
                const hermesPath = hermesSessionScanner.findHermesJsonlBySessionId(resolvedSid);
                if (hermesPath) {
                  jsonlPath = hermesPath;
                  agent = 'hermes';
                }
              }
            }
          }
        }

        // Bail only if we can't anchor on anything at all.
        if (!entry && !jsonlPath) {
          closeWithError('session not found');
          return;
        }

        attachedAgent = agent;

        // Capture entry metadata for meta polling.
        let meta;
        if (entry) {
          console.log('[live] entry-found pid=%s sid=%s cwd=%s agent=%s tmuxAvail=%s cmuxAvail=%s',
            entry.pid, entry.sessionId, entry.cwd, entry.agent || 'claude', !!entry.tmuxAvailable, !!entry.cmuxAvailable);
          meta = buildMeta(entry, null);
          lastBroadcastBusy = entry.busy;
          lastBroadcastIdle = entry.idleSeconds;
          lastBroadcastPid = entry.pid;
          cmuxState = {
            available: !!entry.cmuxAvailable,
            surfaceId: entry.cmuxSurfaceId || null,
            workspaceId: entry.cmuxWorkspaceId || null
          };
          tmuxState = {
            available: !!entry.tmuxAvailable,
            socketPath: entry.tmuxSocketPath || null,
            paneId: entry.tmuxPaneId || null
          };
          lastBroadcastTmuxAvailable = tmuxState.available;
          lastBroadcastTmuxSocketPath = tmuxState.socketPath;
          lastBroadcastTmuxPaneId = tmuxState.paneId;
        } else {
          // jsonl-only fallback (process not found, but file exists for sid).
          console.log('[live] entry-not-found, using jsonl-only fallback agent=%s path=%s', agent, jsonlPath);
          let cwdGuess = resolvedCwd;
          if (!cwdGuess && jsonlPath) {
            if (agent === 'claude') {
              cwdGuess = decodeEncodedCwd(path.basename(path.dirname(jsonlPath)));
            } else if (agent === 'codex') {
              const head = codexSessionScanner._internal.parseCodexHead(jsonlPath);
              cwdGuess = head ? head.cwd : null;
            }
            // hermes: no cwd recoverable from jsonl head
          }
          meta = buildMeta(null, {
            sessionId: resolvedSid,
            cwd: cwdGuess,
            jsonlPath,
            agent
          });
        }

        attached = true;
        attachedSid = resolvedSid;
        attachedCwd = resolvedCwd;
        lastMeta = meta;

        // Send init synchronously. If the file exists, replay the most recent
        // INIT_LIMIT events; otherwise send empty and let the lazy attach path
        // re-emit init when the file appears.
        const fileExists = !!(jsonlPath && fs.existsSync(jsonlPath));
        if (fileExists) attachedJsonlPath = jsonlPath;
        const norm = pickNormalizer(attachedAgent);
        const allEvents = fileExists ? norm.getCachedEvents(jsonlPath) : [];
        const total = allEvents.length;
        const startIdx = Math.max(0, total - INIT_LIMIT);
        const transcript = allEvents.slice(startIdx);
        // Earlier events may exist either inside the cache window (when the
        // cold load returned more than INIT_LIMIT) or on disk before the
        // window's head. Either case warrants the UI's "load earlier" CTA.
        const earlierOnDisk = fileExists && typeof norm.hasEarlierEvents === 'function'
          ? norm.hasEarlierEvents(jsonlPath)
          : false;
        const hasEarlier = startIdx > 0 || earlierOnDisk;
        console.log('[live] init sent agent=%s transcript=%d events oldestStartIdx=%d hasEarlier=%s',
          attachedAgent, transcript.length, startIdx, hasEarlier);
        send({ type: 'init', meta, transcript, oldestStartIdx: startIdx, hasEarlier });

        if (fileExists) {
          try {
            await attachTailer(jsonlPath, /* alreadyReplayed */ true);
          } catch (e) {
            closeWithError('tailer attach failed: ' + e.message);
            return;
          }
        } else {
          // Either jsonl hasn't been written yet, or sid is still unknown
          // (cwd-only mode). Poll until we can attach.
          pendingJsonlPath = jsonlPath;
          startFileWaitPoll();
        }

        startMetaRefresh();
        return;
      }

      // ── Subsequent messages — input forwarding ──────────────────────
      const type = msg && msg.type;

      if (type === 'send' || type === 'send_key') {
        console.log('[live] %s received sid=%s cmuxAvail=%s tmuxAvail=%s tmuxPane=%s',
          type, attachedSid || '(none)', cmuxState.available, tmuxState.available, tmuxState.paneId || '(none)');
        // Validate payload first, before touching any transport.
        if (type === 'send') {
          const text = msg.text;
          if (typeof text !== 'string') {
            send({ type: 'error', message: 'send: text must be a string' });
            return;
          }
          if (Buffer.byteLength(text, 'utf8') > MAX_SEND_TEXT_BYTES) {
            send({ type: 'error', message: 'send: text too large (max 10000 bytes)' });
            return;
          }
        } else {
          // type === 'send_key'
          const key = msg.key;
          if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
            send({ type: 'error', message: 'send_key: key must be one of ' +
              Array.from(ALLOWED_KEYS).join(', ') });
            return;
          }
        }

        // Routing priority: cmux > tmux > error.
        if (cmuxState.available && cmuxState.surfaceId) {
          const ok = await ensureCmuxConnected();
          if (!ok) {
            send({ type: 'error', message: 'cmux 연결이 끊어졌습니다.' });
            return;
          }
          if (type === 'send') {
            try {
              await cmuxClient.sendText(cmuxState.surfaceId, msg.text);
            } catch (err) {
              send({ type: 'error', message: '전송 실패: ' + (err && err.message ? err.message : String(err)) });
            }
          } else {
            try {
              await cmuxClient.sendKey(cmuxState.surfaceId, msg.key);
            } catch (err) {
              send({ type: 'error', message: '키 전송 실패: ' + (err && err.message ? err.message : String(err)) });
            }
          }
          return;
        }

        if (tmuxState.available && tmuxState.paneId && tmuxState.socketPath) {
          try {
            if (type === 'send') {
              await tmuxClient.sendText(tmuxState.socketPath, tmuxState.paneId, msg.text);
              console.log('[live] tmux sendText OK pane=%s bytes=%d', tmuxState.paneId, Buffer.byteLength(msg.text, 'utf8'));
            } else {
              await tmuxClient.sendKey(tmuxState.socketPath, tmuxState.paneId, msg.key);
              console.log('[live] tmux sendKey OK pane=%s key=%s', tmuxState.paneId, msg.key);
            }
          } catch (err) {
            console.log('[live] tmux send FAIL: %s', err && err.message ? err.message : String(err));
            send({ type: 'error', message: '전송 실패: ' + (err && err.message ? err.message : String(err)) });
          }
          return;
        }

        console.log('[live] send rejected — no available transport');
        send({ type: 'error', message: '입력 forwarding이 비활성 상태입니다.' });
        return;
      }

      if (type === 'load_earlier') {
        const before = Number(msg.before);
        const limit = Math.min(Number(msg.limit) || INIT_LIMIT, 500);
        if (!Number.isFinite(before) || before <= 0) {
          send({ type: 'earlier_events', events: [], oldestStartIdx: 0, hasEarlier: false });
          return;
        }
        let resolvedPath = null;
        if (attachedJsonlPath) {
          resolvedPath = attachedJsonlPath;
        } else if (attachedAgent === 'codex' && attachedSid) {
          resolvedPath = codexSessionScanner.findCodexJsonlBySessionId(attachedSid);
        } else if (attachedAgent === 'hermes' && attachedSid) {
          resolvedPath = hermesSessionScanner.findHermesJsonlBySessionId(attachedSid);
        } else if (attachedSid && attachedCwd) {
          resolvedPath = jsonlPathFor(attachedCwd, attachedSid);
        } else if (attachedSid) {
          resolvedPath = findJsonlPathBySessionId(attachedSid);
        }
        if (!resolvedPath || !fs.existsSync(resolvedPath)) {
          send({ type: 'earlier_events', events: [], oldestStartIdx: 0, hasEarlier: false });
          return;
        }
        const norm = pickNormalizer(attachedAgent);
        const cachedBefore = norm.getCachedEvents(resolvedPath);
        const lenBefore = cachedBefore.length;
        // Expand the cache backwards if needed so we have enough events to
        // satisfy a `before` request from the client. When the file's
        // already fully loaded this is a no-op.
        let allEvents = cachedBefore;
        if (typeof norm.ensureCount === 'function') {
          allEvents = norm.ensureCount(resolvedPath, Math.max(0, before) + limit);
        }
        // If we prepended events on this call, the client's `before` index
        // (relative to the previous cache) shifts by `prepended`.
        const prepended = allEvents.length - lenBefore;
        const beforeAbs = Math.max(0, before) + prepended;
        const newEnd = Math.min(beforeAbs, allEvents.length);
        const newStart = Math.max(0, newEnd - limit);
        const events = allEvents.slice(newStart, newEnd);
        const earlierOnDisk = typeof norm.hasEarlierEvents === 'function'
          ? norm.hasEarlierEvents(resolvedPath)
          : false;
        send({
          type: 'earlier_events',
          events,
          oldestStartIdx: newStart,
          hasEarlier: newStart > 0 || earlierOnDisk
        });
        return;
      }

      send({ type: 'error', message: 'unknown message type: ' + type });
    });

    ws.on('close', () => {
      console.log('[live] connection close sid=%s cwd=%s',
        attachedSid || '(no sid)',
        attachedCwd || '(no cwd)');
      clearInterval(pingInterval);
      if (metaRefreshTimer) clearInterval(metaRefreshTimer);
      if (metaDebounceTimer) clearTimeout(metaDebounceTimer);
      if (fileWaitTimer) { clearInterval(fileWaitTimer); fileWaitTimer = null; }
      if (tailerHandle) {
        try { tailerHandle.detach(); } catch (_) {}
        tailerHandle = null;
      }
    });

    ws.on('error', (err) => {
      console.error('[live] ws error:', err && err.message);
      clearInterval(pingInterval);
      if (metaRefreshTimer) clearInterval(metaRefreshTimer);
      if (metaDebounceTimer) clearTimeout(metaDebounceTimer);
      if (fileWaitTimer) { clearInterval(fileWaitTimer); fileWaitTimer = null; }
      if (tailerHandle) {
        try { tailerHandle.detach(); } catch (_) {}
        tailerHandle = null;
      }
    });
  });

  return wss;
}

module.exports = { router, attachWS };
