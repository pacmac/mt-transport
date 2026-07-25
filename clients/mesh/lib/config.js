// Config DOMAIN (device settings) — NOT the app config.yaml loader (that is
// settings.js). Owns the device's OWN schema (via the `sch` command, port 260)
// and validates set() against it BEFORE any airtime, so a consumer never sends a
// value the device rejects. mesh-gw's /schema is stock Meshtastic — not this.
//
// Transport is injected (config.js owns no addressing): `command` for text-reply
// verbs (config, chunk cfg) and `send` (DM-aware, fire-and-forget) for `sch` pages,
// The SCHEMA is no longer pulled over the air at all — it is a file generated at
// reply. Addressing (target->num, DM vs fallback) lives in mesh-dm; we just pass a node.
'use strict';
const fs = require('fs');
const { MeshError } = require('./errors');

// field -> text-command mapping. The device's uniform {type:set} channel (PRIVATE_APP
// on 260) is unreachable — mesh-gw send is text-only — so each writable field maps to a
// text command here. EXTENSIBLE: add an entry per field. chunk.* is what the gap-sweep
// needs now. `chunk cfg <hop> <gap>` sets BOTH, so write() carries the unchanged sibling.
// needsCurrent: read the current value first (chunk cfg sets BOTH hop+gap, so we must
// carry the unchanged sibling). confirm(): validate from the WRITE reply — every write
// echoes its result (chunk cfg -> {hop,gap}; name/lname -> {name,ok}) — so no read-back.
const COMMAND_MAP = {
  'chunk.gap': { needsCurrent: true, readVerb: 'chunk', readArgs: ['cfg'], writeVerb: 'chunk',
                 write: (cur, v) => ['cfg', String(cur.hop), String(v)],
                 confirm: (r, v) => !!(r && Number(r.gap) === v) },
  'chunk.hop': { needsCurrent: true, readVerb: 'chunk', readArgs: ['cfg'], writeVerb: 'chunk',
                 write: (cur, v) => ['cfg', String(v), String(cur.gap)],
                 confirm: (r, v) => !!(r && Number(r.hop) === v) },
  'name':  { writeVerb: 'name',  write: (cur, v) => [v], confirm: (r, v) => !!(r && r.ok && r.name === v) },
  'lname': { writeVerb: 'lname', write: (cur, v) => [v], confirm: (r, v) => !!(r && r.ok && r.name === v) },
  // agc [<on> [<sec>]] sets BOTH on+sec and replies {type:'agc',on,sec,agcr} — same shape as
  // chunk cfg (hop+gap), so each write carries the unchanged sibling read from bare `agc`.
  'agc.on':  { needsCurrent: true, readVerb: 'agc', readArgs: [], writeVerb: 'agc',
               write: (cur, v) => [String(v), String(cur.sec)],
               confirm: (r, v) => !!(r && Number(r.on) === v) },
  'agc.sec': { needsCurrent: true, readVerb: 'agc', readArgs: [], writeVerb: 'agc',
               write: (cur, v) => [String(cur.on), String(v)],
               confirm: (r, v) => !!(r && Number(r.sec) === v) },
};

// Writable fields with no device read command — surfaced by get() as `unread`,
// never faked (they exist in the schema but have no live-value source).
const UNREAD_FIELDS = ['mute', 'push.auto', 'tele.chg', 'tele.ka', 'name', 'lname'];

// Built-in bounds for the COMMAND_MAP fields, used ONLY when the device schema is
// unreachable (the `sch` broadcast is lossy on a congested/marginal mesh). These MUST
// mirror CONFIG_FIELDS in pac-garage-alarm/src/main.cpp — they are a reachability
// fallback, not the source of truth (the device schema is; it is preferred when it loads).
const FALLBACK_FIELDS = {
  'chunk.gap': { id: 'chunk.gap', ty: 'n', label: 'Chunk gap ms', writable: true, min: 0, max: 60000, bounded: true },
  'chunk.hop': { id: 'chunk.hop', ty: 'n', label: 'Chunk hops', writable: true, min: 0, max: 7, bounded: true },
  'name':  { id: 'name',  ty: 't', label: 'Short name', writable: true, min: 1, max: 4,  bounded: true }, // mn/mx are LENGTHS
  'lname': { id: 'lname', ty: 't', label: 'Long name',  writable: true, min: 1, max: 30, bounded: true }, // device validateName caps 24; confirm catches over-cap
  'agc.on':  { id: 'agc.on',  ty: 'b', label: 'AGC reset',   writable: true },
  'agc.sec': { id: 'agc.sec', ty: 'n', label: 'AGC reset s', writable: true, min: 5, max: 3600, bounded: true },
};

