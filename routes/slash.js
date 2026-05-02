'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const session = require('../auth/session');
const builtinSlash = require('../lib/builtinSlash');
const skillCache = require('../lib/skillCache');

const router = express.Router();

// ---------------------------------------------------------------------------
// Custom commands: parse ~/.claude/commands/*.md with 30-second mtime cache
// ---------------------------------------------------------------------------

const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');
const CACHE_TTL_MS = 30 * 1000;

let _customCache = null;
let _customCacheTime = 0;

function parseDescription(content) {
  // Look for frontmatter region between --- lines
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const descMatch = fm[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
  }
  return null;
}

function loadCustomCommands() {
  const now = Date.now();
  if (_customCache !== null && now - _customCacheTime < CACHE_TTL_MS) {
    return _customCache;
  }

  const result = [];
  try {
    const entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;

      const filePath = path.join(COMMANDS_DIR, entry.name);
      let content;
      try {
        // Read first 1KB only
        const buf = Buffer.alloc(1024);
        const fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
        fs.closeSync(fd);
        content = buf.slice(0, bytesRead).toString('utf8');
      } catch (_) {
        continue;
      }

      const basename = entry.name.slice(0, -3); // remove .md
      const desc = parseDescription(content) || basename;

      result.push({
        name: '/' + basename,
        description: desc,
        kind: 'custom'
      });
    }
  } catch (_) {
    // Directory doesn't exist or unreadable — tolerate silently
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  _customCache = result;
  _customCacheTime = now;
  return result;
}

// ---------------------------------------------------------------------------
// Plugin commands & skills: scan ~/.claude/plugins/cache/*/*/*/{commands,skills}
// ---------------------------------------------------------------------------

const PLUGIN_CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache');

let _pluginCache = null;
let _pluginCacheTime = 0;

function safeReadFirstKB(filePath) {
  try {
    const buf = Buffer.alloc(2048);
    const fd = fs.openSync(filePath, 'r');
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; }
}

function readPluginName(versionDir) {
  // Prefer .claude-plugin/plugin.json's "name" field; fall back to the
  // directory two levels above the version (the plugin name).
  const jsonPath = path.join(versionDir, '.claude-plugin', 'plugin.json');
  try {
    const txt = fs.readFileSync(jsonPath, 'utf8');
    const j = JSON.parse(txt);
    if (j && typeof j.name === 'string' && j.name) return j.name;
  } catch (_) {}
  // Fallback: parent dir name (the plugin directory)
  return path.basename(path.dirname(versionDir));
}

function scanPluginCommands(versionDir, pluginName) {
  const out = [];
  const cmdDir = path.join(versionDir, 'commands');
  let entries;
  try { entries = fs.readdirSync(cmdDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
    const base = e.name.slice(0, -3);
    const desc = parseDescription(safeReadFirstKB(path.join(cmdDir, e.name))) || base;
    out.push({
      name: '/' + pluginName + ':' + base,
      description: desc,
      kind: 'plugin'
    });
  }
  return out;
}

function scanPluginSkills(versionDir, pluginName) {
  const out = [];
  const skillsDir = path.join(versionDir, 'skills');
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    // Skill description lives in SKILL.md frontmatter (or skill.md)
    let desc = e.name;
    for (const fname of ['SKILL.md', 'skill.md']) {
      const p = path.join(skillsDir, e.name, fname);
      const c = safeReadFirstKB(p);
      if (c) {
        const d = parseDescription(c);
        if (d) { desc = d; break; }
      }
    }
    out.push({
      name: '/' + pluginName + ':' + e.name,
      description: desc,
      kind: 'plugin'
    });
  }
  return out;
}

function loadPluginCommands() {
  const now = Date.now();
  if (_pluginCache !== null && now - _pluginCacheTime < CACHE_TTL_MS) {
    return _pluginCache;
  }

  const result = [];
  let marketplaces;
  try { marketplaces = fs.readdirSync(PLUGIN_CACHE_DIR, { withFileTypes: true }); }
  catch (_) { marketplaces = []; }

  for (const m of marketplaces) {
    if (!m.isDirectory() || m.name.startsWith('.') || m.name === 'marketplaces') continue;
    const mDir = path.join(PLUGIN_CACHE_DIR, m.name);
    let plugins;
    try { plugins = fs.readdirSync(mDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const p of plugins) {
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      const pDir = path.join(mDir, p.name);
      let versions;
      try { versions = fs.readdirSync(pDir, { withFileTypes: true }); } catch (_) { continue; }
      // Pick the first directory that looks like a version (most plugins have one)
      const version = versions.find((v) => v.isDirectory() && !v.name.startsWith('.'));
      if (!version) continue;
      const versionDir = path.join(pDir, version.name);
      const pluginName = readPluginName(versionDir);
      result.push(...scanPluginCommands(versionDir, pluginName));
      result.push(...scanPluginSkills(versionDir, pluginName));
    }
  }

  // Dedupe by name (in case a plugin's slash command is also exposed as a skill)
  const seen = new Set();
  const deduped = [];
  for (const item of result) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    deduped.push(item);
  }
  deduped.sort((a, b) => a.name.localeCompare(b.name));

  _pluginCache = deduped;
  _pluginCacheTime = now;
  return deduped;
}

// ---------------------------------------------------------------------------
// GET /api/slash-commands
// ---------------------------------------------------------------------------

router.get('/api/slash-commands', session.requireAuth, (req, res) => {
  const cache = skillCache.get();

  const builtIn = builtinSlash.map((c) => ({
    name: c.name,
    description: c.description,
    kind: 'built-in'
  }));

  const skills = (cache.skills || []).map((s) => ({
    name: (typeof s === 'string' ? s : (s.name || String(s))).startsWith('/')
      ? (typeof s === 'string' ? s : s.name)
      : '/' + (typeof s === 'string' ? s : s.name),
    description: (typeof s === 'object' && s.description) ? s.description : '',
    kind: 'skill'
  }));

  const agents = (cache.agents || []).map((a) => ({
    name: typeof a === 'string' ? a : (a.name || String(a)),
    description: (typeof a === 'object' && a.description) ? a.description : '',
    kind: 'agent'
  }));

  const custom = loadCustomCommands();
  const plugins = loadPluginCommands();

  res.json({ built_in: builtIn, skills, agents, custom, plugins });
});

module.exports = router;
