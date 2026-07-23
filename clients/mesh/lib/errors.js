// Domain errors. Consumers see these — never transport/protocol internals.
'use strict';

class MeshError extends Error {
  constructor(msg, code) { super(msg); this.name = 'MeshError'; this.code = code; }
}
// Thrown by every skeleton function body until its phase implements it.
class NotImplemented extends MeshError {
  constructor(what) { super(`not implemented: ${what}`, 'ENOTIMPL'); this.name = 'NotImplemented'; }
}
class NodeOffline extends MeshError {
  constructor(node) { super(`node offline: ${node}`, 'ENODEOFF'); this.name = 'NodeOffline'; }
}
class ImageUnavailable extends MeshError {
  constructor(node, pid) { super(`image unavailable: ${node}/${pid}`, 'EIMGUNAVAIL'); this.name = 'ImageUnavailable'; }
}
class OutOfRange extends MeshError {
  constructor(key, value, lo, hi) { super(`out of range: ${key}=${value} (allowed ${lo}..${hi})`, 'ERANGE'); this.name = 'OutOfRange'; }
}

// Helper the skeleton uses everywhere.
const ni = (what) => { throw new NotImplemented(what); };

module.exports = { MeshError, NotImplemented, NodeOffline, ImageUnavailable, OutOfRange, ni };
