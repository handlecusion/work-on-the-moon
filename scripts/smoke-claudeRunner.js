'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runClaude } = require('../lib/claudeRunner');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(msg + '\n');
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-smoke-'));
  return dir;
}

function runTurn(opts) {
  return new Promise((resolve, reject) => {
    const runner = runClaude(opts);
    const events = [];
    let exitInfo = null;

    runner.on('event', (evt) => {
      log('  [event] kind=' + evt.kind + (evt.text ? ' text=' + JSON.stringify(evt.text.slice(0, 80)) : '') + (evt.sessionId ? ' sessionId=' + evt.sessionId : ''));
      events.push(evt);
    });

    runner.on('error', (err) => {
      reject(err);
    });

    runner.on('exit', (info) => {
      exitInfo = info;
      log('  [exit ] code=' + info.code + ' signal=' + info.signal + ' sessionId=' + info.sessionId + ' durationMs=' + info.durationMs);
      resolve({ events, exitInfo });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tmpDir = makeTmpDir();
  log('tmpDir: ' + tmpDir);

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

  // ---- Turn 1: expect "pong" ----
  log('\n=== Turn 1: ask for "pong" ===');
  let turn1;
  try {
    turn1 = await runTurn({
      prompt: 'Reply with exactly the word: pong',
      cwd: tmpDir,
      sessionId: null
    });
  } catch (err) {
    log('FATAL spawn error: ' + err.message);
    process.exit(1);
  }

  const { events: events1, exitInfo: exit1 } = turn1;

  // Assertions for turn 1
  const initEvt = events1.find(e => e.kind === 'init');
  assert('turn1: received init event', !!initEvt);
  assert('turn1: init has sessionId', !!(initEvt && initEvt.sessionId));

  const resultEvt1 = events1.find(e => e.kind === 'result');
  assert('turn1: received result event', !!resultEvt1);
  assert('turn1: result isError=false', resultEvt1 && resultEvt1.isError === false);

  const textEvts1 = events1.filter(e => e.kind === 'assistant_text');
  assert('turn1: at least one assistant_text event', textEvts1.length > 0);

  const fullText1 = textEvts1.map(e => e.text).join('');
  assert('turn1: response contains "pong"', fullText1.toLowerCase().includes('pong'));

  assert('turn1: exit code 0', exit1.code === 0);
  assert('turn1: exit sessionId present', !!exit1.sessionId);

  const sessionId = exit1.sessionId;
  log('\n  session ID from turn 1: ' + sessionId);

  if (!sessionId) {
    log('\nSkipping turn 2 — no session ID obtained from turn 1.');
    failed++;
  } else {
    // ---- Turn 2: resume session and ask what word was said ----
    log('\n=== Turn 2: resume session, ask about prior word ===');
    let turn2;
    try {
      turn2 = await runTurn({
        prompt: 'What word did you just say? Reply with one word only.',
        cwd: tmpDir,
        sessionId
      });
    } catch (err) {
      log('FATAL spawn error turn 2: ' + err.message);
      failed++;
    }

    if (turn2) {
      const { events: events2, exitInfo: exit2 } = turn2;

      const textEvts2 = events2.filter(e => e.kind === 'assistant_text');
      assert('turn2: at least one assistant_text event', textEvts2.length > 0);

      const fullText2 = textEvts2.map(e => e.text).join('');
      assert('turn2: response contains "pong" (memory retained)', fullText2.toLowerCase().includes('pong'));

      const resultEvt2 = events2.find(e => e.kind === 'result');
      assert('turn2: received result event', !!resultEvt2);
      assert('turn2: exit code 0', exit2.code === 0);

      log('\n  turn 2 response: ' + JSON.stringify(fullText2.trim()));
    }
  }

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
  log('Unhandled error: ' + err.stack);
  process.exit(1);
});
