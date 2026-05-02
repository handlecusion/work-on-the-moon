'use strict';

const store = require('../auth/store');

const MESSAGE_LOG_MAX_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _defaultProject() {
  return {
    sessionId: null,
    sessionStartedAt: null,
    lastUsedAt: null,
    messageLog: []
  };
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
 * Ensure a specific project entry exists inside data.projects.
 * Must be called inside store.update() after _ensureProjects().
 */
function _ensureProject(data, name) {
  if (!data.projects[name] || typeof data.projects[name] !== 'object') {
    data.projects[name] = _defaultProject();
  } else {
    const p = data.projects[name];
    if (p.sessionId === undefined) p.sessionId = null;
    if (p.sessionStartedAt === undefined) p.sessionStartedAt = null;
    if (p.lastUsedAt === undefined) p.lastUsedAt = null;
    if (!Array.isArray(p.messageLog)) p.messageLog = [];
  }
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

// Kick off a migration if data.projects is absent. We swallow errors here
// because the migration will be retried implicitly on the first real write.
(function migrateIfNeeded() {
  const data = store.getData();
  if (!data.projects) {
    store.update((d) => { _ensureProjects(d); }).catch(() => {});
  }
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current project state (read-only snapshot).
 */
function getProjectState(name) {
  const data = store.getData();
  _ensureProjects(data);
  if (!data.projects[name]) return _defaultProject();
  const p = data.projects[name];
  return {
    sessionId: p.sessionId || null,
    sessionStartedAt: p.sessionStartedAt || null,
    lastUsedAt: p.lastUsedAt || null,
    messageLog: Array.isArray(p.messageLog) ? p.messageLog.slice() : []
  };
}

/**
 * Sets the sessionId for a project. If it differs from the current one,
 * sessionStartedAt is updated.
 */
async function setSessionId(name, id) {
  return store.update((data) => {
    _ensureProjects(data);
    _ensureProject(data, name);
    const p = data.projects[name];
    if (p.sessionId !== id) {
      p.sessionId = id || null;
      p.sessionStartedAt = id ? new Date().toISOString() : null;
    }
  });
}

/**
 * Updates lastUsedAt to the current time.
 */
async function touchProject(name) {
  return store.update((data) => {
    _ensureProjects(data);
    _ensureProject(data, name);
    data.projects[name].lastUsedAt = new Date().toISOString();
  });
}

/**
 * Clears the session and empties the message log.
 */
async function clearSession(name) {
  return store.update((data) => {
    _ensureProjects(data);
    _ensureProject(data, name);
    const p = data.projects[name];
    p.sessionId = null;
    p.sessionStartedAt = null;
    p.messageLog = [];
  });
}

/**
 * Appends a normalized event entry to the project's messageLog.
 * Trims the oldest entries if the log exceeds MESSAGE_LOG_MAX_BYTES.
 */
async function appendMessage(name, entry) {
  return store.update((data) => {
    _ensureProjects(data);
    _ensureProject(data, name);
    const p = data.projects[name];
    p.messageLog.push(Object.assign({ ts: new Date().toISOString() }, entry));
    _trimMessageLog(p.messageLog);
  });
}

/**
 * Returns the message log, optionally filtered to entries with ts > since.
 * @param {string} name
 * @param {{ since?: string }} [opts]
 */
function getMessageLog(name, opts) {
  const { since } = opts || {};
  const data = store.getData();
  _ensureProjects(data);
  if (!data.projects[name]) return [];
  const log = Array.isArray(data.projects[name].messageLog)
    ? data.projects[name].messageLog
    : [];
  if (!since) return log.slice();
  return log.filter(e => e.ts && e.ts > since);
}

/**
 * Returns all projects that have a sessionId, sorted by lastUsedAt desc.
 */
function listActiveProjects() {
  const data = store.getData();
  _ensureProjects(data);
  return Object.entries(data.projects)
    .filter(([, p]) => p.sessionId)
    .map(([name, p]) => ({
      name,
      sessionId: p.sessionId,
      lastUsedAt: p.lastUsedAt || null
    }))
    .sort((a, b) => {
      if (!a.lastUsedAt && !b.lastUsedAt) return 0;
      if (!a.lastUsedAt) return 1;
      if (!b.lastUsedAt) return -1;
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    });
}

module.exports = {
  getProjectState,
  setSessionId,
  touchProject,
  clearSession,
  appendMessage,
  getMessageLog,
  listActiveProjects
};
