'use strict';

/**
 * normalizerCache — shared, append-and-prepend-aware cache for normalized
 * transcript event arrays.
 *
 * Goals (all three of these matter together):
 *   - cold open of a 20MB jsonl is fast → only the last ~256KB are read
 *     and parsed; the rest of the file isn't touched.
 *   - re-read while the file is byte-identical → cache hit, instant.
 *   - re-read while the file has only grown → read only the appended bytes
 *     and append the parsed events (delta path).
 *   - re-read while the file shrunk / rotated → full re-read.
 *   - load_earlier from the UI → backward expansion, reading earlier 256KB
 *     chunks and prepending events. After expanding to BOF, subsequent
 *     load_earliers hit memory only.
 *
 * The cache entry tracks both ends of the byte window it has consumed:
 *   {
 *     events,         // normalized events for [headOffset, size) bytes
 *     mtime,
 *     size,           // byte position right after the last complete line
 *     partial,        // bytes after `size` that didn't end in a newline
 *     headOffset,     // byte position where events[0]'s source line begins
 *     headIsBOF,      // headOffset === 0 (no more bytes to read backwards)
 *     lastAccess,
 *   }
 *
 * `liveTailer` and `routes/live.js` (init send + load_earlier) both call
 * into this cache. The init path slices the last INIT_LIMIT events and
 * cares whether earlier events exist on disk; the load_earlier path
 * expands the cache backwards and slices the requested range.
 */

const fs = require('fs');

const DEFAULT_MAX_ENTRIES = 10;

// Tail chunk used for both cold reads and backward expansion. 256 KB is
// large enough that a typical claude/codex/hermes jsonl yields a few
// hundred events from one read, but small enough to keep cold I/O under
// ~5 ms on local disk.
const TAIL_CHUNK_BYTES = 256 * 1024;

// Below this size we just read the whole file — tail-chunking is more
// overhead than it saves and we want headIsBOF=true on the first read.
const FULL_READ_THRESHOLD = 64 * 1024;

// Safety cap so a pathological file (all one giant line) can't make us
// loop forever in backward expansion.
const MAX_BACKWARD_EXPANSIONS = 200;

/**
 * Read the byte range [from, to) of `filePath` and return a Buffer (raw
 * bytes). Working in bytes — not utf-8 decoded JS strings — is essential
 * for boundary math: chunks contain Korean / emoji / other multi-byte
 * UTF-8 characters, so JS string char indices don't map to file byte
 * offsets. Returns an empty Buffer on a clean empty read, or null on
 * I/O error.
 */
function readSlice(filePath, from, to) {
  if (to <= from) return Buffer.alloc(0);
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const len = to - from;
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, from);
    if (read <= 0) return Buffer.alloc(0);
    return buf.slice(0, read);
  } catch (_) {
    return null;
  } finally {
    if (fd !== -1) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

const NL_BYTE = 0x0A;

/**
 * Parse JSONL Buffer `body` into normalized events. Drops the final
 * incomplete line (if any) and returns { events, trailing } where
 * `trailing` is the leftover bytes after the last newline as a string
 * (empty when body ends with \n). Lines are decoded as UTF-8 right
 * before JSON.parse so multi-byte boundaries don't get split mid-char.
 */
function parseBody(body, normalizeEntry) {
  const events = [];
  let lastNl = -1;
  let trailing = '';
  // Walk byte indices; for each newline, slice the prior line and parse it.
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== NL_BYTE) continue;
    const lineBuf = body.slice(lastNl + 1, i);
    lastNl = i;
    if (lineBuf.length === 0) continue;
    const line = lineBuf.toString('utf8');
    let raw;
    try { raw = JSON.parse(line); } catch (_) { continue; }
    const arr = normalizeEntry(raw);
    for (const ev of arr) events.push(ev);
  }
  // Bytes after the last \n are an incomplete trailing line.
  if (lastNl + 1 < body.length) {
    trailing = body.slice(lastNl + 1).toString('utf8');
  }
  return { events, trailing };
}

/**
 * Create the cached-events API for one normalizeEntry function. Each
 * factory instance keeps its own LRU map so claude/codex/hermes entries
 * don't evict each other.
 */
