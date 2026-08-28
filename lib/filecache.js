// ════════════════════════════════════════════════════════════════════════════
// lib/filecache.js — A CACHE. NOT STORAGE. NOT A BACKUP.
// ────────────────────────────────────────────────────────────────────────────
// Tom opened a 364 KB PDF in the viewer and waited about twenty seconds. Every
// GET /api/files/:id/content was a fresh round trip out of Railway, across the
// WireGuard tailnet, into the Synology, and back — for bytes the container had
// already fetched minutes earlier. This is the copy that makes the second look
// instant.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// It is not storage. Nothing is ever ONLY here. Every byte in this directory
// is a duplicate of a file that lives on the NAS, it is written to the OS temp
// directory by default, and it is expected to vanish on every deploy, restart,
// crash and container reschedule. That is not a limitation to be engineered
// around — it is the definition. If you ever find yourself reaching for this
// module as a place to PUT something, you want lib/storage.js.
//
// Concretely, the rules that keep it honest:
//   · a write goes to the NAS through storage.put() and is invalidated HERE,
//     never written here instead;
//   · a cache miss is a normal event with a normal cost, never an error;
//   · storageReady() is unaffected by anything in this file — a server with a
//     warm cache and a dead NAS is still a server with a dead NAS, and
//     /api/health must keep saying so;
//   · a partial transfer is DISCARDED, never committed. A truncated PDF served
//     fast is worse than a whole one served slowly.
//
// ── VALIDATOR ──────────────────────────────────────────────────────────────
// Keyed on nas_path, validated against the size the `files` row records. Bytes
// only reach a nas_path through storage.put(), and every one of those five call
// sites invalidates this cache by path — that is the real guarantee. The size
// check is the belt to that pair of braces: if the two ever disagree, the entry
// is dropped and the NAS is asked, because being slow is recoverable and
// serving somebody the wrong contract is not.
//
// ── ENV ────────────────────────────────────────────────────────────────────
//   FILE_CACHE_MAX_BYTES   total cap, default 200 MB. **0 disables the cache.**
//   FILE_CACHE_DIR         where to put it, default <tmp>/showrunner-filecache
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX = 200 * 1024 * 1024;
const MAX_BYTES = (() => {
  const raw = process.env.FILE_CACHE_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX;
})();
const DIR = String(process.env.FILE_CACHE_DIR || '').trim() ||
  path.join(os.tmpdir(), 'showrunner-filecache');

// One file must not be able to evict the whole cache to make room for itself.
// A quarter of the cap is the ceiling for a single entry — a 200 MB cache will
// hold a 50 MB show render and refuse a 120 MB one, which is the right trade:
// the big rare thing pays the NAS trip, the small frequent things stay warm.
const MAX_ENTRY = Math.floor(MAX_BYTES / 4);

// key -> { file, size, atime }.  In memory ONLY, and deliberately so: a fresh
// process starts with a cold cache and a swept directory rather than trusting
// files it has no record of writing.
const INDEX = new Map();
let bytesHeld = 0;
let ready = false;
let disabledReason = MAX_BYTES === 0 ? 'FILE_CACHE_MAX_BYTES=0' : null;
let seq = 0;
const stats = { hits: 0, misses: 0, writes: 0, evictions: 0, discarded: 0, invalidations: 0 };

const NAME_RE = /^[0-9a-f]{40}\.bin$/;          // what we are allowed to delete

function enabled() { return MAX_BYTES > 0 && ready; }
function keyFor(nasPath) {
  return crypto.createHash('sha1').update(String(nasPath || '')).digest('hex');
}
function fileFor(key) { return path.join(DIR, key + '.bin'); }
function rmQuiet(p) { try { fs.unlinkSync(p); } catch (_) {} }

// Boot. Creating the directory is the only thing that can turn the cache on;
// if it fails the cache stays off and the app is exactly as fast as it was.
//
// The sweep deletes ONLY files matching `<40 hex>.bin`, never a directory and
// never anything else, because FILE_CACHE_DIR is operator-supplied and a typo
// pointing it at something real must not cost anybody a file. Orphans are the
// previous process's entries: nothing indexes them, so they would otherwise sit
// there forever consuming disk nobody is accounting for.
function init() {
  if (MAX_BYTES === 0) { ready = false; return false; }
  try {
    fs.mkdirSync(DIR, { recursive: true });
    for (const name of fs.readdirSync(DIR)) {
      if (NAME_RE.test(name) || /^[0-9a-f]{40}\.part\./.test(name)) rmQuiet(path.join(DIR, name));
    }
    ready = true;
    disabledReason = null;
  } catch (e) {
    ready = false;
    disabledReason = e.message;
  }
  return ready;
}

