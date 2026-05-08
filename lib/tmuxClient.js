'use strict';

/**
 * tmuxClient — thin wrapper around the tmux CLI for pane discovery and input
 * forwarding. No npm deps — stdlib + execFile only.
 *
 * Usage (singleton):
 *   const tmux = require('./lib/tmuxClient');
 *   const sockets = tmux.resolveSocketPaths();
 *   const panes   = await tmux.listPanes(sockets[0]);
 *   await tmux.sendText(sockets[0], '%17', 'hello\n');
 *
 * Usage (factory, e.g. for tests):
 *   const { createClient } = require('./lib/tmuxClient');
 *   const client = createClient();
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// TmuxError
// ---------------------------------------------------------------------------

class TmuxError extends Error {
  constructor(code, message, raw) {
    super(message);
    this.name = 'TmuxError';
    this.code = code;
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const PANE_ID_RE = /^%\d+$/;

// Keys the UI is allowed to forward. Maps wotm key name → tmux key name.
const ALLOWED_KEYS = {
  'enter':   'Enter',
  'escape':  'Escape',
  'ctrl-c':  'C-c',
  'ctrl-d':  'C-d',
  'tab':     'Tab',
  'up':      'Up',
  'down':    'Down',
  'left':    'Left',
  'right':   'Right',
};

// Format string for list-panes — keep stable so parseLine() is correct.
const LIST_PANES_FORMAT =
  '#{pane_id}|#{pane_pid}|#{pane_tty}|#{session_name}|' +
  '#{window_index}|#{pane_index}|#{pane_current_command}';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout != null ? String(stdout) : '', stderr: stderr != null ? String(stderr) : '' });
    });
  });
}

/**
 * Parse a single list-panes output line into a pane descriptor.
 * Returns null on malformed lines.
 */
function parsePaneLine(line) {
  if (!line) return null;
  const parts = line.split('|');
  // We expect exactly 7 fields; allow extra pipe characters inside command.
  if (parts.length < 7) return null;
  const [paneId, panePidRaw, paneTty, sessionName, windowIndexRaw, paneIndexRaw, ...cmdParts] = parts;
  const currentCommand = cmdParts.join('|');
  const panePid = parseInt(panePidRaw, 10);
  const windowIndex = parseInt(windowIndexRaw, 10);
  const paneIndex = parseInt(paneIndexRaw, 10);
  if (!paneId || !PANE_ID_RE.test(paneId)) return null;
  return { paneId, panePid, paneTty, sessionName, windowIndex, paneIndex, currentCommand };
}

/**
 * Validate that socketPath is an absolute path that exists (resolving symlinks).
 * Throws TmuxError on failure.
 */
function validateSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) {
    throw new TmuxError('invalid_socket', 'socketPath must be an absolute path');
  }
  try {
    fs.realpathSync(socketPath); // resolves symlinks; throws if missing
  } catch (e) {
    throw new TmuxError('invalid_socket', 'socketPath does not exist: ' + socketPath, e);
  }
}

// ---------------------------------------------------------------------------
// Top-level functions (also used as singleton methods)
// ---------------------------------------------------------------------------

/**
 * resolveSocketPaths() — synchronous.
 * Returns an array of /tmp/tmux-<uid>/* socket file paths that exist and are
 * Unix sockets. Defensive: the dir may not exist if tmux has never run.
 */
function resolveSocketPaths() {
  const uid = process.getuid();
  const tmuxDir = path.join('/tmp', 'tmux-' + uid);
  let entries;
  try {
    entries = fs.readdirSync(tmuxDir, { withFileTypes: true });
  } catch (_) {
    return []; // dir absent — tmux never started, or already cleaned up
  }
  const results = [];
  for (const e of entries) {
    const full = path.join(tmuxDir, e.name);
    try {
      const st = fs.statSync(full);
      if (st.isSocket()) results.push(full);
    } catch (_) { /* skip */ }
  }
  return results;
}

