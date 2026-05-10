'use strict';

const store = require('../auth/store');

const MESSAGE_LOG_MAX_BYTES = 3 * 1024 * 1024;

const KNOWN_AGENTS = ['claude', 'codex', 'hermes'];
const DEFAULT_AGENT = 'claude';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _defaultAgentSlot() {
  return {
    sessionId: null,
    sessionStartedAt: null,
    lastUsedAt: null,
    messageLog: []
  };
}

function _normalizeAgent(agent) {
  if (!agent) return DEFAULT_AGENT;
  return agent;
}

/**
 * Ensure data.projects exists. Must be called inside store.update() so that
 * the mutation is persisted. Safe to call multiple times.
 */
function _ensureProjects(data) {
  if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) {
    data.projects = {};
  }
}

/**
 * Ensure a specific project entry exists with the per-agent shape:
 *   data.projects[name] = { agents: { claude: {...}, codex: {...} } }
 *
 * Migrates the legacy top-level shape (sessionId/messageLog at the project
 * root) into agents.claude. Idempotent: a project that's already in the new
 * shape is left alone.
 */
function _ensureProject(data, name) {
  if (!data.projects[name] || typeof data.projects[name] !== 'object') {
    data.projects[name] = { agents: {} };
  }
  const project = data.projects[name];
  if (!project.agents || typeof project.agents !== 'object' || Array.isArray(project.agents)) {
    project.agents = {};
  }

  // Migration: detect legacy fields at the project root and move them into
  // agents.claude. Only do this once — if agents.claude already has data, the
  // migration has run before and we leave the legacy fields alone (we'll
  // delete them below regardless to keep things tidy).
  const hasLegacy =
    project.sessionId !== undefined ||
    project.sessionStartedAt !== undefined ||
    project.lastUsedAt !== undefined ||
    Array.isArray(project.messageLog);

  if (hasLegacy && !project.agents.claude) {
    project.agents.claude = {
      sessionId: project.sessionId || null,
      sessionStartedAt: project.sessionStartedAt || null,
      lastUsedAt: project.lastUsedAt || null,
      messageLog: Array.isArray(project.messageLog) ? project.messageLog : []
    };
  }

  // Strip legacy top-level fields once we've migrated (or if they're stale).
  if (hasLegacy) {
    delete project.sessionId;
    delete project.sessionStartedAt;
    delete project.lastUsedAt;
    delete project.messageLog;
  }
}

function _ensureAgentSlot(data, name, agent) {
  _ensureProject(data, name);
  const project = data.projects[name];
  if (!project.agents[agent] || typeof project.agents[agent] !== 'object') {
    project.agents[agent] = _defaultAgentSlot();
    return;
  }
  const slot = project.agents[agent];
  if (slot.sessionId === undefined) slot.sessionId = null;
  if (slot.sessionStartedAt === undefined) slot.sessionStartedAt = null;
  if (slot.lastUsedAt === undefined) slot.lastUsedAt = null;
  if (!Array.isArray(slot.messageLog)) slot.messageLog = [];
}

/**
 * Trim the messageLog array until its serialized size is under the cap.
 * Mutates the array in place.
 */
function _trimMessageLog(messageLog) {
  while (messageLog.length > 0) {
    const json = JSON.stringify(messageLog);
    if (Buffer.byteLength(json, 'utf8') <= MESSAGE_LOG_MAX_BYTES) break;
    messageLog.shift();
  }
}

// ---------------------------------------------------------------------------
// Schema migration: runs once on require, before any other operation.
// ---------------------------------------------------------------------------

