'use strict';

/**
 * Smoke test for the /ws/chat WebSocket endpoint.
 *
 * Usage: node scripts/smoke-chat-ws.js [project-name]
 *
 * Requires a valid session cookie. This script reads from auth/store.js
 * directly — the server holds sessions in memory (loaded at startup from disk).
 * If the server was started before this script creates a session, the session
 * won't be known to the server. Therefore, this script looks for an EXISTING
 * valid session already in the data file (i.e., one created when you last
 * logged in via the browser). If none is found, it prints instructions.
 */

const path = require('path');
const WebSocket = require('ws');
const store = require('../auth/store');

const HOST = process.env.CLAUDE_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CLAUDE_WEB_PORT, 10) || 3700;
const PROJECT = process.argv[2] || 'claude-web';
const TIMEOUT_MS = 120000; // 2 minutes per phase

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write('[smoke] ' + msg + '\n');
}

function bail(msg) {
  process.stderr.write('[smoke] FATAL: ' + msg + '\n');
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
// Find an existing valid session from the on-disk store
// ---------------------------------------------------------------------------

function findValidToken() {
  store.loadSync();
  const data = store.getData();
  const now = Date.now();
  const sessions = (data.sessions || []).filter(s => Date.parse(s.expiresAt) > now);
  if (!sessions.length) return null;
  // Return the most recently created one
  sessions.sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  return sessions[0].token;
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

/**
 * Connect to the WS endpoint with cookie auth and return a promise that
 * resolves to { ws, waitForType, sendMsg, close }.
 *
 * waitForType(type, filter?, timeoutMs?) — resolves with first matching msg.
 * sendMsg(obj) — sends JSON.
 * close() — closes the connection.
 */
function connect(token) {
  return new Promise((resolve, reject) => {
    const wsUrl = 'ws://' + HOST + ':' + PORT + '/ws/chat';
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: 'claudeweb_session=' + token }
    });

    const pending = []; // [{type, filter, resolve, reject, timer, fromIndex}]
    const received = []; // all received messages in order

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
        /**
         * Wait for the next message of `type` (with optional filter) that
         * arrives at or after position `fromIndex` in the received array
         * (defaults to current end of received — i.e., only future messages).
         */
        waitForType(type, filter, timeoutMs, fromIndex) {
          timeoutMs = timeoutMs || TIMEOUT_MS;
          if (fromIndex === undefined) fromIndex = received.length;
          return new Promise((res, rej) => {
            // Check already-received messages from fromIndex onward
            for (let i = fromIndex; i < received.length; i++) {
              const m = received[i];
              if (m.type === type && (!filter || filter(m))) {
                res(m);
                return;
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
        sendMsg(obj) {
          ws.send(JSON.stringify(obj));
        },
        close() {
          ws.close();
        }
      };
      resolve(api);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch (e) { msg = { type: '__parse_error__', raw: raw.toString('utf8') }; }
      dispatch(msg);
    });

    ws.on('error', (err) => {
      reject(err);
    });

    ws.on('close', (code, reason) => {
      // Reject any outstanding pending waiters
      for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('ws closed code=' + code + ' reason=' + reason));
      }
      pending.length = 0;
    });
  });
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  log('=== smoke-chat-ws ===');
  log('project: ' + PROJECT);
  log('server:  ws://' + HOST + ':' + PORT + '/ws/chat');

  // ---- 1. Get session token ----
  const token = findValidToken();
  if (!token) {
    process.stderr.write(
      '\n[smoke] No valid session found in ~/.claude-web/data.json.\n' +
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

  // ---- 4. Expect history ----
  let historyMsg;
  try {
    historyMsg = await api.waitForType('history');
  } catch (e) {
    bail('did not receive history: ' + e.message);
  }
  assert('received history message', !!historyMsg);
  assert('history.messages is array', Array.isArray(historyMsg.messages));
  assert('history.busy is boolean', typeof historyMsg.busy === 'boolean');
  log('history: sessionId=' + historyMsg.sessionId + ' messages=' + historyMsg.messages.length + ' busy=' + historyMsg.busy);

  // If currently busy, wait for idle before proceeding
  if (historyMsg.busy) {
    log('server is busy — waiting for idle state...');
    try {
      await api.waitForType('state', (m) => m.busy === false);
    } catch (e) {
      bail('timed out waiting for idle: ' + e.message);
    }
  }

  // ---- 5. Send first prompt ----
  log('\n=== Phase 1: send prompt ===');
  const p1Start = api.received.length; // snapshot index before sending
  api.sendMsg({ type: 'send', text: 'Reply with exactly: pong' });
  log('sent: "Reply with exactly: pong"');

  // Expect state busy=true (only from p1Start onward)
  try {
    await api.waitForType('state', (m) => m.busy === true, TIMEOUT_MS, p1Start);
    log('got state busy=true');
  } catch (e) {
    bail('did not get busy=true: ' + e.message);
  }

  // Expect init event with sessionId
  let initEvt;
  try {
    initEvt = await api.waitForType('event', (m) => m.kind === 'init', TIMEOUT_MS, p1Start);
  } catch (e) {
    bail('did not get init event: ' + e.message);
  }
  assert('phase1: received init event', !!initEvt);
  assert('phase1: init.sessionId present', !!(initEvt && initEvt.sessionId));
  log('init sessionId=' + (initEvt && initEvt.sessionId));

  // Wait for result
  let resultEvt1;
  try {
    resultEvt1 = await api.waitForType('event', (m) => m.kind === 'result', TIMEOUT_MS, p1Start);
  } catch (e) {
    bail('did not get result event: ' + e.message);
  }
  assert('phase1: received result event', !!resultEvt1);

  // Collect assistant_text events in the p1Start..now range
  const p1End = api.received.length;
  const textEvts1 = api.received.slice(p1Start, p1End).filter(m => m.type === 'event' && m.kind === 'assistant_text');
  assert('phase1: at least one assistant_text', textEvts1.length > 0);
  const fullText1 = textEvts1.map(m => m.text || '').join('');
  assert('phase1: response contains "pong"', /pong/i.test(fullText1));
  log('phase1 assistant_text: ' + JSON.stringify(fullText1.trim().slice(0, 100)));

  // Wait for state idle
  try {
    await api.waitForType('state', (m) => m.busy === false, TIMEOUT_MS, p1Start);
    log('got state busy=false');
  } catch (e) {
    bail('did not get busy=false after result: ' + e.message);
  }
  assert('phase1: state busy=false received', true);

  // ---- 6. Send second prompt (memory test) ----
  log('\n=== Phase 2: memory test ===');
  const p2Start = api.received.length; // snapshot index before phase 2
  api.sendMsg({ type: 'send', text: 'What word did you just say? Reply with one word.' });
  log('sent: "What word did you just say? Reply with one word."');

  // Wait for busy (only from p2Start onward)
  try {
    await api.waitForType('state', (m) => m.busy === true, 10000, p2Start);
  } catch (e) {
    bail('did not get busy=true for phase2: ' + e.message);
  }

  // Wait for result
  let resultEvt2;
  try {
    resultEvt2 = await api.waitForType('event', (m) => m.kind === 'result', TIMEOUT_MS, p2Start);
  } catch (e) {
    bail('did not get result event for phase2: ' + e.message);
  }
  assert('phase2: received result event', !!resultEvt2);

  // Collect assistant_text events in the p2Start..now range
  const p2End = api.received.length;
  const textEvts2 = api.received.slice(p2Start, p2End).filter(m => m.type === 'event' && m.kind === 'assistant_text');
  const fullText2 = textEvts2.map(m => m.text || '').join('');
  assert('phase2: at least one assistant_text', textEvts2.length > 0);
  assert('phase2: response contains "pong" (session memory retained)', /pong/i.test(fullText2));
  log('phase2 assistant_text: ' + JSON.stringify(fullText2.trim().slice(0, 100)));

  // Wait for idle
  try {
    await api.waitForType('state', (m) => m.busy === false, TIMEOUT_MS, p2Start);
  } catch (e) {
    bail('phase2: did not get busy=false: ' + e.message);
  }

  // ---- 7. newChat ----
  log('\n=== Phase 3: newChat ===');
  const p3Start = api.received.length;
  api.sendMsg({ type: 'newChat' });
  log('sent: newChat');

  let newHistory;
  try {
    newHistory = await api.waitForType('history', (m) => m.sessionId === null, 10000, p3Start);
  } catch (e) {
    bail('did not get history{sessionId:null} after newChat: ' + e.message);
  }
  assert('phase3: received history with sessionId=null', newHistory && newHistory.sessionId === null);
  assert('phase3: history.messages is empty', newHistory && Array.isArray(newHistory.messages) && newHistory.messages.length === 0);
  log('newChat history: sessionId=' + newHistory.sessionId + ' messages=' + (newHistory && newHistory.messages.length));

  // ---- 8. Clean close ----
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
  process.stderr.write('[smoke] Unhandled error: ' + (err.stack || err.message) + '\n');
  process.exit(1);
});
