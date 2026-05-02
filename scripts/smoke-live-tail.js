'use strict';

/**
 * Smoke test for /ws/live (PR-E2 live attach).
 *
 *   1. Pick a sessionId from liveSessionScanner.scanLive() — most-recent
 *      lastActivityTs.
 *   2. Read an existing valid session token from on-disk data store.
 *   3. Connect to ws://127.0.0.1:3700/ws/live with cookie auth.
 *   4. Send {type:'hello', sessionId}.
 *   5. Expect 'init' within 5s. Assert meta.sessionId matches and
 *      transcript is an array.
 *   6. Expect at least 1 normalized event in init.transcript.
 *   7. Wait up to 10s for a meta_update (periodic poll). Allow no-op if
 *      file is quiet.
 *   8. Close cleanly.
 *
 * Usage: node scripts/smoke-live-tail.js
 */

const WebSocket = require('ws');
const store = require('../auth/store');
const liveSessionScanner = require('../lib/liveSessionScanner');

const HOST = process.env.CLAUDE_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CLAUDE_WEB_PORT, 10) || 3700;

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

function pickSessionId(list) {
  if (!Array.isArray(list)) return null;
  const candidates = list.filter(e => e && e.sessionId && e.jsonlPath);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ta = a.lastActivityTs ? Date.parse(a.lastActivityTs) : -Infinity;
    const tb = b.lastActivityTs ? Date.parse(b.lastActivityTs) : -Infinity;
    return tb - ta;
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
        close() { ws.close(); }
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

async function main() {
  log('=== smoke-live-tail ===');
  log('server: ws://' + HOST + ':' + PORT + '/ws/live');

  // ---- 1. Find a session ----
  log('scanning live sessions…');
  let live;
  try {
    live = await liveSessionScanner.scanLive();
  } catch (e) {
    bail('scanLive failed: ' + e.message);
  }
  log('localActive count: ' + live.length);

  const target = pickSessionId(live);
  if (!target) {
    bail('no live session with sessionId+jsonlPath found — start a Claude CLI session first');
  }
  log('target sessionId: ' + target.sessionId);
  log('target cwd:       ' + target.cwd);
  log('target source:    ' + target.source);
  log('target busy:      ' + target.busy);

  // ---- 2. Token ----
  const token = findValidToken();
  if (!token) {
    bail('no valid auth session — log in via browser first');
  }
  log('session token: ' + token.slice(0, 8) + '...');

  // ---- 3. Connect ----
  let api;
  try {
    api = await connect(token);
  } catch (e) {
    bail('connect failed: ' + e.message);
  }
  log('connected');

  // ---- 4. Hello ----
  api.sendMsg({ type: 'hello', sessionId: target.sessionId });
  log('sent hello sessionId=' + target.sessionId);

  // ---- 5. Init ----
  let initMsg;
  try {
    initMsg = await api.waitForType('init', null, 5000);
  } catch (e) {
    bail('did not receive init within 5s: ' + e.message);
  }
  assert('received init message', !!initMsg);
  assert('init has meta', !!(initMsg && initMsg.meta));
  assert('init.meta.sessionId matches',
    initMsg && initMsg.meta && initMsg.meta.sessionId === target.sessionId);
  assert('init.transcript is array', Array.isArray(initMsg && initMsg.transcript));

  // ---- 6. Transcript content ----
  const transcript = (initMsg && initMsg.transcript) || [];
  log('transcript length: ' + transcript.length);
  assert('init.transcript has >= 1 entry', transcript.length >= 1);

  if (transcript.length) {
    const sample = transcript[0];
    assert('transcript[0] has kind', !!(sample && sample.kind));
    log('  first kind: ' + (sample && sample.kind));
    const kinds = {};
    for (const ev of transcript) {
      kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
    }
    log('  kind histogram: ' + JSON.stringify(kinds));
  }

  // ---- 7. Wait for meta_update or accept no-op ----
  log('waiting up to 12s for meta_update (periodic 10s poll)…');
  let metaUpdate = null;
  try {
    metaUpdate = await api.waitForType('meta_update', null, 12000);
  } catch (_) {
    log('  no meta_update within 12s (file is quiet — acceptable)');
  }
  if (metaUpdate) {
    assert('meta_update has busy boolean', typeof metaUpdate.busy === 'boolean');
    assert('meta_update has idleSeconds', typeof metaUpdate.idleSeconds === 'number' || metaUpdate.idleSeconds === null);
    log('  meta_update: busy=' + metaUpdate.busy + ' idle=' + metaUpdate.idleSeconds + 's pid=' + metaUpdate.pid);
  } else {
    log('  (no-op accepted)');
  }

  // ---- 8. Close ----
  api.close();
  log('closed');

  log('\n==========================================');
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
