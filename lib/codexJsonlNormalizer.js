'use strict';

/**
 * codexJsonlNormalizer — converts raw lines from a Codex CLI session jsonl
 * file into the same normalized event union that jsonlNormalizer.js produces
 * for Claude Code transcripts. The frontend renderer in chat-live.js can then
 * consume both sources without any renderer changes.
 *
 * Codex jsonl schema (verified against real sessions):
 *
 *   { timestamp, type: "session_meta",  payload: { id, cwd, model_provider, ... } }
 *   { timestamp, type: "turn_context",  payload: { cwd, model, sandbox_policy, ... } }
 *   { timestamp, type: "event_msg",     payload: { type: "user_message",   message } }
 *   { timestamp, type: "event_msg",     payload: { type: "agent_message",  message } }
 *   { timestamp, type: "event_msg",     payload: { type: "agent_reasoning",text    } }
 *   { timestamp, type: "event_msg",     payload: { type: "item_completed", item    } }
 *   { timestamp, type: "event_msg",     payload: { type: "token_count",    ...     } }
 *   { timestamp, type: "response_item", payload: { type: "message", role, content:[{type:"output_text"|"input_text", text}] } }
 *   { timestamp, type: "response_item", payload: { type: "function_call",        name, arguments, call_id } }
 *   { timestamp, type: "response_item", payload: { type: "function_call_output", call_id, output } }
 *   { timestamp, type: "response_item", payload: { type: "custom_tool_call",     name, input, call_id, status } }
 *   { timestamp, type: "response_item", payload: { type: "custom_tool_call_output", call_id, output } }
 *   { timestamp, type: "response_item", payload: { type: "reasoning", summary:[{type:"summary_text",text}], encrypted_content } }
 *
 * Mapping strategy:
 *   session_meta, turn_context         → [] (filtered)
 *   event_msg / user_message           → user_text
 *   event_msg / agent_message          → assistant_text
 *   event_msg / agent_reasoning        → assistant_thinking
 *   event_msg / item_completed         → [] (internal plan state, not user-visible)
 *   event_msg / token_count            → [] (telemetry)
 *   response_item / message (assistant)→ assistant_text (one event per output_text block)
 *   response_item / message (user/dev) → [] (context injection, not user-visible)
 *   response_item / function_call      → tool_use
 *   response_item / function_call_output → tool_result
 *   response_item / custom_tool_call   → tool_use  (apply_patch etc.)
 *   response_item / custom_tool_call_output → tool_result
 *   response_item / reasoning          → assistant_thinking (decrypted summary only)
 *   anything else                      → unknown
 */

const fs = require('fs');
const { createEventsCache } = require('./normalizerCache');

// Entry types that carry no user-visible payload.
const FILTERED_TYPES = new Set([
  'session_meta',
  'turn_context',
]);

function pickTs(raw) {
  if (raw && typeof raw.timestamp === 'string') return raw.timestamp;
  return null;
}

/**
 * Safe-parse a JSON string. Returns the parsed value on success, or the
 * original string as a fallback so we never lose information.
 */
