'use strict';

/**
 * authSwapper.js — manages a single in-flight `claude auth login` PTY session.
 *
 * Exports: { events, start, submitCode, cancel, getStatus, getState }
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude'; // fall through to PATH lookup
}

const CLAUDE_BIN = resolveClaudeBin();
const PTY_COLS = 120;
const PTY_ROWS = 30;
const PTY_TERM = 'xterm-256color';
const BUFFER_MAX_BYTES = 64 * 1024;      // 64 KB rolling buffer
const TIMEOUT_MS = 30 * 60 * 1000;       // 30 minutes
const SIGKILL_DELAY_MS = 2000;

const SPAWN_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME || os.homedir(),
  USER: process.env.USER || os.userInfo().username,
  LOGNAME: process.env.LOGNAME || os.userInfo().username,
  SHELL: process.env.SHELL || '/bin/sh'
};

// ---------------------------------------------------------------------------
// ANSI strip helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const URL_RE = /(https:\/\/(?:claude\.com|platform\.claude\.com)\/[^\s]+)/;
const PASTE_CODE_RE = /Paste code here[^>]*>\s*$/m;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const events = new EventEmitter();

let _phase = 'idle';   // 'idle'|'starting'|'awaiting_code'|'verifying'|'done'|'failed'|'cancelled'
let _mode = null;
let _urlSeen = null;
let _errorMessage = null;

let _ptyProcess = null;
let _buffer = '';           // raw PTY output (rolling, capped at BUFFER_MAX_BYTES chars)
let _urlEmitted = false;
let _promptEmitted = false;
let _hardTimeout = null;
let _sigkillTimer = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _setState(phase, extra) {
  _phase = phase;
  if (extra && 'mode' in extra) _mode = extra.mode;
  if (extra && 'urlSeen' in extra) _urlSeen = extra.urlSeen;
  if (extra && 'errorMessage' in extra) _errorMessage = extra.errorMessage;
}

function _appendBuffer(chunk) {
  _buffer += chunk;
  // Rolling trim: keep last BUFFER_MAX_BYTES characters
  if (_buffer.length > BUFFER_MAX_BYTES) {
    _buffer = _buffer.slice(_buffer.length - BUFFER_MAX_BYTES);
  }
}

function _cleanup() {
  if (_hardTimeout) { clearTimeout(_hardTimeout); _hardTimeout = null; }
  if (_sigkillTimer) { clearTimeout(_sigkillTimer); _sigkillTimer = null; }
  _ptyProcess = null;
  _urlEmitted = false;
  _promptEmitted = false;
  _buffer = '';
}

// ---------------------------------------------------------------------------
// getStatus — non-interactive, uses execFile
// ---------------------------------------------------------------------------

function getStatus() {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ['auth', 'status', '--json'],
      { env: SPAWN_ENV, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          resolve({ loggedIn: false, raw: null });
          return;
        }
        let parsed;
        try { parsed = JSON.parse(stdout); }
        catch (_) { resolve({ loggedIn: false, raw: null }); return; }

        resolve({
          loggedIn: parsed.loggedIn === true,
          email: parsed.email || undefined,
          orgName: parsed.orgName || undefined,
          subscriptionType: parsed.subscriptionType || undefined,
          authMethod: parsed.authMethod || undefined,
          apiProvider: parsed.apiProvider || undefined,
          raw: parsed
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------

function getState() {
  return {
    phase: _phase,
    mode: _mode || undefined,
    urlSeen: _urlSeen || undefined,
    errorMessage: _errorMessage || undefined
  };
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

function cancel() {
  if (!_ptyProcess) {
    // Nothing in flight — safe no-op
    _setState('cancelled');
    events.emit('cancelled');
    return;
  }

  _setState('cancelled');

  const proc = _ptyProcess;
  _cleanup();

  try { proc.kill('SIGINT'); } catch (_) {}

  _sigkillTimer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }, SIGKILL_DELAY_MS);
  if (_sigkillTimer.unref) _sigkillTimer.unref();

  events.emit('cancelled');
}

// ---------------------------------------------------------------------------
// submitCode
// ---------------------------------------------------------------------------

function submitCode(code) {
  if (_phase !== 'awaiting_code' || !_ptyProcess) {
    return false;
  }

  _setState('verifying');

  try {
    _ptyProcess.write(code + '\r');
  } catch (err) {
    console.error('[authSwapper] submitCode write error:', err);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// _runLogout — best-effort, non-interactive
// ---------------------------------------------------------------------------

function _runLogout() {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ['auth', 'logout'],
      { env: SPAWN_ENV, timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn('[authSwapper] logout failed (ignored):', err.message);
          events.emit('output', { data: '[logout failed: ' + err.message + ']\r\n' });
        } else {
          const out = (stdout || '') + (stderr || '');
          if (out) events.emit('output', { data: '[logout] ' + out });
        }
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start({ mode, email } = {}) {
  // Single-flight guard
  if (_phase !== 'idle' && _phase !== 'done' && _phase !== 'failed' && _phase !== 'cancelled') {
    throw new Error('authSwapper: swap already in progress (phase=' + _phase + ')');
  }

  // Reset state for fresh run
  _setState('starting', { mode: mode || 'claudeai', urlSeen: null, errorMessage: null });
  _urlEmitted = false;
  _promptEmitted = false;
  _buffer = '';

  // --- Step 1: best-effort logout ---
  await _runLogout();

  // --- Step 2: build login args ---
  const loginArgs = ['auth', 'login'];
  if (mode === 'console') {
    loginArgs.push('--console');
  } else {
    loginArgs.push('--claudeai');
  }
  if (email && typeof email === 'string' && email.trim()) {
    loginArgs.push('--email', email.trim());
  }

  // --- Step 3: spawn PTY ---
  let proc;
  try {
    proc = pty.spawn(CLAUDE_BIN, loginArgs, {
      name: PTY_TERM,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      env: SPAWN_ENV,
      cwd: process.env.HOME || os.homedir()
    });
  } catch (err) {
    _setState('failed', { errorMessage: err.message });
    events.emit('done', { success: false, error: err.message });
    return;
  }

  _ptyProcess = proc;

  // 30-minute hard timeout
  _hardTimeout = setTimeout(() => {
    console.warn('[authSwapper] 30-minute timeout — cancelling');
    cancel();
  }, TIMEOUT_MS);
  if (_hardTimeout.unref) _hardTimeout.unref();

  // --- PTY data ---
  proc.onData((chunk) => {
    events.emit('output', { data: chunk });

    _appendBuffer(chunk);
    const clean = stripAnsi(_buffer);

    // URL extraction (once)
    if (!_urlEmitted) {
      const m = URL_RE.exec(clean);
      if (m) {
        _urlEmitted = true;
        _urlSeen = m[1];
        events.emit('url', { url: m[1] });
      }
    }

    // Paste-code prompt (once, only after URL seen)
    if (_urlEmitted && !_promptEmitted) {
      // Check the last 512 chars of clean buffer for the prompt
      const tail = clean.slice(-512);
      if (PASTE_CODE_RE.test(tail)) {
        _promptEmitted = true;
        _setState('awaiting_code');
        events.emit('prompt', { kind: 'paste_code' });
      }
    }
  });

  // --- PTY exit ---
  proc.onExit(({ exitCode, signal: sig }) => {
    const wasProc = _ptyProcess === proc;
    if (!wasProc) return; // already cleaned up (e.g. cancel)

    _cleanup();

    if (_phase === 'cancelled') {
      // cancel() already handled this
      return;
    }

    if (exitCode === 0 && sig == null) {
      _setState('done');
      getStatus().then((status) => {
        events.emit('done', { success: true, status });
      });
    } else {
      // scrape last 1KB of buffer for error message
      const errText = _buffer.slice(-1024);
      _setState('failed', { errorMessage: stripAnsi(errText) });
      events.emit('done', { success: false, error: stripAnsi(errText) });
    }
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  events,
  start,
  submitCode,
  cancel,
  getStatus,
  getState
};
