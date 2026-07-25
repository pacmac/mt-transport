'use strict';
// Writes verified payloads out. Ported from clients/node/lib/store.js.
//
// NO CONVERSION HAPPENS HERE. The camera emits JPEG and the chunker moves opaque
// bytes, so this is a write. If this file ever grows an image library, something
// has gone wrong upstream.

const fs = require('fs');
const path = require('path');
const { Cache } = require('./cache');
const { openDb } = require('./db');

// A ledger row -> the entry shape the butler and the API speak. Kept in one place so the
// column names never leak past this file.
function rowToEntry(r) {
  return {
    id: r.id, unit: r.unit, kind: r.kind,
    verb: r.verb, args: r.args ? JSON.parse(r.args) : [], body: r.body,
    toNum: r.to_num, channel: r.channel, replyId: r.reply_id,
    state: r.state, tries: r.tries, maxTries: r.max_tries,
    createdAt: r.created_at, triedAt: r.tried_at, settledAt: r.settled_at,
    ttlMs: r.ttl_ms,
    result: r.result ? safeParse(r.result) : null,
    error: r.error_code ? { code: r.error_code, message: r.error_msg || null } : null,
  };
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const EXT = { 1: 'json', 2: 'jpg', 3: 'log', 4: 'json' }; // SCHEMA/IMAGE/LOG/JSON

class PayloadStore {
  constructor({ dir = './payloads', query = {} } = {}) {
    this.dir = dir;
    // Declared (store.queryDefaultLimit / queryMaxLimit), not magic numbers inline.
    this.defaultLimit = query.defaultLimit;
    this.maxLimit = query.maxLimit;
    // ONE database for everything that must survive a restart: the request ledger and the
    // cache. Image bytes and transfer parts stay as files — they are bulk payload, and a
    // database is the wrong home for them.
    this.db = openDb(path.join(dir, 'mesh.db'));
    this.cache = new Cache(this.db);
    this._saveQueueTx = this.db.transaction((unit, rows) => {
      this.db.prepare('DELETE FROM requests WHERE unit = ?').run(String(unit));
      const ins = this.db.prepare(
        `INSERT INTO requests (id, unit, kind, verb, args, body, to_num, channel, reply_id, state, tries, max_tries,
                               created_at, tried_at, settled_at, ttl_ms, result, error_code, error_msg)
         VALUES (@id, @unit, @kind, @verb, @args, @body, @to_num, @channel, @reply_id, @state, @tries, @max_tries,
                 @created_at, @tried_at, @settled_at, @ttl_ms, @result, @error_code, @error_msg)`,
      );
      for (const r of rows) ins.run(r);
    });
    this._importLegacyQueues();
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

  // ---- the request ledger ----------------------------------------------------
  // Was one queue.json per unit, rewritten IN FULL on every state change. Now rows, so a
  // state transition is an UPDATE of one row and the ledger can actually be queried.
  // The butler still hands us whole arrays; that is its interface, not the storage's.
  saveQueue(node, entries) {
    const rows = (entries || []).map((e) => ({
      id: e.id, unit: node, kind: e.kind || 'command',
      verb: e.verb != null ? e.verb : null,
      args: e.args ? JSON.stringify(e.args) : null,
      body: e.body != null ? e.body : null,
      to_num: e.toNum != null ? e.toNum : null,
      channel: e.channel != null ? e.channel : null,
      reply_id: e.replyId != null ? e.replyId : null,
      state: e.state || e.status,          // tolerate either name while callers migrate
      tries: e.tries != null ? e.tries : (e.attempts || 0),
      max_tries: e.maxTries != null ? e.maxTries : (e.maxAttempts != null ? e.maxAttempts : 5),
      created_at: e.createdAt != null ? e.createdAt : (e.enqueuedAt || Date.now()),
      tried_at: e.triedAt != null ? e.triedAt : (e.sentAt || null),
      settled_at: e.settledAt != null ? e.settledAt : (e.ackedAt || null),
      ttl_ms: e.ttlMs != null ? e.ttlMs : null,
      result: e.result != null ? JSON.stringify(e.result) : (e.receipt != null ? JSON.stringify(e.receipt) : null),
      // The butler carries a structured {code, message}; `lastError` is the file-era
      // prose, kept only so a legacy import still records why something failed.
      error_code: (e.error && e.error.code) || e.errorCode || (e.lastError ? 'error' : null),
      error_msg: (e.error && e.error.message) || e.errorMsg || e.lastError || null,
    }));
    // One transaction: a half-written queue is an instruction half-remembered.
    this._saveQueueTx(node, rows);
    return rows.length;
  }

  loadQueue(node) {
    return this.db.prepare('SELECT * FROM requests WHERE unit = ? ORDER BY created_at ASC')
      .all(String(node)).map(rowToEntry);
  }

  // Units with anything in the ledger — the butler loads these on startup.
  listQueuedUnits() {
    return this.db.prepare('SELECT DISTINCT unit FROM requests').all().map((r) => r.unit);
  }

  // Declared paging caps (store.queryDefaultLimit / queryMaxLimit) — checked on use so a
  // missing value is an error, never a silent NaN.
  _q(k) {
    const v = this[k];
    if (!Number.isFinite(v)) throw new Error(`store: store.${k} is required — declare it in settings.js`);
    return v;
  }

  // Cross-unit query — the thing files could not do. Everything sent, newest first.
  listRequests({ unit, state, kind, limit = 200, offset = 0 } = {}) {
    const where = [], args = [];
    if (unit) { where.push('unit = ?'); args.push(String(unit)); }
    if (state) { where.push('state = ?'); args.push(String(state)); }
    if (kind) { where.push('kind = ?'); args.push(String(kind)); }
    const sql = `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
      + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    return this.db.prepare(sql).all(...args,
      Math.min(Number(limit) || this._q('defaultLimit'), this._q('maxLimit')), Number(offset) || 0)
      .map(rowToEntry);
  }

  // Retention: cap terminal requests per unit. NEVER prunes anything still live — a
  // queued command is an instruction someone gave and must not evaporate.
  pruneRequests(keepPerUnit = 500) {
    const terminal = ['done', 'sent', 'failed', 'expired', 'cancelled'];
    const marks = terminal.map(() => '?').join(',');
    let removed = 0;
    for (const unit of this.listQueuedUnits()) {
      const r = this.db.prepare(
        `DELETE FROM requests WHERE unit = ? AND state IN (${marks}) AND id NOT IN (
           SELECT id FROM requests WHERE unit = ? AND state IN (${marks})
           ORDER BY created_at DESC LIMIT ?)`,
      ).run(unit, ...terminal, unit, ...terminal, Math.max(0, Number(keepPerUnit) || 0));
      removed += r.changes;
    }
    return removed;
  }

  // One-time import of the file-era queues. A command queued before the switch is still
  // someone's instruction, so it must survive. Files are LEFT IN PLACE — deleting them
  // is a separate, later decision, and keeping them means a bad import is recoverable.
  _importLegacyQueues() {
    if (this.cache.value('meta', 'queues_imported')) return 0;
    let units = [];
    try {
      units = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.dir, d.name, 'queue.json')))
        .map((d) => d.name);
    } catch { /* no store dir yet */ }
    let n = 0;
    for (const unit of units) {
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(path.join(this.dir, unit, 'queue.json'), 'utf8')); }
      catch { continue; }
      if (!Array.isArray(entries) || !entries.length) continue;
      // Old status names -> new states. `sent` is REUSED with a different meaning, so it
      // must be rewritten, never passed through.
      const MAP = { pending: 'queued', sent: 'trying', acked: 'done', failed: 'failed', expired: 'expired', cancelled: 'cancelled' };
      this.saveQueue(unit, entries.map((e) => ({ ...e, state: MAP[e.status] || 'queued' })));
      n += entries.length;
    }
    this.cache.put('meta', 'queues_imported', { at: Date.now(), count: n });
    return n;
  }

  // Retention is NOT implemented. Left explicit rather than silently absent.
  prune() { throw new Error('retention policy not implemented — see specs/mesh-images.md §7'); }
}

module.exports = { PayloadStore, EXT };
