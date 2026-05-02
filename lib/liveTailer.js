'use strict';

/**
 * liveTailer — single-watcher-per-file fan-out tail of Claude Code
 * transcript jsonl files.
 *
 * Responsibilities:
 *   - On first attach to a path, replay the full file (parsed + normalized)
 *     to that listener via onInit.
 *   - Tail the file via fs.watch + 1s polling (hybrid for macOS robustness).
 *   - When the file grows, read the new bytes, parse line-by-line (buffering
 *     a partial trailing line for the next read), normalize, and broadcast
 *     each event to ALL active listeners.
 *   - When the file shrinks (truncated/replaced), re-emit a fresh transcript
 *     to ALL listeners via onInit.
 *   - When the file disappears, fire onClose for all listeners and tear down.
 *   - Cap concurrent watchers at MAX_WATCHERS for sanity.
 */

const fs = require('fs');
const { normalizeEntry, loadEntireTranscript } = require('./jsonlNormalizer');

const POLL_INTERVAL_MS = 1000;
const MAX_WATCHERS = 50;

// Map<jsonlPath, WatcherEntry>
//   listeners: Set<{onInit, onEvent, onMtimeChange, onClose}>
//   byteOffset: number — bytes consumed so far
//   partialLine: string — leftover bytes from incomplete final line
//   watcher: fs.FSWatcher | null
//   pollTimer: NodeJS.Timeout | null
//   lastMtimeMs: number | null
//   alive: boolean
const watchers = new Map();

function _readNewBytes(entry, jsonlPath, fromOffset, toOffset) {
  if (toOffset <= fromOffset) return '';
  let fd = -1;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const len = toOffset - fromOffset;
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, fromOffset);
    if (read <= 0) return '';
    return buf.slice(0, read).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function _broadcastEvent(entry, ev) {
  for (const listener of entry.listeners) {
    try { listener.onEvent && listener.onEvent(ev); } catch (_) {}
  }
}

function _broadcastMtime(entry, mtime, sizeBefore, sizeAfter) {
  for (const listener of entry.listeners) {
    try {
      listener.onMtimeChange && listener.onMtimeChange(mtime, sizeBefore, sizeAfter);
    } catch (_) {}
  }
}

function _broadcastInit(entry, events) {
  for (const listener of entry.listeners) {
    try { listener.onInit && listener.onInit(events); } catch (_) {}
  }
}

function _broadcastClose(entry) {
  for (const listener of entry.listeners) {
    try { listener.onClose && listener.onClose(); } catch (_) {}
  }
}

function _processGrowth(entry, jsonlPath, newSize) {
  const fromOffset = entry.byteOffset;
  if (newSize <= fromOffset) return;
  const chunk = _readNewBytes(entry, jsonlPath, fromOffset, newSize);
  if (!chunk) {
    entry.byteOffset = newSize;
    return;
  }
  const combined = entry.partialLine + chunk;
  // Split, keep the last segment as the partial line if no trailing \n.
  const lines = combined.split('\n');
  let trailing = '';
  if (combined.length > 0 && combined[combined.length - 1] !== '\n') {
    trailing = lines.pop() || '';
  } else {
    // last segment will be '' (because split on trailing newline yields empty)
    lines.pop();
  }

  for (const line of lines) {
    if (!line) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_) {
      continue; // partial or corrupt — skip
    }
    const events = normalizeEntry(raw);
    for (const ev of events) {
      _broadcastEvent(entry, ev);
    }
  }

  entry.partialLine = trailing;
  // Advance offset past consumed bytes; trailing partial stays in memory.
  entry.byteOffset = newSize - Buffer.byteLength(trailing, 'utf8');
}

