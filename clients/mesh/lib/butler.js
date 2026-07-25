'use strict';
// Command butler — per-unit persistent command queue, delivered into a unit's wake window.
//
// A sleeping radio hears nothing; the only letterbox is the ~10 s RX window after the unit's
// OWN transmit. mtmesh emits a 'heard' event on every packet from a unit — that IS the window
// opening. onHeard() fires the oldest pending command as a directed PKC DM (deliver = the
// mesh.command path); the reply is the receipt. Retries across windows, TTL-expires, keeps a
// ledger. One command per window (SF11 airtime + the 10 s budget). See specs/mtmesh-command-butler.md.
const { EventEmitter } = require('events');

let _seq = 0;
// Unique, monotonic-ish per process (no Date.now collisions across a burst). Not persisted-safe
// across restarts by itself, but combined with the store the id only needs process-uniqueness.
const genId = () => `${Date.now().toString(36)}.${(_seq++).toString(36)}`;

class Butler extends EventEmitter {
  // deps: { deliver(unit,verb,args)->Promise<reply>, store, log, cfg }
  constructor(deps = {}) {
    super();
    this.deliver = deps.deliver;
    this.store = deps.store;
    this.log = deps.log || { debug() {}, info() {}, warn() {} };
    const c = (deps.cfg && deps.cfg.butler) || {};
    this.ttlMs = c.ttlMs;                                 // butler.ttlMs
    // maxTries is the name now; maxAttempts is still accepted so an existing config.yaml
    // keeps working rather than silently reverting to the default.
    this.maxTries = c.maxTries != null ? c.maxTries : c.maxAttempts;   // butler.maxTries
    // Hard ceiling on UNDELIVERED commands per unit. Nothing in normal operation queues
    // ten commands at one radio — the largest real backlog observed is 1 — so hitting this
    // is a BUG SIGNAL (a caller looping), not a capacity problem to be raised away.
    // Configurable because a limit that lives only in code is one nobody knows they can
    // change, and it would have to be found by reading source mid-incident.
    this.maxPending = c.maxPending;                       // butler.maxPending
    this.inflight = new Set();                            // units mid-delivery (one per window)
    this._q = new Map();                                 // unit -> entries[] (mirror of the store)
    this._load();
  }

  _load() {
    if (!this.store || !this.store.listQueuedUnits) return;
    for (const unit of this.store.listQueuedUnits()) {
      const entries = this.store.loadQueue(unit) || [];
      // An entry left in `trying` was mid-delivery when the process stopped. That attempt
      // died with it and nothing will ever settle the row, so it would sit in the outbox
      // forever showing "in progress". Put it back in the queue — the try is already
      // counted, so it costs a retry, not a lost instruction.
      // `trying` is now STICKY between attempts (audit-260725a-truth), so a row in that
      // state on load is either mid-attempt-when-we-died or simply waiting for the next
      // window — indistinguishable, and both resume identically. Leave the state alone and
      // just clear nextTryAt: whatever it said was computed by a process that no longer
      // exists. _deliverNext picks `trying` rows up, so nothing is stranded.
      let recovered = 0;
      for (const e of entries) if (e.state === 'trying') { e.nextTryAt = null; recovered++; }
      this._q.set(unit, entries);
      if (recovered) {
        this.log.info('butler: recovered %d interrupted request(s) for %s', recovered, unit);
        this._persist(unit);
      }
    }
  }
  _persist(unit) { if (this.store) this.store.saveQueue(unit, this._q.get(unit) || []); }
  _entries(unit) { let e = this._q.get(unit); if (!e) { e = []; this._q.set(unit, e); } return e; }

