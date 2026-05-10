'use strict';

/**
 * hermesSlash — list slash commands available inside a Hermes Agent CLI
 * session. Mirrors codexSlash.js but reflects the hermes layout:
 *
 *   ~/.hermes/skills/<category>/<name>/SKILL.md   (2-level nested)
 *   ~/.hermes/commands/*.md                       (optional, may not exist)
 *
 * Hermes builtin slash commands are derived from the CLI's interactive REPL
 * (e.g. /help, /skills, /model). This list is conservative — anything we
 * don't list still types fine; we just don't surface it in the picker.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTime = 0;

const HERMES_BUILTINS = [
  { name: '/help',       description: 'Print help / list all commands' },
  { name: '/clear',      description: 'Clear the conversation' },
  { name: '/exit',       description: 'Exit hermes' },
  { name: '/quit',       description: 'Same as /exit' },
  { name: '/model',      description: 'Change model' },
  { name: '/skills',     description: 'List or load a skill' },
  { name: '/memory',     description: 'View / edit agent memory' },
  { name: '/rollback',   description: 'Roll back to a filesystem checkpoint' },
  { name: '/checkpoint', description: 'Create a filesystem checkpoint' },
  { name: '/tools',      description: 'Toggle toolsets for this session' },
  { name: '/login',      description: 'Authenticate with an inference provider' },
  { name: '/logout',     description: 'Sign out of an inference provider' },
];

const HERMES_HOME   = path.join(os.homedir(), '.hermes');
const SKILLS_DIR    = path.join(HERMES_HOME, 'skills');
const COMMANDS_DIR  = path.join(HERMES_HOME, 'commands');

function parseFrontmatterField(content, field) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const re = new RegExp('^' + field + ':\\s*(.+)$', 'm');
  const m = fm[1].match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function safeReadFirstKB(filePath) {
  try {
    const buf = Buffer.alloc(2048);
    const fd = fs.openSync(filePath, 'r');
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; }
}

/**
 * Walk ~/.hermes/skills/<category>/<name>/SKILL.md (2-level), produce a flat
 * list of slash entries keyed by skill name. Categories with no SKILL.md
 * (e.g. just a DESCRIPTION.md) are skipped.
 */
function loadSkills() {
  const result = [];
  let categories;
  try { categories = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); }
  catch (_) { return result; }

  for (const cat of categories) {
    if (!cat.isDirectory()) continue;
    if (cat.name.startsWith('.')) continue;

    const catDir = path.join(SKILLS_DIR, cat.name);
    let skills;
    try { skills = fs.readdirSync(catDir, { withFileTypes: true }); }
    catch (_) { continue; }

    for (const sk of skills) {
      if (!sk.isDirectory()) continue;
      if (sk.name.startsWith('.')) continue;

      const skillMd = path.join(catDir, sk.name, 'SKILL.md');
      try { fs.statSync(skillMd); } catch (_) { continue; }

      // Reject symlinks pointing outside the hermes tree.
      const dirPath = path.join(catDir, sk.name);
      try {
        const lstat = fs.lstatSync(dirPath);
        if (lstat.isSymbolicLink()) {
          const real = fs.realpathSync(dirPath);
          if (!real.startsWith(HERMES_HOME)) continue;
        }
      } catch (_) { continue; }

      const content = safeReadFirstKB(skillMd);
      const desc = parseFrontmatterField(content, 'description') || sk.name;
      result.push({ name: '/' + sk.name, description: desc, kind: 'skill' });
    }
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
    const desc = parseFrontmatterField(content, 'description') || basename;
    result.push({ name: '/' + basename, description: desc, kind: 'custom' });
  }
  return result;
}

function listHermesSlash() {
  const now = Date.now();
  if (_cache !== null && now - _cacheTime < CACHE_TTL_MS) return _cache;

  const builtins = HERMES_BUILTINS.map((c) => ({ ...c, kind: 'builtin' }));
  const skills   = loadSkills();
  const custom   = loadCustomCommands();

  // Dedup by name — skills can collide with builtin if a hermes builtin
  // shares a name; builtins win.
  const seen = new Set();
  const merged = [];
  for (const item of [...builtins, ...skills, ...custom]) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    merged.push(item);
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));

  _cache = merged;
  _cacheTime = now;
  return merged;
}

module.exports = { listHermesSlash };
