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
    this.ttlMs = c.ttlMs != null ? c.ttlMs : 86400000;   // 24 h
    this.maxAttempts = c.maxAttempts != null ? c.maxAttempts : 5;
    this.inflight = new Set();                            // units mid-delivery (one per window)
    this._q = new Map();                                 // unit -> entries[] (mirror of the store)
    this._load();
  }

  _load() {
    if (!this.store || !this.store.listQueuedUnits) return;
    for (const unit of this.store.listQueuedUnits()) this._q.set(unit, this.store.loadQueue(unit) || []);
  }
  _persist(unit) { if (this.store) this.store.saveQueue(unit, this._q.get(unit) || []); }
  _entries(unit) { let e = this._q.get(unit); if (!e) { e = []; this._q.set(unit, e); } return e; }

  enqueue(unit, verb, args = [], opts = {}) {
    const entry = {
      id: genId(), unit, verb,
      args: Array.isArray(args) ? args : (args == null || args === '' ? [] : [args]),
      status: 'pending', enqueuedAt: Date.now(),
      ttlMs: opts.ttlMs != null ? opts.ttlMs : this.ttlMs,
      attempts: 0, maxAttempts: opts.maxAttempts != null ? opts.maxAttempts : this.maxAttempts,
      sentAt: null, ackedAt: null, receipt: null, lastError: null,
    };
    this._entries(unit).push(entry);
    this._persist(unit);
    this.emit('queued', entry);
    this.log.info('butler: queued %s %s for %s (id %s)', verb, entry.args.join(' '), unit, entry.id);
    return entry;
  }

  list(unit) {
    if (unit) return (this._q.get(unit) || []).slice();
    const out = []; for (const [, e] of this._q) out.push(...e); return out;
  }
  get(id) { for (const [, e] of this._q) { const f = e.find((x) => x.id === id); if (f) return f; } return null; }
  cancel(id) {
    for (const [unit, e] of this._q) {
      const f = e.find((x) => x.id === id && x.status === 'pending');
      if (f) { f.status = 'cancelled'; this._persist(unit); this.emit('cancelled', f); return f; }
    }
    return null;
  }

  _sweep(unit, now) {
    let changed = false;
    for (const e of this._entries(unit)) {
      if (e.status === 'pending' && now - e.enqueuedAt > e.ttlMs) { e.status = 'expired'; changed = true; this.emit('expired', e); }
    }
    if (changed) this._persist(unit);
  }

  // The unit's window is open (it transmitted). Fire the oldest pending command; the reply is
  // the receipt. Never overlap deliveries to one unit (one command per ~10 s window).
  async onHeard(unit) {
    if (!unit || this.inflight.has(unit)) return;
    const now = Date.now();
    this._sweep(unit, now);
    const next = this._entries(unit).find((e) => e.status === 'pending');
    if (!next) return;
    this.inflight.add(unit);
    next.status = 'sent'; next.attempts++; next.sentAt = Date.now();
    this._persist(unit);
    this.log.info('butler: window open for %s — delivering %s (attempt %d)', unit, next.verb, next.attempts);
    try {
      const reply = await this.deliver(unit, next.verb, next.args);
      next.status = 'acked'; next.ackedAt = Date.now(); next.receipt = reply; next.lastError = null;
      this.emit('acked', next);
      this.log.info('butler: acked %s for %s (id %s)', next.verb, unit, next.id);
    } catch (e) {
      next.lastError = (e && e.message) || String(e);
      if (next.attempts >= next.maxAttempts) { next.status = 'failed'; this.emit('failed', next); }
      else { next.status = 'pending'; }   // back to pending — retry on the next window
      this.log.warn('butler: delivery failed for %s: %s (attempt %d/%d)', unit, next.lastError, next.attempts, next.maxAttempts);
    } finally {
      this._persist(unit);
      this.inflight.delete(unit);
    }
  }
}

module.exports = { Butler };
