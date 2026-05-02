'use strict';

/**
 * Smoke test for PR-F3 cmux IPC routing through /ws/live.
 *
 *   1. Read a valid session token from the on-disk store.
 *   2. Pick a localActive entry where cmuxAvailable === true AND its cwd
 *      basename is NOT in a sensitive list (we never want to nudge our own
 *      working session). Prefer surfaces that look idle (busy=false).
 *   3. Connect to /ws/live, send hello with the chosen sessionId.
 *   4. Wait for `init`, assert meta.cmuxAvailable === true.
 *   5. Send {type:'send', text:'# claude-web smoke (no-op)\n'}. The leading
 *      `#` makes claude/shell treat it as a comment so it's harmless.
 *   6. Wait 2 s — assert no `error` event arrived.
 *   7. Listen 3 s for any new ws frames as a positive signal of cmux echo,
 *      but don't fail if none arrive (claude TUI may buffer).
 *   8. Send {type:'send_key', key:'escape'} — assert no error.
 *   9. Print PASS/FAIL summary.
 *
 * Usage: node scripts/smoke-live-input.js
 */

const path = require('path');
const WebSocket = require('ws');
const store = require('../auth/store');
const liveSessionScanner = require('../lib/liveSessionScanner');

const HOST = process.env.CLAUDE_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CLAUDE_WEB_PORT, 10) || 3700;

// Never inject keystrokes into these projects — keep our own dev session
// quiet, plus a small allowlist of "do not touch" surfaces. Override via env.
const SENSITIVE_BASENAMES = new Set(
  (process.env.SMOKE_SENSITIVE_PROJECTS || 'working-in-the-moon,claude-web')
    .split(',').map(s => s.trim()).filter(Boolean)
);

let passed = 0;
let failed = 0;

function log(msg) { process.stdout.write('[smoke] ' + msg + '\n'); }
function bail(msg) {
  process.stderr.write('[smoke] FATAL: ' + msg + '\n');
  process.exit(1);
}
function assert(label, condition) {
  if (condition) { log('  PASS: ' + label); passed++; }
  else { log('  FAIL: ' + label); failed++; }
}

function findValidToken() {
  store.loadSync();
  const data = store.getData();
  const now = Date.now();
  const sessions = (data.sessions || []).filter(s => Date.parse(s.expiresAt) > now);
  if (!sessions.length) return null;
  sessions.sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  return sessions[0].token;
}