// ── read ────────────────────────────────────────────────────────────────────
// Returns { stream, size } or null. `expectedSize` is the `files.size` column;
// null means "no opinion", which is only ever the case for callers that do not
// have the row, and there are none today.
function open(nasPath, expectedSize) {
  if (!enabled()) return null;
  const key = keyFor(nasPath);
  const e = INDEX.get(key);
  if (!e) { stats.misses += 1; return null; }
  let st;
  try { st = fs.statSync(e.file); } catch (_) { drop(key); stats.misses += 1; return null; }
  // The validator. A disagreement is not something to reason about — it is
  // something to throw away.
  if (st.size !== e.size || (expectedSize != null && st.size !== Number(expectedSize))) {
    drop(key); stats.misses += 1; return null;
  }
  e.atime = Date.now();
  stats.hits += 1;
  return { stream: fs.createReadStream(e.file), size: st.size };
}

// ── write ───────────────────────────────────────────────────────────────────
// The caller tees the NAS stream through this while piping it to the client, so
// the first person to open a file pays for it once and warms it for everybody.
// Returns null when there is nothing to do (disabled, or the file is too big to
// be worth a quarter of the cache) — the caller must treat null as normal.
//
// Nothing is visible to a reader until commit(): the bytes land in a .part file
// and are RENAMED into place, so a torn transfer can never be read back as a
// whole document.
function capture(nasPath, expectedSize) {
  if (!enabled()) return null;
  if (expectedSize == null || !(expectedSize > 0)) return null;
  if (expectedSize > MAX_ENTRY) return null;
  const key = keyFor(nasPath);
  const part = path.join(DIR, key + '.part.' + process.pid + '.' + (seq += 1));
  let out;
  try { out = fs.createWriteStream(part); } catch (_) { return null; }
  let n = 0, dead = false;
  const kill = () => {
    if (dead) return;
    dead = true;
    stats.discarded += 1;
    try { out.destroy(); } catch (_) {}
    rmQuiet(part);
  };
  out.on('error', kill);
  return {
    write(chunk) {
      if (dead || !chunk) return;
      n += chunk.length;
      // Overshooting the declared size means the row and the NAS disagree.
      // Trusting neither is the cheap, correct move.
      if (n > expectedSize) return kill();
      try { out.write(chunk); } catch (_) { kill(); }
    },
    abort: kill,
    commit() {
      if (dead) return;
      out.end(() => {
        if (dead) return;
        if (n !== Number(expectedSize)) { kill(); return; }
        const dest = fileFor(key);
        fs.rename(part, dest, (err) => {
          if (err) { rmQuiet(part); return; }
          const prev = INDEX.get(key);
          if (prev) bytesHeld -= prev.size;
          INDEX.set(key, { file: dest, size: n, atime: Date.now() });
          bytesHeld += n;
          stats.writes += 1;
          evict();
        });
      });
    }
  };
}

// ── invalidate ──────────────────────────────────────────────────────────────
// Called from every site that writes or removes bytes at a nas_path. This is
// the correctness guarantee; the size check in open() is only the backstop.
function invalidatePath(nasPath) {
  if (MAX_BYTES === 0 || !nasPath) return false;
  const key = keyFor(nasPath);
  if (!INDEX.has(key)) return false;
  drop(key);
  stats.invalidations += 1;
  return true;
}
function drop(key) {
  const e = INDEX.get(key);
  if (!e) return;
  INDEX.delete(key);
  bytesHeld -= e.size;
  if (bytesHeld < 0) bytesHeld = 0;
  rmQuiet(e.file);
}
// Least-recently-USED, not least-recently-written: a spec everybody opens all
// week should outlive a receipt filed once and never looked at again.
function evict() {
  if (bytesHeld <= MAX_BYTES) return;
  const byAge = [...INDEX.entries()].sort((a, b) => a[1].atime - b[1].atime);
  for (const [key] of byAge) {
    if (bytesHeld <= MAX_BYTES) break;
    drop(key);
    stats.evictions += 1;
  }
}
function clear() {
  for (const key of [...INDEX.keys()]) drop(key);
  bytesHeld = 0;
}

// What /api/health prints. `role` is stated out loud so nobody reading a health
// payload at 2am mistakes a warm cache for a working NAS.
function info() {
  return {
    role: 'cache-only (duplicates of NAS bytes; safe to delete at any time)',
    enabled: enabled(),
    reason: enabled() ? null : (disabledReason || 'not initialised'),
    dir: DIR,
    entries: INDEX.size,
    bytes: bytesHeld,
    maxBytes: MAX_BYTES,
    maxEntryBytes: MAX_ENTRY,
    ...stats
  };
}

module.exports = {
  init, enabled, open, capture, invalidatePath, clear, info, keyFor,
  // testable seams
  DIR, MAX_BYTES, MAX_ENTRY, _index: INDEX
};
