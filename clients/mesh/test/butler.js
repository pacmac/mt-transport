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

  // 4. TTL expiry — swept before firing, never delivered
  {
    const store = memStore();
    let fired = false;
    const b = new Butler({ deliver: async () => { fired = true; return {}; }, store });
    const e = b.enqueue('!dd', 'ping', [], { ttlMs: 5 });
    await sleep(15);
    await b.onHeard('!dd');
    ok(b.get(e.id).status === 'expired' && !fired, 'ttl: expired past ttlMs, not delivered');
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

  console.log(`butler OK: ${pass} assertions passed`);
})().catch((e) => { console.error('butler FAILED:', (e && e.stack) || e); process.exit(1); });
