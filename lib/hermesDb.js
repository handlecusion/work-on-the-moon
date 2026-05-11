'use strict';

/**
 * hermesDb — read-only access to ~/.hermes/state.db (SQLite).
 *
 * Hermes stores its authoritative session state in SQLite, not in jsonl
 * files. The `.jsonl` files under ~/.hermes/sessions/ are a side-channel
 * that hermes only writes in certain modes (e.g. when launched from
 * specific gateway flows). For ordinary `hermes chat` invocations the
 * transcript lives entirely in the `messages` table.
 *
 * We shell out to the system `sqlite3` CLI rather than adding a native
 * better-sqlite3 dependency. The CLI is preinstalled on every macOS
 * (the project is darwin-only) and `sqlite3 -json -readonly` against a
 * WAL-mode database is concurrent-safe with hermes's writes.
 *
 * Per-query latency is ~10-20 ms, which is fine for our polling cadence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const STATE_DB = path.join(os.homedir(), '.hermes', 'state.db');
const SQLITE_BIN = '/usr/bin/sqlite3';
const QUERY_TIMEOUT_MS = 3000;

function dbExists() {
  try { fs.accessSync(STATE_DB, fs.constants.R_OK); return true; }
  catch (_) { return false; }
}

/**
 * Run a query and parse the JSON array output. Returns [] on any error
 * (missing db, locked, malformed JSON). Never throws.
 */
function runQuery(sql, opts) {
  return new Promise((resolve) => {
    if (!dbExists()) return resolve([]);
    const args = ['-json', '-readonly', STATE_DB, sql];
    const child = execFile(SQLITE_BIN, args, { timeout: QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const text = String(stdout || '').trim();
      if (!text) return resolve([]);
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (_) { return resolve([]); }
      resolve(Array.isArray(parsed) ? parsed : []);
    });
    // execFile handles timeout; nothing extra to do here.
  });
}

/**
 * Escape a SQL string literal for embedding. Hermes session ids are well-
 * formed timestamps but we belt-and-suspenders this since the values cross
 * a shell-out boundary.
 */
function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * Return the list of currently-active CLI sessions (no ended_at), ordered
 * by most recent activity first. Each row: { id, started_at, message_count,
 * title }. started_at is unix epoch seconds (float).
 *
 * "Most recent activity" is approximated by the max(message.timestamp) for
 * each session — sessions with newer messages bubble up. Falls back to
 * started_at when the session has no messages yet.
 */
async function listActiveCliSessions() {
  const sql =
    'SELECT s.id        AS id,' +
    '       s.started_at AS started_at,' +
    '       s.message_count AS message_count,' +
    '       s.title     AS title,' +
    '       COALESCE((SELECT MAX(timestamp) FROM messages WHERE session_id = s.id), s.started_at) AS last_ts ' +
    'FROM sessions s ' +
    "WHERE s.source = 'cli' AND s.ended_at IS NULL " +
    'ORDER BY last_ts DESC LIMIT 50';
  return runQuery(sql);
}

/**
 * Load all messages for a session, ordered by timestamp. Each row maps to
 * the jsonl-style entry that hermesJsonlNormalizer.normalizeEntry expects
 * — see rowToJsonlEntry() below.
 */
async function loadMessages(sessionId) {
  if (!sessionId) return [];
  const sql =
    'SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp,' +
    '       reasoning, reasoning_content, finish_reason ' +
    'FROM messages WHERE session_id = ' + sqlString(sessionId) + ' ' +
    'ORDER BY timestamp, id';
  return runQuery(sql);
}

/**
 * Load only the messages with timestamp > sinceTs. Used by the live tailer
 * so a poll only ships new rows.
 */
async function loadMessagesSince(sessionId, sinceTs) {
  if (!sessionId) return [];
  const where = sinceTs != null
    ? 'session_id = ' + sqlString(sessionId) + ' AND timestamp > ' + Number(sinceTs)
    : 'session_id = ' + sqlString(sessionId);
  const sql =
    'SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp,' +
    '       reasoning, reasoning_content, finish_reason ' +
    'FROM messages WHERE ' + where + ' ' +
    'ORDER BY timestamp, id';
  return runQuery(sql);
}

/**
 * Quick "last activity" probe used by the scanner — single column, no
 * heavy data. Returns the latest message timestamp (unix epoch seconds)
 * or null when the session has no messages yet.
 */
async function getLatestTimestamp(sessionId) {
  if (!sessionId) return null;
  const sql = 'SELECT MAX(timestamp) AS ts FROM messages WHERE session_id = ' + sqlString(sessionId);
  const rows = await runQuery(sql);
  if (!rows.length) return null;
  const ts = rows[0].ts;
  return (typeof ts === 'number') ? ts : null;
}

/**
 * Translate a `messages` row into the same jsonl-style shape that
 * hermesJsonlNormalizer.normalizeEntry consumes. Lets us reuse the
 * normalizer for DB-sourced events too.
 */
function rowToJsonlEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {
    role: row.role,
    content: row.content,
    timestamp: (typeof row.timestamp === 'number')
      ? new Date(row.timestamp * 1000).toISOString()
      : undefined
  };
  if (row.tool_call_id) out.tool_call_id = row.tool_call_id;
  if (row.tool_name)    out.name         = row.tool_name;
  if (row.tool_calls) {
    try { out.tool_calls = JSON.parse(row.tool_calls); }
    catch (_) { out.tool_calls = []; }
  }
  if (row.reasoning)         out.reasoning         = row.reasoning;
  if (row.reasoning_content) out.reasoning_content = row.reasoning_content;
  if (row.finish_reason)     out.finish_reason     = row.finish_reason;
  return out;
}

module.exports = {
  STATE_DB,
  dbExists,
  listActiveCliSessions,
  loadMessages,
  loadMessagesSince,
  getLatestTimestamp,
  rowToJsonlEntry
};
