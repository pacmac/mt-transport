'use strict';
// Outbound command queue.
//
// This is a CORRECTNESS mechanism, not throughput management. At SF11 a full
// frame is 2.156 s of airtime and replies carry no sequence number, so two
// overlapping commands to one target cannot be attributed to their requests.
// One in flight per target, with spacing, is the only way the reply means
// anything.
//
// NOTHING IS RETRIED BY DEFAULT. Most of these commands are not idempotent —
// a retried @reboot reboots twice. Retry is opt-in per command.

class CommandQueue {
  constructor({ send, minSpacingMs = 3000, timeoutMs = 20000 }) {
    this.send = send;               // async (text) => void
    this.minSpacingMs = minSpacingMs;
    this.timeoutMs = timeoutMs;
    this.q = [];
    this.inFlight = null;
    this.lastSentAt = 0;
  }

  /**
   * @param {string} text     the command, e.g. "@336b ping"
   * @param {object} opts     {priority, dedupKey, match, retries}
   *   match(replyObj) => bool   correlates a reply to this command
   *   retries                   default 0 — see note above
   */
  enqueue(text, opts = {}) {
    const key = opts.dedupKey || text;
    // An impatient double-click must not double the airtime. Check the IN-FLIGHT
    // command as well as the pending queue: _pump() runs synchronously up to its
    // first await, so by the time enqueue() returns the entry has already left
    // this.q. Checking only the queue silently failed to dedup the one case that
    // matters most — the command that is on the air right now.
    const existing = (this.inFlight && this.inFlight.key === key)
      ? this.inFlight
      : this.q.find((e) => e.key === key);
    if (existing) return existing.promise;

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = { text, key, opts, resolve, reject, promise,
                    priority: opts.priority ?? 0, retries: opts.retries ?? 0 };
    this.q.push(entry);
    this.q.sort((a, b) => b.priority - a.priority);
    this._pump();
    return promise;
  }

  onReply(replyObj) {
    if (!this.inFlight) return false;
    const m = this.inFlight.opts.match;
    if (m && !m(replyObj)) return false;
    clearTimeout(this.inFlight.timer);
    this.inFlight.resolve(replyObj);
    this.inFlight = null;
    this._pump();
    return true;
  }

  async _pump() {
    if (this.inFlight || !this.q.length) return;
    const wait = Math.max(0, this.minSpacingMs - (Date.now() - this.lastSentAt));
    if (wait) {
      // ONE pending pump only. Without this guard every enqueue() during the
      // spacing window starts its own self-perpetuating timer chain, and each
      // chain keeps respawning — a fetch loop calling enqueue repeatedly
      // exhausted a 2 GB heap in 42 seconds.
      if (!this._pumpTimer) {
        this._pumpTimer = setTimeout(() => { this._pumpTimer = null; this._pump(); }, wait);
      }
      return;
    }

    const e = this.q.shift();
    this.inFlight = e;
    this.lastSentAt = Date.now();
    try {
      await this.send(e.text);
    } catch (err) {
      this.inFlight = null;
      e.reject(err);
      return this._pump();
    }
    // Silence is the normal failure mode on an unacked broadcast link, so a
    // timeout is a real answer rather than an anomaly.
    // Some commands answer by another route entirely — a chunk pull replies
    // with chunks on the binary port, never with text. Waiting for a text reply
    // would time out every single time. Resolve on send for those.
    if (e.opts.noReply) {
      this.inFlight = null;
      e.resolve({ sent: true });
      return this._pump();
    }

    e.timer = setTimeout(() => {
      this.inFlight = null;
      if (e.retries > 0) { e.retries--; this.q.unshift(e); }
      else e.reject(new Error(`timeout: ${e.text}`));
      this._pump();
    }, this.timeoutMs);
  }

  get pending() { return this.q.length + (this.inFlight ? 1 : 0); }
}

module.exports = { CommandQueue };
