'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { WebSocketServer } = require('ws');

const session = require('../auth/session');
const projects = require('./projects');
const { runClaude } = require('../lib/claudeRunner');
const projectStore = require('../lib/projectStore');
const swapper = require('../lib/authSwapper');
const skillCache = require('../lib/skillCache');

const router = express.Router();

// ---------------------------------------------------------------------------
// Placeholder HTML served when public/chat.html doesn't exist yet (PR-2)
// ---------------------------------------------------------------------------

const PLACEHOLDER_HTML = `<!doctype html><meta charset=utf-8><title>chat</title>
<h1>chat: <span id=p></span></h1>
<pre id=log style="white-space:pre-wrap;border:1px solid #ccc;padding:8px;height:50vh;overflow:auto"></pre>
<input id=msg style="width:80%"><button id=send>send</button>
<button id=newc>new chat</button><button id=stop>stop</button>
<script>
const name = location.pathname.split('/').pop();
document.getElementById('p').textContent = name;
const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws/chat');
const log = document.getElementById('log');
function add(o){ log.textContent += JSON.stringify(o)+'\\n'; log.scrollTop = log.scrollHeight; }
ws.onopen = () => { ws.send(JSON.stringify({type:'hello', project:name})); add({_:'open'}); };
ws.onmessage = e => add(JSON.parse(e.data));
ws.onclose = e => add({_:'close', code:e.code, reason:e.reason});
document.getElementById('send').onclick = () => { ws.send(JSON.stringify({type:'send', text:document.getElementById('msg').value})); document.getElementById('msg').value=''; };
document.getElementById('newc').onclick = () => ws.send(JSON.stringify({type:'newChat'}));
document.getElementById('stop').onclick = () => ws.send(JSON.stringify({type:'interrupt'}));
</script>
`;

// ---------------------------------------------------------------------------
// HTTP route: GET /chat/:name
// ---------------------------------------------------------------------------

router.get('/chat/:name', session.requireAuth, (req, res) => {
  const name = req.params.name;
  if (!projects.NAME_RE.test(name) || name.startsWith('.')) {
    return res.status(404).send('Project not found');
  }
  const abs = path.join(projects.CODE_DIR, name);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return res.status(404).send('Project not found');
  }
  const chatHtml = path.join(__dirname, '..', 'public', 'chat.html');
  if (fs.existsSync(chatHtml)) {
    return res.sendFile(chatHtml);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PLACEHOLDER_HTML);
});

// ---------------------------------------------------------------------------
// Per-project runner registry
// ---------------------------------------------------------------------------
//
// runners: Map<projectName, {
//   abortController: AbortController | null,
//   clients: Set<WebSocket>,
//   busy: boolean
// }>

const runners = new Map();

function getOrCreateEntry(projectName) {
  let entry = runners.get(projectName);
  if (!entry) {
    entry = { abortController: null, clients: new Set(), busy: false };
    runners.set(projectName, entry);
  }
  return entry;
}

