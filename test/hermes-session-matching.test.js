'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const hermesDb = require('../lib/hermesDb');
const hermesScanner = require('../lib/hermesSessionScanner');

const { extractOnboardCwd, resolveCwdMapFromOnboardRows } = hermesDb._internal;
const { pickSessionForPid } = hermesScanner._internal;

function onboardRow(activeId, depth, timestamp, messageId, cwd) {
  return {
    active_id: activeId,
    depth,
    timestamp,
    message_id: messageId,
    tool_calls: JSON.stringify([
      {
        type: 'function',
        function: {
          name: 'mcp_llmwiki_onboard_project',
          arguments: JSON.stringify({ cwd, wiki_path: '/Users/ys/Code/wiki' })
        }
      }
    ]),
    content: ''
  };
}

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

test('resolveCwdMapFromOnboardRows chooses newest same-depth onboard cwd', () => {
  const rows = [
    onboardRow('active', 0, 100, 1, '/Users/ys/Code/old-project'),
    onboardRow('active', 0, 200, 2, '/Users/ys/Code/new-project')
  ];

  assert.deepEqual(resolveCwdMapFromOnboardRows(rows), {
    active: '/Users/ys/Code/new-project'
  });
});

test('resolveCwdMapFromOnboardRows uses message id as same-timestamp tiebreaker', () => {
  const rows = [
    onboardRow('active', 0, 200, 2, '/Users/ys/Code/older-message'),
    onboardRow('active', 0, 200, 3, '/Users/ys/Code/newer-message')
  ];

  assert.deepEqual(resolveCwdMapFromOnboardRows(rows), {
    active: '/Users/ys/Code/newer-message'
  });
});

test('resolveCwdMapFromOnboardRows preserves nearest parent-session inheritance', () => {
  const rows = [
    onboardRow('active', 1, 300, 3, '/Users/ys/Code/parent-newer'),
    onboardRow('active', 0, 100, 1, '/Users/ys/Code/active-older')
  ];

  assert.deepEqual(resolveCwdMapFromOnboardRows(rows), {
    active: '/Users/ys/Code/active-older'
  });
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
