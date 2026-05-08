'use strict';

/**
 * smoke-tmux.js — manual smoke test for tmuxClient.
 *
 * Usage:
 *   node scripts/smoke-tmux.js
 *     → lists all tmux sockets and panes, exits 0
 *
 *   node scripts/smoke-tmux.js <socketPath> <paneId>
 *     → sends a benign echo command, waits 500ms, captures output,
 *       exits 0 if "wotm-smoke-OK" found, non-zero otherwise
 */

const { execFile } = require('child_process');
const tmuxClient = require('../lib/tmuxClient');

function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) { reject(err); return; }
      resolve(stdout != null ? String(stdout) : '');
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listMode() {
  const sockets = tmuxClient.resolveSocketPaths();
  if (sockets.length === 0) {
    console.log('No tmux sockets found in /tmp/tmux-' + process.getuid() + '/');
    console.log('(Is tmux running?)');
    process.exit(0);
  }
  console.log('Found ' + sockets.length + ' tmux socket(s):');
  for (const sock of sockets) {
    console.log('  socket: ' + sock);
    const panes = await tmuxClient.listPanes(sock);
    if (panes.length === 0) {
      console.log('    (no panes — server may have stopped)');
    }
    for (const p of panes) {
      console.log(
        '    pane=' + p.paneId +
        ' pid=' + p.panePid +
        ' tty=' + p.paneTty +
        ' session=' + p.sessionName +
        ' win=' + p.windowIndex + '.' + p.paneIndex +
        ' cmd=' + p.currentCommand
      );
    }
  }
  process.exit(0);
}

async function sendMode(socketPath, paneId) {
  const MARKER = 'wotm-smoke-OK';
  const TEXT = 'echo ' + MARKER + '\n';

  console.log('Sending to socket=' + socketPath + ' pane=' + paneId);
  console.log('  text: ' + JSON.stringify(TEXT));

  try {
    await tmuxClient.sendText(socketPath, paneId, TEXT);
  } catch (err) {
    console.error('sendText failed:', err.message);
    process.exit(1);
  }

  console.log('  waiting 500ms for output...');
  await sleep(500);

  let captured;
  try {
    captured = await execP('tmux', ['-S', socketPath, 'capture-pane', '-p', '-t', paneId], { timeout: 2000 });
  } catch (err) {
    console.error('capture-pane failed:', err.message);
    process.exit(1);
  }

  if (captured.includes(MARKER)) {
    console.log('  PASS — "' + MARKER + '" found in captured output.');
    process.exit(0);
  } else {
    console.log('  FAIL — "' + MARKER + '" NOT found in captured output.');
    console.log('  Output (last 400 chars):', captured.slice(-400).replace(/\n/g, '\\n'));
    process.exit(1);
  }
}

const [,, socketArg, paneArg] = process.argv;

if (!socketArg && !paneArg) {
  listMode().catch((err) => { console.error(err); process.exit(1); });
} else if (socketArg && paneArg) {
  sendMode(socketArg, paneArg).catch((err) => { console.error(err); process.exit(1); });
} else {
  console.error('Usage: node scripts/smoke-tmux.js [<socketPath> <paneId>]');
  process.exit(1);
}
