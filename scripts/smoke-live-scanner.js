'use strict';

/**
 * Smoke test for the live session scanner (PR-E1).
 *
 *   1. Hits GET /api/sessions?include=local with a valid auth cookie.
 *   2. Validates the response is { managed: Array, localActive: Array }.
 *   3. Prints the top 5 entries from localActive.
 *   4. Sanity-asserts shape and presence.
 *   5. Calls liveSessionScanner.scanLive() directly and validates parity.
 *
 * Usage: node scripts/smoke-live-scanner.js
 */

const http = require('http');
const store = require('../auth/store');
const liveSessionScanner = require('../lib/liveSessionScanner');

const HOST = process.env.WOTM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WOTM_PORT, 10) || 3700;

// ---------------------------------------------------------------------------
// Tiny test rig
// ---------------------------------------------------------------------------

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

function preview(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== smoke-live-scanner ===');
  log('server: http://' + HOST + ':' + PORT + '/api/sessions?include=local');

  const token = findValidToken();
  if (!token) {
    process.stderr.write(
      '\n[smoke] No valid session found in ~/.wotm/data.json.\n' +
      'Please log in via the browser first, then re-run this script.\n\n'
    );
    process.exit(1);
  }
  log('session token: ' + token.slice(0, 8) + '...');

  // -----------------------------------------------------------------------
  // 1. HTTP API
  // -----------------------------------------------------------------------
  let resp;
  try {
    resp = await httpGet({
      hostname: HOST,
      port: PORT,
      path: '/api/sessions?include=local',
      method: 'GET',
      headers: { Cookie: 'claudeweb_session=' + token }
    });
  } catch (e) {
    bail('HTTP request failed: ' + e.message);
  }

  assert('HTTP 200', resp.status === 200);

  let payload;
  try {
    payload = JSON.parse(resp.body);
  } catch (e) {
    bail('response is not valid JSON: ' + e.message);
  }

  assert('payload is an object',
    payload && typeof payload === 'object' && !Array.isArray(payload));
  assert('payload.managed is array', Array.isArray(payload && payload.managed));
  assert('payload.localActive is array', Array.isArray(payload && payload.localActive));

  if (!Array.isArray(payload.localActive)) {
    bail('cannot continue — localActive is not an array');
  }

  const localActive = payload.localActive;
  assert('localActive has >= 1 entry', localActive.length >= 1);

  // -----------------------------------------------------------------------
  // 2. Print top 3 (with cmux fields)
  // -----------------------------------------------------------------------
  log('\nTop 3 localActive entries:');
  const top3 = localActive.slice(0, 3);
  for (const e of top3) {
    const sid = e.sessionId ? e.sessionId.slice(0, 8) : '(none)';
    log('  pid=' + e.pid +
        ' sid=' + sid +
        ' src=' + e.source +
        ' busy=' + e.busy +
        ' idle=' + e.idleSeconds + 's' +
        ' cmuxAvail=' + e.cmuxAvailable +
        ' wsId=' + (e.cmuxWorkspaceId ? e.cmuxWorkspaceId.slice(0, 8) : 'null') +
        ' sfId=' + (e.cmuxSurfaceId ? e.cmuxSurfaceId.slice(0, 8) : 'null') +
        ' cwd=' + e.cwd +
        ' lastUser=' + JSON.stringify(preview(e.lastUserText, 60)));
  }

  // -----------------------------------------------------------------------
  // 3. Shape assertions
  // -----------------------------------------------------------------------
  let shapeOk = true;
  let badField = '';
  for (const e of localActive) {
    if (typeof e.pid !== 'number') { shapeOk = false; badField = 'pid'; break; }
    if (typeof e.cwd !== 'string') { shapeOk = false; badField = 'cwd@pid=' + e.pid; break; }
    if (e.source !== 'cmux' && e.source !== 'terminal') {
      shapeOk = false; badField = 'source=' + e.source + '@pid=' + e.pid; break;
    }
    if (e.sessionId !== null && typeof e.sessionId !== 'string') {
      shapeOk = false; badField = 'sessionId@pid=' + e.pid; break;
    }
    if (typeof e.busy !== 'boolean') {
      shapeOk = false; badField = 'busy@pid=' + e.pid; break;
    }
    if (typeof e.idleSeconds !== 'number') {
      shapeOk = false; badField = 'idleSeconds@pid=' + e.pid; break;
    }
    if (e.lastUserText !== null && (typeof e.lastUserText !== 'string' || e.lastUserText.length > 80)) {
      shapeOk = false; badField = 'lastUserText@pid=' + e.pid; break;
    }
    if (e.lastAssistantText !== null && (typeof e.lastAssistantText !== 'string' || e.lastAssistantText.length > 80)) {
      shapeOk = false; badField = 'lastAssistantText@pid=' + e.pid; break;
    }
    // PR-F2: cmux fields must be present
    if (typeof e.cmuxAvailable !== 'boolean') {
      shapeOk = false; badField = 'cmuxAvailable@pid=' + e.pid; break;
    }
    if (e.cmuxWorkspaceId !== null && typeof e.cmuxWorkspaceId !== 'string') {
      shapeOk = false; badField = 'cmuxWorkspaceId@pid=' + e.pid; break;
    }
    if (e.cmuxSurfaceId !== null && typeof e.cmuxSurfaceId !== 'string') {
      shapeOk = false; badField = 'cmuxSurfaceId@pid=' + e.pid; break;
    }
  }
  assert('all entries have valid shape' + (shapeOk ? '' : ' (' + badField + ')'), shapeOk);

  const withSession = localActive.filter(e => e.sessionId);
  assert('at least one entry has non-null sessionId', withSession.length >= 1);

  // PR-F2: cmuxAvailable counts from HTTP path (server may not be inside cmux)
  const withCmuxAvailHttp = localActive.filter(e => e.cmuxAvailable === true);
  const withTerminal = localActive.filter(e => e.source === 'terminal');
  const withCmux = localActive.filter(e => e.source === 'cmux');
  log('\nsource breakdown: cmux=' + withCmux.length + ' terminal=' + withTerminal.length);
  log('cmux mapping (HTTP): cmuxAvailable=true count=' + withCmuxAvailHttp.length);
  if (withCmuxAvailHttp.length === 0) {
    log('  note: server process may not be inside cmux (LaunchAgent runs outside cmux)');
    log('  cmuxAvailable=true will be verified on the direct call below');
  }

  // -----------------------------------------------------------------------
  // 4. Direct module call
  // -----------------------------------------------------------------------
  log('\nDirect liveSessionScanner.scanLive() …');
  liveSessionScanner.invalidateCache();
  let direct;
  try {
    direct = await liveSessionScanner.scanLive();
  } catch (e) {
    bail('direct scanLive() threw: ' + (e.stack || e.message));
  }
  assert('direct scanLive returns array', Array.isArray(direct));
  assert('direct scanLive non-empty', direct.length >= 1);

  let directShapeOk = true;
  for (const e of direct) {
    if (typeof e.pid !== 'number') { directShapeOk = false; break; }
    if (typeof e.cwd !== 'string') { directShapeOk = false; break; }
    if (e.source !== 'cmux' && e.source !== 'terminal') { directShapeOk = false; break; }
    if (typeof e.cmuxAvailable !== 'boolean') { directShapeOk = false; break; }
  }
  assert('direct entries have valid shape (incl cmux fields)', directShapeOk);

  // PR-F2: at least one direct entry must have cmuxAvailable=true.
  // The direct call runs in the terminal process (inside cmux), so it CAN
  // access the cmux socket. The server/HTTP path may be outside cmux.
  const withCmuxAvailDirect = direct.filter(e => e.cmuxAvailable === true);
  log('\ncmux mapping (direct): cmuxAvailable=true count=' + withCmuxAvailDirect.length);
  if (withCmuxAvailDirect.length === 0) {
    // Diagnostic: print cwds from live sessions and workspaces seen
    log('  DIAGNOSTIC: no cmuxAvailable=true entries found');
    log('  live session cwds: ' + direct.map(e => e.cwd).join(', '));
  }
  assert('direct: at least one entry has cmuxAvailable=true (9 cmux workspaces on this Mac)',
    withCmuxAvailDirect.length >= 1);

  // PIDs from the direct call should overlap heavily with the HTTP call;
  // they are not required to be identical because new processes can spawn
  // between calls.
  const httpPids = new Set(localActive.map(e => e.pid));
  const directPids = new Set(direct.map(e => e.pid));
  let overlap = 0;
  for (const p of httpPids) if (directPids.has(p)) overlap++;
  assert('HTTP and direct overlap on >= 1 pid', overlap >= 1);

  // -----------------------------------------------------------------------
  // 5. Summary
  // -----------------------------------------------------------------------
  log('\n==========================================');
  log('Results: ' + passed + ' passed, ' + failed + ' failed');
  log('localActive count: ' + localActive.length);
  log('direct count:      ' + direct.length);
  log('overlap:           ' + overlap);
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
