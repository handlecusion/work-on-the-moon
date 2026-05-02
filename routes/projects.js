'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const session = require('../auth/session');

const router = express.Router();

const CODE_DIR = path.join(os.homedir(), 'Code');
const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Lazy-load projectStore to avoid circular deps at startup
let _projectStore = null;
function getProjectStore() {
  if (!_projectStore) _projectStore = require('../lib/projectStore');
  return _projectStore;
}

function listProjects() {
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
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

router.get('/api/projects', session.requireAuth, (req, res) => {
  const names = listProjects();
  const store = getProjectStore();
  const projects = names.map((name) => {
    const state = store.getProjectState(name);
    return { name, lastUsedAt: state.lastUsedAt || null };
  });
  // Sort: projects with lastUsedAt first (most recent), then alphabetical
  projects.sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.name.localeCompare(b.name);
  });
  res.json({ projects, root: CODE_DIR });
});

module.exports = { router, listProjects, CODE_DIR, NAME_RE };