(function migrateIfNeeded() {
  const data = store.getData();
  let needsWrite = false;
  if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) {
    needsWrite = true;
  } else {
    for (const name of Object.keys(data.projects)) {
      const p = data.projects[name];
      if (!p || typeof p !== 'object') { needsWrite = true; break; }
      const hasLegacy =
        p.sessionId !== undefined ||
        p.sessionStartedAt !== undefined ||
        p.lastUsedAt !== undefined ||
        Array.isArray(p.messageLog);
      if (hasLegacy || !p.agents) { needsWrite = true; break; }
    }
  }
  if (!needsWrite) return;
  store.update((d) => {
    _ensureProjects(d);
    for (const name of Object.keys(d.projects)) {
      _ensureProject(d, name);
    }
  }).catch(() => {});
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the per-agent state slice (read-only snapshot). Creates a blank
 * slot in memory if none exists for that agent — does NOT persist; callers
 * that need to persist should hit a setter.
 */
function getProjectState(name, agent = DEFAULT_AGENT) {
  agent = _normalizeAgent(agent);
  const data = store.getData();
  _ensureProjects(data);
  const project = data.projects[name];
  if (!project) return _defaultAgentSlot();

  // Read-side migration tolerance: if the on-disk doc is still legacy (no
  // agents wrapper, has top-level sessionId), surface that data under the
  // claude slot. This keeps reads working before the deferred write lands.
  if (!project.agents) {
    if (agent === 'claude') {
      return {
        sessionId: project.sessionId || null,
        sessionStartedAt: project.sessionStartedAt || null,
        lastUsedAt: project.lastUsedAt || null,
        messageLog: Array.isArray(project.messageLog) ? project.messageLog.slice() : []
      };
    }
    return _defaultAgentSlot();
  }

  const slot = project.agents[agent];
  if (!slot) return _defaultAgentSlot();
  return {
    sessionId: slot.sessionId || null,
    sessionStartedAt: slot.sessionStartedAt || null,
    lastUsedAt: slot.lastUsedAt || null,
    messageLog: Array.isArray(slot.messageLog) ? slot.messageLog.slice() : []
  };
}

/**
 * Sets the sessionId for an agent under a project. If it differs from the
 * current one, sessionStartedAt is updated.
 */
async function setSessionId(name, agent, id) {
  // Back-compat shim: callers that haven't been updated pass (name, id).
  if (id === undefined && (typeof agent === 'string' || agent === null)) {
    id = agent;
    agent = DEFAULT_AGENT;
  }
  agent = _normalizeAgent(agent);
  return store.update((data) => {
    _ensureProjects(data);
    _ensureAgentSlot(data, name, agent);
    const slot = data.projects[name].agents[agent];
    if (slot.sessionId !== id) {
      slot.sessionId = id || null;
      slot.sessionStartedAt = id ? new Date().toISOString() : null;
    }
  });
}

/**
 * Updates lastUsedAt to the current time for the given agent slot.
 */
async function touchProject(name, agent = DEFAULT_AGENT) {
  agent = _normalizeAgent(agent);
  return store.update((data) => {
    _ensureProjects(data);
    _ensureAgentSlot(data, name, agent);
    data.projects[name].agents[agent].lastUsedAt = new Date().toISOString();
  });
}

/**
 * Clears the session and empties the message log for the given agent slot.
 */
async function clearSession(name, agent = DEFAULT_AGENT) {
  agent = _normalizeAgent(agent);
  return store.update((data) => {
    _ensureProjects(data);
    _ensureAgentSlot(data, name, agent);
    const slot = data.projects[name].agents[agent];
    slot.sessionId = null;
    slot.sessionStartedAt = null;
    slot.messageLog = [];
  });
}

/**
 * Appends a normalized event entry to the agent slot's messageLog.
 * Trims the oldest entries if the log exceeds MESSAGE_LOG_MAX_BYTES.
 */
async function appendMessage(name, agent, entry) {
  // Back-compat shim: callers that haven't been updated pass (name, entry).
  if (entry === undefined && agent && typeof agent === 'object' && !Array.isArray(agent)) {
    entry = agent;
    agent = DEFAULT_AGENT;
  }
  agent = _normalizeAgent(agent);
  return store.update((data) => {
    _ensureProjects(data);
    _ensureAgentSlot(data, name, agent);
    const slot = data.projects[name].agents[agent];
    slot.messageLog.push(Object.assign({ ts: new Date().toISOString() }, entry));
    _trimMessageLog(slot.messageLog);
  });
}

/**
 * Returns the message log for the given agent, optionally filtered to entries
 * with ts > since.
 * @param {string} name
 * @param {string} [agent='claude']
 * @param {{ since?: string }} [opts]
 */
function getMessageLog(name, agent = DEFAULT_AGENT, opts) {
  // Back-compat shim: getMessageLog(name) or getMessageLog(name, opts).
  if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
    opts = agent;
    agent = DEFAULT_AGENT;
  }
  agent = _normalizeAgent(agent);
  const { since } = opts || {};
  const data = store.getData();
  _ensureProjects(data);
  const project = data.projects[name];
  if (!project) return [];

  let log;
  if (project.agents && project.agents[agent]) {
    log = Array.isArray(project.agents[agent].messageLog)
      ? project.agents[agent].messageLog
      : [];
  } else if (!project.agents && agent === 'claude' && Array.isArray(project.messageLog)) {
    // Read-side migration tolerance.
    log = project.messageLog;
  } else {
    log = [];
  }
  if (!since) return log.slice();
  return log.filter(e => e.ts && e.ts > since);
}

/**
 * Returns all (project, agent) pairs that have a sessionId, sorted by
 * lastUsedAt desc. Each row is { name, agent, sessionId, lastUsedAt }.
 */
function listActiveProjects() {
  const data = store.getData();
  _ensureProjects(data);
  const rows = [];
  for (const [name, project] of Object.entries(data.projects)) {
    if (!project) continue;
    if (project.agents && typeof project.agents === 'object') {
      for (const [agent, slot] of Object.entries(project.agents)) {
        if (slot && slot.sessionId) {
          rows.push({
            name,
            agent,
            sessionId: slot.sessionId,
            lastUsedAt: slot.lastUsedAt || null
          });
        }
      }
    } else if (project.sessionId) {
      // Tolerate pre-migration shape.
      rows.push({
        name,
        agent: 'claude',
        sessionId: project.sessionId,
        lastUsedAt: project.lastUsedAt || null
      });
    }
  }
  rows.sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return 0;
    if (!a.lastUsedAt) return 1;
    if (!b.lastUsedAt) return -1;
    return b.lastUsedAt.localeCompare(a.lastUsedAt);
  });
  return rows;
}

module.exports = {
  KNOWN_AGENTS,
  DEFAULT_AGENT,
  getProjectState,
  setSessionId,
  touchProject,
  clearSession,
  appendMessage,
  getMessageLog,
  listActiveProjects
};
