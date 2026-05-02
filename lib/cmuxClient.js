'use strict';

/**
 * cmuxClient — Node.js client for the cmux v2 Unix-socket JSON-line IPC.
 *
 * Protocol: line-delimited JSON-RPC over an AF_UNIX socket.
 *   Request:  {"id":<num>,"method":"<dotted.name>","params":{...}}\n
 *   Response: {"id":<num>,"ok":true,"result":{...}}\n
 *   Error:    {"id":<num>,"ok":false,"error":{"code":"...","message":"..."}}\n
 *
 * Usage (singleton):
 *   const cmux = require('./lib/cmuxClient');
 *   await cmux.connect();
 *   await cmux.ping();
 *
 * Usage (factory, e.g. for tests):
 *   const { createClient } = require('./lib/cmuxClient');
 *   const client = createClient({ socketPath: '/tmp/cmux.sock' });
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// CmuxError
// ---------------------------------------------------------------------------

class CmuxError extends Error {
  constructor(code, message, raw) {
    super(message);
    this.name = 'CmuxError';
    this.code = code;
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Socket path discovery
// ---------------------------------------------------------------------------

const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'cmux');

/**
 * resolveSocketPath() — sync, returns string path or null.
 *
 * Priority (matches official Python wrapper):
 *  1. CMUX_SOCKET_PATH env var (if file exists OR non-standard path)
 *  2. ~/Library/Application Support/cmux/last-socket-path (text file)
 *  3. /tmp/cmux-last-socket-path (text file)
 *  4. Known candidates
 *  5. Glob /tmp/cmux-debug-*.sock and ~/Library/.../cmux*.sock — pick newest
 */
function resolveSocketPath() {
  // 1. Env override
  const envPath = process.env.CMUX_SOCKET_PATH;
  if (envPath) {
    if (!envPath.startsWith('/tmp/cmux') && !envPath.startsWith(APP_SUPPORT_DIR)) {
      // non-standard path — trust it regardless
      return envPath;
    }
    if (_fileExists(envPath)) return envPath;
  }

  // 2. last-socket-path in app support
  const appSupportPointer = path.join(APP_SUPPORT_DIR, 'last-socket-path');
  const p2 = _readPointerFile(appSupportPointer);
  if (p2 && _fileExists(p2)) return p2;

  // 3. /tmp/cmux-last-socket-path
  const p3 = _readPointerFile('/tmp/cmux-last-socket-path');
  if (p3 && _fileExists(p3)) return p3;

  // 4. Known static candidates
  const candidates = [
    '/tmp/cmux-debug.sock',
    path.join(APP_SUPPORT_DIR, 'cmux.sock'),
    '/tmp/cmux.sock',
  ];
  for (const c of candidates) {
    if (_fileExists(c)) return c;
  }

  // 5. Glob — pick newest mtime
  const globCandidates = _globSocks();
  if (globCandidates.length > 0) {
    globCandidates.sort((a, b) => b.mtime - a.mtime);
    return globCandidates[0].p;
  }

  return null;
}

function _fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function _readPointerFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

