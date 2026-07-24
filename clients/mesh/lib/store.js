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