  // kind 'command' (a verb the device answers) or 'text' (a free-form message that
  // carries NO receipt of any kind). The distinction decides the terminal state — see
  // _deliverNext: a command can reach `done`, a text can only ever reach `sent`.
  enqueue(unit, verb, args = [], opts = {}) {
    const kind = opts.kind === 'text' ? 'text' : 'command';
    const normArgs = kind === 'text' ? [] : (Array.isArray(args) ? args : (args == null || args === '' ? [] : [args]));
    const live = this._entries(unit).filter((e) => e.state === 'queued' || e.state === 'trying');

    // COLLAPSE an identical command that is still undelivered. It cannot achieve anything
    // the pending one will not, and a caller polling with a WRITE (which is exactly how 55
    // strays were created) would otherwise stack one entry per attempt.
    //
    // Commands only. TEXT IS EXEMPT: two identical messages are two genuine sends — a
    // person typing "ok" twice means it twice, and silently swallowing a message is far
    // worse than a duplicate command.
    if (kind === 'command' && !opts.force) {
      const same = live.find((e) => e.kind === 'command' && e.verb === verb
        && e.args.length === normArgs.length && e.args.every((a, i) => String(a) === String(normArgs[i])));
      if (same) {
        this.log.info('butler: %s for %s already queued (id %s) — collapsed, not re-queued', verb, unit, same.id);
        return { ...same, collapsed: true };
      }
    }

    // BACKSTOP for a flood that varies its arguments, which collapse cannot catch.
    // Throws rather than dropping silently: a caller this far out of control must be told.
    if (live.length >= this.maxPending) {
      const err = new Error(
        `queue full for ${unit}: ${live.length} undelivered commands (max ${this.maxPending}). `
        + 'This usually means a caller is looping — check for a poll that WRITES instead of reads.');
      err.code = 'EQUEUEFULL';
      this.log.warn('butler: REFUSED %s for %s — %d pending, at the cap', verb, unit, live.length);
      throw err;
    }

    const entry = {
      id: genId(), unit, kind, verb: kind === 'text' ? null : verb,
      body: kind === 'text' ? String(opts.body != null ? opts.body : verb) : null,
      args: normArgs,
      // Delivery target for a text, captured at submit time so a RETRY goes exactly where
      // the original was aimed. These were previously dropped here — the DB columns and
      // the store mapping both existed, but the entry never carried them, so every
      // directed message silently went out as a broadcast.
      toNum: opts.toNum != null ? opts.toNum : null,
      channel: opts.channel != null ? opts.channel : null,
      replyId: opts.replyId != null ? opts.replyId : null,
      state: 'queued', createdAt: Date.now(),
      ttlMs: opts.ttlMs != null ? opts.ttlMs : this.ttlMs,
      tries: 0, maxTries: opts.maxTries != null ? opts.maxTries : (opts.maxAttempts != null ? opts.maxAttempts : this.maxTries),
      // nextTryAt: when the next attempt is due, or null when it is gated on the unit's
      // wake window and therefore unknowable. Only WE know that, so a consumer cannot tell
      // "next attempt in 30 s" from "next attempt in 15 min" without it.
      triedAt: null, nextTryAt: null, settledAt: null, result: null, error: null,
    };
    this._entries(unit).push(entry);
    this._persist(unit);
    this.emit('queued', entry);
    this.log.info('butler: queued %s for %s (id %s)',
      kind === 'text' ? 'text' : `${verb} ${entry.args.join(' ')}`.trim(), unit, entry.id);

    // Try ONCE immediately, rather than waiting for the unit's next transmission. A unit
    // that is awake (or never sleeps, which is the deployed unit's current state) would
    // otherwise sit for a whole heartbeat — up to 15 min — before a command left the
    // gateway, for no reason.
    //
    // Deliberately NOT gated on "do we think it is awake": that reads unitMode(), whose
    // slp/awake values are the known-unreliable ones (task model-sleep-truth). Always
    // trying needs no state, so it cannot be wrong. The cost of guessing wrong is one
    // frame a sleeping unit does not hear.
    //
    // NOT AWAITED, and that matters: deliver() waits ~20 s on a radio reply, so awaiting
    // here would make POST /v1/mesh/queue block for 20 s against a sleeping unit and
    // break the documented contract that a queued command returns an id immediately.
    // _deliverNext shares the inflight guard, so this cannot overlap a window delivery.
    setImmediate(() => {
      this._deliverNext(unit, 'immediate').catch((e) => {
        this.log.debug('butler: immediate attempt for %s errored: %s', unit, e && e.message);
      });
    });
    return entry;
  }

  list(unit) {
    if (unit) return (this._q.get(unit) || []).slice();
    const out = []; for (const [, e] of this._q) out.push(...e); return out;
  }
  get(id) { for (const [, e] of this._q) { const f = e.find((x) => x.id === id); if (f) return f; } return null; }
  cancel(id) {
    for (const [unit, e] of this._q) {
      // Must reach a RETRYING row too, not just an untouched one: `trying` is sticky
      // between attempts, so cancelling only `queued` would make anything that had been
      // tried once permanently uncancellable (audit-260725a-truth). The inflight guard is
      // what keeps us from cancelling a row whose send is actually in the air right now.
      const f = e.find((x) => x.id === id
        && (x.state === 'queued' || (x.state === 'trying' && !this.inflight.has(unit))));
      if (f) { f.state = 'cancelled'; f.settledAt = Date.now(); this._persist(unit); this.emit('cancelled', f); return f; }
    }
    return null;
  }

  _sweep(unit, now) {
    let changed = false;
    for (const e of this._entries(unit)) {
      // Sticky `trying` must expire too. Expiring only `queued` would mean a command that
      // failed its first attempt outlives its TTL forever, retrying until maxTries however
      // stale it has become (audit-260725a-truth). Never expire a row mid-attempt: the
      // delivery in flight is about to settle it either way.
      if ((e.state === 'queued' || (e.state === 'trying' && !this.inflight.has(unit)))
          && now - e.createdAt > e.ttlMs) {
        e.state = 'expired'; e.settledAt = now;
        e.error = { code: 'expired', message: 'not delivered before its time limit' };
        changed = true; this.emit('expired', e);
      }
    }
    if (changed) this._persist(unit);
  }

