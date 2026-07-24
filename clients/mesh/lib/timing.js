// Timing/pacing — the ONLY code that knows airtime exists.
//
// This is a CORRECTNESS mechanism, not throughput management. At SF11 a full frame
// is ~2.156 s of airtime and replies carry NO sequence number, so two overlapping
// commands to one target cannot be attributed to their requests. One in flight,
// with spacing, is the only thing that makes a reply mean anything — correlation
// is positional.
//
// NOTHING IS RETRIED BY DEFAULT. Most commands are not idempotent — a retried
// @reboot reboots twice. Retry is opt-in per command. All intervals come from
// settings.timing.
//
// Ported from clients/node/lib/queue.js (CommandQueue) to the skeleton's thunk
// shape: enqueue takes the send THUNK, not text+injected-send, so timing holds no
// socket and unit-tests with fake thunks. index.js wires gw<->timing in phase 3.
'use strict';
const { MeshError } = require('./errors');
const log = require('./log').log.child('timing');

class Timing {
  constructor(cfg) {
    this.cfg = cfg || {};                 // cfg = settings.timing
    this.q = [];
    this.inFlight = null;
    this.lastSentAt = 0;
    this._pumpTimer = null;
  }

  // Space between sends, from config.
  get spacingMs() { return this.cfg.sendSpacingMs; }

  /**
   * Enqueue an outbound send; resolves when its reply lands (positional).
   * @param {() => Promise<any>} thunk  does the actual send (e.g. gw.sendText)
   * @param {object} opts
   *   match(replyObj) => bool   correlates a reply to this command
   *   dedupKey                  identical pending key returns the SAME promise
   *   priority   (default 0)    higher runs first (a chunk pull must not wait
   *                             behind an operator command, and vice-versa)
   *   retries    (default 0)    NO blind retry — see header
   *   noReply    (default false) command answers by another route (binary port);
   *                             resolve on send rather than wait for a text reply
   *   timeoutMs                 default cfg.replyTimeoutMs
   */
  enqueue(thunk, opts = {}) {
    // Dedup only when a key is given (there is no text to default to). Check the
    // IN-FLIGHT entry as well as the queue: _pump() runs synchronously up to its
    // first await, so by the time enqueue() returns the entry may already have
    // left this.q — the command on the air right now is the one that matters most.
    if (opts.dedupKey != null) {
      const existing = (this.inFlight && this.inFlight.key === opts.dedupKey)
        ? this.inFlight
        : this.q.find((e) => e.key === opts.dedupKey);
      if (existing) { log.debug('dedup: returning in-flight promise', opts.dedupKey); return existing.promise; }
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = {
      thunk, opts, resolve, reject, promise,
      key: opts.dedupKey,
      priority: opts.priority ?? 0,
      retries: opts.retries ?? 0,
      timeoutMs: opts.timeoutMs ?? this.cfg.replyTimeoutMs,
      timer: null,
    };
    this.q.push(entry);
    this.q.sort((a, b) => b.priority - a.priority);
    log.trace('enqueue', { priority: entry.priority, dedupKey: entry.key, pending: this.pending });
    this._pump();
    return promise;
  }

  // Correlate a reply to the in-flight command. EXACT when the device threaded a
  // reply_id (sendReply(msg, rx.id)) AND we captured our sent packet id — then a reply
  // carrying a DIFFERENT reply_id is ignored (the delayed/overlapping-reply cross the
  // butler kept hitting). Falls back to the POSITIONAL match when either is absent
  // (broadcasts / untraceable replies). Returns whether it was consumed.
  onReply(replyObj, replyId = null) {
    if (!this.inFlight) return false;
    const e = this.inFlight;
    if (e.sentId != null && replyId != null) {
      if (Number(replyId) !== e.sentId) return false;   // a different command's reply
    } else {
      const m = e.opts.match;
      if (m && !m(replyObj)) return false;
    }
    clearTimeout(e.timer);
    this.inFlight = null;
    log.trace('reply matched');
    e.resolve(replyObj);
    this._pump();
    return true;
  }

  async _pump() {
    if (this.inFlight || !this.q.length) return;

    const wait = Math.max(0, (this.spacingMs || 0) - (Date.now() - this.lastSentAt));
    if (wait) {
      // ONE pending pump only. Without this guard every enqueue() during the
      // spacing window starts its own self-perpetuating timer chain — a fetch loop
      // calling enqueue repeatedly exhausted a 2 GB heap in 42 s (queue.js).
      if (!this._pumpTimer) {
        this._pumpTimer = setTimeout(() => { this._pumpTimer = null; this._pump(); }, wait);
      }
      return;
    }

    const e = this.q.shift();
    this.inFlight = e;
    this.lastSentAt = Date.now();
    log.trace('send', { priority: e.priority, noReply: !!e.opts.noReply });
    let res;
    try {
      res = await e.thunk();
    } catch (err) {
      log.warn('send threw', err);
      this.inFlight = null;
      e.reject(err);
      return this._pump();
    }
    // The sent packet id (gw.sendText -> {id}); the device threads its reply_id to it,
    // so onReply can correlate EXACTLY instead of positionally.
    e.sentId = (res && res.id != null) ? Number(res.id) : null;

    // Some commands answer by another route entirely — a chunk pull replies with
    // binary chunks on port 261, never with text. Resolve on send for those.
    if (e.opts.noReply) {
      this.inFlight = null;
      e.resolve({ sent: true });
      return this._pump();
    }

    // Silence is the normal failure mode on an unacked broadcast link, so a
    // timeout is a real answer rather than an anomaly.
    e.timer = setTimeout(() => {
      this.inFlight = null;
      log.debug('timeout', { retriesLeft: e.retries });
      if (e.retries > 0) { e.retries--; this.q.unshift(e); }
      else e.reject(new MeshError(`timeout: reply not received`, 'ETIMEOUT'));
      this._pump();
    }, e.timeoutMs);
  }

  get pending() { return this.q.length + (this.inFlight ? 1 : 0); }
}

module.exports = { Timing };