function safeParse(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch (_) { return str; }
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
  const payload = (raw.payload && typeof raw.payload === 'object') ? raw.payload : {};
  const ptype = payload.type;

  // ── event_msg ────────────────────────────────────────────────────────────
  if (type === 'event_msg') {
    if (ptype === 'user_message') {
      const text = typeof payload.message === 'string' ? payload.message : '';
      if (!text) return [];
      return [{ kind: 'user_text', text, ts }];
    }

    if (ptype === 'agent_message') {
      const text = typeof payload.message === 'string' ? payload.message : '';
      if (!text) return [];
      // messageId and blockIndex not available at this layer; use null / 0.
      return [{ kind: 'assistant_text', messageId: null, text, blockIndex: 0, ts }];
    }

    if (ptype === 'agent_reasoning') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) return [];
      return [{ kind: 'assistant_thinking', messageId: null, text, blockIndex: 0, ts }];
    }

    // item_completed (plan state), token_count (telemetry) → drop silently.
    if (ptype === 'item_completed' || ptype === 'token_count') return [];

    // Unknown event_msg subtype.
    return [{ kind: 'unknown', raw, ts }];
  }

  // ── response_item ─────────────────────────────────────────────────────────
  if (type === 'response_item') {

    // ── message ──────────────────────────────────────────────────────────────
    if (ptype === 'message') {
      const role = payload.role;
      // Only assistant messages are user-visible in the transcript.
      if (role !== 'assistant') return [];

      const content = Array.isArray(payload.content) ? payload.content : [];
      const messageId = typeof payload.id === 'string' ? payload.id : null;
      const out = [];
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block || typeof block !== 'object') continue;
        // Codex uses "output_text" for assistant output; "input_text" appears
        // in developer/user injections which we filtered above by role check.
        const btype = block.type;
        if (btype === 'output_text' || btype === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (!text) continue;
          out.push({ kind: 'assistant_text', messageId, text, blockIndex: i, ts });
        } else {
          out.push({ kind: 'unknown', raw: block, ts });
        }
      }
      return out;
    }

    // ── function_call (standard OpenAI tool call) ────────────────────────────
    if (ptype === 'function_call') {
      return [{
        kind: 'tool_use',
        messageId: typeof payload.id === 'string' ? payload.id : null,
        toolUseId: typeof payload.call_id === 'string' ? payload.call_id : null,
        name: typeof payload.name === 'string' ? payload.name : null,
        // arguments is a JSON-encoded string in the OpenAI schema.
        input: safeParse(payload.arguments) ?? {},
        blockIndex: 0,
        ts
      }];
    }

    // ── function_call_output ─────────────────────────────────────────────────
    if (ptype === 'function_call_output') {
      return [{
        kind: 'tool_result',
        toolUseId: typeof payload.call_id === 'string' ? payload.call_id : null,
        content: payload.output != null ? payload.output : '',
        isError: false,
        ts
      }];
    }

    // ── custom_tool_call (apply_patch and similar Codex-native tools) ────────
    // payload.input is already a string (the patch body), not JSON.
    if (ptype === 'custom_tool_call') {
      return [{
        kind: 'tool_use',
        messageId: null,
        toolUseId: typeof payload.call_id === 'string' ? payload.call_id : null,
        name: typeof payload.name === 'string' ? payload.name : null,
        // input is a raw patch string; wrap in an object to match the union.
        input: { raw: payload.input != null ? payload.input : '' },
        blockIndex: 0,
        ts
      }];
    }

    // ── custom_tool_call_output ──────────────────────────────────────────────
    if (ptype === 'custom_tool_call_output') {
      // output is a JSON string: {"output":"...","metadata":{...}}; safe-parse it.
      const parsed = safeParse(payload.output);
      const content = (parsed && typeof parsed === 'object' && parsed.output != null)
        ? parsed.output
        : (payload.output != null ? payload.output : '');
      return [{
        kind: 'tool_result',
        toolUseId: typeof payload.call_id === 'string' ? payload.call_id : null,
        content,
        isError: false,
        ts
      }];
    }

    // ── reasoning (encrypted; only the summary is readable) ─────────────────
    if (ptype === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const parts = summary
        .filter(s => s && (s.type === 'summary_text' || s.type === 'text'))
        .map(s => (typeof s.text === 'string' ? s.text : ''))
        .filter(Boolean);
      if (!parts.length) return [];
      return [{
        kind: 'assistant_thinking',
        messageId: typeof payload.id === 'string' ? payload.id : null,
        text: parts.join('\n'),
        blockIndex: 0,
        ts
      }];
    }

    // Unknown response_item subtype.
    return [{ kind: 'unknown', raw, ts }];
  }

  // ── Anything else ─────────────────────────────────────────────────────────
  return [{ kind: 'unknown', raw, ts }];
}

// Append-aware LRU cache shared with the other agents — see normalizerCache.
const { loadEntireTranscript, getCachedEvents } = createEventsCache(normalizeEntry);

module.exports = {
  normalizeEntry,
  loadEntireTranscript,
  getCachedEvents,
  FILTERED_TYPES
};