function createEventsCache(normalizeEntry, maxEntries = DEFAULT_MAX_ENTRIES) {
  const cache = new Map();

  function evictIfNeeded() {
    if (cache.size < maxEntries) return;
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
    }
    if (oldestKey != null) cache.delete(oldestKey);
  }

  /**
   * Read the entire file and build a cache entry. Used for small files and
   * as the fallback when a tail read can't make forward progress.
   */
  function fullReadInto(jsonlPath, currentMtime, currentSize) {
    let buf;
    try { buf = fs.readFileSync(jsonlPath); }   // Buffer, not utf-8 string
    catch (_) { return null; }
    const { events, trailing } = parseBody(buf, normalizeEntry);
    return {
      events,
      mtime: currentMtime,
      size: currentSize - Buffer.byteLength(trailing, 'utf8'),
      partial: trailing,
      headOffset: 0,
      headIsBOF: true,
      lastAccess: Date.now()
    };
  }

  /**
   * Read backwards from `end` (a known line boundary or EOF) until we have
   * a `body` string covering bytes [actualStart, end) where every byte in
   * body is part of a complete jsonl line that starts at byte `actualStart`
   * in the file.
   *
   * To distinguish "newHead lands mid-line" from "newHead lands exactly on
   * a line start", we read one extra byte before our nominal start and
   * inspect it: if it is '\n', then the nominal start is itself a line
   * boundary and we keep the entire chunk after the probe byte. Otherwise
   * we drop everything up through the first '\n' (the terminator of the
   * leading partial line).
   *
   * Grows the chunk size when stuck inside one >TAIL_CHUNK_BYTES jsonl
   * line (claude tool_results can hit 1MB+).
   *
   * Returns { body, actualStart } or null on I/O error.
   */
  function readBackwardsToBoundary(jsonlPath, end) {
    if (end <= 0) return { body: Buffer.alloc(0), actualStart: 0 };
    let chunkSize = TAIL_CHUNK_BYTES;
    while (true) {
      if (chunkSize >= end) {
        const chunk = readSlice(jsonlPath, 0, end);
        if (chunk == null) return null;
        return { body: chunk, actualStart: 0 };
      }
      const probeStart = end - chunkSize - 1;
      const chunk = readSlice(jsonlPath, probeStart, end);
      if (chunk == null) return null;
      if (chunk[0] === NL_BYTE) {
        return { body: chunk.slice(1), actualStart: probeStart + 1 };
      }
      const nl = chunk.indexOf(NL_BYTE, 1);
      if (nl >= 1 && nl < chunk.length - 1) {
        return { body: chunk.slice(nl + 1), actualStart: probeStart + nl + 1 };
      }
      chunkSize *= 2;
    }
  }

  /**
   * Read the last TAIL_CHUNK_BYTES of the file (growing if needed) and
   * build a cache entry containing events from that window. Unlike the
   * backwards-expansion case, here `end == currentSize` is NOT a known
   * line boundary — the file may have a trailing partial line that we
   * capture as `cached.partial` for later delta reads.
   */
  function tailReadInto(jsonlPath, currentMtime, currentSize) {
    if (currentSize <= 0) {
      return {
        events: [], mtime: currentMtime, size: 0, partial: '',
        headOffset: 0, headIsBOF: true, lastAccess: Date.now()
      };
    }
    let chunkSize = TAIL_CHUNK_BYTES;
    let actualStart;
    let body;
    while (true) {
      if (chunkSize >= currentSize) {
        const chunk = readSlice(jsonlPath, 0, currentSize);
        if (chunk == null) return null;
        actualStart = 0;
        body = chunk;
        break;
      }
      const probeStart = currentSize - chunkSize - 1;
      const chunk = readSlice(jsonlPath, probeStart, currentSize);
      if (chunk == null) return null;
      if (chunk[0] === NL_BYTE) {
        actualStart = probeStart + 1;
        body = chunk.slice(1);
        break;
      }
      // Inside the chunk, find the first '\n' after the probe byte that
      // is followed by at least one more byte (so there's at least one
      // complete line in the window).
      const nl = chunk.indexOf(NL_BYTE, 1);
      if (nl >= 1 && nl < chunk.length - 1) {
        actualStart = probeStart + nl + 1;
        body = chunk.slice(nl + 1);
        break;
      }
      chunkSize *= 2;
    }

    const { events, trailing } = parseBody(body, normalizeEntry);
    return {
      events,
      mtime: currentMtime,
      size: currentSize - Buffer.byteLength(trailing, 'utf8'),
      partial: trailing,
      headOffset: actualStart,
      headIsBOF: actualStart === 0,
      lastAccess: Date.now()
    };
  }

  /**
   * Stream-read an entire transcript. Bypasses the cache — used by callers
   * that explicitly want a full snapshot independent of the live cache
   * (e.g. liveTailer initial replay before our delta integration lands).
   * Tolerates partial / unparseable lines.
   */
  function loadEntireTranscript(jsonlPath) {
    if (!jsonlPath) return [];
    let buf;
    try { buf = fs.readFileSync(jsonlPath); }   // Buffer, not utf-8 string
    catch (_) { return []; }
    if (!buf || buf.length === 0) return [];
    const { events } = parseBody(buf, normalizeEntry);
    return events;
  }

  /**
   * Return a normalized event array for jsonlPath. On a cold read of a
   * large file this returns ONLY the tail window — call `ensureCount` or
   * check `hasEarlierEvents` to find out if more exists on disk.
   */
  function getCachedEvents(jsonlPath) {
    if (!jsonlPath) return [];
    let st;
    try { st = fs.statSync(jsonlPath); } catch (_) { return []; }
    const currentMtime = st.mtime ? st.mtime.getTime() : 0;
    const currentSize  = st.size;

    const cached = cache.get(jsonlPath);

    // Hot path: nothing has changed on disk since we last touched it.
    if (cached
        && cached.mtime === currentMtime
        && cached.size + Buffer.byteLength(cached.partial, 'utf8') === currentSize) {
      cached.lastAccess = Date.now();
      return cached.events;
    }

    // Cold cache, truncate, or rotate → start a fresh entry.
    if (!cached || currentSize < cached.size + Buffer.byteLength(cached.partial, 'utf8')) {
      let entry;
      if (currentSize <= FULL_READ_THRESHOLD) {
        entry = fullReadInto(jsonlPath, currentMtime, currentSize);
      } else {
        entry = tailReadInto(jsonlPath, currentMtime, currentSize);
        if (!entry) entry = fullReadInto(jsonlPath, currentMtime, currentSize);
      }
      if (!entry) return cached ? cached.events : [];
      evictIfNeeded();
      cache.set(jsonlPath, entry);
      return entry.events;
    }

    // Append-only delta: file grew by (currentSize - previousEnd). Read
    // [cached.size, currentSize) so the slice contains `partial + new`
    // and we can re-split on newlines cleanly.
    const chunk = readSlice(jsonlPath, cached.size, currentSize);
    if (chunk == null) {
      // Read failed; return what we have. Next call will retry.
      return cached.events;
    }
    // chunk already starts with the partial bytes still on disk; no need
    // to prepend cached.partial (it's the same bytes the read just returned).
    const { events: newEvents, trailing } = parseBody(chunk, normalizeEntry);
    for (const ev of newEvents) cached.events.push(ev);
    cached.size = currentSize - Buffer.byteLength(trailing, 'utf8');
    cached.partial = trailing;
    cached.mtime = currentMtime;
    cached.lastAccess = Date.now();
    return cached.events;
  }

  /**
   * Returns true when the cache for this path is tail-only — i.e. the file
   * has events on disk that come before events[0] in the cached array.
   * Routes use this to set the `hasEarlier` flag on the init send so the
   * UI knows whether to show a "load earlier" affordance.
   */
  function hasEarlierEvents(jsonlPath) {
    const cached = cache.get(jsonlPath);
    if (!cached) return false;
    return !cached.headIsBOF;
  }

  /**
   * Ensure the cached events array contains at least `targetCount` events,
   * expanding backwards by TAIL_CHUNK_BYTES at a time until that count is
   * reached or we've consumed all earlier bytes in the file.
   *
   * Returns the resulting cached events array (same reference that future
   * getCachedEvents calls return). Returns [] if there is no cache entry
   * for this path yet — caller should getCachedEvents first.
   */
  function ensureCount(jsonlPath, targetCount) {
    const cached = cache.get(jsonlPath);
    if (!cached) return [];
    if (typeof targetCount !== 'number' || targetCount <= cached.events.length) {
      return cached.events;
    }

    let iterations = 0;
    while (cached.events.length < targetCount && !cached.headIsBOF) {
      if (++iterations > MAX_BACKWARD_EXPANSIONS) break;
      const r = readBackwardsToBoundary(jsonlPath, cached.headOffset);
      if (r == null) break;
      if (r.actualStart >= cached.headOffset) break;  // no progress, bail

      // `r.body` ends at cached.headOffset, which is a line boundary, so
      // parseBody discards the empty segment after the final newline.
      const { events: prepended } = parseBody(r.body, normalizeEntry);
      cached.events = prepended.concat(cached.events);
      cached.headOffset = r.actualStart;
      cached.headIsBOF = r.actualStart === 0;
      cached.lastAccess = Date.now();
    }
    return cached.events;
  }

  function _debugStats() {
    return {
      entryCount: cache.size,
      entries: Array.from(cache.entries()).map(([k, v]) => ({
        path: k,
        events: v.events.length,
        headOffset: v.headOffset,
        headIsBOF: v.headIsBOF,
        size: v.size,
        partialBytes: Buffer.byteLength(v.partial, 'utf8')
      }))
    };
  }

  function _clear() { cache.clear(); }

  return {
    loadEntireTranscript,
    getCachedEvents,
    hasEarlierEvents,
    ensureCount,
    _debugStats,
    _clear
  };
}

module.exports = { createEventsCache };