  // The unit's window is open (it transmitted). Fire the oldest pending command; the reply is
  // the receipt. Never overlap deliveries to one unit (one command per ~10 s window).
  async onHeard(unit) { return this._deliverNext(unit, 'window'); }

  // The single delivery path, shared by the window trigger above and the immediate attempt
  // in enqueue(). ONE implementation on purpose: two would be two places to get the
  // inflight locking wrong, and that lock is what keeps us to one command per window.
  // `reason` only changes the log line.
  async _deliverNext(unit, reason = 'window') {
    if (!unit || this.inflight.has(unit)) return;
    const now = Date.now();
    this._sweep(unit, now);
    // `trying` is sticky between attempts, so a retrying row sits in that state waiting for
    // the next window — it must be selectable here or it would never be retried. The
    // inflight set (not the state field) is the concurrency lock; it is added below and
    // released in the finally, so this can never pick a row whose send is actually in air.
    const next = this._entries(unit).find((e) => e.state === 'queued' || e.state === 'trying');
    if (!next) return;
    // NEVER attempt a row that has already used its budget. The selector matches on STATE, so
    // a row interrupted at tries == maxTries (a restart mid-attempt) would otherwise be picked
    // up, incremented PAST maxTries, and only settled after that extra attempt — observed live
    // as tries=6/5. That is not a harmless spare transmission: without the restart the row
    // would have been `failed` at try 5, and the reply that did arrive would have had no live
    // row to attach to. Settle it here instead (audit-260725a-truth step 5).
    if (next.tries >= next.maxTries) {
      next.state = 'failed'; next.settledAt = Date.now(); next.nextTryAt = null;
      next.error = next.error || { code: 'no_reply', message: 'gave up after the last attempt' };
      this._persist(unit);
      this.emit('failed', next);
      this.log.warn('butler: %s for %s already used %d/%d attempts — settling failed, not retrying',
        next.verb || 'text', unit, next.tries, next.maxTries);
      return;
    }
    this.inflight.add(unit);
    next.state = 'trying'; next.tries++; next.triedAt = Date.now(); next.nextTryAt = null;
    this._persist(unit);
    this.emit('trying', next);
    this.log.info('butler: %s — delivering %s for %s (try %d)',
      reason === 'immediate' ? 'immediate try' : 'window open', next.verb || 'text', unit, next.tries);
    try {
      const result = await this.deliver(unit, next.verb, next.args, next);
      next.settledAt = Date.now(); next.error = null;
      if (next.kind === 'text') {
        // A plain text message carries NO receipt. The most that can truthfully be said
        // is that the gateway accepted it, so `sent` is TERMINAL here — never `done`.
        // Rendering these the same would show a message as confirmed when nothing
        // confirms it. (SMTP's "250 accepted" vs actual delivery.)
        next.state = 'sent'; next.result = result != null ? result : null;
        this.emit('sent', next);
        this.log.info('butler: sent text for %s (id %s) — no confirmation is possible', unit, next.id);
      } else {
        next.state = 'done'; next.result = result;
        this.emit('done', next);
        this.log.info('butler: done %s for %s (id %s)', next.verb, unit, next.id);
      }
    } catch (e) {
      next.error = classifyError(e);
      if (next.tries >= next.maxTries) {
        next.state = 'failed'; next.settledAt = Date.now();
        this.emit('failed', next);
      } else {
        // STAYS `trying`. It used to drop back to 'queued', which made that one word mean
        // both "never attempted" and "3 of 5 attempts made" — so /control showed a ping as
        // "29m ago, queued" while it was actually mid-retry with an attempt 9 minutes
        // earlier (audit-260725a-truth). `queued` now means exactly "not yet attempted".
        // nextTryAt stays null: the retry is gated on the unit transmitting, and we cannot
        // know when that will be. Null here means "on its next wake window", not "never".
        next.state = 'trying'; next.nextTryAt = null;
      }
      this.log.warn('butler: delivery failed for %s: %s (try %d/%d)', unit, next.error.message, next.tries, next.maxTries);
    } finally {
      this._persist(unit);
      this.inflight.delete(unit);
    }
  }
}

// A failure becomes a CODE plus a human message. Consumers branch on the code; prose is
// for people. Previously this was a bare string that a dashboard had to regex, and which
// half-leaked our mechanics ("timeout: reply not received").
function classifyError(e) {
  const message = (e && e.message) || String(e);
  let code = 'error';
  if (/timeout|timed out|reply not received/i.test(message)) code = 'no_reply';
  else if (/unreachable|not found|unknown (unit|node)/i.test(message)) code = 'unreachable';
  else if (/refus|denied|ELIVE/i.test(message)) code = 'refused';
  return { code, message };
}

module.exports = { Butler, classifyError };
