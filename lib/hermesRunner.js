'use strict';

/**
 * hermesRunner — spawn `hermes chat -q PROMPT -Q --pass-session-id ...` per
 * user turn and surface its events to the chat WebSocket layer using the
 * same event union that claudeRunner / codexRunner emit.
 *
 * Hermes behavior (verified against /Users/ys/.local/bin/hermes):
 *
 *   stdout (-Q quiet mode + --pass-session-id):
 *     session_id: <id>
 *     <final assistant text>
 *
 *   On disk: hermes writes events to ~/.hermes/sessions/<id>.jsonl while
 *   the process runs. We detect that file by diffing the directory listing
 *   before vs. after spawn, then tail it for tool_use / tool_result /
 *   assistant_thinking events that don't appear on stdout.
 *
 * Why node-pty: hermes pulls in a rich CLI library that detects TTY for
 * spinner/progress output. -Q suppresses spinners, but several internal
 * paths still call isatty(); spawning through a PTY guarantees consistent
 * behaviour across installs.
 */

const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const hermesNormalizer = require('./hermesJsonlNormalizer');

const HERMES_BIN  = '/Users/ys/.local/bin/hermes';
const SESSIONS_DIR = path.join(os.homedir(), '.hermes', 'sessions');
const SIGKILL_DELAY_MS = 2000;
const STDOUT_MAX_BYTES = 1 * 1024 * 1024;
const TAIL_POLL_MS = 500;

const SESSION_ID_LINE = /^session_id:\s+([0-9]{8}_[0-9]{6}_[0-9a-f]{6,8})\s*$/m;

function listOpenJsonls() {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR); } catch (_) { return new Set(); }
  const out = new Set();
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    if (name.startsWith('session_')) continue;
    out.add(name);
  }
  return out;
}

/**
 * Spawn a single hermes turn.
 *
 * Required: opts.prompt (string), opts.cwd (string).
 * Optional: opts.sessionId (resume), opts.signal (AbortSignal).
 *
 * Returns an EventEmitter that emits:
 *   'event' { kind: 'init', sessionId, cwd, model, tools:[], skills:[], agents:[], plugins:[] }
 *   'event' { kind: 'assistant_text' | 'assistant_thinking' | 'tool_use' | 'tool_result' | 'unknown' | 'parse_error' | 'stderr_tail', ... }
 *   'event' { kind: 'result', sessionId, isError, finalText, terminalReason, durationMs, ... }
 *   'error' (Error)
 *   'exit'  { code, signal, sessionId, durationMs }
 */
