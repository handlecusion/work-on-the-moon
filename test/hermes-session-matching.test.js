'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const hermesDb = require('../lib/hermesDb');
const hermesScanner = require('../lib/hermesSessionScanner');

const { extractOnboardCwd } = hermesDb._internal;
const { pickSessionForPid } = hermesScanner._internal;

test('extractOnboardCwd reads JSON-encoded onboard tool args', () => {
  const toolCalls = JSON.stringify([
    {
      type: 'function',
      function: {
        name: 'mcp_llmwiki_onboard_project',
        arguments: JSON.stringify({
          cwd: '/Users/ys/Code/working-on-the-moon',
          wiki_path: '/Users/ys/Code/wiki'
        })
      }
    }
  ]);

  assert.equal(extractOnboardCwd(toolCalls), '/Users/ys/Code/working-on-the-moon');
});

test('extractOnboardCwd reads plain text result cwd', () => {
  const text = 'mcp_llmwiki_onboard_project result: cwd=/Users/ys/Code/art-ax graph_status=fresh';
  assert.equal(extractOnboardCwd(text), '/Users/ys/Code/art-ax');
});

test('extractOnboardCwd preserves spaces in quoted cwd', () => {
  const text = 'mcp_llmwiki_onboard_project args: "cwd":"/Users/ys/Code/My Project", "wiki_path":"/Users/ys/Code/wiki"';
  assert.equal(extractOnboardCwd(text), '/Users/ys/Code/My Project');
});

test('pickSessionForPid prefers cwd match over freshest session', () => {
  const sessions = [
    { id: 'newer-other', last_ts: 2000 },
    { id: 'older-target', last_ts: 1000 }
  ];
  const cwdMap = {
    'newer-other': '/Users/ys/Code/art-ax',
    'older-target': '/Users/ys/Code/working-on-the-moon'
  };

  const picked = pickSessionForPid(Date.now(), sessions, '/Users/ys/Code/working-on-the-moon', cwdMap);
  assert.equal(picked.id, 'older-target');
});

test('pickSessionForPid refuses mismatch when any cwd signal exists', () => {
  const sessions = [
    { id: 'newer-other', last_ts: 2000 },
    { id: 'older-target', last_ts: 1000 }
  ];
  const cwdMap = {
    'newer-other': '/Users/ys/Code/art-ax'
  };

  const picked = pickSessionForPid(Date.now(), sessions, '/Users/ys/Code/working-on-the-moon', cwdMap);
  assert.equal(picked, null);
});

test('pickSessionForPid keeps legacy recency fallback without cwd signal', () => {
  const startedAtMs = 1_000_000;
  const sessions = [
    { id: 'fresh', last_ts: 1_001 },
    { id: 'old', last_ts: 1 }
  ];

  const picked = pickSessionForPid(startedAtMs, sessions, '/Users/ys/Code/working-on-the-moon', {});
  assert.equal(picked.id, 'fresh');
});
