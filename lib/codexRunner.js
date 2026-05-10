'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const os = require('os');

const CODEX_BIN = '/opt/homebrew/bin/codex';
const STDERR_MAX_BYTES = 8 * 1024;
const SIGKILL_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Event classification
// Actual codex --json JSONL shapes (verified against real output):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"...","type":"command_execution",...}}
//   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"id":"...","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,...}}
// ---------------------------------------------------------------------------

function classify(raw, ctx) {
  const type = raw.type;

  if (type === 'thread.started') {
    // session identity
    if (raw.thread_id) ctx.sessionId = raw.thread_id;
    return {
      kind: 'init',
      sessionId: raw.thread_id || null,
      cwd: ctx.cwd,
      model: null,
      tools: [],
      skills: [],
      agents: [],
      plugins: []
    };
  }

  if (type === 'turn.started') {
    return null; // not useful to consumers
  }

  if (type === 'item.started') {
    // In-progress tool execution — drop; item.completed carries the result
    return null;
  }

  if (type === 'item.completed') {
    const item = raw.item || {};
    const itemType = item.type;

    if (itemType === 'agent_message') {
      return {
        kind: 'assistant_text',
        messageId: item.id || null,
        text: item.text || '',
        blockIndex: 0
      };
    }

    if (itemType === 'command_execution') {
      // Emit as tool_use + tool_result pair so the UI can show what ran
      return [
        {
          kind: 'tool_use',
          toolUseId: item.id || null,
          name: 'shell',
          input: { command: item.command || '' }
        },
        {
          kind: 'tool_result',
          toolUseId: item.id || null,
          content: item.aggregated_output || '',
          isError: item.exit_code !== 0 && item.exit_code != null
        }
      ];
    }

    // Unknown item type — surface it
    return { kind: 'unknown', raw };
  }

  if (type === 'turn.completed') {
    // usage carries token counts; emit as result
    const usage = raw.usage || {};
    ctx.turnCompleted = true;
    return {
      kind: 'result',
      sessionId: ctx.sessionId,
      isError: false,
      costUsd: null,
      durationMs: null, // filled in at exit
      numTurns: null,
      finalText: null,
      terminalReason: 'codex_done',
      usage: {
        inputTokens: usage.input_tokens || 0,
        cachedInputTokens: usage.cached_input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      }
    };
  }

  // Anything else — don't swallow
  return { kind: 'unknown', raw };
}

// ---------------------------------------------------------------------------
// runCodex
// ---------------------------------------------------------------------------

function runCodex(opts) {
  const { prompt, cwd, sessionId = null, signal = null } = opts || {};

  if (!prompt || typeof prompt !== 'string') {
    throw new TypeError('runCodex: opts.prompt must be a non-empty string');
  }
  if (!cwd || typeof cwd !== 'string') {
    throw new TypeError('runCodex: opts.cwd must be a non-empty string');
  }

  const emitter = new EventEmitter();

  // Build args.
  // New session:  codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C <cwd> <prompt>
  // Resume:       codex exec resume <sessionId> --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C <cwd> <prompt>
  const commonFlags = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C', cwd
  ];

  const args = sessionId
    ? ['exec', 'resume', sessionId, ...commonFlags, prompt]
    : ['exec', ...commonFlags, prompt];

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    LOGNAME: process.env.LOGNAME || os.userInfo().username,
    SHELL: process.env.SHELL || '/bin/sh'
  };

  // Mutable context shared with classify()
  const ctx = { sessionId: sessionId || null, cwd, turnCompleted: false };

  let child;
  try {
    child = spawn(CODEX_BIN, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    process.nextTick(() => emitter.emit('error', err));
    return emitter;
  }

  const startTs = Date.now();

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

    const classified = classify(raw, ctx);
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

    if (stderrBuf.byteLength > 0) {
      const text = stderrBuf.toString('utf8');
      // codex always prints "Reading additional input from stdin..." to stderr —
      // suppress that noise; surface everything else.
      if (text.trim() !== 'Reading additional input from stdin...') {
        emitter.emit('event', { kind: 'stderr_tail', text });
      }
    }

    emitter.emit('exit', {
      code,
      signal: sig,
      sessionId: ctx.sessionId,
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
      if (timer.unref) timer.unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => signal.removeEventListener('abort', onAbort));
  }

  return emitter;
}

module.exports = { runCodex };
