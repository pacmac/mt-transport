'use strict';
// Writes verified payloads out. Ported from clients/node/lib/store.js.
//
// NO CONVERSION HAPPENS HERE. The camera emits JPEG and the chunker moves opaque
// bytes, so this is a write. If this file ever grows an image library, something
// has gone wrong upstream.

const fs = require('fs');
const path = require('path');
const { Cache } = require('./cache');

const EXT = { 1: 'json', 2: 'jpg', 3: 'log', 4: 'json' }; // SCHEMA/IMAGE/LOG/JSON

class PayloadStore {
  constructor({ dir = './payloads' } = {}) {
    this.dir = dir;
    // Everything that must survive a restart but is not a payload file lives here.
    // Kept OUT of the per-node payload dirs so a node dir stays what it says it is:
    // images and transfer parts.
    this.cache = new Cache(path.join(dir, 'cache'));
  }

  save(buf, { pid, ptype = 2, node = 'unknown', when = Date.now() } = {}) {
    const ext = EXT[ptype] || 'bin';
    const sub = path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'));
    fs.mkdirSync(sub, { recursive: true });
    const p = path.join(sub, `${when}_pid${pid}.${ext}`);
    fs.writeFileSync(p, buf);
    return p;
  }

  // ---- resume: partial-transfer persistence --------------------------------
  // A transfer may span interruptions (radio busy, or an outside influence cuts
  // it off), so partial progress is persisted and continued. Keyed by node+pid;
  // the sidecar carries crc/count/len so a resume is REJECTED if the payload
  // behind that pid changed (a 16-bit pid collision between two distinct images)
  // rather than blending two images. See specs/chunk-resume.md.
  _partPaths(node, pid) {
    const sub = path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'));
    const base = path.join(sub, `pid${pid}`);
    return { sub, buf: `${base}.part`, meta: `${base}.part.json` };
  }

  savePartial(node, { pid, crc, count, len, have, buf }) {
    const p = this._partPaths(node, pid);
    fs.mkdirSync(p.sub, { recursive: true });
    // Buffer first, then the sidecar: a crash between the two leaves a buffer with
    // no sidecar, which loadPartial treats as "no partial" — safe. The reverse
    // (sidecar without buffer) would claim progress we cannot back up.
    fs.writeFileSync(p.buf, buf);
    fs.writeFileSync(p.meta, JSON.stringify(
      { pid, crc: crc >>> 0, count, len, have: [...have].sort((a, b) => a - b) }));
  }

  loadPartial(node, pid) {
    const p = this._partPaths(node, pid);
    if (!fs.existsSync(p.meta) || !fs.existsSync(p.buf)) return null;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')); }
    catch { return null; } // corrupt sidecar: treat as no partial
    const buf = fs.readFileSync(p.buf);
    if (buf.length !== meta.len) return null; // buffer/sidecar disagree
    return { ...meta, crc: meta.crc >>> 0, have: new Set(meta.have), buf };
  }

  clearPartial(node, pid) {
    const p = this._partPaths(node, pid);
    for (const f of [p.buf, p.meta]) {
      try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
    }
  }

  // Per-pid transfer telemetry. PERSISTENT — unlike the partial, this survives completion,
  // so a finished/failed transfer's stats remain readable across restarts.
  _statsPath(node, pid) {
    return path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'), `pid${pid}.stats.json`);
  }
  saveStats(node, pid, stats) {
    const p = this._statsPath(node, pid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(stats, null, 2));
    return p;
  }
  loadStats(node, pid) {
    try { return JSON.parse(fs.readFileSync(this._statsPath(node, pid), 'utf8')); }
    catch { return null; }
  }

