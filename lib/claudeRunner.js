'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const os = require('os');

const STDERR_MAX_BYTES = 8 * 1024;
const SIGKILL_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

function classify(raw) {
  const type = raw.type;

  if (type === 'system') {
    const sub = raw.subtype;
    if (sub === 'hook_started' || sub === 'hook_response') {
      return null; // filtered
    }
    if (sub === 'init') {
      return {
        kind: 'init',
        sessionId: raw.session_id || null,
        cwd: raw.cwd || null,
        model: raw.model || null,
        tools: raw.tools || [],
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        agents: Array.isArray(raw.agents) ? raw.agents : [],
        plugins: Array.isArray(raw.plugins) ? raw.plugins : []
      };
    }
    if (sub === 'notification') {
      return {
        kind: 'system_notification',
        message: raw.notification != null
          ? (typeof raw.notification === 'string' ? raw.notification : JSON.stringify(raw.notification))
          : JSON.stringify(raw)
      };
    }
    return { kind: 'unknown', raw };
  }

  if (type === 'rate_limit_event') {
    return { kind: 'rate_limit', ...raw };
  }

  if (type === 'assistant') {
    const msg = raw.message || {};
    const msgId = msg.id || null;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const events = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || !block.type) continue;
      if (block.type === 'text') {
        events.push({ kind: 'assistant_text', messageId: msgId, text: block.text || '', blockIndex: i });
      } else if (block.type === 'thinking') {
        events.push({ kind: 'assistant_thinking', messageId: msgId, text: block.thinking || block.text || '', blockIndex: i });
      } else if (block.type === 'tool_use') {
        events.push({ kind: 'tool_use', messageId: msgId, toolUseId: block.id || null, name: block.name || null, input: block.input, blockIndex: i });
      } else {
        events.push({ kind: 'unknown', raw: block });
      }
    }
    return events.length > 0 ? events : null;
  }

  if (type === 'user') {
    const msg = raw.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const events = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || !block.type) continue;
      if (block.type === 'tool_result') {
        events.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id || null,
          content: block.content,
          isError: block.is_error === true,
          blockIndex: i
        });
      } else {
        events.push({ kind: 'unknown', raw: block });
      }
    }
    return events.length > 0 ? events : null;
  }

  if (type === 'result') {
    return {
      kind: 'result',
      sessionId: raw.session_id || null,
      isError: raw.is_error === true,
      costUsd: raw.total_cost_usd != null ? raw.total_cost_usd : null,
      durationMs: raw.duration_ms != null ? raw.duration_ms : null,
      numTurns: raw.num_turns != null ? raw.num_turns : null,
      finalText: raw.result || null,
      terminalReason: raw.subtype || raw.terminal_reason || null
    };
  }

  return { kind: 'unknown', raw };
}

// ---------------------------------------------------------------------------
// runClaude
// ---------------------------------------------------------------------------

function runClaude(opts) {
  const { prompt, cwd, sessionId = null, signal = null } = opts || {};

  if (!prompt || typeof prompt !== 'string') {
    throw new TypeError('runClaude: opts.prompt must be a non-empty string');
  }
  if (!cwd || typeof cwd !== 'string') {
    throw new TypeError('runClaude: opts.cwd must be a non-empty string');
  }

  const emitter = new EventEmitter();

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(sessionId ? ['--resume', sessionId] : [])
  ];

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    SHELL: process.env.SHELL || '/bin/sh'
  };

  let child;
  try {
    child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    // spawn() itself threw (rare; usually ENOENT comes from child.on('error'))
    process.nextTick(() => emitter.emit('error', err));
    return emitter;
  }

  const startTs = Date.now();
  let initSessionId = null;
  let resultSessionId = null;

  // --- stderr buffer (rolling, max STDERR_MAX_BYTES) ---
  let stderrBuf = Buffer.alloc(0);
  child.stderr.on('data', (chunk) => {
    stderrBuf = Buffer.concat([stderrBuf, chunk]);
    if (stderrBuf.byteLength > STDERR_MAX_BYTES) {
      stderrBuf = stderrBuf.slice(stderrBuf.byteLength - STDERR_MAX_BYTES);
    }
  });

  // --- stdout line-by-line ---
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let raw;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      emitter.emit('event', { kind: 'parse_error', raw: line, message: err.message });
      return;
    }

    // Cache session IDs
    if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) {
      initSessionId = raw.session_id;
    }
    if (raw.type === 'result' && raw.session_id) {
      resultSessionId = raw.session_id;
    }

    const classified = classify(raw);
    if (classified === null) return; // filtered

    if (Array.isArray(classified)) {
      for (const evt of classified) {
        emitter.emit('event', evt);
      }
    } else {
      emitter.emit('event', classified);
    }
  });

  // --- child error (e.g. ENOENT) ---
  child.on('error', (err) => {
    emitter.emit('error', err);
  });

  // --- child exit ---
  child.on('close', (code, sig) => {
    const durationMs = Date.now() - startTs;
    const resolvedSessionId = initSessionId || resultSessionId || null;

    if (stderrBuf.byteLength > 0) {
      emitter.emit('event', { kind: 'stderr_tail', text: stderrBuf.toString('utf8') });
    }

    emitter.emit('exit', {
      code,
      signal: sig,
      sessionId: resolvedSessionId,
      durationMs
    });
  });

  // --- abort signal ---
  if (signal) {
    const onAbort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGINT');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, SIGKILL_DELAY_MS);
      // Don't keep the process alive for this timer
      if (timer.unref) timer.unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => signal.removeEventListener('abort', onAbort));
  }

  return emitter;
}

module.exports = { runClaude };
