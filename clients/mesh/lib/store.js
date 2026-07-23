'use strict';
// Writes verified payloads out. Ported from clients/node/lib/store.js.
//
// NO CONVERSION HAPPENS HERE. The camera emits JPEG and the chunker moves opaque
// bytes, so this is a write. If this file ever grows an image library, something
// has gone wrong upstream.

const fs = require('fs');
const path = require('path');

const EXT = { 1: 'json', 2: 'jpg', 3: 'log', 4: 'json' }; // SCHEMA/IMAGE/LOG/JSON

class PayloadStore {
  constructor({ dir = './payloads' } = {}) { this.dir = dir; }

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

  // Retention is NOT implemented. Left explicit rather than silently absent.
  prune() { throw new Error('retention policy not implemented — see specs/mesh-images.md §7'); }
}

module.exports = { PayloadStore, EXT };