  // Command-butler queue — persistent per-unit command ledger. Survives restart, so a command
  // queued for a unit that wakes in hours is still there. One `queue.json` per unit dir.
  // ---- device config SCHEMA -------------------------------------------------
  // The schema describes the device's own settable fields (id/type/label/default/
  // bounds). It is fetched by pulling `sch` pages OFF THE DEVICE, which only works
  // while the unit is awake — and a sleeping unit is unreachable ~99% of the time.
  // An in-memory cache therefore is not enough: after a service restart the schema
  // would be gone and a dashboard could not render a config form until the unit next
  // woke. So it is persisted here and survives restarts.
  //
  // Stored per node, but the schema is FIRMWARE-GLOBAL (identical across units on the
  // same build), so `ver` is recorded and a sibling's copy can satisfy a unit we have
  // never successfully polled — see Config.schema().
  _schemaPath(node) {
    const sub = path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'));
    return { sub, file: path.join(sub, 'schema.json') };
  }

  // Now backed by the generic Cache (ns 'schema'). The RETURN SHAPE IS UNCHANGED —
  // callers (lib/config.js) still get the schema object with `fetchedAt`, so this is
  // storage moving, not an interface change. No TTL: a schema is only invalidated by a
  // firmware flash, which `?refresh=1` handles explicitly.
  saveSchema(node, schema) {
    this.cache.put('schema', node, { ...schema, fetchedAt: Date.now() });
  }

  loadSchema(node) {
    const hit = this.cache.value('schema', node);
    if (hit) return hit;
    // Legacy location (<store>/<node>/schema.json), written before the cache existed.
    // Read it once and promote it, so an existing install does not lose a schema it
    // already paid a wake window to fetch.
    try {
      const legacy = JSON.parse(fs.readFileSync(this._schemaPath(node).file, 'utf8'));
      if (legacy && Array.isArray(legacy.fields)) { this.cache.put('schema', node, legacy); return legacy; }
    } catch { /* absent or corrupt: treat as "no cache", never throw */ }
    return null;
  }

  // ---- device registry ------------------------------------------------------
  // Which node ids are OURS (they speak our private protocol on port 260/261).
  // Persisted for the same reason as the schema: a unit asleep since the last restart
  // has told us nothing, and it must not disappear from the device list because of it.
  saveDevices(ids) { this.cache.put('registry', 'devices', [...new Set(ids)].filter(Boolean)); }

  loadDevices() {
    const v = this.cache.value('registry', 'devices');
    return Array.isArray(v) ? v : [];
  }

  // Any persisted schema, newest first — used as a fallback for a unit we have never
  // polled, since the schema is firmware-global.
  anySchemas() {
    const out = [];
    // Cache first (the current location), then the legacy per-node files below, so a
    // half-migrated install still finds every copy it holds.
    for (const e of this.cache.all('schema')) {
      if (e.value && Array.isArray(e.value.fields)) out.push({ node: e.key, ...e.value });
    }
    let subs = [];
    try { subs = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()); }
    catch { return out; }
    for (const d of subs) {
      if (d.name === 'cache') continue;                // the cache dir is read above
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, d.name, 'schema.json'), 'utf8'));
        if (j && Array.isArray(j.fields)) out.push({ node: d.name, ...j });
      } catch { /* skip */ }
    }
    // A node can appear in BOTH locations mid-migration; keep only its newest copy so
    // the caller's "first match wins" fallback cannot pick up a superseded schema.
    const seen = new Set();
    return out
      .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))
      .filter((s) => (seen.has(s.node) ? false : (seen.add(s.node), true)));
  }

  _queuePath(node) {
    return path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'), 'queue.json');
  }
  saveQueue(node, entries) {
    const p = this._queuePath(node);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries, null, 2));
    return p;
  }
  loadQueue(node) {
    try { return JSON.parse(fs.readFileSync(this._queuePath(node), 'utf8')); }
    catch { return []; }
  }
  // Units with a persisted queue — the butler loads these on startup. Dir names ARE the unit
  // keys (node ids like !987ab80f survive the [\w!-] sanitiser unchanged).
  listQueuedUnits() {
    try {
      return fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.dir, d.name, 'queue.json')))
        .map((d) => d.name);
    } catch { return []; }
  }

  // Retention is NOT implemented. Left explicit rather than silently absent.
  prune() { throw new Error('retention policy not implemented — see specs/mesh-images.md §7'); }
}

module.exports = { PayloadStore, EXT };
