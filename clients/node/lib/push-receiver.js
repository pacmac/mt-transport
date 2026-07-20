'use strict';
// mt-chunk-push — the passive receiver.
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
//
// tick() returns a frame to send or null. It never sends more than one at a
// time, and every frame it can send is idempotent, so losing any of them costs
// one more idle period rather than the transfer.

const p = require('./chunk-push');

const ST = { START: 'start', RECEIVING: 'receiving', REPAIRING: 'repairing', DONE: 'done' };

class PushReceiver {
  /**
   * @param pid       payload id to fetch
   * @param idleMs    quiet period before we ask the device anything. Must be
   *                  comfortably longer than the device's inter-send gap, or we
   *                  interrupt a stream that is merely pacing itself.
   * @param maxStale  give up after this many CONSECUTIVE repair rounds that
   *                   delivered nothing new. Deliberately NOT a cap on total
   *                   rounds: at high loss the REPAIR request itself is often
   *                   the frame that gets lost, so a total cap gives up on a
   *                   transfer that is converging perfectly well, just slowly.
   *                   What we actually want to detect is "stuck", and stuck
   *                   means no new chunks — not "many attempts".
   */
  /**
   * @param maxUnanswered give up after this many PROGRESS_Q in a row that got no
   *                      reply. Without this the receiver waits FOREVER on a dead
   *                      device — it never reaches the repair branch, so the
   *                      stale-round bound never trips. Found by the e2e harness
   *                      killing the device mid-stream; the symptom was a fetch
   *                      that neither completes nor errors, which is exactly the
   *                      failure mode this whole protocol exists to remove.
   *
   *                      TUNING, learned the hard way: a first attempt at 6 broke
   *                      the 30% and 50% loss cases. On a lossy link the REPLIES
   *                      are lost too, so a live device looks dead — the two are
   *                      indistinguishable from a query alone. The counter is
   *                      therefore reset by ANY inbound frame (see onFrame):
   *                      receiving anything at all is proof of life, and that is
   *                      a far stronger signal than the absence of one reply.
   *                      Sizing it, with arithmetic rather than a guess: while
   *                      the device is in AWAITACK it is LEGITIMATELY SILENT, so
   *                      the liveness reset cannot help there — silence is the
   *                      expected state. At 50% loss a query round-trip succeeds
   *                      with p = 0.5 * 0.5 = 0.25, so N tries fail with 0.75^N,
   *                      and a transfer has ~8 such stretches. N=12 gives ~23%
   *                      cumulative false-death (measured: 2/5 seeds wrongly
   *                      aborted). N=30 gives ~0.02% per stretch, and costs ~30
   *                      idle periods (~4 min) to declare a genuinely dead
   *                      device. Aborting a WORKING transfer is far worse than
   *                      taking four minutes to notice a dead one, so the bound
   *                      is deliberately loose.
   */
  constructor(pid, { idleMs = 8000, maxStale = 8, maxUnanswered = 30,
                     actMs = 4000 } = {}) {
    // actMs: spacing once the DEVICE has told us where it is. The long idleMs is
    // for detecting silence we cannot otherwise explain; it must not also gate
    // the actions we take after the answer arrives.
    this.actMs = actMs;
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

    // Diagnostics — the free loss measurement push gives us. The device tells
    // us how many it sent; we know how many we hold.
    this.stats = { chunkFrames: 0, dupes: 0, manifests: 0, progressReplies: 0,
                   startsSent: 0, queriesSent: 0, repairsSent: 0, repairIds: 0,
                   staleRounds: 0, deviceCursor: null };
  }

  // ---- passive receive ------------------------------------------------------
  // This is all of it.
  onFrame(buf, nowMs) {
    const f = p.decodeFrame(buf);
    if (!f || f.pid !== this.pid) return false;

    this.lastRxMs = nowMs;
    // ANY frame proves the device is alive — chunks, manifest, progress alike.
    // This is what separates "device gone" from "replies being lost".
    this.unanswered = 0;

    if (f.type === p.MSG.CHUNK) {
      this.stats.chunkFrames++;
      if (this.chunks.has(f.seq)) this.stats.dupes++;
      // Idempotent overwrite. A duplicate is not an error and not a special
      // case; it is the same bytes landing in the same slot.
      this.chunks.set(f.seq, Buffer.from(f.data));
      if (this.state === ST.START) this.state = ST.RECEIVING;
      return true;
    }

    if (f.type === p.MSG.MANIFEST) {
      this.stats.manifests++;
      // Repeated by the device on a cadence precisely so losing one cannot
      // strand us. Taking the first and ignoring the rest is correct.
      if (!this.manifest) this.manifest = { bytes: f.bytes, count: f.count, crc: f.crc };
      if (this.state === ST.START) this.state = ST.RECEIVING;
      return true;
    }

    if (f.type === p.MSG.PROGRESS) {
      this.stats.progressReplies++;
      this.stats.deviceCursor = f.cursor;
      this.awaitingProgress = false;
      // done means "finished this pass", NOT that we have everything. Only we
      // can know that, and we answer it below in tick().
      this.progressDone = f.done;
      return true;
    }

    return false;
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

    // Not idle yet — the device is streaming. Do nothing at all. Interrupting
    // here is exactly the mistake pull made on every batch.
    //
    // BUT once the device has SAID it finished its pass (or we already hold
    // everything), we are no longer guessing, so the long timer must not apply.
    // It previously did, and each tail step cost a FULL idle period — query,
    // repair and complete = 3 x 35 s = 105 s of dead time. Measured consequence:
    // a transfer missing ONE chunk sat at 31/32 and overran a 240 s deadline.
    // The idle timer detects unexplained silence; it must not delay the action
    // that the answer already justified.
    const known = this.manifest && (this.progressDone || this.missing().length === 0);
    const gate = known ? this.actMs : this.idleMs;
    if (nowMs - this.lastRxMs < gate) return null;
    if (nowMs - this.lastTxMs < gate) return null;

    this.lastTxMs = nowMs;

    // Nothing has ever arrived: the START was lost (or the device had nothing
    // to send yet). Ask again — idempotent, and the device restarts the pass.
    if (!this.manifest && this.chunks.size === 0) {
      this.stats.startsSent++;
      return p.encodeStart(this.pid);
    }

    // Chunks arrived but no manifest yet — it can only be requested by waiting
    // for a repeat, so just ask where the device is and keep listening.
    if (!this.manifest) return this._query();

    const miss = this.missing();

    // We have everything. Only WE can assert this, so say so and release the
    // device's buffer.
    if (miss.length === 0) {
      const asm = this.assemble();
      if (!asm) { this.failed = 'CRC mismatch on a complete set'; return null; }
      this.state = ST.DONE;
      return p.encodeComplete(this.pid, this.manifest.crc);
    }

    // Something is missing. Is the device still sending, or has it finished and
    // we lost the tail? A timer cannot tell; only the device knows.
    if (!this.progressDone) return this._query();

    // Device says it finished its pass, and we still have gaps. Ask for exactly
    // those ids — scattered, which first+count could never express.
    // Progress, not attempts. A round that delivered even one chunk resets the
    // counter; only genuinely stuck transfers trip it.
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

  // Ask the device where it got to. Tracks unanswered queries so a device that
  // has gone away produces a clear failure rather than an eternal wait.
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
  // Verified, never assumed: a complete set that fails CRC is a failure, not a
  // payload.
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