function _checkFile(jsonlPath) {
  const entry = watchers.get(jsonlPath);
  if (!entry || !entry.alive) return;

  let st;
  try {
    st = fs.statSync(jsonlPath);
  } catch (_) {
    // File gone
    _broadcastClose(entry);
    _teardown(jsonlPath);
    return;
  }

  const newSize = st.size;
  const newMtimeMs = st.mtime ? st.mtime.getTime() : null;
  const sizeBefore = entry.byteOffset + Buffer.byteLength(entry.partialLine, 'utf8');

  if (newSize < sizeBefore) {
    // File truncated or replaced — re-read whole thing.
    entry.byteOffset = 0;
    entry.partialLine = '';
    const events = loadEntireTranscript(jsonlPath);
    // Set offset to current size so subsequent growth tails from here.
    entry.byteOffset = newSize;
    entry.lastMtimeMs = newMtimeMs;
    _broadcastInit(entry, events);
    _broadcastMtime(entry, st.mtime, sizeBefore, newSize);
    return;
  }

  if (newSize > sizeBefore) {
    _processGrowth(entry, jsonlPath, newSize);
  }

  if (newMtimeMs != null && newMtimeMs !== entry.lastMtimeMs) {
    entry.lastMtimeMs = newMtimeMs;
    _broadcastMtime(entry, st.mtime, sizeBefore, newSize);
  }
}

function _setupWatcher(jsonlPath, entry) {
  // fs.watch — best-effort change events
  try {
    entry.watcher = fs.watch(jsonlPath, { persistent: true }, (eventType) => {
      // Coalesce with the polling tick: just check the file now.
      _checkFile(jsonlPath);
      if (eventType === 'rename') {
        // 'rename' may indicate deletion or replace; the next stat in
        // _checkFile will detect that.
      }
    });
    entry.watcher.on('error', () => {
      // Errors are not fatal — polling timer will keep us going.
    });
  } catch (_) {
    entry.watcher = null;
  }

  entry.pollTimer = setInterval(() => {
    _checkFile(jsonlPath);
  }, POLL_INTERVAL_MS);
  if (entry.pollTimer.unref) entry.pollTimer.unref();
}

function _teardown(jsonlPath) {
  const entry = watchers.get(jsonlPath);
  if (!entry) return;
  entry.alive = false;
  if (entry.watcher) {
    try { entry.watcher.close(); } catch (_) {}
    entry.watcher = null;
  }
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }
  entry.listeners.clear();
  watchers.delete(jsonlPath);
}

/**
 * Attach a listener to the tail of `jsonlPath`. The listener receives
 *   - onInit(events)        — once with the full transcript replay
 *   - onEvent(event)        — for each newly appended event
 *   - onMtimeChange(mtime, sizeBefore, sizeAfter) — when stat changes
 *   - onClose()             — when the file is deleted/unwatchable
 *
 * Returns a handle with `.detach()` that removes this listener.
 */
async function attach(jsonlPath, listener) {
  if (!jsonlPath || typeof jsonlPath !== 'string') {
    throw new TypeError('liveTailer.attach: jsonlPath required');
  }
  if (!listener || typeof listener !== 'object') {
    throw new TypeError('liveTailer.attach: listener required');
  }

  let entry = watchers.get(jsonlPath);

  if (!entry) {
    if (watchers.size >= MAX_WATCHERS) {
      throw new Error('liveTailer: too many active watchers (' + MAX_WATCHERS + ')');
    }

    let st;
    try {
      st = fs.statSync(jsonlPath);
    } catch (_) {
      throw new Error('liveTailer: cannot stat ' + jsonlPath);
    }

    entry = {
      listeners: new Set(),
      byteOffset: st.size,
      partialLine: '',
      watcher: null,
      pollTimer: null,
      lastMtimeMs: st.mtime ? st.mtime.getTime() : null,
      alive: true
    };
    watchers.set(jsonlPath, entry);
    _setupWatcher(jsonlPath, entry);
  }

  // Replay the full transcript to THIS listener only (not siblings).
  const replay = loadEntireTranscript(jsonlPath);
  try { listener.onInit && listener.onInit(replay); } catch (_) {}

  entry.listeners.add(listener);

  return {
    detach() {
      const e = watchers.get(jsonlPath);
      if (!e) return;
      e.listeners.delete(listener);
      if (e.listeners.size === 0) {
        _teardown(jsonlPath);
      }
    }
  };
}

function _stats() {
  return {
    pathCount: watchers.size,
    listenerTotal: Array.from(watchers.values())
      .reduce((acc, e) => acc + e.listeners.size, 0)
  };
}

module.exports = {
  attach,
  _stats,
  MAX_WATCHERS,
  POLL_INTERVAL_MS
};
