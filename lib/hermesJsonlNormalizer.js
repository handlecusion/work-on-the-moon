'use strict';

/**
 * hermesJsonlNormalizer — converts raw lines from a Hermes Agent session
 * jsonl file into the same normalized event union that jsonlNormalizer.js
 * (claude) and codexJsonlNormalizer.js produce. This lets the existing
 * chat-live renderer consume hermes transcripts without changes.
 *
 * Hermes jsonl schema (verified against ~/.hermes/sessions/*.jsonl):
 *
 *   {"role":"session_meta","tools":[…],"model":"…","platform":"…","timestamp":"…"}
 *   {"role":"user","content":"…","timestamp":"…"}
 *   {"role":"assistant","content":"…","reasoning":null|"…","reasoning_content":"…",
 *      "finish_reason":"stop","timestamp":"…"}
 *   {"role":"assistant","content":"","reasoning":"…","reasoning_content":"…",
 *      "finish_reason":"tool_calls","tool_calls":[
 *        {"id":"call_…","call_id":"call_…","type":"function",
 *         "function":{"name":"…","arguments":"<json-string>"}}],
 *      "timestamp":"…"}
 *   {"role":"tool","name":"…","content":"…","tool_call_id":"call_…","timestamp":"…"}
 *   {"role":"system","content":"…","timestamp":"…"}   (rarely seen)
 *
 * Mapping strategy:
 *   session_meta              → []
 *   user                      → user_text
 *   assistant + content       → assistant_text   (+ assistant_thinking from reasoning)
 *   assistant + tool_calls    → tool_use[]       (+ assistant_thinking from reasoning,
 *                                                  + assistant_text if content is non-empty)
 *   tool                      → tool_result
 *   system                    → []  (context injection, not user-visible)
 */

const fs = require('fs');

const FILTERED_ROLES = new Set(['session_meta', 'system']);

function pickTs(raw) {
  if (raw && typeof raw.timestamp === 'string') return raw.timestamp;
  return null;
}

function safeParse(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch (_) { return str; }
}

function reasoningText(raw) {
  // Hermes uses two parallel fields; prefer reasoning_content (model output)
  // but fall back to reasoning for older sessions.
  const a = typeof raw.reasoning_content === 'string' ? raw.reasoning_content : '';
  const b = typeof raw.reasoning           === 'string' ? raw.reasoning           : '';
  // Filter out the literal sentinel strings 'None' and 'null' that some
  // hermes versions write when reasoning was not produced.
  const pick = a || b;
  if (!pick) return '';
  if (pick === 'None' || pick === 'null') return '';
  return pick;
}

/**
 * Normalize a single raw jsonl entry into an array of events.
 * Always returns an array (possibly empty). Never throws.
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const role = raw.role;
  if (!role) return [];
  if (FILTERED_ROLES.has(role)) return [];

  const ts = pickTs(raw);

  // ── user ─────────────────────────────────────────────────────────
  if (role === 'user') {
    const text = typeof raw.content === 'string' ? raw.content : '';
    if (!text) return [];
    return [{ kind: 'user_text', text, ts }];
  }

  // ── assistant ────────────────────────────────────────────────────
  if (role === 'assistant') {
    const out = [];

    const think = reasoningText(raw);
    if (think) {
      out.push({ kind: 'assistant_thinking', messageId: null, text: think, blockIndex: 0, ts });
    }

    // Assistant text — only when the message has visible content. When the
    // turn is purely tool calls, content may be '' or null; skip it.
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (content) {
      out.push({ kind: 'assistant_text', messageId: null, text: content, blockIndex: 0, ts });
    }

    // Tool calls — emit a tool_use per entry. Hermes uses the OpenAI shape
    // where `function.arguments` is a JSON-encoded string.
    const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!c || typeof c !== 'object') continue;
      const fn = (c.function && typeof c.function === 'object') ? c.function : {};
      const name = typeof fn.name === 'string' ? fn.name : null;
      const argsRaw = fn.arguments;
      const input = (typeof argsRaw === 'string') ? safeParse(argsRaw) : (argsRaw || {});
      // Prefer call_id (semantic key used by tool_call_id back-link) over id.
      const toolUseId = typeof c.call_id === 'string'
        ? c.call_id
        : (typeof c.id === 'string' ? c.id : null);
      out.push({
        kind: 'tool_use',
        messageId: null,
        toolUseId,
        name,
        input: (input == null ? {} : input),
        blockIndex: i,
        ts
      });
    }

    return out;
  }

  // ── tool ─────────────────────────────────────────────────────────
  if (role === 'tool') {
    const toolUseId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : null;
    const content = raw.content != null ? raw.content : '';
    return [{
      kind: 'tool_result',
      toolUseId,
      content,
      isError: false,
      ts
    }];
  }

  // ── anything else ────────────────────────────────────────────────
  return [{ kind: 'unknown', raw, ts }];
}

/**
 * Stream-read an entire Hermes session transcript and return a flat array of
 * normalized events. Tolerates partial / unparseable trailing lines.
 * Never throws — returns [] on any I/O error.
 */
function loadEntireTranscript(jsonlPath) {
  if (!jsonlPath) return [];
  let buf;
  try {
    buf = fs.readFileSync(jsonlPath, 'utf8');
  } catch (_) {
    return [];
  }
  if (!buf) return [];
  const lines = buf.split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const events = normalizeEntry(raw);
    for (const ev of events) out.push(ev);
  }
  return out;
}

// ── In-memory LRU cache for normalized transcript arrays ────────────
const MAX_CACHE_ENTRIES = 10;
const _eventsCache = new Map();

function getCachedEvents(jsonlPath) {
  if (!jsonlPath) return [];
  let currentMtime;
  try {
    currentMtime = fs.statSync(jsonlPath).mtime.getTime();
  } catch (_) {
    return [];
  }
  const cached = _eventsCache.get(jsonlPath);
  if (cached && cached.mtime === currentMtime) {
    cached.lastAccess = Date.now();
    return cached.events;
  }
  const events = loadEntireTranscript(jsonlPath);
  if (_eventsCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _eventsCache) {
      if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
    }
    if (oldestKey != null) _eventsCache.delete(oldestKey);
  }
  _eventsCache.set(jsonlPath, { mtime: currentMtime, events, lastAccess: Date.now() });
  return events;
}

module.exports = {
  normalizeEntry,
  loadEntireTranscript,
  getCachedEvents,
  FILTERED_ROLES
};
