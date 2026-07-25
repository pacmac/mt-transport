// Generic persistent cache — one place for anything that must survive a restart.
//
// WHY THIS EXISTS: the units sleep. A 15-minute sleeper is unreachable ~99% of the time,
// so anything we can only learn from a live device (its config schema, the fact that it
// is ours at all) is GONE after a service restart unless we wrote it down. That is a
// correctness requirement, not a speed trick.
//
// BACKED BY SQLITE (was one JSON file per entry). The INTERFACE IS UNCHANGED and that is
// deliberate: test/cache.js passes against both backends without edits, which is what
// made this swap safe. No caller knows where the bytes live.
'use strict';
const path = require('path');
const { openDb } = require('./db');

// A namespace/key is stored verbatim now (SQLite does not care about path characters),
// but keys are still bounded: an unbounded key would be a way to bloat the row.
const norm = (s) => String(s).slice(0, 512);

class Cache {
  // Accepts either a directory (the DB is created inside it) or an open DB handle, so the
  // store and the ledger can share ONE database rather than opening two.
  constructor(dirOrDb) {
    if (dirOrDb && typeof dirOrDb === 'object' && typeof dirOrDb.prepare === 'function') {
      this.db = dirOrDb;
      this._ownsDb = false;
    } else {
      this.dir = dirOrDb;
      this.db = openDb(path.join(String(dirOrDb), 'mesh.db'));
      this._ownsDb = true;
    }
    this._put = this.db.prepare(
      `INSERT INTO cache (ns, k, v, saved_at, ttl_ms) VALUES (@ns, @k, @v, @saved_at, @ttl_ms)
       ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, saved_at = excluded.saved_at, ttl_ms = excluded.ttl_ms`,
    );
    this._get = this.db.prepare('SELECT v, saved_at, ttl_ms FROM cache WHERE ns = ? AND k = ?');
    this._all = this.db.prepare('SELECT k, v, saved_at, ttl_ms FROM cache WHERE ns = ? ORDER BY saved_at DESC');
    this._del = this.db.prepare('DELETE FROM cache WHERE ns = ? AND k = ?');
    this._clear = this.db.prepare('DELETE FROM cache WHERE ns = ?');
  }

  // Store a value. ttlMs is OPTIONAL and defaults to no expiry — see get() for what
  // expiry does, and more importantly what it does NOT do.
  put(ns, key, value, opts = {}) {
    const ttlMs = (opts.ttlMs != null && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0)
      ? Math.round(opts.ttlMs) : null;
    const savedAt = Date.now();
    this._put.run({ ns: norm(ns), k: norm(key), v: JSON.stringify(value === undefined ? null : value), saved_at: savedAt, ttl_ms: ttlMs });
    return { ns: String(ns), key: String(key), value, savedAt, ttlMs };
  }

  // Read an entry back with its age. Returns null only when we genuinely hold nothing.
  //
  // EXPIRY NEVER DELETES. An entry past its ttl comes back with `stale: true` and the
  // caller decides what that is worth. This is deliberate and load-bearing: a stale
  // schema still describes the device far better than a blank form does, and dropping our
  // only copy while the unit sleeps would reintroduce the exact bug the persistent schema
  // cache was written to fix. `stale` must be honest, so it goes on the wire.
  get(ns, key) {
    const row = this._get.get(norm(ns), norm(key));
    if (!row) return null;
    return this._row(row);
  }

  // The value alone — fresh OR stale. For callers with no use for the metadata.
  value(ns, key) {
    const e = this.get(ns, key);
    return e ? e.value : null;
  }

  // Every entry in a namespace, newest first. Used where any copy will do (the
  // firmware-global schema falling back to a sibling unit's).
  all(ns) {
    return this._all.all(norm(ns)).map((row) => ({ key: row.k, ...this._row(row) }));
  }

  del(ns, key) { return this._del.run(norm(ns), norm(key)).changes > 0; }
  clear(ns) { this._clear.run(norm(ns)); return true; }

  _row(row) {
    const ageMs = Date.now() - row.saved_at;
    let value = null;
    // A row we cannot parse is treated as absent rather than throwing — same defensive
    // posture the file backend had for a corrupt file.
    try { value = JSON.parse(row.v); } catch { return { value: null, savedAt: row.saved_at, ttlMs: row.ttl_ms, ageMs, stale: false }; }
    return {
      value,
      savedAt: row.saved_at,
      ttlMs: row.ttl_ms != null ? row.ttl_ms : null,
      ageMs,
      stale: row.ttl_ms != null && ageMs > row.ttl_ms,
    };
  }
}

module.exports = { Cache };