function _globSocks() {
  const results = [];

  // /tmp/cmux-debug-*.sock
  try {
    for (const entry of fs.readdirSync('/tmp')) {
      if (/^cmux-debug-.+\.sock$/.test(entry)) {
        const full = path.join('/tmp', entry);
        try { results.push({ p: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
      }
    }
  } catch { /* /tmp not readable */ }

  // ~/Library/Application Support/cmux/cmux*.sock
  try {
    for (const entry of fs.readdirSync(APP_SUPPORT_DIR)) {
      if (/^cmux.*\.sock$/.test(entry)) {
        const full = path.join(APP_SUPPORT_DIR, entry);
        try { results.push({ p: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
      }
    }
  } catch { /* dir not readable */ }

  return results;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function createClient(opts) {
  opts = opts || {};

  const events = new EventEmitter();
  let socketPath = opts.socketPath || null; // null = lazy-resolve on connect
  let socket = null;
  let connected = false;
  let recvBuf = '';
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function _dispatch(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      console.error('[cmux] unparseable line:', line.slice(0, 200));
      return;
    }
    const id = msg.id;
    if (id == null) return; // unsolicited notification — ignore for now

    const entry = pending.get(id);
    if (!entry) return; // stale / unknown id

    clearTimeout(entry.timer);
    pending.delete(id);

    if (msg.ok === true) {
      entry.resolve(msg.result);
    } else {
      const err = msg.error || {};
      entry.reject(new CmuxError(err.code || 'unknown', err.message || 'unknown error', msg));
    }
  }

  function _onData(chunk) {
    recvBuf += chunk;
    let nl;
    while ((nl = recvBuf.indexOf('\n')) !== -1) {
      const line = recvBuf.slice(0, nl).trim();
      recvBuf = recvBuf.slice(nl + 1);
      if (line.length > 0) _dispatch(line);
    }
  }

  function _rejectAll(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new CmuxError('disconnected', reason || 'socket closed'));
    }
    pending.clear();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function isConnected() { return connected; }

  async function connect() {
    if (connected) return;

    const sp = socketPath || resolveSocketPath();
    if (!sp) {
      throw new CmuxError('not_running', 'cmux socket not found — is cmux running?');
    }
    if (!_fileExists(sp)) {
      throw new CmuxError('not_running', `cmux socket not found at ${sp}`);
    }

    socketPath = sp; // cache for reconnect info

    await new Promise((resolve, reject) => {
      const s = net.createConnection({ path: sp }, () => {
        socket = s;
        connected = true;
        recvBuf = '';
        nextId = 1;
        console.log(`[cmux] connected to ${sp}`);
        events.emit('connected');
        resolve();
      });

      s.setEncoding('utf8');

      const connectTimer = setTimeout(() => {
        s.destroy();
        reject(new CmuxError('timeout', `connect timeout to ${sp}`));
      }, 5000);

      s.once('connect', () => clearTimeout(connectTimer));

      s.on('data', _onData);

      s.on('close', () => {
        if (connected) {
          connected = false;
          socket = null;
          console.log('[cmux] disconnected');
          _rejectAll('socket closed unexpectedly');
          events.emit('disconnected');
        }
      });

      s.on('error', (err) => {
        clearTimeout(connectTimer);
        if (!connected) {
          reject(new CmuxError('connect_error', err.message, err));
        } else {
          console.error('[cmux]', err);
          events.emit('error', err);
        }
      });
    });
  }

  async function close() {
    if (!socket) return;
    const s = socket;
    connected = false;
    socket = null;
    _rejectAll('client closed');
    await new Promise((resolve) => {
      s.once('close', resolve);
      s.destroy();
    });
    console.log('[cmux] connection closed by client');
  }

  async function call(method, params, callOpts) {
    if (!connected) throw new CmuxError('not_connected', 'not connected to cmux');

    callOpts = callOpts || {};
    const timeoutMs = typeof callOpts.timeoutMs === 'number' ? callOpts.timeoutMs : 10000;
    const id = nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CmuxError('timeout', `call timeout: ${method} (id=${id})`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ id, method, params: params || {} }) + '\n';
      socket.write(msg);
    });
  }

  // -------------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------------

  async function ping() {
    const result = await call('system.ping');
    return result && result.pong === true;
  }

  async function identify() {
    return call('system.identify');
  }

  async function listWindows() {
    const result = await call('window.list');
    return result.windows || [];
  }

  async function listWorkspaces(windowId) {
    const params = windowId ? { window_id: windowId } : {};
    const result = await call('workspace.list', params);
    const workspaces = result.workspaces || [];
    // Non-destructive camelCase alias for current_directory
    return workspaces.map((ws) => {
      if (ws.current_directory != null && ws.currentDirectory == null) {
        return Object.assign({}, ws, { currentDirectory: ws.current_directory });
      }
      return ws;
    });
  }

  async function currentWorkspace() {
    const result = await call('workspace.current');
    return result.workspace_id || null;
  }

  async function listSurfaces(workspaceId) {
    const params = workspaceId ? { workspace_id: workspaceId } : {};
    const result = await call('surface.list', params);
    const surfaces = result.surfaces || [];
    // Normalize snake_case fields to camelCase aliases (non-destructive)
    return surfaces.map((s) => {
      const extra = {};
      if (s.pane_id != null && s.paneId == null) extra.paneId = s.pane_id;
      if (s.pane_ref != null && s.paneRef == null) extra.paneRef = s.pane_ref;
      if (s.index_in_pane != null && s.indexInPane == null) extra.indexInPane = s.index_in_pane;
      if (s.selected_in_pane != null && s.selectedInPane == null) extra.selectedInPane = s.selected_in_pane;
      return Object.keys(extra).length > 0 ? Object.assign({}, s, extra) : s;
    });
  }

  async function sendText(surfaceId, text) {
    const params = { text };
    if (surfaceId != null) params.surface_id = surfaceId;
    await call('surface.send_text', params);
  }

  async function sendKey(surfaceId, key) {
    const params = { key };
    if (surfaceId != null) params.surface_id = surfaceId;
    await call('surface.send_key', params);
  }

  async function readText(surfaceId) {
    const params = {};
    if (surfaceId != null) params.surface_id = surfaceId;
    const result = await call('surface.read_text', params);
    return result.text || '';
  }

  return {
    events,
    resolveSocketPath,
    isConnected,
    connect,
    close,
    call,
    ping,
    identify,
    listWindows,
    listWorkspaces,
    currentWorkspace,
    listSurfaces,
    sendText,
    sendKey,
    readText,
  };
}

// ---------------------------------------------------------------------------
// Singleton default export
// ---------------------------------------------------------------------------

const _singleton = createClient();

module.exports = _singleton;
module.exports.CmuxError = CmuxError;
module.exports.createClient = createClient;
module.exports.resolveSocketPath = resolveSocketPath;
