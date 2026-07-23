'use strict';
// mt-chunk-push — the passive receiver. Ported verbatim from
// clients/node/lib/push-receiver.js (codec now lives in ./protocol). Do NOT
// simplify: every constant and comment encodes a lesson paid for on-air.
//
// THE WHOLE DESIGN IS IN onFrame(): store[seq] = payload, and nothing else.
// No gap tracking, no windows, no per-chunk timers, no acks. Out-of-order
// arrival, duplicates and reordering are non-events, because the sequence id
// carries the position and a duplicate is an idempotent overwrite. There is no
// in-flight logic to get wrong — which is the point, since every failure we
// measured under pull was in logic that ran while the transfer was in flight.
//
// Everything else lives in tick(), which runs only when the line has gone QUIET.
//
// State machine, deliberately small:
//   no manifest + idle      -> re-send START      (self-heals a lost START)
//   have manifest + idle    -> send PROGRESS_Q    (am I waiting, or did I lose the tail?)
//   PROGRESS{done:false}    -> keep waiting       (device is pacing itself)
//   PROGRESS{done:true}     -> REPAIR missing ids, or COMPLETE if none

const p = require('./protocol');

const ST = { START: 'start', RECEIVING: 'receiving', REPAIRING: 'repairing', DONE: 'done' };

class PushReceiver {
  /**
   * @param pid       payload id to fetch
   * @param idleMs    quiet period before we ask the device anything. Must be
   *                  comfortably longer than the device's inter-send gap, or we
   *                  interrupt a stream that is merely pacing itself.
   * @param maxStale  give up after this many CONSECUTIVE repair rounds that
   *                   delivered nothing new. NOT a cap on total rounds: at high
   *                   loss the REPAIR request itself is often the frame lost, so
   *                   a total cap gives up on a transfer converging perfectly
   *                   well, just slowly. What we detect is "stuck" = no new chunks.
   * @param maxUnanswered give up after this many PROGRESS_Q in a row that got no
   *                      reply. Without it the receiver waits FOREVER on a dead
   *                      device. Reset by ANY inbound frame (proof of life beats
   *                      absence of one reply). Sized loose (30) on purpose: on a
   *                      lossy link replies are lost too, so a live device looks
   *                      dead — aborting a WORKING transfer is far worse than
   *                      taking ~4 min to notice a genuinely dead one.
   */
  constructor(pid, { idleMs = 8000, maxStale = 8, maxUnanswered = 30,
                     actMs = 4000, quietMs = 15000 } = {}) {
    // actMs: spacing once the DEVICE has told us where it is. The long idleMs is
    // for detecting silence we cannot otherwise explain; it must not also gate
    // the actions we take after the answer arrives.
    // quietMs: the wait once we HAVE a manifest and the stream has fallen quiet
    // but the device has not yet said "done". Invariant actMs < quietMs < idleMs.
    // Must stay comfortably above the device's max inter-chunk gap (measured 9s)
    // or we query mid-stream — wasted airtime only, never a premature REPAIR.
    this.actMs = actMs;
    this.quietMs = quietMs;
    this.maxUnanswered = maxUnanswered;
    this.unanswered = 0;
    this.pid = pid;
    this.idleMs = idleMs;
    this.maxStale = maxStale;

    this.chunks = new Map(); // seq -> Buffer. The entire receive state.
    this.manifest = null;
    this.state = ST.START;
    this.rounds = 0;
    this.staleRounds = 0;
    this.heldAtLastRepair = -1;

    this.lastRxMs = -Infinity;   // last time ANY frame arrived
    this.lastTxMs = -Infinity;   // last time we asked for anything
    this.awaitingProgress = false;
    this.failed = null;

    this.stats = { chunkFrames: 0, dupes: 0, manifests: 0, progressReplies: 0,
                   startsSent: 0, queriesSent: 0, repairsSent: 0, repairIds: 0,
                   staleRounds: 0, deviceCursor: null };
  }

  // ---- passive receive ------------------------------------------------------
  onFrame(buf, nowMs) {
    const f = p.decodeFrame(buf);
    if (!f || f.pid !== this.pid) return false;

    this.lastRxMs = nowMs;
    // ANY frame proves the device is alive — chunks, manifest, progress alike.
    this.unanswered = 0;

    if (f.type === p.MSG.CHUNK) {
      this.stats.chunkFrames++;
      if (this.chunks.has(f.seq)) this.stats.dupes++;
      // Idempotent overwrite. A duplicate is not an error and not a special case.
      this.chunks.set(f.seq, Buffer.from(f.data));
      if (this.state === ST.START) this.state = ST.RECEIVING;
      return true;
    }

    if (f.type === p.MSG.MANIFEST) {
      this.stats.manifests++;
      // Repeated by the device on a cadence precisely so losing one cannot strand
      // us. Taking the first and ignoring the rest is correct.
      if (!this.manifest) this.manifest = { bytes: f.bytes, count: f.count, crc: f.crc };
      if (this.state === ST.START) this.state = ST.RECEIVING;
      return true;
    }

    if (f.type === p.MSG.PROGRESS) {
      this.stats.progressReplies++;
      this.stats.deviceCursor = f.cursor;
      this.awaitingProgress = false;
      // done means "finished this pass", NOT that we have everything.
      this.progressDone = f.done;
      return true;
    }

    return false;
  }

