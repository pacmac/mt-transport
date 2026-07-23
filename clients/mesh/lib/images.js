// Image domain — hides chunk/push/timing/windows entirely. getImage runs the
// whole device-paced transfer and resolves bytes; startImageListener passively
// catches device-initiated pushes (auto-upload). (Bodies: mesh-images phase.)
'use strict';
const { ni } = require('./errors');

class Images {
  constructor(deps) { this.deps = deps; }           // { gw, protocol, timing, model, cfg }
  async list(node) { return ni('images.list'); }    // pids available on a node
  async get(node, pid, opts) { return ni('images.get'); } // -> Buffer (onProgress, signal)
  startListener() { return ni('images.startListener'); }  // passive push receiver
  stopListener() { return ni('images.stopListener'); }
}

module.exports = { Images };
