'use strict';

/**
 * Smoke test for GET /api/sessions
 *
 * Usage: node scripts/smoke-sessions-api.js
 *
 * Reads an existing valid session token from the on-disk store (same approach
 * as smoke-chat-ws.js). Requires the server to be running.
 */

const http = require('http');
const path = require('path');
const store = require('../auth/store');

const HOST = process.env.CLAUDE_WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.CLAUDE_WEB_PORT, 10) || 3700;

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
// Find a valid session token
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
// Simple HTTP GET helper
// ---------------------------------------------------------------------------

function httpGet(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== smoke-sessions-api ===');
  log('server: http://' + HOST + ':' + PORT + '/api/sessions');

  // 1. Get token
  const token = findValidToken();
  if (!token) {
    process.stderr.write(
      '\n[smoke] No valid session found in ~/.claude-web/data.json.\n' +
      'Please log in via the browser first, then re-run this script.\n\n'
    );
    process.exit(1);
  }
  log('session token: ' + token.slice(0, 8) + '...');

  // 2. GET /api/sessions
  let resp;
  try {
    resp = await httpGet({
      hostname: HOST,
      port: PORT,
      path: '/api/sessions',
      method: 'GET',
      headers: { Cookie: 'claudeweb_session=' + token }
    });
  } catch (e) {
    bail('HTTP request failed: ' + e.message);
  }

  // 3. Assert HTTP 200
  assert('HTTP 200', resp.status === 200);

  // 4. Parse JSON
  let items;
  try {
    items = JSON.parse(resp.body);
  } catch (e) {
    bail('response is not valid JSON: ' + e.message);
  }
  assert('response is an array', Array.isArray(items));

  if (!Array.isArray(items)) {
    bail('cannot continue — response is not an array');
  }

  // 5. At least one item
  assert('at least one item (~/Code/ has directories)', items.length > 0);

  // 6. Shape validation on each item
  let shapeOk = true;
  for (const item of items) {
    if (typeof item.name !== 'string') { shapeOk = false; break; }
    if (item.sessionId !== null && typeof item.sessionId !== 'string') { shapeOk = false; break; }
    if (item.lastUsedAt !== null && typeof item.lastUsedAt !== 'string') { shapeOk = false; break; }
    if (item.lastUserText !== null && typeof item.lastUserText !== 'string') { shapeOk = false; break; }
    if (item.lastAssistantText !== null && typeof item.lastAssistantText !== 'string') { shapeOk = false; break; }
    if (typeof item.busy !== 'boolean') { shapeOk = false; break; }
    if (typeof item.hasMessages !== 'boolean') { shapeOk = false; break; }
    if (typeof item.messageCount !== 'number') { shapeOk = false; break; }
    if (item.lastUserText !== null && item.lastUserText.length > 80) { shapeOk = false; break; }
    if (item.lastAssistantText !== null && item.lastAssistantText.length > 80) { shapeOk = false; break; }
  }
  assert('all items have correct shape', shapeOk);

  // 7. Sort order: items with lastUsedAt !== null come before null
  let sortOk = true;
  let seenNull = false;
  for (const item of items) {
    if (item.lastUsedAt === null) {
      seenNull = true;
    } else if (seenNull) {
      // Found a non-null after a null — sort is wrong
      sortOk = false;
      break;
    }
  }
  assert('sorted: lastUsedAt non-null before null', sortOk);

  // 8. Print top 3
  log('\nTop 3 sessions:');
  const top3 = items.slice(0, 3);
  for (const item of top3) {
    log('  name=' + item.name +
        ' lastUsedAt=' + (item.lastUsedAt || 'null') +
        ' busy=' + item.busy +
        ' lastUserText=' + JSON.stringify(item.lastUserText || ''));
  }

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
