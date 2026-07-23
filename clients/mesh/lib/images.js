// Image domain — hides chunk/push/timing/windows entirely.
//
// AUTONOMOUS by design (the auto-upload gap): startListener() turns on an always-
// on catcher. A device-initiated push (PIR image on port 261) for an unknown pid
// is auto-adopted; a long-lived PushReceiver accumulates chunks across bursts,
// drives the control side (START/PROGRESS_Q/REPAIR/COMPLETE as text), persists
// partials so a MARGINAL link converges across windows and process restarts,
// CRC-verifies, saves the JPEG, and emits an 'image' event. No human ever kicks it.
//
// getImage(node,pid) is the active one-shot over the same drive loop. Ported from
// clients/node index.js push() + push-receiver + store; codec is in protocol.js.
'use strict';
const { PushReceiver } = require('./push-receiver');
const { PayloadStore } = require('./store');
const { MeshError } = require('./errors');

const PT_IMAGE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Images {
  // deps: { gw, gwId, channel, protocol, timing, model, cfg, log, command, send }
  constructor(deps) {
    this.gw = deps.gw;
    this.gwId = deps.gwId;
    this.channel = deps.channel;
    this.protocol = deps.protocol;
    this.timing = deps.timing;
    this.model = deps.model;
    this.cfg = deps.cfg || {};
    this.log = deps.log || { debug() {}, info() {}, warn() {} };
    this.command = deps.command;                 // (node,verb,args) => reply
    this.send = deps.send;                        // (node, text) => fire-and-forget over the DM path
    this.store = new PayloadStore({ dir: (this.cfg.paths && this.cfg.paths.store) || './payloads' });
    this.active = new Map();                      // pid -> { rx, node, aborted, promise }
    this.listening = false;
    this.emit = () => {};                          // installed by Mesh
  }

  // ---- the single port-261 entry point --------------------------------------
  onFrame(buf, from) {
    const f = this.protocol.decodeFrame(buf);
    if (!f) return;
    const now = Date.now();
    const cur = this.active.get(f.pid);
    if (cur) { cur.rx.onFrame(buf, now); return; }
    // Autonomous catch: a fresh push for a pid we're not tracking.
    const M = this.protocol.MSG;
    if (this.listening && (f.type === M.MANIFEST || f.type === M.CHUNK)) {
      const node = from || String(f.pid);
      const entry = this._startTransfer(node, f.pid);
      entry.rx.onFrame(buf, now);
      this.log.info('auto-adopt push pid %d from %s', f.pid, node);
      this.emit('image-available', { node, pid: f.pid });
    }
  }

  // ---- transfer lifecycle ---------------------------------------------------
  _startTransfer(node, pid, opts = {}) {
    const existing = this.active.get(pid);
    if (existing) return existing;
    const T = this.cfg.timing || {};
    const idleMs = T.pushIdleMs != null ? T.pushIdleMs : 35000; // proven push idle
    const entry = { rx: new PushReceiver(pid, { idleMs, actMs: T.pushActMs, quietMs: T.pushQuietMs }), node, aborted: false };
    this.active.set(pid, entry);
    entry.promise = this._drive(entry, opts).finally(() => this.active.delete(pid));
    return entry;
  }

  // Map a decoded control frame to its push sub-command and fire it over the DM path
  // (best-effort: chunks are the reply, not text; a lost control frame costs one idle
  // period). Addressing (@token / to:num / fallback) is owned by the injected send().
  _sendControl(node, buf) {
    const f = this.protocol.decodeFrame(buf);
    if (!f) return;
    const M = this.protocol.MSG;
    let text;
    if (f.type === M.START) text = `push ${f.pid}`;
    else if (f.type === M.PROGRESS_Q) text = `push q ${f.pid}`;
    else if (f.type === M.REPAIR) text = `push rep ${f.pid} ${f.ids.join(',')}`;
    else if (f.type === M.COMPLETE) text = `push done ${f.pid} ${f.crc}`;
    else return;
    this.send(node, text)
      .catch((e) => this.log.debug('control send failed: %s', e && e.message));
  }

  _persistPartial(node, rx) {
    if (!rx.manifest) return;
    const len = rx.manifest.bytes;
    const CH = this.protocol.CHUNK_DATA_MAX;
    const buf = Buffer.alloc(len);
    const have = new Set();
    for (const [seq, data] of rx.chunks) {
      const off = seq * CH;
      if (off >= len) continue;
      const n = Math.min(data.length, len - off);
      data.copy(buf, off, 0, n);
      have.add(seq);
    }
    try {
      this.store.savePartial(node, { pid: rx.pid, crc: rx.manifest.crc, count: rx.manifest.count, len, have, buf });
    } catch (e) { this.log.debug('savePartial failed: %s', e && e.message); }
  }

  async _drive(entry, { onProgress, signal } = {}) {
    const { rx, node } = entry;
    const pid = rx.pid;
    const T = this.cfg.timing || {};
    const pollMs = T.pushPollMs != null ? T.pushPollMs : 1000;
    const deadline = Date.now() + (T.pushDeadlineMs != null ? T.pushDeadlineMs : 900000);
    const PROTO = this.protocol.PROTO_VERSION;

    // Adopt / START, and resume from a persisted partial when the device confirms
    // the SAME payload (crc+count). Never blend two images behind a reused pid.
    let adopt = false;
    let st = null;
    try {
      st = await this.command(node, 'push', ['stat']);
      if (st && st.proto !== undefined && st.proto !== PROTO) {
        throw new MeshError(`image ${pid}: protocol mismatch — device v${st.proto} (fw ${st.fw}), client v${PROTO}`, 'EPROTO');
      }
      if (st && st.upst === 0) {
        throw new MeshError(`image ${pid}: device holds no published payload (upst=0)`, 'ENOIMG');
      }
      if (st && (st.upst === 2 || st.upst === 3) && st.up === pid) adopt = true;
    } catch (e) {
      if (e.code === 'EPROTO' || e.code === 'ENOIMG') throw e;
      // no stat reply — fall through and START normally
    }

    if (st && st.crc !== undefined) {
      const prior = this.store.loadPartial(node, pid);
      if (prior && prior.crc === (st.crc >>> 0) && prior.count === st.cnt) {
        rx.seed(prior);
        this.log.debug('resume: seeded %d/%d for pid %d', prior.have.size, prior.count, pid);
      } else if (prior) {
        this.store.clearPartial(node, pid);
      }
    }

    if (!adopt) this._sendControl(node, this.protocol.encodeStart(pid));

    let lastPersistCount = -1;
    while (Date.now() < deadline) {
      if ((signal && signal.aborted) || entry.aborted) {
        throw new MeshError(`image ${pid}: aborted`, 'EABORT');
      }
      await sleep(pollMs);

      const out = rx.tick(Date.now());
      if (out) this._sendControl(node, out);

      if (rx.received !== lastPersistCount) { lastPersistCount = rx.received; this._persistPartial(node, rx); }
      if (onProgress) { try { onProgress({ received: rx.received, count: rx.count }); } catch { /* never break the transfer */ } }

      if (rx.failed) throw new MeshError(`image ${pid}: ${rx.failed}`, 'EXFER');
      if (rx.done) {
        const buf = rx.assemble();
        if (!buf) throw new MeshError(`image ${pid}: complete but CRC failed`, 'ECRC');
        this.store.clearPartial(node, pid);
        const path = this.store.save(buf, { pid, ptype: PT_IMAGE, node });
        this.log.info('image saved: pid %d (%d bytes) -> %s', pid, buf.length, path);
        this.emit('image', { node, pid, path, bytes: buf.length });
        return { buf, path };
      }
    }
    throw new MeshError(`image ${pid}: deadline at ${rx.received}/${rx.count}`, 'EDEADLINE');
  }

  // ---- public API -----------------------------------------------------------
  async get(node, pid, opts = {}) {
    pid = pid | 0;
    if (this.active.has(pid)) throw new MeshError(`image ${pid}: already in flight`, 'EBUSY');
    const { buf } = await this._startTransfer(node, pid, opts).promise;
    return buf;
  }

  async list(node) {
    const st = await this.command(node, 'push', ['stat']);
    return {
      pid: st && st.up, state: st && st.upst, chunks: st && st.cnt,
      crc: st && st.crc, proto: st && st.proto, fw: st && st.fw,
      ready: !!(st && st.upst !== 0 && st.up > 0),
    };
  }

  // Capture a fresh photo then fetch it. `cam grab` is answered by the device PUBLISHING
  // the new image (not a text reply), so we fire it and poll list() until a NEW pid is
  // ready, then get() it. This is the flow that verified the pipeline live (pid 60780).
  async grab(node, { pollMs = 2000, timeoutMs = 30000 } = {}) {
    // Cap each poll: list() carries the idempotent retry, which can block for tens of
    // seconds on a congested link — a single slow poll must not stall the whole grab.
    const listOnce = () => Promise.race([
      this.list(node).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    const before = (await listOnce()) || {};
    await this.send(node, 'cam grab');                       // trigger capture (fire-and-forget)
    const deadline = Date.now() + timeoutMs;
    let st = null;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      st = await listOnce();
      if (st && st.ready && st.pid && st.pid !== before.pid) break;   // a fresh capture is published
    }
    if (!(st && st.ready && st.pid)) throw new MeshError('grab: no fresh capture published in time', 'EGRAB');
    const buf = await this.get(node, st.pid);
    return { pid: st.pid, bytes: buf.length, buf };
  }

  startListener() {
    this.listening = true;
    this.log.info('image listener ON (autonomous auto-upload catch)');
    return () => this.stopListener();
  }

  stopListener() {
    this.listening = false;
    for (const entry of this.active.values()) entry.aborted = true;
    this.log.info('image listener OFF');
  }
}

module.exports = { Images };
