'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const session = require('../auth/session');
const projects = require('./projects');

const router = express.Router();

router.get('/session/:name', session.requireAuth, (req, res, next) => {
  const name = req.params.name;
  if (!projects.NAME_RE.test(name) || name.startsWith('.')) {
    return res.status(400).send('Invalid project name');
  }
  const abs = path.join(projects.CODE_DIR, name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return res.status(404).send('Project not found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'terminal.html'));
});

// ---- Persistent PTY registry, keyed by project name ----
const BUFFER_LIMIT = 64 * 1024; // 64KB

/**
 * sessions: Map<projectName, {
 *   pty,
 *   buffer: string,
 *   cols, rows,
 *   clients: Set<ws>
 * }>
 */
const sessions = new Map();

function trimBuffer(s) {
  if (s.length <= BUFFER_LIMIT) return s;
  return s.slice(s.length - BUFFER_LIMIT);
}

function broadcast(sess, msgObj, exceptWs) {
  const msg = JSON.stringify(msgObj);
  for (const c of sess.clients) {
    if (c === exceptWs) continue;
    if (c.readyState === c.OPEN) {
      try { c.send(msg); } catch (_) {}
    }
  }
}

function spawnPty(projectName, cwd, cols, rows) {
  const shell = process.env.SHELL || '/bin/zsh';
  // Use login shell to load PATH; then cd and exec claude.
  // exec replaces shell so claude becomes pid; loses login env if not login shell.
  // We use -l -c to ensure login profile sourced (so claude is on PATH).
  const cmd = 'cd ' + JSON.stringify(cwd) + ' && exec claude --dangerously-skip-permissions';
  const p = pty.spawn(shell, ['-l', '-c', cmd], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 32,
    cwd: cwd,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' })
  });
  return p;
}

function getOrCreateSession(projectName, cols, rows) {
  let sess = sessions.get(projectName);
  if (sess && sess.pty) return sess;

  if (!projects.NAME_RE.test(projectName) || projectName.startsWith('.')) {
    throw new Error('잘못된 프로젝트 이름');
  }
  const abs = path.join(projects.CODE_DIR, projectName);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error('프로젝트를 찾을 수 없습니다');
  }

  const p = spawnPty(projectName, abs, cols, rows);
  sess = {
    pty: p,
    buffer: '',
    cols: cols || 120,
    rows: rows || 32,
    clients: new Set()
  };
  sessions.set(projectName, sess);

  p.onData((data) => {
    sess.buffer = trimBuffer(sess.buffer + data);
    broadcast(sess, { type: 'output', data });
  });

  p.onExit(({ exitCode, signal }) => {
    broadcast(sess, { type: 'exit', code: typeof exitCode === 'number' ? exitCode : (signal || 0) });
    sessions.delete(projectName);
    sess.pty = null;
  });

  return sess;
}

function killSession(projectName) {
  const sess = sessions.get(projectName);
  if (!sess) return;
  try { if (sess.pty) sess.pty.kill(); } catch (_) {}
  sessions.delete(projectName);
}

function attachWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let urlObj;
    try {
      urlObj = new url.URL(req.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
      return;
    }
    if (urlObj.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }
    const sessionRow = session.getSessionForWS(req, urlObj);
    if (!sessionRow) {
      // 4401 = unauthorized (custom)
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionRow);
    });
  });

  wss.on('connection', (ws, req, sessionRow) => {
    let attachedProject = null;

    function send(obj) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (_) {}
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch (_) { send({ type: 'error', message: 'invalid json' }); return; }

      const type = msg && msg.type;
      if (type === 'start') {
        const projectName = msg.project;
        if (!projectName || typeof projectName !== 'string') {
          send({ type: 'error', message: '프로젝트 이름이 필요합니다.' });
          return;
        }
        if (!projects.NAME_RE.test(projectName) || projectName.startsWith('.')) {
          send({ type: 'error', message: '잘못된 프로젝트 이름' });
          return;
        }
        // Detach from previous if switching
        if (attachedProject && attachedProject !== projectName) {
          const prev = sessions.get(attachedProject);
          if (prev) prev.clients.delete(ws);
        }
        let sess;
        try {
          sess = getOrCreateSession(projectName, msg.cols, msg.rows);
        } catch (e) {
          send({ type: 'error', message: e.message });
          return;
        }
        attachedProject = projectName;
        sess.clients.add(ws);
        // If client provided cols/rows, resize once on attach to fit current device.
        if (msg.cols && msg.rows && (msg.cols !== sess.cols || msg.rows !== sess.rows)) {
          try {
            sess.pty.resize(msg.cols, msg.rows);
            sess.cols = msg.cols;
            sess.rows = msg.rows;
          } catch (_) {}
        }
        // Replay buffer
        if (sess.buffer && sess.buffer.length) {
          send({ type: 'output', data: sess.buffer });
        }
        return;
      }

      if (!attachedProject) {
        send({ type: 'error', message: 'start 메시지가 먼저 필요합니다.' });
        return;
      }
      const sess = sessions.get(attachedProject);
      if (!sess || !sess.pty) {
        send({ type: 'error', message: '세션이 종료되었습니다.' });
        return;
      }

      if (type === 'input') {
        if (typeof msg.data === 'string') {
          try { sess.pty.write(msg.data); } catch (_) {}
        }
        return;
      }
      if (type === 'resize') {
        const cols = parseInt(msg.cols, 10);
        const rows = parseInt(msg.rows, 10);
        if (cols > 0 && rows > 0) {
          try {
            sess.pty.resize(cols, rows);
            sess.cols = cols;
            sess.rows = rows;
          } catch (_) {}
        }
        return;
      }
      if (type === 'kill') {
        killSession(attachedProject);
        return;
      }
      send({ type: 'error', message: 'unknown message type: ' + type });
    });

    ws.on('close', () => {
      if (attachedProject) {
        const sess = sessions.get(attachedProject);
        if (sess) sess.clients.delete(ws);
      }
    });

    ws.on('error', () => {
      if (attachedProject) {
        const sess = sessions.get(attachedProject);
        if (sess) sess.clients.delete(ws);
      }
    });
  });

  return wss;
}

module.exports = { router, attachWS, sessions, killSession };