  // ---- resume ---------------------------------------------------------------
  // Install a persisted partial (identity ALREADY checked by the caller against
  // the device's live crc/count — never blend two images behind a reused pid).
  // The partial's identity IS the manifest; chunks are reconstructed from the
  // contiguous buffer at the fixed CHUNK_DATA_MAX stride (every chunk but the
  // last is exactly that size). This is what lets a marginal transfer survive a
  // process/daemon restart instead of starting from zero.
  seed(prior) {
    const CH = p.CHUNK_DATA_MAX;
    this.manifest = { bytes: prior.len, count: prior.count, crc: prior.crc >>> 0 };
    for (const seq of prior.have) {
      const off = seq * CH;
      if (off >= prior.len) continue;
      const end = Math.min(off + CH, prior.len);
      this.chunks.set(seq, Buffer.from(prior.buf.subarray(off, end)));
    }
    if (this.chunks.size) this.state = ST.RECEIVING;
  }

  // ---- what we are missing --------------------------------------------------
  missing() {
    if (!this.manifest) return null;
    const out = [];
    for (let i = 0; i < this.manifest.count; i++) if (!this.chunks.has(i)) out.push(i);
    return out;
  }

  get received() { return this.chunks.size; }
  get count() { return this.manifest ? this.manifest.count : 0; }
  get done() { return this.state === ST.DONE; }

  // ---- drive ----------------------------------------------------------------
  // Returns a Buffer to send, or null. Called on every loop iteration; almost
  // always returns null, because a healthy transfer needs nothing from us.
  tick(nowMs) {
    if (this.state === ST.DONE || this.failed) return null;

    // Not idle yet — the device is streaming. Do nothing. Three-way gate:
    //   known (device said done / we hold all) -> actMs  : act at once — that once
    //         cost 3 x 35 s of dead time on a transfer missing ONE chunk.
    //   have manifest, stream quiet, not done  -> quietMs: query soon. The device
    //         streams every few s (measured max gap 9s); the old 35s here was dead
    //         airtime — a clean run wasted 2 x 35 s on a transfer missing 2 of 32.
    //   no manifest yet (awaiting START/stream)-> idleMs : stay patient. A short
    //         wait resends START before the device's ~20s prepare and can restart
    //         its stream. The startup wait and the quiet wait are NOT the same.
    const known = this.manifest && (this.progressDone || this.missing().length === 0);
    const gate = known ? this.actMs : (this.manifest ? this.quietMs : this.idleMs);
    if (nowMs - this.lastRxMs < gate) return null;
    if (nowMs - this.lastTxMs < gate) return null;

    this.lastTxMs = nowMs;

    // Nothing has ever arrived: the START was lost. Ask again — idempotent.
    if (!this.manifest && this.chunks.size === 0) {
      this.stats.startsSent++;
      return p.encodeStart(this.pid);
    }

    // Chunks but no manifest yet — just ask where the device is and keep listening.
    if (!this.manifest) return this._query();

    const miss = this.missing();

    // We have everything. Only WE can assert this — say so and release the buffer.
    if (miss.length === 0) {
      const asm = this.assemble();
      if (!asm) { this.failed = 'CRC mismatch on a complete set'; return null; }
      this.state = ST.DONE;
      return p.encodeComplete(this.pid, this.manifest.crc);
    }

    // Still sending, or finished and we lost the tail? Only the device knows.
    if (!this.progressDone) return this._query();

    // Device finished its pass, we still have gaps. Ask for exactly those ids.
    // Progress, not attempts: a round that delivered even one chunk resets it.
    if (this.chunks.size > this.heldAtLastRepair) this.staleRounds = 0;
    else this.staleRounds++;
    this.heldAtLastRepair = this.chunks.size;
    this.rounds++;

    if (this.staleRounds >= this.maxStale) {
      this.failed = `stuck: ${this.maxStale} consecutive repair rounds delivered ` +
                    `nothing new, still missing ${miss.length} of ${this.manifest.count}`;
      return null;
    }
    const ids = miss.slice(0, p.REPAIR_IDS_MAX);
    this.state = ST.REPAIRING;
    this.progressDone = false; // it will be sending again; re-ask before next repair
    this.stats.repairsSent++;
    this.stats.repairIds += ids.length;
    this.stats.staleRounds = this.staleRounds;
    return p.encodeRepair(this.pid, ids);
  }

  // Ask where the device got to. Tracks unanswered queries so a dead device
  // produces a clear failure rather than an eternal wait.
  _query() {
    if (this.awaitingProgress) this.unanswered++;
    else this.unanswered = 0;

    if (this.unanswered >= this.maxUnanswered) {
      this.failed = `device unresponsive: ${this.maxUnanswered} progress queries ` +
                    `unanswered, holding ${this.chunks.size}` +
                    (this.manifest ? `/${this.manifest.count}` : '') + ' chunks';
      return null;
    }
    this.stats.queriesSent++;
    this.stats.unanswered = this.unanswered;
    this.awaitingProgress = true;
    return p.encodeProgressQ(this.pid);
  }

  // ---- assemble -------------------------------------------------------------
  // Verified, never assumed: a complete set that fails CRC is a failure.
  assemble() {
    if (!this.manifest) return null;
    const parts = [];
    for (let i = 0; i < this.manifest.count; i++) {
      const c = this.chunks.get(i);
      if (!c) return null;
      parts.push(c);
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== this.manifest.bytes) return null;
    if (p.crc32(buf) !== this.manifest.crc) return null;
    return buf;
  }
}

module.exports = { PushReceiver, ST };