// One ragged schema row -> a field descriptor. Rows (from fmtField in the firmware):
//   text    [id,"t",lb,"",  w, mn, mx]   (mn/mx are LENGTHS)
//   bool    [id,"b",lb,df,  w]
//   numeric [id,"n",lb,df,  w, mn, mx]   (bounded) | [id,"n",lb,df,w] (unbounded)
function parseRow(r) {
  if (!Array.isArray(r) || r.length < 5) return null;
  const f = { id: r[0], ty: r[1], label: r[2], def: null, writable: false, min: null, max: null, bounded: false };
  if (f.ty === 'b') { f.def = r[3]; f.writable = !!r[4]; }
  else if (f.ty === 't') { f.def = r[3]; f.writable = !!r[4]; f.min = r[5]; f.max = r[6]; f.bounded = true; }
  else if (f.ty === 'n') { f.def = r[3]; f.writable = !!r[4]; if (r.length >= 7) { f.min = r[5]; f.max = r[6]; f.bounded = true; } }
  else return null;
  return f;
}

class Config {
  constructor(deps = {}) {
    this.command = deps.command;                 // (node,verb,args) => text reply object
    this.send = deps.send;                       // (node,text) => fire-and-forget (DM path)
    this.log = deps.log || { debug() {}, info() {}, warn() {} };
    this.store = deps.store || null;             // persists payloads; no longer used for schema
    // The schema comes from a FILE generated at firmware build time (schema.file), never
    // from the radio. It is static per build, so there is nothing to pull and nothing to
    // cache across restarts beyond the hot map below.
    this.schemaFile = deps.schemaFile || null;
    this._schema = new Map();                    // node -> { ver, fields:[...] } (hot cache)
  }

