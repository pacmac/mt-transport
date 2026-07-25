// Generic persistent cache — one place for anything that must survive a restart.
//
// WHY THIS EXISTS: the units sleep. A 15-minute sleeper is unreachable ~99% of the
// time, so anything we can only learn from a live device (its config schema, the fact
// that it is ours at all) is GONE after a service restart unless we wrote it down.
// That is a correctness requirement, not a speed trick — see specs/single-service-host.md
// "Schema cache". This module generalises what lib/store.js was doing for schemas alone.
//
// BACKEND-AGNOSTIC ON PURPOSE. The storage here is one JSON file per entry, but no
// caller may depend on that: task `cache-sqlite-backend` swaps this for better-sqlite3
// (already installed and verified on this box) without touching a single call site.
// Keep the method signatures below stable — they are the contract, not the files.
'use strict';
const fs = require('fs');
const path = require('path');

// A namespace/key becomes a path segment, so it must not be able to escape the cache
// dir or collide. Anything outside the safe set becomes '_', and the original is kept
// in the entry so a mangled key is still identifiable by a human reading the file.
const safe = (s) => String(s).replace(/[^\w!.-]/g, '_').slice(0, 180) || '_';

class Cache {
  // dir: the cache ROOT. Namespaces are subdirectories of it.
  constructor(dir) {
    this.dir = dir;
    this._mem = new Map();          // ns/key -> entry, avoids a disk read per get
  }

  _nsDir(ns) { return path.join(this.dir, safe(ns)); }
  _file(ns, key) { return path.join(this._nsDir(ns), `${safe(key)}.json`); }
  _memKey(ns, key) { return `${safe(ns)}/${safe(key)}`; }

  // Store a value. ttlMs is OPTIONAL and defaults to no expiry — see get() for what
  // expiry does (and, more importantly, what it does NOT do).
  put(ns, key, value, opts = {}) {
    const entry = {
      ns: String(ns), key: String(key), value,
      savedAt: Date.now(),
      ttlMs: (opts.ttlMs != null && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) ? Math.round(opts.ttlMs) : null,
    };
    const file = this._file(ns, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a half-written file that
    // reads as corrupt. rename(2) is atomic within a filesystem.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
    this._mem.set(this._memKey(ns, key), entry);
    return entry;
  }

  // Read an entry back with its age. Returns null only when we genuinely hold nothing.
  //
  // EXPIRY NEVER DELETES. An entry past its ttl comes back with `stale: true` and the
  // caller decides what that is worth. This is deliberate and load-bearing: a stale
  // schema still describes the device far better than a blank form does, and dropping
  // our only copy while the unit sleeps would reintroduce the exact bug the persistent
  // schema cache was written to fix. `stale` must be honest, so it goes on the wire.
  get(ns, key) {
    const mk = this._memKey(ns, key);
    let entry = this._mem.get(mk);
    if (!entry) {
      try { entry = JSON.parse(fs.readFileSync(this._file(ns, key), 'utf8')); }
      catch { return null; }          // absent or corrupt: "no cache", never throw
      if (!entry || typeof entry !== 'object') return null;
      this._mem.set(mk, entry);
    }
    const ageMs = Date.now() - (entry.savedAt || 0);
    return {
      value: entry.value,
      savedAt: entry.savedAt || null,
      ttlMs: entry.ttlMs != null ? entry.ttlMs : null,
      ageMs,
      stale: entry.ttlMs != null && ageMs > entry.ttlMs,
    };
  }

  // The value alone — fresh OR stale. For callers that have no use for the metadata.
  value(ns, key) {
    const e = this.get(ns, key);
    return e ? e.value : null;
  }

  // Every entry in a namespace, newest first. Used where any copy will do (the
  // firmware-global schema falling back to a sibling unit's).
  all(ns) {
    let names = [];
    try { names = fs.readdirSync(this._nsDir(ns)).filter((n) => n.endsWith('.json')); }
    catch { return []; }
    const out = [];
    for (const n of names) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this._nsDir(ns), n), 'utf8'));
        if (!entry || typeof entry !== 'object') continue;
        const ageMs = Date.now() - (entry.savedAt || 0);
        out.push({
          key: entry.key != null ? entry.key : n.replace(/\.json$/, ''),
          value: entry.value,
          savedAt: entry.savedAt || null,
          ttlMs: entry.ttlMs != null ? entry.ttlMs : null,
          ageMs,
          stale: entry.ttlMs != null && ageMs > entry.ttlMs,
        });
      } catch { /* skip a corrupt entry rather than failing the whole listing */ }
    }
    return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  del(ns, key) {
    this._mem.delete(this._memKey(ns, key));
    try { fs.unlinkSync(this._file(ns, key)); return true; } catch { return false; }
  }

  clear(ns) {
    for (const k of [...this._mem.keys()]) if (k.startsWith(`${safe(ns)}/`)) this._mem.delete(k);
    try { fs.rmSync(this._nsDir(ns), { recursive: true, force: true }); return true; }
    catch { return false; }
  }
}

module.exports = { Cache };
