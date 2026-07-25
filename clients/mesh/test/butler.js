'use strict';
// Offline butler tests: enqueue+persist, fire-on-heard+receipt, retry, TTL expiry, persistence
// reload, cancel, one-command-per-window (inflight guard) + FIFO. No mesh/gw — mock deliver+store.
const assert = require('assert');
const { Butler } = require('../lib/butler');
let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// in-memory store mirroring PayloadStore's queue methods (deep-copies like the JSON sidecar does)
function memStore() {
  const q = new Map();
  return {
    saveQueue(u, e) { q.set(u, JSON.parse(JSON.stringify(e))); },
    loadQueue(u) { return q.has(u) ? JSON.parse(JSON.stringify(q.get(u))) : []; },
    listQueuedUnits() { return [...q.keys()]; },
  };
}

(async () => {
  // 1. enqueue persists
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => ({ ok: true }), store });
    const e = b.enqueue('!aa', 'ping', []);
    ok(e.status === 'pending' && e.id, 'enqueue: pending entry with id');
    ok(store.loadQueue('!aa').length === 1, 'enqueue: persisted to store');
  }

  // 2. onHeard delivers oldest + acks with the reply as receipt
  {
    const store = memStore();
    let called = null;
    const b = new Butler({ deliver: async (u, v, a) => { called = { u, v, a }; return { type: v, ok: true }; }, store });
    b.enqueue('!bb', 'ping', []);
    await b.onHeard('!bb');
    const e = b.list('!bb')[0];
    ok(called && called.u === '!bb' && called.v === 'ping', 'onHeard: delivered to the right unit/verb');
    ok(e.status === 'acked' && e.receipt && e.receipt.ok, 'onHeard: acked, reply stored as receipt');
    ok(e.attempts === 1 && e.ackedAt, 'onHeard: attempts=1, ackedAt set');
    ok(store.loadQueue('!bb')[0].status === 'acked', 'onHeard: ack persisted');
  }

  // 3. failing deliver → retry (pending), then failed at maxAttempts
  {
    const store = memStore();
    let n = 0;
    const b = new Butler({ deliver: async () => { n++; throw new Error('ETIMEOUT'); }, store, cfg: { butler: { maxAttempts: 2 } } });
    b.enqueue('!cc', 'ping', []);
    await b.onHeard('!cc');
    ok(b.list('!cc')[0].status === 'pending' && b.list('!cc')[0].attempts === 1, 'retry: back to pending after 1 fail');
    await b.onHeard('!cc');
    const e = b.list('!cc')[0];
    ok(e.status === 'failed' && e.attempts === 2 && e.lastError === 'ETIMEOUT', 'retry: failed after maxAttempts');
    ok(n === 2, 'retry: deliver called exactly maxAttempts times');
  }

  // 4. TTL expiry — swept before firing, never delivered.
  //    Seeded straight into the store (the restart path) rather than via enqueue(): enqueue
  //    now fires an IMMEDIATE attempt, which for a short-ttl entry would legitimately deliver
  //    at t=0 while still inside its TTL. That is correct behaviour, so to test the SWEEP in
  //    isolation the entry has to already be stale before the butler ever sees it.
  {
    const store = memStore();
    let fired = false;
    store.saveQueue('!dd', [{
      id: 'stale.0', unit: '!dd', verb: 'ping', args: [],
      status: 'pending', enqueuedAt: Date.now() - 60000, ttlMs: 5,
      attempts: 0, maxAttempts: 5,
      sentAt: null, ackedAt: null, receipt: null, lastError: null,
    }]);
    const b = new Butler({ deliver: async () => { fired = true; return {}; }, store });
    await b.onHeard('!dd');
    ok(b.get('stale.0').status === 'expired' && !fired, 'ttl: expired past ttlMs, not delivered');
  }

  // 5. persistence across a reload (fresh butler, same store)
  {
    const store = memStore();
    const b1 = new Butler({ deliver: async () => ({}), store });
    b1.enqueue('!ee', 'status', ['mem']);
    const b2 = new Butler({ deliver: async () => ({}), store });
    const e = b2.list('!ee');
    ok(e.length === 1 && e[0].verb === 'status' && e[0].args[0] === 'mem', 'persistence: queue restored on load');
  }

  // 6. cancel a pending command
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => ({}), store });
    const e = b.enqueue('!ff', 'reboot', []);
    ok(b.cancel(e.id).status === 'cancelled', 'cancel: pending -> cancelled');
    ok(b.cancel(e.id) === null, 'cancel: already-cancelled returns null');
  }

  // 7. one command per window (inflight guard) + FIFO across windows
  {
    const store = memStore();
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const b = new Butler({ deliver: async (u, v) => { order.push(v); await gate; return { ok: true }; }, store });
    b.enqueue('!gg', 'first', []);
    b.enqueue('!gg', 'second', []);
    const p1 = b.onHeard('!gg');   // starts 'first', parks on the gate (inflight set synchronously)
    await b.onHeard('!gg');        // inflight → must NOT start 'second'
    ok(order.length === 1 && order[0] === 'first', 'one-per-window: only the oldest fires while inflight');
    release(); await p1;
    await b.onHeard('!gg');        // next window → 'second'
    ok(order.length === 2 && order[1] === 'second', 'FIFO: next window delivers the next pending');
  }

  // ---- immediate attempt on enqueue (spec: butler-immediate-attempt) -------------------
  // A queued command must not wait for the unit's next transmission before anything is
  // tried. Previously delivery happened ONLY in onHeard(), so a command could sit for a
  // whole heartbeat (up to 15 min) against a unit that was awake and would have answered.

  // 9. enqueue alone delivers — no onHeard anywhere in this block
  {
    const store = memStore();
    let called = null;
    const b = new Butler({ deliver: async (u, v, a) => { called = { u, v, a }; return { type: v, ok: true }; }, store });
    const e = b.enqueue('!ii', 'ping', []);
    await sleep(10);
    ok(called && called.v === 'ping', 'immediate: enqueue delivers without any onHeard');
    ok(b.get(e.id).status === 'acked', 'immediate: entry acked from the immediate attempt');
    ok(b.get(e.id).attempts === 1, 'immediate: the attempt COUNTS (the ledger stays truthful)');
    ok(b.get(e.id).receipt && b.get(e.id).receipt.type === 'ping', 'immediate: reply stored as the receipt');
  }

  // 10. enqueue() RETURNS BEFORE the delivery settles. This is the load-bearing one:
  //     deliver() waits ~20 s on a radio reply, so if enqueue awaited it, POST /queue
  //     would block for 20 s against a sleeping unit and break the "returns an id
  //     immediately" contract.
  {
    const store = memStore();
    let settled = false;
    const b = new Butler({ deliver: async () => { await sleep(50); settled = true; return {}; }, store });
    const e = b.enqueue('!jj', 'status', []);
    ok(settled === false, 'immediate: enqueue does not block on the radio');
    ok(e.status === 'pending', 'immediate: caller gets a pending entry with its id at once');
    await sleep(80);
    ok(settled === true && b.get(e.id).status === 'acked', 'immediate: the attempt completes behind the caller');
  }

  // 11. A FAILED immediate attempt must fall back to the wake-window path — the butler's
  //     whole reason for existing is the sleeping unit, so that path must stay intact.
  {
    const store = memStore();
    let n = 0;
    const b = new Butler({ deliver: async () => { n++; if (n === 1) throw new Error('timeout: reply not received'); return { ok: true }; }, store });
    const e = b.enqueue('!kk', 'ping', []);
    await sleep(10);
    ok(b.get(e.id).status === 'pending', 'immediate: a failed immediate attempt returns to pending');
    ok(b.get(e.id).attempts === 1, 'immediate: the failed attempt is recorded');
    ok(b.get(e.id).lastError === 'timeout: reply not received', 'immediate: the error is recorded');
    await b.onHeard('!kk');
    ok(b.get(e.id).status === 'acked' && n === 2, 'immediate: still delivers on the next window');
  }

  // 12. A BURST must not fire N concurrent deliveries — the inflight guard still holds
  //     one command per window, which the immediate attempt shares rather than bypasses.
  {
    const store = memStore();
    let concurrent = 0, maxConcurrent = 0, done = 0;
    const b = new Butler({
      deliver: async () => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20); concurrent--; done++; return { ok: true };
      }, store });
    b.enqueue('!ll', 'ping', []);
    b.enqueue('!ll', 'status', []);
    b.enqueue('!ll', 'agc', []);
    await sleep(60);
    ok(maxConcurrent === 1, 'immediate: a burst never overlaps deliveries to one unit');
    ok(done === 1, 'immediate: one command per window — the rest wait, as before');
    ok(b.list('!ll').filter((x) => x.status === 'pending').length === 2, 'immediate: the other two stay pending');
  }

  console.log(`butler OK: ${pass} assertions passed`);
})().catch((e) => { console.error('butler FAILED:', (e && e.stack) || e); process.exit(1); });