  // ---- schema: the device's own field table (pull-paginated, cached) ----------
  // Resolution order: hot cache -> PERSISTED cache -> pull from the device.
  //
  // The persisted step is what makes this usable at all. Pulling `sch` pages needs the
  // unit AWAKE, and a 15-minute sleeper is unreachable ~99% of the time — so without a
  // cache that survives a service restart, a dashboard could not render a config form
  // until the unit happened to wake. The schema only changes when firmware changes, so
  // a cached copy is valid indefinitely; `refresh` forces a re-pull after a flash.
  //
  // If the device cannot be reached we RETURN THE CACHE rather than throwing, flagged
  // `stale: true` so the caller can say "from cache" instead of showing an error.
  async schema(node, { refresh = false } = {}) {
    // THE SCHEMA IS A FILE, NEVER RADIO TRAFFIC. It is static per firmware build, so
    // pulling it over LoRa was always the wrong mechanism — 20 fields at 3 per page is
    // SEVEN request/response round trips at 30-90 s each, and it never once completed.
    // Generated at firmware build time from CONFIG_FIELDS (tools/gen_schema.py), so it
    // cannot drift from what applySet() validates against.
    if (!refresh) {
      const hot = this._schema.get(node);
      if (hot) return hot;
    }
    const file = this.schemaFile;
    if (!file) throw new MeshError('config: schema.file is not configured — declare it in settings.js', 'ECONFIG');

    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      throw new MeshError(`schema file unreadable (${file}): ${e.message}. It is generated `
        + 'by the firmware build (tools/gen_schema.py) — build the firmware to produce it.', 'ESCHEMAFILE');
    }
    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) { throw new MeshError(`schema file is not valid JSON (${file}): ${e.message}`, 'ESCHEMAFILE'); }
    if (!doc || !Array.isArray(doc.fields) || !doc.fields.length) {
      throw new MeshError(`schema file has no fields (${file}) — refusing to serve an empty schema`, 'ESCHEMAFILE');
    }

    const schema = {
      ver: doc.ver != null ? doc.ver : 1,
      fw: doc.fw != null ? doc.fw : null,
      fields: doc.fields,
      source: 'file',
      fetchedAt: Date.now(),
    };
    this._schema.set(node, schema);
    return schema;
  }

  // ---- get: compose the available device reads into a flat values map ---------
  async get(node) {
    const cfg = await Promise.resolve(this.command(node, 'config')).catch(() => null);
    const chunk = await Promise.resolve(this.command(node, 'chunk', ['cfg'])).catch(() => null);
    const values = {};
    const put = (k, v) => { if (v != null) values[k] = v; };
    if (cfg && typeof cfg === 'object') {
      put('beat', cfg.beat); put('txp', cfg.txp); put('slp', cfg.slp);
      if (cfg.det) { put('det.n', cfg.det.n); put('det.win', cfg.det.win); }
      if (cfg.alm) { const a = cfg.alm; put('alm.on', a.on); put('alm.ovr', a.ovr); put('alm.und', a.und); put('alm.hum', a.hum); put('alm.ren', a.ren); }
    }
    if (chunk && typeof chunk === 'object') { put('chunk.hop', chunk.hop); put('chunk.gap', chunk.gap); }
    const unread = UNREAD_FIELDS.filter((k) => !(k in values));
    return { values, unread };
  }

  // ---- set: schema-validated (no airtime if invalid), mapped, then confirmed --
  // Resolve a field descriptor WITHOUT forcing a schema pull when we already know the
  // field: prefer an already-cached device schema, then the built-in bound for a mapped
  // field. Only when the field is unknown to both do we pull the schema (a non-mapped
  // field genuinely needs it). This keeps a mapped set (chunk.gap — the gap-sweep) off
  // the air-heavy `sch` broadcast, which is unreliable on a congested/marginal mesh.
  async _field(node, field) {
    const cached = this._schema.get(node);
    let f = cached && cached.fields.find((x) => x.id === field);
    if (f) return f;
    f = FALLBACK_FIELDS[field];
    if (f) return f;
    let schema = null;
    // The schema being unavailable must DEGRADE to the built-in bounds, never fail the
    // write outright — that is what FALLBACK_FIELDS is for. Previously this caught only
    // the over-air 'ESCHEMA'; the file path raises ESCHEMAFILE (missing/corrupt file) or
    // ECONFIG (schema.file not declared), and those were propagating instead of falling
    // back, turning a degraded case into a hard failure.
    const SCHEMA_UNAVAILABLE = new Set(['ESCHEMA', 'ESCHEMAFILE', 'ECONFIG']);
    try { schema = await this.schema(node); }
    catch (e) {
      if (!SCHEMA_UNAVAILABLE.has(e.code)) throw e;
      this.log.warn('config schema unavailable (%s) — falling back to built-in bounds', e.message);
    }
    f = schema && schema.fields.find((x) => x.id === field);
    if (!f) throw new MeshError(schema ? `unknown field ${field}` : `field ${field} needs the device schema (unavailable)`, 'EFIELD');
    return f;
  }

  async set(node, patch) {
    const out = {};
    for (const [field, raw] of Object.entries(patch || {})) {
      const f = await this._field(node, field);
      if (!f.writable) throw new MeshError(`${field} is read-only`, 'EREADONLY');

      // Coerce + validate CLIENT-SIDE — an invalid value never reaches the air.
      let v;
      if (f.ty === 'b') {
        v = (raw === true || raw === 1 || raw === '1' || raw === 'true') ? 1
          : (raw === false || raw === 0 || raw === '0' || raw === 'false') ? 0 : NaN;
        if (v !== 0 && v !== 1) throw new MeshError(`${field}: expected 0 or 1`, 'EVALUE');
      } else if (f.ty === 'n') {
        v = Number(raw);
        if (!Number.isFinite(v) || !Number.isInteger(v)) throw new MeshError(`${field}: expected an integer`, 'EVALUE');
        if (f.bounded && (v < f.min || v > f.max)) throw new MeshError(`${field} out of range [${f.min},${f.max}]`, 'ERANGE');
      } else if (f.ty === 't') {
        v = String(raw);
        if (f.bounded && (v.length < f.min || v.length > f.max))
          throw new MeshError(`${field}: length ${v.length} out of [${f.min},${f.max}]`, 'ERANGE');
      } else {
        throw new MeshError(`${field}: unsupported type ${f.ty}`, 'EVALUE');
      }

      const map = COMMAND_MAP[field];
      if (!map) throw new MeshError(`${field} valid but no transport mapping yet`, 'ENOMAP');

      // chunk.* must preserve its sibling, so read current first; text fields don't.
      let cur = null;
      if (map.needsCurrent) {
        cur = await this.command(node, map.readVerb, map.readArgs);
        if (!cur || typeof cur !== 'object') throw new MeshError(`${field}: could not read current value`, 'ECONFIRM');
      }
      const reply = await this.command(node, map.writeVerb, map.write(cur, v));
      if (!map.confirm(reply, v)) throw new MeshError(`${field}: set not confirmed`, 'ECONFIRM');
      out[field] = v;
    }
    return { set: out, confirmed: true };
  }
}

module.exports = { Config };