function runHermes(opts) {
  const { prompt, cwd, sessionId = null, signal = null } = opts || {};

  if (!prompt || typeof prompt !== 'string') {
    throw new TypeError('runHermes: opts.prompt must be a non-empty string');
  }
  if (!cwd || typeof cwd !== 'string') {
    throw new TypeError('runHermes: opts.cwd must be a non-empty string');
  }

  const emitter = new EventEmitter();

  const args = ['chat', '-q', prompt, '-Q', '--pass-session-id', '--source', 'wotm'];
  if (sessionId) args.push('--resume', sessionId);

  const env = Object.assign({}, process.env, {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    SHELL: process.env.SHELL || '/bin/sh',
    TERM: 'xterm-256color',
    NO_COLOR: '1'
  });

  // Snapshot the directory before spawn so we can identify the new jsonl.
  const preExistingJsonls = listOpenJsonls();

  let child;
  try {
    child = pty.spawn(HERMES_BIN, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env
    });
  } catch (err) {
    process.nextTick(() => emitter.emit('error', err));
    return emitter;
  }

  const startTs = Date.now();

  let stdoutBuf = '';
  let detectedSessionId = sessionId || null;
  let initEmitted = false;
  let resolvedJsonlPath = null;
  let jsonlTailOffset = 0;
  let jsonlPartial = '';
  let tailTimer = null;
  let exited = false;

  function maybeEmitInit(sid) {
    if (initEmitted || !sid) return;
    initEmitted = true;
    emitter.emit('event', {
      kind: 'init',
      sessionId: sid,
      cwd,
      model: null,
      tools: [],
      skills: [],
      agents: [],
      plugins: []
    });
  }

  // ── Resolve the jsonl path for this run ─────────────────────────────
  function resolveJsonlForThisRun() {
    if (resolvedJsonlPath) return resolvedJsonlPath;

    // Easy case: --resume with known sid; hermes writes to <sid>.jsonl.
    if (detectedSessionId) {
      const candidate = path.join(SESSIONS_DIR, detectedSessionId + '.jsonl');
      if (fs.existsSync(candidate)) {
        resolvedJsonlPath = candidate;
        return resolvedJsonlPath;
      }
    }

    // Otherwise, diff against pre-spawn listing.
    const current = listOpenJsonls();
    for (const name of current) {
      if (preExistingJsonls.has(name)) continue;
      // Found a new jsonl — assume it's ours.
      resolvedJsonlPath = path.join(SESSIONS_DIR, name);
      const sid = name.slice(0, -'.jsonl'.length);
      if (!detectedSessionId) {
        detectedSessionId = sid;
        maybeEmitInit(sid);
      }
      return resolvedJsonlPath;
    }
    return null;
  }

  function tailJsonlOnce() {
    const p = resolveJsonlForThisRun();
    if (!p) return;
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    const size = st.size;
    if (size <= jsonlTailOffset) return;

    let fd = -1;
    try {
      fd = fs.openSync(p, 'r');
      const len = size - jsonlTailOffset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, jsonlTailOffset);
      if (read <= 0) return;
      const chunk = buf.slice(0, read).toString('utf8');
      const combined = jsonlPartial + chunk;
      const lines = combined.split('\n');
      let trailing = '';
      if (combined.length > 0 && combined[combined.length - 1] !== '\n') {
        trailing = lines.pop() || '';
      } else {
        lines.pop();
      }
      for (const line of lines) {
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch (_) { continue; }
        const events = hermesNormalizer.normalizeEntry(raw);
        for (const ev of events) emitter.emit('event', ev);
      }
      jsonlPartial = trailing;
      jsonlTailOffset = size - Buffer.byteLength(trailing, 'utf8');
    } catch (_) {
      // ignore; next tick re-tries
    } finally {
      if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }

  tailTimer = setInterval(tailJsonlOnce, TAIL_POLL_MS);
  if (tailTimer.unref) tailTimer.unref();

  // ── pty data → stdout buffer ────────────────────────────────────────
  child.onData((data) => {
    if (typeof data !== 'string') data = data.toString('utf8');
    if (stdoutBuf.length < STDOUT_MAX_BYTES) {
      stdoutBuf += data;
      if (stdoutBuf.length > STDOUT_MAX_BYTES) {
        stdoutBuf = stdoutBuf.slice(0, STDOUT_MAX_BYTES);
      }
    }

    // Pull the session_id line out as soon as it appears.
    if (!initEmitted) {
      const m = SESSION_ID_LINE.exec(stdoutBuf);
      if (m) {
        const sid = m[1];
        detectedSessionId = sid;
        maybeEmitInit(sid);
        // Try resolving the jsonl path now that we have the sid.
        resolveJsonlForThisRun();
      }
    }
  });

  // ── pty exit ────────────────────────────────────────────────────────
  child.onExit(({ exitCode, signal: sig }) => {
    exited = true;
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
    // One last tail pass to catch any final events.
    try { tailJsonlOnce(); } catch (_) {}

    const durationMs = Date.now() - startTs;

    // Parse final assistant text out of stdout: everything after the
    // session_id line.
    let finalText = '';
    const sidMatch = SESSION_ID_LINE.exec(stdoutBuf);
    if (sidMatch) {
      const after = stdoutBuf.slice(sidMatch.index + sidMatch[0].length);
      finalText = after.replace(/\r/g, '').trim();
    } else {
      finalText = stdoutBuf.replace(/\r/g, '').trim();
    }

    if (!initEmitted && detectedSessionId) {
      maybeEmitInit(detectedSessionId);
    }

    // Emit the assistant text only if the jsonl tail didn't already carry
    // it — but we don't know that for sure, so always emit. Duplicates are
    // de-noised by the chat UI (same messageId/blockIndex would dedupe; we
    // use null/0 so this can produce a duplicate). Net effect: the final
    // line in stdout is the canonical answer; if the tailer also surfaced
    // it, the UI sees two consecutive assistant_text events. Keep it
    // simple and drop stdout-derived assistant_text when the tailer fired
    // at least one assistant event.
    const emittedAssistantViaTail = (function() {
      // We don't track this precisely; conservatively assume tail was used
      // when the resolved jsonl path exists and is non-empty.
      if (!resolvedJsonlPath) return false;
      try { return fs.statSync(resolvedJsonlPath).size > 0; }
      catch (_) { return false; }
    })();

    if (finalText && !emittedAssistantViaTail) {
      emitter.emit('event', {
        kind: 'assistant_text',
        messageId: null,
        text: finalText,
        blockIndex: 0
      });
    }

    const isError = (exitCode != null && exitCode !== 0);

    emitter.emit('event', {
      kind: 'result',
      sessionId: detectedSessionId,
      isError,
      costUsd: null,
      durationMs,
      numTurns: null,
      finalText: finalText || null,
      terminalReason: isError ? 'hermes_error' : 'hermes_done',
      usage: null
    });

    emitter.emit('exit', {
      code: exitCode == null ? 0 : exitCode,
      signal: sig || null,
      sessionId: detectedSessionId,
      durationMs
    });
  });

  // ── abort signal ────────────────────────────────────────────────────
  if (signal) {
    const onAbort = () => {
      if (exited) return;
      try { child.kill('SIGINT'); } catch (_) {}
      const timer = setTimeout(() => {
        if (!exited) { try { child.kill('SIGKILL'); } catch (_) {} }
      }, SIGKILL_DELAY_MS);
      if (timer.unref) timer.unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    emitter.once('exit', () => signal.removeEventListener('abort', onAbort));
  }

  return emitter;
}

module.exports = { runHermes };
