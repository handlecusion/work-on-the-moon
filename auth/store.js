'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = path.join(os.homedir(), '.claude-web');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_DATA = {
  passkeys: [],
  sessions: [],
  registrationTokens: [],
  currentChallenges: {},
  setupCompleted: false
};

let cache = null;
// In-memory mutex: chain async writes so they never overlap.
let writeChain = Promise.resolve();

function ensureDirSync() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadSync() {
  ensureDirSync();
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), { mode: 0o600 });
    cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
    return cache;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_DATA)), parsed);
    // Ensure all keys exist
    for (const k of Object.keys(DEFAULT_DATA)) {
      if (cache[k] === undefined) cache[k] = JSON.parse(JSON.stringify(DEFAULT_DATA[k]));
    }
    return cache;
  } catch (e) {
    console.error('[store] data.json corrupt; backing up and resetting:', e.message);
    const backup = DATA_FILE + '.corrupt.' + Date.now();
    try { fs.copyFileSync(DATA_FILE, backup); } catch (_) {}
    cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    return cache;
  }
}

function getData() {
  if (!cache) loadSync();
  return cache;
}

async function persist() {
  ensureDirSync();
  const tmp = DATA_FILE + '.tmp.' + crypto.randomBytes(6).toString('hex');
  const json = JSON.stringify(cache, null, 2);
  await fsp.writeFile(tmp, json, { mode: 0o600 });
  await fsp.rename(tmp, DATA_FILE);
}

/**
 * Mutate the data atomically. The mutator receives the in-memory data and
 * may modify it directly. Returns the mutator's return value.
 */
function update(mutator) {
  const run = async () => {
    if (!cache) loadSync();
    const result = await mutator(cache);
    await persist();
    return result;
  };
  // Chain so writes are serialized.
  const next = writeChain.then(run, run);
  // Don't let a failing run break the chain forever.
  writeChain = next.catch(() => {});
  return next;
}

// ---- Helpers used by routes ----

function pruneExpired() {
  const now = Date.now();
  const data = getData();
  const before = {
    sessions: data.sessions.length,
    regTokens: data.registrationTokens.length,
    challenges: Object.keys(data.currentChallenges).length
  };
  data.sessions = data.sessions.filter(s => Date.parse(s.expiresAt) > now);
  data.registrationTokens = data.registrationTokens.filter(t => Date.parse(t.expiresAt) > now && !t.used);
  for (const id of Object.keys(data.currentChallenges)) {
    if (Date.parse(data.currentChallenges[id].expiresAt) <= now) {
      delete data.currentChallenges[id];
    }
  }
  const changed =
    before.sessions !== data.sessions.length ||
    before.regTokens !== data.registrationTokens.length ||
    before.challenges !== Object.keys(data.currentChallenges).length;
  return changed;
}

async function pruneAndPersist() {
  await update(() => { pruneExpired(); });
}

function findSession(token) {
  if (!token) return null;
  pruneExpired();
  const data = getData();
  return data.sessions.find(s => s.token === token) || null;
}

function findRegistrationToken(token) {
  if (!token) return null;
  pruneExpired();
  const data = getData();
  return data.registrationTokens.find(t => t.token === token && !t.used) || null;
}

module.exports = {
  DATA_DIR,
  DATA_FILE,
  loadSync,
  getData,
  update,
  persist,
  pruneExpired,
  pruneAndPersist,
  findSession,
  findRegistrationToken
};
