// Live state model — the queryable domain view. Nodes with their latest telemetry
// summary, fed by the event stream; consumers read/subscribe, never assemble from
// frames. This is the BASIC model (mesh-cli-live): a map of node id -> last 260
// payload + timestamp. The full typed no-I/O model (images/config caches, typed
// summaries) lands in mesh-model-full (phase 6).
'use strict';

class Model {
  constructor() { this._nodes = new Map(); }

  // Apply a decoded domain event. `from` = node id string; `obj` = parsed 260 JSON.
  apply({ from, obj } = {}) {
    if (!from) return;
    const prev = this._nodes.get(from) || { id: from };
    this._nodes.set(from, { ...prev, id: from, last: obj, ts: Date.now() });
  }

  // A unit transmitted (the 'heard' signal, keyed by the REAL sender). Feeds live/dev mode.
  heard(id, at = Date.now()) {
    if (!id) return;
    const prev = this._nodes.get(id) || { id };
    this._nodes.set(id, { ...prev, id, lastHeardMs: at });
  }
  // Cache a unit's sleep state (a status/config reply's `slp`). Feeds live/dev mode.
  sleep(id, slp) {
    if (!id) return;
    const prev = this._nodes.get(id) || { id };
    this._nodes.set(id, { ...prev, id, slp: slp ? 1 : 0 });
  }

  nodes() { return [...this._nodes.values()]; }   // array of summaries
  node(id) { return this._nodes.get(id) || null; } // one summary or null
}

module.exports = { Model };
