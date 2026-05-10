'use strict';

/**
 * normalizerCache — shared mtime+size aware LRU cache for normalized
 * transcript event arrays.
 *
 * Each call site (jsonlNormalizer for claude, codexJsonlNormalizer for codex,
 * hermesJsonlNormalizer for hermes) shapes the same cache: we want
 *   - first load   → full read of the file
 *   - re-read while file is unchanged → instant (cache hit)
 *   - re-read while file has only grown → read only the new bytes, parse
 *     them, append to the cached array (delta)
 *   - re-read while file shrunk / rotated → full re-read
 *
 * `routes/live.js` (init send + load_earlier) and `liveTailer` (initial
 * replay) both call `getCachedEvents` repeatedly during a single live
 * session as the jsonl grows. The previous implementation invalidated the
 * whole cache entry on every mtime bump and re-read the entire file —
 * O(file size) per call. This factory keeps a partial-line buffer + byte
 * offset alongside the events so subsequent calls are O(delta).
 */

const fs = require('fs');

const DEFAULT_MAX_ENTRIES = 10;

/**
 * Read the byte range [from, to) of `filePath` as utf-8. Returns '' on
 * an empty/clean read, or null on I/O error so the caller can decide
 * whether to fall back to a full re-read.
 */
function readSlice(filePath, from, to) {
  if (to <= from) return '';
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const len = to - from;
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, from);
    if (read <= 0) return '';
    return buf.slice(0, read).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/**
 * Create a (loadEntireTranscript, getCachedEvents) pair bound to the given
 * `normalizeEntry` function. Each factory instance maintains its own LRU
 * cache so claude / codex / hermes entries don't evict each other.
 */
function createEventsCache(normalizeEntry, maxEntries = DEFAULT_MAX_ENTRIES) {
  // Map<jsonlPath, {
  //   events: Array,        — normalized events accumulated so far
  //   mtime: number,        — last seen file mtime in ms
  //   size: number,         — byte offset already consumed (excludes trailing partial)
  //   partial: string,      — incomplete trailing line bytes (utf-8)
  //   lastAccess: number,
  // }>
  const cache = new Map();

  function loadEntireTranscript(jsonlPath) {
    if (!jsonlPath) return [];
    let buf;
    try { buf = fs.readFileSync(jsonlPath, 'utf8'); }
    catch (_) { return []; }
    if (!buf) return [];

    const lines = buf.split('\n');
    // The last segment is either '' (file ends in \n) or an incomplete
    // trailing line. Both are dropped here — the caller of a full read
    // doesn't need to retain partial state.
    const completeLines = lines.slice(0, lines.length - 1);
    const out = [];
    for (const line of completeLines) {
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch (_) { continue; }
      const events = normalizeEntry(raw);
      for (const ev of events) out.push(ev);
    }
    return out;
  }

  function evictIfNeeded() {
    if (cache.size < maxEntries) return;
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
    }
    if (oldestKey != null) cache.delete(oldestKey);
  }

  function fullReadInto(jsonlPath, currentMtime, currentSize) {
    let buf;
    try { buf = fs.readFileSync(jsonlPath, 'utf8'); }
    catch (_) { return null; }

    const lines = buf.split('\n');
    let trailing = '';
    if (buf.length > 0 && buf[buf.length - 1] !== '\n') {
      trailing = lines.pop() || '';
    } else {
      lines.pop();
    }
    const events = [];
    for (const line of lines) {
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch (_) { continue; }
      const arr = normalizeEntry(raw);
      for (const ev of arr) events.push(ev);
    }
    return {
      events,
      mtime: currentMtime,
      size: currentSize - Buffer.byteLength(trailing, 'utf8'),
      partial: trailing,
      lastAccess: Date.now()
    };
  }

  function getCachedEvents(jsonlPath) {
    if (!jsonlPath) return [];
    let st;
    try { st = fs.statSync(jsonlPath); } catch (_) { return []; }
    const currentMtime = st.mtime ? st.mtime.getTime() : 0;
    const currentSize  = st.size;

    const cached = cache.get(jsonlPath);

    // Fast path: file is byte-identical to what we already parsed.
    if (cached
        && cached.mtime === currentMtime
        && cached.size + Buffer.byteLength(cached.partial, 'utf8') === currentSize) {
      cached.lastAccess = Date.now();
      return cached.events;
    }

    // Cold cache, or file truncated/rotated — read the whole thing.
    if (!cached || currentSize < cached.size + Buffer.byteLength(cached.partial, 'utf8')) {
      const entry = fullReadInto(jsonlPath, currentMtime, currentSize);
      if (!entry) return cached ? cached.events : [];
      evictIfNeeded();
      cache.set(jsonlPath, entry);
      return entry.events;
    }

    // Append-only delta: read from the byte offset just *before* the
    // trailing partial line, so the slice contains `partial + new bytes`
    // and we can re-split on newlines cleanly.
    const chunk = readSlice(jsonlPath, cached.size, currentSize);
    if (chunk == null) {
      // Read failed; return the snapshot we have. The next call will retry.
      return cached.events;
    }
    const lines = chunk.split('\n');
    let trailing = '';
    if (chunk.length > 0 && chunk[chunk.length - 1] !== '\n') {
      trailing = lines.pop() || '';
    } else {
      lines.pop();
    }
    for (const line of lines) {
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch (_) { continue; }
      const arr = normalizeEntry(raw);
      for (const ev of arr) cached.events.push(ev);
    }
    cached.size = currentSize - Buffer.byteLength(trailing, 'utf8');
    cached.partial = trailing;
    cached.mtime = currentMtime;
    cached.lastAccess = Date.now();
    return cached.events;
  }

  function _debugStats() {
    return {
      entryCount: cache.size,
      entries: Array.from(cache.entries()).map(([k, v]) => ({
        path: k,
        events: v.events.length,
        size: v.size,
        partialBytes: Buffer.byteLength(v.partial, 'utf8')
      }))
    };
  }

  function _clear() {
    cache.clear();
  }

  return { loadEntireTranscript, getCachedEvents, _debugStats, _clear };
}

module.exports = { createEventsCache };