function pickSafeCandidate(list) {
  if (!Array.isArray(list)) return null;
  const candidates = list.filter(e =>
    e &&
    e.sessionId &&
    e.jsonlPath &&
    e.cmuxAvailable === true &&
    e.cmuxSurfaceId &&
    e.cwd &&
    !SENSITIVE_BASENAMES.has(path.basename(e.cwd))
  );
  if (!candidates.length) return null;
  // Prefer idle (busy=false) and largest idleSeconds.
  candidates.sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? 1 : -1;
    return (b.idleSeconds || 0) - (a.idleSeconds || 0);
  });
  return candidates[0];
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const wsUrl = 'ws://' + HOST + ':' + PORT + '/ws/live';
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: 'claudeweb_session=' + token }
    });

    const pending = [];
    const received = [];

    function dispatch(msg) {
      const idx = received.length;
      received.push(msg);
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (idx >= p.fromIndex && p.type === msg.type && (!p.filter || p.filter(msg))) {
          clearTimeout(p.timer);
          pending.splice(i, 1);
          p.resolve(msg);
          return;
        }
      }
    }

    ws.on('open', () => {
      const api = {
        ws,
        received,
        waitForType(type, filter, timeoutMs, fromIndex) {
          timeoutMs = timeoutMs || 30000;
          if (fromIndex === undefined) fromIndex = received.length;
          return new Promise((res, rej) => {
            for (let i = fromIndex; i < received.length; i++) {
              const m = received[i];
              if (m.type === type && (!filter || filter(m))) {
                res(m); return;
              }
            }
            const timer = setTimeout(() => {
              const idx = pending.indexOf(entry);
              if (idx >= 0) pending.splice(idx, 1);
              rej(new Error('timeout waiting for type=' + type + ' after ' + timeoutMs + 'ms'));
            }, timeoutMs);
            const entry = { type, filter, resolve: res, reject: rej, timer, fromIndex };
            pending.push(entry);
          });
        },
        sendMsg(obj) { ws.send(JSON.stringify(obj)); },
        close() { try { ws.close(); } catch (_) {} }
      };
      resolve(api);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch (_) { msg = { type: '__parse_error__', raw: raw.toString('utf8') }; }
      dispatch(msg);
    });

    ws.on('error', (err) => { reject(err); });

    ws.on('close', (code, reason) => {
      for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('ws closed code=' + code + ' reason=' + reason));
      }
      pending.length = 0;
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  log('=== smoke-live-input ===');
  log('server: ws://' + HOST + ':' + PORT + '/ws/live');
  log('sensitive basenames: ' + Array.from(SENSITIVE_BASENAMES).join(', '));

  const token = findValidToken();
  if (!token) {
    process.stderr.write(
      '\n[smoke] No valid session found in ~/.claude-web/data.json.\n' +
      'Please log in via the browser first, then re-run this script.\n\n'
    );
    process.exit(1);
  }
  log('session token: ' + token.slice(0, 8) + '...');

  // ---- 1. Pick a safe candidate ----
  log('scanning live sessions…');
  let live;
  try {
    live = await liveSessionScanner.scanLive();
  } catch (e) {
    bail('scanLive failed: ' + e.message);
  }
  log('localActive count: ' + live.length);
  const cmuxCount = live.filter(e => e && e.cmuxAvailable).length;
  log('cmuxAvailable count: ' + cmuxCount);

  const target = pickSafeCandidate(live);
  if (!target) {
    log('SKIP: no safe candidate (need cmuxAvailable=true and non-sensitive cwd)');
    log('==========================================');
    log('Results: ' + passed + ' passed, ' + failed + ' failed (skipped)');
    log('PASS');
    process.exit(0);
  }
  log('target sid=' + target.sessionId.slice(0, 8) +
      ' cwd=' + target.cwd +
      ' busy=' + target.busy +
      ' idle=' + target.idleSeconds + 's' +
      ' surface=' + (target.cmuxSurfaceId || '').slice(0, 8));

  // ---- 2. Connect ----
  let api;
  try {
    api = await connect(token);
  } catch (e) {
    bail('connect failed: ' + e.message);
  }
  log('connected');

  // ---- 3. Hello ----
  api.sendMsg({ type: 'hello', sessionId: target.sessionId });
  log('sent hello sessionId=' + target.sessionId.slice(0, 8));

  // ---- 4. Init ----
  let initMsg;
  try {
    initMsg = await api.waitForType('init', null, 5000);
  } catch (e) {
    api.close();
    bail('did not receive init within 5s: ' + e.message);
  }
  assert('received init', !!initMsg);
  assert('init.meta exists', !!(initMsg && initMsg.meta));
  assert('init.meta.cmuxAvailable === true',
    initMsg && initMsg.meta && initMsg.meta.cmuxAvailable === true);
  assert('init.meta.cmuxSurfaceId present',
    initMsg && initMsg.meta && typeof initMsg.meta.cmuxSurfaceId === 'string'
      && initMsg.meta.cmuxSurfaceId.length > 0);

  // Snapshot index — we'll watch for new frames after this point.
  const sendIdx = api.received.length;

  // ---- 5. send a comment line ----
  const probeText = '# claude-web smoke (no-op)\n';
  api.sendMsg({ type: 'send', text: probeText });
  log('sent {type:send, text: ' + JSON.stringify(probeText) + '}');

  // ---- 6. Wait 2s for any error ----
  log('waiting 2s for error events…');
  await sleep(2000);
  const errorsAfterSend = api.received.slice(sendIdx).filter(m => m && m.type === 'error');
  if (errorsAfterSend.length) {
    log('  saw error: ' + JSON.stringify(errorsAfterSend[0]));
  }
  assert('no error event after send', errorsAfterSend.length === 0);

  // ---- 7. Optional: positive signal ----
  log('listening 3s for any echo events (best-effort)…');
  const watchIdx = api.received.length;
  await sleep(3000);
  const newFrames = api.received.slice(watchIdx).filter(m => m && m.type !== '__parse_error__');
  log('  new ws frames received: ' + newFrames.length);
  if (newFrames.length) {
    const types = newFrames.map(m => m.type);
    log('  types: ' + JSON.stringify(types));
  } else {
    log('  (none — claude TUI may be buffering, not a failure)');
  }

  // ---- 8. send_key escape ----
  const keyIdx = api.received.length;
  api.sendMsg({ type: 'send_key', key: 'escape' });
  log('sent {type:send_key, key:escape}');
  await sleep(1500);
  const errorsAfterKey = api.received.slice(keyIdx).filter(m => m && m.type === 'error');
  if (errorsAfterKey.length) {
    log('  saw error: ' + JSON.stringify(errorsAfterKey[0]));
  }
  assert('no error event after send_key', errorsAfterKey.length === 0);

  // ---- 9. Close ----
  api.close();
  log('closed');

  log('==========================================');
  log('Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failed === 0) {
    log('PASS');
    process.exit(0);
  } else {
    log('FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write('[smoke] Unhandled error: ' + (err.stack || err.message) + '\n');
  process.exit(1);
});
