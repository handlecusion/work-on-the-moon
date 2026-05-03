'use strict';

/**
 * Smoke test for the auth-swap WS plumbing.
 *
 * SAFE: Does NOT actually log out or trigger auth login.
 * Tests: authStatus WS round-trip, getStatus() direct call, authSwapCancel no-op.
 *
 * Usage: node scripts/smoke-auth-swap.js [project-name]
 */

const path = require('path');
const WebSocket = require('ws');
const store = require('../auth/store');
const swapper = require('../lib/authSwapper');

const HOST = process.env.WOTM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WOTM_PORT, 10) || 3700;
const PROJECT = process.argv[2] || 'work-on-the-moon';
const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write('[smoke-auth] ' + msg + '\n');
}

function bail(msg) {
  process.stderr.write('[smoke-auth] FATAL: ' + msg + '\n');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    log('  PASS: ' + label);
    passed++;
  } else {
    log('  FAIL: ' + label);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Find existing valid session token
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WS connect helper (same pattern as smoke-chat-ws.js)
// ---------------------------------------------------------------------------

function connect(token) {
  return new Promise((resolve, reject) => {
    const wsUrl = 'ws://' + HOST + ':' + PORT + '/ws/chat';
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
          timeoutMs = timeoutMs || TIMEOUT_MS;
          if (fromIndex === undefined) fromIndex = received.length;
          return new Promise((res, rej) => {
            for (let i = fromIndex; i < received.length; i++) {
              const m = received[i];
              if (m.type === type && (!filter || filter(m))) { res(m); return; }
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

    ws.on('error', reject);

    ws.on('close', (code, reason) => {
      for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('ws closed code=' + code + ' reason=' + reason));
      }
      pending.length = 0;
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== smoke-auth-swap ===');
  log('project: ' + PROJECT);
  log('server:  ws://' + HOST + ':' + PORT + '/ws/chat');

  // ---- 1. Find session token ----
  const token = findValidToken();
  if (!token) {
    process.stderr.write(
      '\n[smoke-auth] No valid session found in ~/.wotm/data.json.\n' +
      'Please log in via the browser first, then re-run this script.\n\n'
    );
    process.exit(1);
  }
  log('session token: ' + token.slice(0, 8) + '...');

  // ---- 2. Connect ----
  let api;
  try {
    api = await connect(token);
  } catch (e) {
    bail('connect failed: ' + e.message);
  }
  log('connected');

  // ---- 3. Send hello ----
  api.sendMsg({ type: 'hello', project: PROJECT });
  log('sent hello project=' + PROJECT);

  // Wait for history
  let historyMsg;
  try {
    historyMsg = await api.waitForType('history');
  } catch (e) {
    bail('did not receive history: ' + e.message);
  }
  assert('received history message', !!historyMsg);

  // ---- 4. Expect auto auth_status after hello ----
  let autoAuthStatus;
  try {
    // It may already be in received (sent after history) — look from index 0
    autoAuthStatus = await api.waitForType('event', (m) => m.kind === 'auth_status', TIMEOUT_MS, 0);
  } catch (e) {
    bail('did not receive auto auth_status after hello: ' + e.message);
  }
  assert('auto auth_status received after hello', !!autoAuthStatus);
  assert('auto auth_status loggedIn === true', autoAuthStatus && autoAuthStatus.loggedIn === true);
  assert('auto auth_status email is string', autoAuthStatus && typeof autoAuthStatus.email === 'string');
  if (autoAuthStatus) {
    log('auto auth_status email: ' + autoAuthStatus.email);
  }

  // ---- 5. Send authStatus request ----
  log('\n=== Phase: authStatus request ===');
  const beforeAuthReq = api.received.length;
  api.sendMsg({ type: 'authStatus' });
  log('sent: authStatus');

  let authStatusEvt;
  try {
    authStatusEvt = await api.waitForType('event', (m) => m.kind === 'auth_status', TIMEOUT_MS, beforeAuthReq);
  } catch (e) {
    bail('did not receive auth_status event: ' + e.message);
  }
  assert('auth_status event received', !!authStatusEvt);
  assert('auth_status.loggedIn === true', authStatusEvt && authStatusEvt.loggedIn === true);
  assert('auth_status.email is a string', authStatusEvt && typeof authStatusEvt.email === 'string');
  if (authStatusEvt) {
    log('WS auth_status email: ' + authStatusEvt.email);
  }

  // ---- 6. Direct getStatus() call ----
  log('\n=== Phase: direct getStatus() ===');
  let directStatus;
  try {
    directStatus = await swapper.getStatus();
  } catch (e) {
    bail('getStatus() threw: ' + e.message);
  }
  assert('direct getStatus() loggedIn === true', directStatus && directStatus.loggedIn === true);
  assert('direct getStatus() email is string', directStatus && typeof directStatus.email === 'string');

  // Verify consistency between direct call and WS event
  if (authStatusEvt && directStatus) {
    assert(
      'WS auth_status.email matches direct getStatus().email',
      authStatusEvt.email === directStatus.email
    );
  }
  if (directStatus) {
    log('direct getStatus() email: ' + directStatus.email);
  }

  // ---- 7. authSwapCancel no-op (nothing in progress) ----
  log('\n=== Phase: authSwapCancel no-op ===');
  const beforeCancel = api.received.length;
  api.sendMsg({ type: 'authSwapCancel' });
  log('sent: authSwapCancel (should be no-op — no swap in progress)');

  // Should receive auth_swap_phase: cancelled without crash
  let cancelEvt;
  try {
    cancelEvt = await api.waitForType('event', (m) => m.kind === 'auth_swap_phase' && m.phase === 'cancelled', 5000, beforeCancel);
  } catch (e) {
    bail('authSwapCancel did not produce auth_swap_phase: ' + e.message);
  }
  assert('authSwapCancel produced auth_swap_phase:cancelled', cancelEvt && cancelEvt.phase === 'cancelled');
  assert('authSwapCancel event has correct kind', cancelEvt && cancelEvt.kind === 'auth_swap_phase');

  // ---- 8. Close ----
  api.close();
  log('closed');

  // ---- Summary ----
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
  process.stderr.write('[smoke-auth] Unhandled error: ' + (err.stack || err.message) + '\n');
  process.exit(1);
});
