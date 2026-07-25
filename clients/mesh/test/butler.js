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
    ok(e.state === 'queued' && e.id, 'enqueue: pending entry with id');
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
    ok(e.state === 'done' && e.result && e.result.ok, 'onHeard: acked, reply stored as receipt');
    ok(e.tries === 1 && e.settledAt, 'onHeard: tries=1, settledAt set');
    ok(store.loadQueue('!bb')[0].state === 'done', 'onHeard: ack persisted');
  }

  // 3. failing deliver → retry (pending), then failed at maxTries
  {
    const store = memStore();
    let n = 0;
    const b = new Butler({ deliver: async () => { n++; throw new Error('ETIMEOUT'); }, store, cfg: { butler: { maxTries: 2 } } });
    b.enqueue('!cc', 'ping', []);
    await b.onHeard('!cc');
    // STAYS `trying` after a failed attempt — it does NOT drop back to `queued`. That is the
    // whole point: `queued` must mean "not yet attempted" and nothing else, so a display
    // showing the state alone cannot present a mid-retry command as untouched.
    ok(b.list('!cc')[0].state === 'trying' && b.list('!cc')[0].tries === 1, 'retry: STAYS trying after 1 fail, not back to queued');
    await b.onHeard('!cc');
    const e = b.list('!cc')[0];
    ok(e.state === 'failed' && e.tries === 2 && e.error.message === 'ETIMEOUT', 'retry: failed after maxTries');
    ok(n === 2, 'retry: deliver called exactly maxTries times');
  }

  // 3b. Sticky `trying` must not strand a row: a RETRYING command stays cancellable and
  //     stays expirable. Cancelling/expiring only `queued` — as the code did before
  //     audit-260725a-truth — would make anything tried once immortal: uncancellable by a
  //     person and never swept by its TTL.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { throw new Error('ETIMEOUT'); }, store, cfg: { butler: { maxTries: 5 } } });
    const q = b.enqueue('!ee', 'ping', []);
    await b.onHeard('!ee');
    ok(b.list('!ee')[0].state === 'trying' && b.list('!ee')[0].tries === 1, 'cancel-while-retrying: precondition, row is mid-retry');
    const c = b.cancel(q.id);
    ok(c && c.state === 'cancelled', 'a RETRYING command can still be cancelled');
    ok(b.list('!ee')[0].state === 'cancelled', 'cancel-while-retrying: persisted');
  }
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { throw new Error('ETIMEOUT'); }, store, cfg: { butler: { maxTries: 5 } } });
    b.enqueue('!ff', 'ping', [], { ttlMs: 20 });
    await b.onHeard('!ff');
    ok(b.list('!ff')[0].state === 'trying', 'expire-while-retrying: precondition, row is mid-retry');
    await new Promise((r) => setTimeout(r, 40));
    await b.onHeard('!ff');                    // _sweep runs at the head of _deliverNext
    const e = b.list('!ff')[0];
    ok(e.state === 'expired' && e.error.code === 'expired', 'a RETRYING command still expires on its TTL');
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
      state: 'queued', createdAt: Date.now() - 60000, ttlMs: 5,
      tries: 0, maxTries: 5,
      triedAt: null, settledAt: null, result: null, error: null,
    }]);
    const b = new Butler({ deliver: async () => { fired = true; return {}; }, store });
    await b.onHeard('!dd');
    ok(b.get('stale.0').state === 'expired' && !fired, 'ttl: expired past ttlMs, not delivered');
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
    ok(b.cancel(e.id).state === 'cancelled', 'cancel: pending -> cancelled');
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
    ok(b.get(e.id).state === 'done', 'immediate: entry acked from the immediate attempt');
    ok(b.get(e.id).tries === 1, 'immediate: the attempt COUNTS (the ledger stays truthful)');
    ok(b.get(e.id).result && b.get(e.id).result.type === 'ping', 'immediate: reply stored as the receipt');
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
    ok(e.state === 'queued', 'immediate: caller gets a pending entry with its id at once');
    await sleep(80);
    ok(settled === true && b.get(e.id).state === 'done', 'immediate: the attempt completes behind the caller');
  }

  // 11. A FAILED immediate attempt must fall back to the wake-window path — the butler's
  //     whole reason for existing is the sleeping unit, so that path must stay intact.
  {
    const store = memStore();
    let n = 0;
    const b = new Butler({ deliver: async () => { n++; if (n === 1) throw new Error('timeout: reply not received'); return { ok: true }; }, store });
    const e = b.enqueue('!kk', 'ping', []);
    await sleep(10);
    ok(b.get(e.id).state === 'trying', 'immediate: a failed immediate attempt STAYS trying (it is no longer untouched)');
    ok(b.get(e.id).tries === 1, 'immediate: the failed attempt is recorded');
    ok(b.get(e.id).error.code === 'no_reply', 'immediate: the error is recorded');
    await b.onHeard('!kk');
    ok(b.get(e.id).state === 'done' && n === 2, 'immediate: still delivers on the next window');
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
    ok(b.list('!ll').filter((x) => x.state === 'queued').length === 2, 'immediate: the other two stay pending');
  }

  // 13. A request interrupted by a restart must not be orphaned. It was mid-delivery when
  //     the process died, so nothing will ever settle it.
  //     Since audit-260725a-truth `trying` is STICKY, so a row in that state on load is
  //     either interrupted-mid-attempt or simply waiting for the next window — the two are
  //     indistinguishable and resume identically. So the invariant under test is no longer
  //     "what string does it hold" but the thing that actually matters: IT STILL GETS
  //     DELIVERED, and its used try is still counted.
  {
    const store = memStore();
    store.saveQueue('!mm', [{
      id: 'orphan.0', unit: '!mm', kind: 'command', verb: 'ping', args: [],
      state: 'trying', createdAt: Date.now(), ttlMs: 86400000,
      tries: 1, maxTries: 5, triedAt: Date.now(), nextTryAt: 999, settledAt: null, result: null, error: null,
    }]);
    let delivered = 0;
    const b = new Butler({ deliver: async () => { delivered++; return { ok: true }; }, store });
    ok(b.get('orphan.0').tries === 1, 'restart: the try it already used is still counted');
    ok(b.get('orphan.0').nextTryAt === null,
       'restart: nextTryAt is cleared — it was computed by a process that no longer exists');
    await b.onHeard('!mm');
    ok(delivered === 1, 'restart: an interrupted request IS retried, not orphaned');
    ok(b.get('orphan.0').state === 'done' && b.get('orphan.0').tries === 2, 'restart: it settles normally');
    ok(store.loadQueue('!mm')[0].state === 'done', 'restart: the outcome is persisted');
  }

  // 13b. A row that has ALREADY used maxTries must never be attempted again. A restart
  //      mid-attempt leaves exactly that: state `trying`, tries == maxTries. The selector
  //      matches on state, so without a guard it gets one free extra attempt — observed
  //      live as tries=6/5 (audit-260725a-truth step 5). It must settle `failed` instead.
  {
    const store = memStore();
    store.saveQueue('!nn', [{
      id: 'spent.0', unit: '!nn', kind: 'command', verb: 'ping', args: [],
      state: 'trying', createdAt: Date.now(), ttlMs: 86400000,
      tries: 5, maxTries: 5, triedAt: Date.now(), settledAt: null, result: null, error: null,
    }]);
    let delivered = 0;
    const b = new Butler({ deliver: async () => { delivered++; return { ok: true }; }, store });
    await b.onHeard('!nn');
    const e = b.get('spent.0');
    ok(delivered === 0, 'exhausted: deliver() is NOT called for a row already at maxTries');
    ok(e.state === 'failed' && e.tries === 5, 'exhausted: it settles failed, tries never exceeds maxTries');
    ok(e.settledAt != null, 'exhausted: it is settled, not left live forever');
    ok(store.loadQueue('!nn')[0].state === 'failed', 'exhausted: persisted');
  }

  // ---- flood guards (spec: butler-collapse-duplicates) --------------------------------
  // A real incident: 55 identical commands were queued because a wait-loop used a POST as
  // its poll condition. Nothing was broken — the service did exactly as asked — so the
  // guard belongs here, not in the caller's discipline.

  // 14. THE REPLAY: 55 identical enqueues must produce exactly ONE entry.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store });
    const first = b.enqueue('!nn', 'txp', []);
    const ids = new Set([first.id]);
    let collapsed = 0;
    for (let i = 0; i < 54; i++) {
      const e = b.enqueue('!nn', 'txp', []);
      ids.add(e.id);
      if (e.collapsed) collapsed++;
    }
    ok(b.list('!nn').length === 1, 'REPLAY: 55 identical enqueues -> ONE entry');
    ok(ids.size === 1, 'REPLAY: the same id is returned every time (so polling it works)');
    ok(collapsed === 54, 'REPLAY: every repeat is flagged collapsed');
  }

  // 15. Collapse is narrow: a different verb or different args is a different command.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store });
    b.enqueue('!oo', 'txp', ['0']);
    b.enqueue('!oo', 'txp', ['-9']);      // different ARGS
    b.enqueue('!oo', 'status', []);       // different VERB
    ok(b.list('!oo').length === 3, 'different verb/args are NOT collapsed');
  }

  // 16. Once the first is terminal, a repeat is a genuinely new command.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => ({ ok: true }), store });
    b.enqueue('!pp', 'ping', []);
    await sleep(20);                       // immediate attempt settles it
    ok(b.list('!pp')[0].state === 'done', 'precondition: first one settled');
    const second = b.enqueue('!pp', 'ping', []);
    ok(!second.collapsed && b.list('!pp').length === 2, 'a repeat AFTER settling is a new command');
  }

  // 17. TEXT IS EXEMPT — swallowing a duplicate message is worse than a duplicate command.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store });
    b.enqueue('!qq', null, [], { kind: 'text', body: 'ok' });
    b.enqueue('!qq', null, [], { kind: 'text', body: 'ok' });
    ok(b.list('!qq').length === 2, 'two identical TEXTS are two sends, never collapsed');
  }

  // 18. force bypasses collapse — a deliberate repeat must stay possible.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store });
    b.enqueue('!rr', 'ping', []);
    const f = b.enqueue('!rr', 'ping', [], { force: true });
    ok(!f.collapsed && b.list('!rr').length === 2, 'force: true queues a real duplicate');
  }

  // 19. The cap catches a VARIED flood, which collapse cannot.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store, cfg: { butler: { maxPending: 10 } } });
    for (let i = 0; i < 10; i++) b.enqueue('!ss', 'txp', [String(i)]);
    ok(b.list('!ss').length === 10, 'cap: fills to the limit');
    let threw = null;
    try { b.enqueue('!ss', 'txp', ['99']); } catch (e) { threw = e; }
    ok(threw && threw.code === 'EQUEUEFULL', 'cap: refuses past the limit, with a code');
    ok(b.list('!ss').length === 10, 'cap: nothing extra was stored');
  }

  // 20. The cap counts only UNDELIVERED entries — settled history must not block new work.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => ({ ok: true }), store, cfg: { butler: { maxPending: 3 } } });
    for (let i = 0; i < 8; i++) { b.enqueue('!tt', 'txp', [String(i)]); await sleep(8); }
    ok(b.list('!tt').filter((e) => e.state === 'done').length >= 5, 'cap: settled entries accumulated');
    ok(b.enqueue('!tt', 'ping', []).id, 'cap: a new command is still accepted despite long history');
  }

  // 21. A text's delivery target must survive enqueue AND a reload. The DB columns and the
  //     store mapping both existed, but the ENTRY never carried them — so every directed
  //     message silently became a broadcast. Nothing asserted the middle of that chain.
  {
    const store = memStore();
    const b = new Butler({ deliver: async () => { await sleep(10000); return {}; }, store });
    const e = b.enqueue('!da5af428', null, [], { kind: 'text', body: 'hi', toNum: 3663393832, channel: 2 });
    ok(e.toNum === 3663393832, 'text: toNum is on the entry');
    ok(e.channel === 2, 'text: channel is on the entry');
    const reloaded = new Butler({ deliver: async () => ({}), store }).get(e.id);
    ok(reloaded.toNum === 3663393832 && reloaded.channel === 2, 'text: addressing survives a reload');
    const bare = b.enqueue('*', null, [], { kind: 'text', body: 'broadcast me' });
    ok(bare.toNum === null && bare.channel === null, 'text: no target -> null, so the send path broadcasts');
  }

  console.log(`butler OK: ${pass} assertions passed`);
})().catch((e) => { console.error('butler FAILED:', (e && e.stack) || e); process.exit(1); });
