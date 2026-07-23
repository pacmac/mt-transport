// Live state model — the queryable domain view (no I/O). Nodes with current
// summary (id/name/uptime/battery/cam), known images, config cache. Fed by the
// event stream; consumers read/subscribe, never assemble from frames.
// (Bodies: mesh-model phase.)
'use strict';
const { ni } = require('./errors');

class Model {
  constructor() { this._nodes = new Map(); }
  nodes() { return ni('model.nodes'); }             // array of summaries
  node(id) { return ni('model.node'); }             // one node summary
  // Apply a decoded domain event to the model. Skeleton.
  apply(event) { return ni('model.apply'); }
}

module.exports = { Model };