/**
 * listPanes(socketPath) — async.
 * Runs `tmux -S <socket> list-panes -aF <format>` and parses each line.
 * Returns [] on non-zero exit (e.g. tmux server not running anymore).
 */
async function listPanes(socketPath) {
  try {
    const { stdout } = await execP(
      'tmux',
      ['-S', socketPath, 'list-panes', '-a', '-F', LIST_PANES_FORMAT],
      { timeout: 1000 }
    );
    const lines = stdout.split('\n');
    const panes = [];
    for (const line of lines) {
      const p = parsePaneLine(line.trim());
      if (p) panes.push(p);
    }
    return panes;
  } catch (_) {
    // tmux server not running, socket stale, or process killed — soft failure
    return [];
  }
}

// Counter for unique buffer names within this process.
let _bufCounter = 0;

/**
 * sendText(socketPath, paneId, text) — async.
 * Loads text into a named tmux buffer, then pastes it into the target pane.
 * Strategy: load-buffer (via stdin) → paste-buffer -d.
 */
async function sendText(socketPath, paneId, text) {
  if (typeof text !== 'string') {
    throw new TmuxError('invalid_text', 'text must be a string');
  }
  if (!PANE_ID_RE.test(paneId)) {
    throw new TmuxError('invalid_pane_id', 'paneId must match /^%\\d+$/');
  }
  validateSocketPath(socketPath);

  const bufName = 'wotm-' + process.pid + '-' + (_bufCounter++);

  // Step 1: load-buffer from stdin
  await new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-S', socketPath, 'load-buffer', '-b', bufName, '-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(new TmuxError('spawn_error', 'load-buffer spawn failed: ' + err.message, err)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new TmuxError('load_buffer_failed', 'tmux load-buffer exited ' + code + ': ' + stderr.trim()));
      } else {
        resolve();
      }
    });
    child.stdin.write(text);
    child.stdin.end();
  });

  // Step 2: paste-buffer -d (deletes buffer on paste)
  try {
    await execP('tmux', ['-S', socketPath, 'paste-buffer', '-d', '-b', bufName, '-t', paneId], { timeout: 2000 });
  } catch (err) {
    // Best-effort cleanup in case paste-buffer left the buffer behind
    execFile('tmux', ['-S', socketPath, 'delete-buffer', '-b', bufName], () => {});
    throw new TmuxError('paste_buffer_failed', 'tmux paste-buffer failed: ' + (err.message || String(err)), err);
  }
}

/**
 * sendKey(socketPath, paneId, key) — async.
 * Sends a named key to the target pane.
 */
async function sendKey(socketPath, paneId, key) {
  if (!PANE_ID_RE.test(paneId)) {
    throw new TmuxError('invalid_pane_id', 'paneId must match /^%\\d+$/');
  }
  const mappedKey = ALLOWED_KEYS[key];
  if (!mappedKey) {
    throw new TmuxError('invalid_key', 'key must be one of: ' + Object.keys(ALLOWED_KEYS).join(', '));
  }
  validateSocketPath(socketPath);

  try {
    await execP('tmux', ['-S', socketPath, 'send-keys', '-t', paneId, mappedKey], { timeout: 2000 });
  } catch (err) {
    throw new TmuxError('send_keys_failed', 'tmux send-keys failed: ' + (err.message || String(err)), err);
  }
}

// ---------------------------------------------------------------------------
// Client factory (matches cmuxClient.createClient convention)
// ---------------------------------------------------------------------------

function createClient() {
  return {
    resolveSocketPaths,
    listPanes,
    sendText,
    sendKey,
  };
}

// ---------------------------------------------------------------------------
// Singleton default export
// ---------------------------------------------------------------------------

const singleton = createClient();

module.exports = singleton;
module.exports.createClient = createClient;
module.exports.TmuxError = TmuxError;
module.exports.resolveSocketPaths = resolveSocketPaths;
