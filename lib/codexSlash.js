'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTime = 0;

const CODEX_BUILTINS = [
  { name: '/apply',    description: 'Apply a previously generated diff' },
  { name: '/clear',    description: 'Clear the conversation' },
  { name: '/compact',  description: 'Compact the conversation history' },
  { name: '/diff',     description: 'Show diff' },
  { name: '/exit',     description: 'Same as /quit' },
  { name: '/feedback', description: 'Submit feedback' },
  { name: '/help',     description: 'Print help / list all commands' },
  { name: '/init',     description: 'Initialize a project for codex' },
  { name: '/login',    description: 'Manage codex login' },
  { name: '/logout',   description: 'Sign out of codex' },
  { name: '/model',    description: 'Change model' },
  { name: '/quit',     description: 'Exit codex' },
  { name: '/skill',    description: 'Use an installed skill' },
];

const CODEX_HOME = path.join(os.homedir(), '.codex');
const SKILLS_DIR  = path.join(CODEX_HOME, 'skills');
const COMMANDS_DIR = path.join(CODEX_HOME, 'commands');

function parseDescription(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const m = fm[1].match(/^description:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

function safeReadFirstKB(filePath) {
  try {
    const buf = Buffer.alloc(1024);
    const fd = fs.openSync(filePath, 'r');
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; }
}

function loadSkills() {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); }
  catch (_) { return result; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // skip .system and hidden dirs

    const skillMd = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    // Only include dirs that have a SKILL.md
    try { fs.statSync(skillMd); } catch (_) { continue; }

    // Skip symlinks pointing outside codex tree
    const dirPath = path.join(SKILLS_DIR, entry.name);
    try {
      const lstat = fs.lstatSync(dirPath);
      if (lstat.isSymbolicLink()) {
        const real = fs.realpathSync(dirPath);
        if (!real.startsWith(CODEX_HOME)) continue;
      }
    } catch (_) { continue; }

    const content = safeReadFirstKB(skillMd);
    const desc = parseDescription(content) || entry.name;
    result.push({ name: '/' + entry.name, description: desc, kind: 'skill' });
  }
  return result;
}

function loadCustomCommands() {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true }); }
  catch (_) { return result; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.startsWith('.')) continue;

    const filePath = path.join(COMMANDS_DIR, entry.name);
    const content = safeReadFirstKB(filePath);
    const basename = entry.name.slice(0, -3);
    const desc = parseDescription(content) || basename;
    result.push({ name: '/' + basename, description: desc, kind: 'custom' });
  }
  return result;
}

function listCodexSlash() {
  const now = Date.now();
  if (_cache !== null && now - _cacheTime < CACHE_TTL_MS) return _cache;

  const builtins = CODEX_BUILTINS.map((c) => ({ ...c, kind: 'builtin' }));
  const skills   = loadSkills();
  const custom   = loadCustomCommands();

  const merged = [...builtins, ...skills, ...custom];
  merged.sort((a, b) => a.name.localeCompare(b.name));

  _cache = merged;
  _cacheTime = now;
  return merged;
}

module.exports = { listCodexSlash };
