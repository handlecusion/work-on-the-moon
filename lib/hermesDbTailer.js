'use strict';

/**
 * hermesDbTailer — single-watcher-per-session poll tail of hermes state.db
 * `messages` rows. Mirrors the listener contract of `lib/liveTailer.js`
 * (onInit / onEvent / onMtimeChange / onClose) so routes/live.js can swap
 * tailers based on the agent's storage backend.
 *
 * Polls every POLL_INTERVAL_MS by querying messages with timestamp greater
 * than the highest one we've seen. New rows are normalized through the
 * shared hermesJsonlNormalizer (after a row→jsonl-entry adapter) and
 * delivered to every attached listener.
 */

const hermesDb = require('./hermesDb');
const hermesNormalizer = require('./hermesJsonlNormalizer');

const POLL_INTERVAL_MS = 2000;
const MAX_WATCHERS = 50;

// Map<sessionId, WatcherEntry>
//   listeners: Set<{onInit, onEvent, onMtimeChange, onClose}>
//   lastTimestamp: number | null  — latest message.timestamp we've shipped
//   pollTimer: NodeJS.Timeout | null
//   alive: boolean
const watchers = new Map();

function _broadcastEvent(entry, ev) {
  for (const listener of entry.listeners) {
    try { listener.onEvent && listener.onEvent(ev); } catch (_) {}
  }
}

function _broadcastMtime(entry, ts) {
  for (const listener of entry.listeners) {
    try { listener.onMtimeChange && listener.onMtimeChange(ts); } catch (_) {}
  }
}

function _broadcastClose(entry) {
  for (const listener of entry.listeners) {
    try { listener.onClose && listener.onClose(); } catch (_) {}
  }
}

function _rowsToEvents(rows) {
  const events = [];
  for (const r of rows) {
    const entry = hermesDb.rowToJsonlEntry(r);
    if (!entry) continue;
    const arr = hermesNormalizer.normalizeEntry(entry);
    for (const ev of arr) events.push(ev);
  }
  return events;
}

async function _pollOnce(sessionId) {
  const entry = watchers.get(sessionId);
  if (!entry || !entry.alive) return;

  const newRows = await hermesDb.loadMessagesSince(sessionId, entry.lastTimestamp);
  if (!newRows.length) return;

  let maxTs = entry.lastTimestamp;
  for (const r of newRows) {
    if (typeof r.timestamp === 'number' && (maxTs == null || r.timestamp > maxTs)) {
      maxTs = r.timestamp;
    }
  }
  entry.lastTimestamp = maxTs;

  const events = _rowsToEvents(newRows);
  for (const ev of events) _broadcastEvent(entry, ev);
  _broadcastMtime(entry, maxTs);
}

function _setupWatcher(sessionId, entry) {
  entry.pollTimer = setInterval(() => {
    _pollOnce(sessionId).catch(() => {});
  }, POLL_INTERVAL_MS);
  if (entry.pollTimer.unref) entry.pollTimer.unref();
}

function _teardown(sessionId) {
  const entry = watchers.get(sessionId);
  if (!entry) return;
  entry.alive = false;
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }
  entry.listeners.clear();
  watchers.delete(sessionId);
}

/**
 * Attach a listener to the hermes DB tail of `sessionId`. Replays the full
 * transcript via onInit synchronously, then keeps shipping new events on
 * each poll.
 */
async function attach(sessionId, listener) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('hermesDbTailer.attach: sessionId required');
  }
  if (!listener || typeof listener !== 'object') {
    throw new TypeError('hermesDbTailer.attach: listener required');
  }

  let entry = watchers.get(sessionId);
  if (!entry) {
    if (watchers.size >= MAX_WATCHERS) {
      throw new Error('hermesDbTailer: too many active watchers (' + MAX_WATCHERS + ')');
    }
    entry = {
      listeners: new Set(),
      lastTimestamp: null,
      pollTimer: null,
      alive: true
    };
    watchers.set(sessionId, entry);
    _setupWatcher(sessionId, entry);
  }

  // Replay the full transcript to THIS listener only. We track the highest
  // timestamp we've shipped so subsequent polls don't re-emit the replay.
  const rows = await hermesDb.loadMessages(sessionId);
  const events = _rowsToEvents(rows);
  let maxTs = entry.lastTimestamp;
  for (const r of rows) {
    if (typeof r.timestamp === 'number' && (maxTs == null || r.timestamp > maxTs)) {
      maxTs = r.timestamp;
    }
  }
  if (maxTs != null) entry.lastTimestamp = maxTs;

  try { listener.onInit && listener.onInit(events); } catch (_) {}

  entry.listeners.add(listener);

  return {
    detach() {
      const e = watchers.get(sessionId);
      if (!e) return;
      e.listeners.delete(listener);
      if (e.listeners.size === 0) {
        _teardown(sessionId);
      }
    }
  };
}

/**
 * Load the full transcript on demand without attaching a tailer — used by
 * routes/live.js init send and load_earlier when we just need the
 * snapshot. (Equivalent of normalizer.getCachedEvents for the DB path.)
 */
async function loadTranscript(sessionId) {
  const rows = await hermesDb.loadMessages(sessionId);
  return _rowsToEvents(rows);
}

function _stats() {
  return {
    sessionCount: watchers.size,
    listenerTotal: Array.from(watchers.values()).reduce((acc, e) => acc + e.listeners.size, 0)
  };
}

module.exports = { attach, loadTranscript, _stats, MAX_WATCHERS, POLL_INTERVAL_MS };
