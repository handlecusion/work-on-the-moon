'use strict';

const express = require('express');
const fs = require('fs');
const session = require('../auth/session');
const { CODE_DIR, NAME_RE } = require('./projects');
const projectStore = require('../lib/projectStore');
const liveSessionScanner = require('../lib/liveSessionScanner');

const router = express.Router();

// Lazy-load chat module to avoid circular dep issues at startup
let _chatModule = null;
function getChatModule() {
  if (!_chatModule) _chatModule = require('./chat');
  return _chatModule;
}

function listProjectNames() {
  if (!fs.existsSync(CODE_DIR)) return [];
  let entries;
  try {
    entries = fs.readdirSync(CODE_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name.startsWith('.')) continue;
    if (!NAME_RE.test(name)) continue;
    out.push(name);
  }
  return out;
}

router.get('/api/sessions', session.requireAuth, async (req, res) => {
  const chat = getChatModule();
  const names = listProjectNames();

  const items = [];
  for (const name of names) {
    for (const agent of ['claude', 'codex', 'hermes']) {
      const state = projectStore.getProjectState(name, agent);
      const busy = chat.isProjectBusy(name, agent);

      // Only emit non-claude rows when the project actually has activity in
      // that agent. This keeps the "모든 프로젝트" list at one row per project
      // while still surfacing per-agent rows in "최근 대화" once they exist.
      if ((agent === 'codex' || agent === 'hermes') &&
          state.messageLog.length === 0 && !state.sessionId && !busy) {
        continue;
      }

      let lastUserText = null;
      let lastAssistantText = null;
      for (let i = state.messageLog.length - 1; i >= 0; i--) {
        const e = state.messageLog[i];
        if (!lastUserText && e.kind === 'user_text') {
          lastUserText = (e.text || '').slice(0, 80);
        }
        if (!lastAssistantText && e.kind === 'assistant_text') {
          lastAssistantText = (e.text || '').slice(0, 80);
        }
        if (lastUserText && lastAssistantText) break;
      }

      items.push({
        name,
        agent,
        sessionId: state.sessionId || null,
        lastUsedAt: state.lastUsedAt || null,
        sessionStartedAt: state.sessionStartedAt || null,
        busy,
        lastUserText,
        lastAssistantText,
        hasMessages: state.messageLog.length > 0,
        messageCount: state.messageLog.length
      });
    }
  }

  // Sort: lastUsedAt desc (null = -Infinity), then name asc, then agent asc
  items.sort((a, b) => {
    const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity;
    const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity;
    if (tb !== ta) return tb - ta;
    const nc = a.name.localeCompare(b.name);
    if (nc !== 0) return nc;
    return a.agent.localeCompare(b.agent);
  });

  // Determine whether the caller wants the extended response shape. Default
  // remains the legacy bare array so existing frontend consumers keep working
  // until E3 migrates them to the object shape.
  const includeParam = String(req.query.include || '').toLowerCase();
  const wantsLocal = includeParam === 'local' || includeParam.split(',').map(s => s.trim()).includes('local');

  if (!wantsLocal) {
    res.json(items);
    return;
  }

  let localActive = [];
  try {
    localActive = await liveSessionScanner.scanLive();
  } catch (e) {
    // Soft-fail: never let a scanner error break the API. Return empty list.
    localActive = [];
  }

  res.json({ managed: items, localActive });
});

module.exports = router;