function broadcast(entry, obj) {
  const msg = JSON.stringify(obj);
  for (const client of entry.clients) {
    if (client.readyState === client.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

// Broadcast to ALL connected clients across ALL projects
function broadcastAll(obj) {
  const msg = JSON.stringify(obj);
  for (const entry of runners.values()) {
    for (const client of entry.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(msg); } catch (_) {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Quota detection
// ---------------------------------------------------------------------------

function isQuotaError(resultPayload) {
  if (!resultPayload || resultPayload.isError !== true) return false;
  const text = String(resultPayload.finalText || '').toLowerCase();
  return /(rate limit|usage limit|quota|credit balance|out of credits|not.*authenticated|please.*log.*in|please run \/login)/i.test(text);
}

// ---------------------------------------------------------------------------
// Wire swapper events → broadcast to all clients (done once at module load)
// ---------------------------------------------------------------------------

swapper.events.on('url', ({ url }) => {
  const state = swapper.getState();
  broadcastAll({ type: 'event', kind: 'auth_url', url, mode: state.mode || null });
});

swapper.events.on('prompt', ({ kind }) => {
  if (kind === 'paste_code') {
    broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase: 'awaiting_code' });
  }
});

swapper.events.on('output', ({ data }) => {
  broadcastAll({ type: 'event', kind: 'auth_output', data });
});

swapper.events.on('done', ({ success, status, error }) => {
  const phase = success ? 'done' : 'failed';
  broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase });

  const donePayload = { type: 'event', kind: 'auth_done', success };
  if (status) donePayload.status = status;
  if (error) donePayload.error = error;
  broadcastAll(donePayload);

  // Broadcast fresh auth_status after swap completes
  swapper.getStatus().then((freshStatus) => {
    broadcastAll({
      type: 'event',
      kind: 'auth_status',
      loggedIn: freshStatus.loggedIn,
      email: freshStatus.email,
      orgName: freshStatus.orgName,
      subscriptionType: freshStatus.subscriptionType,
      authMethod: freshStatus.authMethod,
      apiProvider: freshStatus.apiProvider
    });
  }).catch(() => {});
});

swapper.events.on('cancelled', () => {
  broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase: 'cancelled' });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

function attachWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let urlObj;
    try {
      urlObj = new url.URL(req.url, 'http://localhost');
    } catch (_) {
      return; // let another handler (or default 400) take it
    }
    if (urlObj.pathname !== '/ws/chat') {
      // Not ours — let other upgrade handlers (e.g. /ws/live) try.
      return;
    }
    const sessionRow = session.getSessionForWS(req, urlObj);
    if (!sessionRow) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionRow);
    });
  });

  wss.on('connection', (ws, req, sessionRow) => {
    console.log('[chat] connection open');

    let attachedProject = null; // set after successful hello
    let isAlive = true;

    // ---- Heartbeat ----
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, 30000);

    ws.on('pong', () => { isAlive = true; });

    // ---- Helpers ----
    function send(obj) {
      sendTo(ws, obj);
    }

    function closeWithError(message) {
      send({ type: 'error', message });
      send({ type: 'closed', reason: message });
      ws.close();
    }

    // ---- Message handler ----
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        send({ type: 'error', message: 'invalid json' });
        return;
      }

      const type = msg && msg.type;

      // ----------------------------------------------------------------
      // hello — must be first message
      // ----------------------------------------------------------------
      if (!attachedProject) {
        if (type !== 'hello') {
          closeWithError('expected hello as first message');
          return;
        }
        const projectName = msg.project;
        if (!projectName || typeof projectName !== 'string' ||
            !projects.NAME_RE.test(projectName) || projectName.startsWith('.')) {
          closeWithError('invalid project name');
          return;
        }
        const abs = path.join(projects.CODE_DIR, projectName);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          closeWithError('project not found');
          return;
        }

        attachedProject = projectName;
        const entry = getOrCreateEntry(projectName);
        entry.clients.add(ws);
        console.log('[chat] hello project=%s clients=%d', projectName, entry.clients.size);

        // Send history
        const state = projectStore.getProjectState(projectName);
        const messages = projectStore.getMessageLog(projectName);
        send({
          type: 'history',
          sessionId: state.sessionId,
          messages,
          busy: entry.busy
        });

        // Send auth_status so the UI account chip is populated on connect
        swapper.getStatus().then((authSt) => {
          send({
            type: 'event',
            kind: 'auth_status',
            loggedIn: authSt.loggedIn,
            email: authSt.email,
            orgName: authSt.orgName,
            subscriptionType: authSt.subscriptionType,
            authMethod: authSt.authMethod,
            apiProvider: authSt.apiProvider
          });
        }).catch(() => {});

        return;
      }

      // ----------------------------------------------------------------
      // Subsequent messages — project already attached
      // ----------------------------------------------------------------
      const entry = getOrCreateEntry(attachedProject);

      // ----------------------------------------------------------------
      // send
      // ----------------------------------------------------------------
      if (type === 'send') {
        if (entry.busy) {
          send({ type: 'error', message: 'busy' });
          return;
        }
        const text = msg.text;
        if (!text || typeof text !== 'string' || !text.trim()) {
          send({ type: 'error', message: 'text is empty' });
          return;
        }
        if (Buffer.byteLength(text, 'utf8') > 100 * 1024) {
          send({ type: 'error', message: 'text too large (max 100KB)' });
          return;
        }

        const ts = new Date().toISOString();
        const userEntry = { ts, kind: 'user_text', text };

        // Persist and broadcast the user message
        projectStore.appendMessage(attachedProject, userEntry).catch((e) => {
          console.error('[chat] appendMessage error:', e);
        });
        broadcast(entry, { type: 'event', kind: 'user_text', text, ts });

        // Start runner
        const state = projectStore.getProjectState(attachedProject);
        const ac = new AbortController();
        entry.abortController = ac;
        entry.busy = true;
        broadcast(entry, { type: 'state', busy: true });
        const projectName = attachedProject; // capture for async closures
        broadcastAll({ type: 'event', kind: 'sessions_changed', name: projectName, busy: true });
        const cwd = path.join(projects.CODE_DIR, projectName);
        let runner;
        try {
          runner = runClaude({
            prompt: text,
            cwd,
            sessionId: state.sessionId || null,
            signal: ac.signal
          });
        } catch (err) {
          entry.busy = false;
          entry.abortController = null;
          broadcast(entry, { type: 'state', busy: false });
          broadcast(entry, { type: 'error', message: err.message });
          return;
        }

        runner.on('event', (evt) => {
          const evtTs = new Date().toISOString();

          // Persist session IDs
          if (evt.kind === 'init' && evt.sessionId) {
            projectStore.setSessionId(projectName, evt.sessionId).catch((e) => {
              console.error('[chat] setSessionId error:', e);
            });
            // Cache skills/agents from init payload
            skillCache.set(evt);
          }
          if (evt.kind === 'result' && evt.sessionId) {
            projectStore.setSessionId(projectName, evt.sessionId).catch((e) => {
              console.error('[chat] setSessionId error:', e);
            });
          }

          // Persist event to message log
          projectStore.appendMessage(projectName, Object.assign({ ts: evtTs }, evt)).catch((e) => {
            console.error('[chat] appendMessage error:', e);
          });

          // Quota detection: inject synthetic quota_exceeded event before result
          if (evt.kind === 'result' && isQuotaError(evt)) {
            // Find last user_text from message log for the retry prompt
            const msgLog = projectStore.getMessageLog(projectName);
            let lastPromptText = null;
            for (let i = msgLog.length - 1; i >= 0; i--) {
              if (msgLog[i].kind === 'user_text') {
                lastPromptText = msgLog[i].text || null;
                break;
              }
            }
            const quotaEvt = {
              ts: evtTs,
              kind: 'quota_exceeded',
              text: evt.finalText,
              project: projectName,
              lastPromptText
            };
            // Persist the synthetic event
            projectStore.appendMessage(projectName, quotaEvt).catch((e) => {
              console.error('[chat] appendMessage quota_exceeded error:', e);
            });
            // Broadcast to all project clients
            const currentEntry2 = runners.get(projectName);
            if (currentEntry2) {
              broadcast(currentEntry2, Object.assign({ type: 'event' }, quotaEvt));
            }
          }

          // Broadcast to all clients on this project
          const currentEntry = runners.get(projectName);
          if (currentEntry) {
            broadcast(currentEntry, Object.assign({ type: 'event' }, evt));
          }
        });

        runner.on('error', (err) => {
          console.error('[chat] runner error project=%s:', projectName, err);
          const currentEntry = runners.get(projectName);
          if (currentEntry) {
            broadcast(currentEntry, { type: 'error', message: err.message });
          }
        });

        runner.on('exit', ({ code, signal: sig, sessionId: exitSessionId, durationMs }) => {
          const currentEntry = runners.get(projectName);
          if (currentEntry) {
            currentEntry.busy = false;
            currentEntry.abortController = null;
            broadcast(currentEntry, { type: 'state', busy: false });
            broadcastAll({ type: 'event', kind: 'sessions_changed', name: projectName, busy: false });

            // GC entry if no clients remain
            if (currentEntry.clients.size === 0) {
              runners.delete(projectName);
            }
          }
          projectStore.touchProject(projectName).catch((e) => {
            console.error('[chat] touchProject error:', e);
          });
        });

        return;
      }

      // ----------------------------------------------------------------
      // interrupt
      // ----------------------------------------------------------------
      if (type === 'interrupt') {
        if (entry.busy && entry.abortController) {
          entry.abortController.abort();
        }
        // else ignore silently
        return;
      }

      // ----------------------------------------------------------------
      // newChat
      // ----------------------------------------------------------------
      if (type === 'newChat') {
        if (entry.busy) {
          send({ type: 'error', message: 'cannot start new chat while busy' });
          return;
        }
        const projectName = attachedProject;
        projectStore.clearSession(projectName).then(() => {
          const currentEntry = runners.get(projectName);
          if (currentEntry) {
            broadcast(currentEntry, { type: 'state', busy: false });
            broadcast(currentEntry, { type: 'history', sessionId: null, messages: [], busy: false });
          }
          broadcastAll({ type: 'event', kind: 'sessions_changed', name: projectName, busy: false });
        }).catch((e) => {
          console.error('[chat] clearSession error:', e);
        });
        return;
      }

      // ----------------------------------------------------------------
      // authStatus — respond to requester only
      // ----------------------------------------------------------------
      if (type === 'authStatus') {
        swapper.getStatus().then((authSt) => {
          send({
            type: 'event',
            kind: 'auth_status',
            loggedIn: authSt.loggedIn,
            email: authSt.email,
            orgName: authSt.orgName,
            subscriptionType: authSt.subscriptionType,
            authMethod: authSt.authMethod,
            apiProvider: authSt.apiProvider
          });
        }).catch(() => {
          send({ type: 'event', kind: 'auth_status', loggedIn: false });
        });
        return;
      }

      // ----------------------------------------------------------------
      // authSwapStart
      // ----------------------------------------------------------------
      if (type === 'authSwapStart') {
        // Guard: refuse if any runner is busy
        let anyBusy = false;
        for (const e of runners.values()) {
          if (e.busy) { anyBusy = true; break; }
        }
        if (anyBusy) {
          send({ type: 'error', message: '응답 중에는 계정 전환을 시작할 수 없습니다.' });
          return;
        }

        // Guard: refuse if swap already in progress
        const swState = swapper.getState();
        if (swState.phase !== 'idle' && swState.phase !== 'done' && swState.phase !== 'failed' && swState.phase !== 'cancelled') {
          send({ type: 'error', message: '이미 계정 전환이 진행 중입니다.' });
          return;
        }

        const swMode = msg.mode || 'claudeai';
        const swEmail = msg.email || undefined;

        // Broadcast 'starting' phase immediately
        broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase: 'starting', mode: swMode });

        swapper.start({ mode: swMode, email: swEmail }).catch((err) => {
          console.error('[chat] authSwapStart error:', err);
          broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase: 'failed' });
          broadcastAll({ type: 'event', kind: 'auth_done', success: false, error: err.message });
        });
        return;
      }

      // ----------------------------------------------------------------
      // authSwapCode
      // ----------------------------------------------------------------
      if (type === 'authSwapCode') {
        const code = msg.code;
        if (!code || typeof code !== 'string') {
          send({ type: 'error', message: 'authSwapCode: code is required' });
          return;
        }
        const accepted = swapper.submitCode(code);
        if (!accepted) {
          send({ type: 'error', message: 'authSwapCode: no swap in progress or wrong phase' });
          return;
        }
        broadcastAll({ type: 'event', kind: 'auth_swap_phase', phase: 'verifying' });
        return;
      }

      // ----------------------------------------------------------------
      // authSwapCancel
      // ----------------------------------------------------------------
      if (type === 'authSwapCancel') {
        swapper.cancel();
        // broadcastAll is handled by swapper.events 'cancelled' listener
        return;
      }

      send({ type: 'error', message: 'unknown message type: ' + type });
    });

    // ---- Close ----
    ws.on('close', () => {
      clearInterval(pingInterval);
      console.log('[chat] connection close project=%s', attachedProject || '(no hello)');
      if (attachedProject) {
        const entry = runners.get(attachedProject);
        if (entry) {
          entry.clients.delete(ws);
          // GC if no clients and not busy
          if (entry.clients.size === 0 && !entry.busy) {
            runners.delete(attachedProject);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[chat] ws error:', err);
      clearInterval(pingInterval);
      if (attachedProject) {
        const entry = runners.get(attachedProject);
        if (entry) {
          entry.clients.delete(ws);
          if (entry.clients.size === 0 && !entry.busy) {
            runners.delete(attachedProject);
          }
        }
      }
    });
  });

  return wss;
}

function isProjectBusy(projectName) {
  const entry = runners.get(projectName);
  return !!(entry && entry.busy);
}

module.exports = { router, attachWS, runners, isProjectBusy };
