'use strict';

/**
 * jsonlNormalizer — converts raw lines from a Claude Code transcript jsonl
 * file into the same normalized event union that `lib/claudeRunner.js`
 * emits. The frontend renderer in `chat.js` understands these events, so
 * the live-attach feature (PR-E2) can reuse the renderer with zero changes
 * beyond a thin tail loop.
 *
 * One raw entry can yield 0, 1, or many normalized events:
 *   - filtered metadata entries (`last-prompt`, `permission-mode`,
 *     `attachment`, `file-history-snapshot`, `summary`) → []
 *   - assistant message with N content blocks → up to N events
 *   - user message with content array containing both text and
 *     tool_result blocks → multiple events
 *
 * No I/O at this layer except `loadEntireTranscript`, which streams the
 * whole file once on initial attach.
 */

const fs = require('fs');

// Entry types that carry no user-visible payload — we drop them silently
// so the frontend renderer doesn't have to care.
const FILTERED_TYPES = new Set([
  'last-prompt',
  'permission-mode',
  'attachment',
  'file-history-snapshot',
  'summary',
  // Additional metadata types observed in real transcripts:
  'ai-title',         // auto-generated session titles
  'pr-link',          // cmux PR linking
  'queue-operation',  // cmux queue state
  'system'            // local system events (not the API 'assistant' system)
]);

function pickTs(raw) {
  if (raw && typeof raw.timestamp === 'string') return raw.timestamp;
  return null;
}

function pickMessageId(message) {
  if (!message || typeof message !== 'object') return null;
  return typeof message.id === 'string' ? message.id : null;
}

/**
 * Normalize a single raw jsonl entry into an array of events.
 * Always returns an array (possibly empty). Never throws.
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return [];

  const type = raw.type;

  if (FILTERED_TYPES.has(type)) return [];

  const ts = pickTs(raw);

  // ── User entry ────────────────────────────────────────────────────────
  if (type === 'user') {
    const message = raw.message || {};
    const content = message.content;

    // String content → one user_text event
    if (typeof content === 'string') {
      const text = content;
      if (!text) return [];
      return [{ kind: 'user_text', text, ts }];
    }

    // Array content → walk blocks, concatenate text blocks, keep
    // tool_result blocks as separate events.
    if (Array.isArray(content)) {
      const out = [];
      const textParts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            textParts.push(block.text);
          }
        } else if (block.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
            content: block.content != null ? block.content : '',
            isError: block.is_error === true,
            ts
          });
        } else {
          // Any other block kind under user role we forward as unknown so
          // we don't silently drop information.
          out.push({ kind: 'unknown', raw: block, ts });
        }
      }
      if (textParts.length > 0) {
        // Concatenate so the renderer shows a single bubble.
        out.unshift({ kind: 'user_text', text: textParts.join('\n'), ts });
      }
      return out;
    }

    return [];
  }

  // ── Assistant entry ──────────────────────────────────────────────────
  if (type === 'assistant') {
    const message = raw.message || {};
    const messageId = pickMessageId(message);
    const content = message.content;

    // Some assistant entries store a string directly (rare). Treat as
    // single text block.
    if (typeof content === 'string') {
      if (!content) return [];
      return [{
        kind: 'assistant_text',
        messageId,
        text: content,
        blockIndex: 0,
        ts
      }];
    }

    if (!Array.isArray(content)) return [];

    const out = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || typeof block !== 'object') continue;
      const btype = block.type;
      if (btype === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text) continue;
        out.push({ kind: 'assistant_text', messageId, text, blockIndex: i, ts });
      } else if (btype === 'thinking') {
        const text = typeof block.thinking === 'string'
          ? block.thinking
          : (typeof block.text === 'string' ? block.text : '');
        if (!text) continue;
        out.push({ kind: 'assistant_thinking', messageId, text, blockIndex: i, ts });
      } else if (btype === 'tool_use') {
        out.push({
          kind: 'tool_use',
          messageId,
          toolUseId: typeof block.id === 'string' ? block.id : null,
          name: typeof block.name === 'string' ? block.name : null,
          input: block.input != null ? block.input : {},
          blockIndex: i,
          ts
        });
      } else {
        out.push({ kind: 'unknown', raw: block, ts });
      }
    }
    return out;
  }

  // ── Anything else ────────────────────────────────────────────────────
  return [{ kind: 'unknown', raw, ts }];
}

/**
 * Stream-read an entire transcript and return a flat array of normalized
 * events. Tolerates partial / unparseable trailing lines.
 *
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
      continue; // skip partial / corrupt
    }
    const events = normalizeEntry(raw);
    for (const ev of events) out.push(ev);
  }
  return out;
}

module.exports = {
  normalizeEntry,
  loadEntireTranscript,
  FILTERED_TYPES
};
