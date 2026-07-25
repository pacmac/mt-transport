'use strict';
// Offline tests for per-unit live/dev mode: unitMode() resolution + dispatch() routing +
// danger-guard. Constructs a bare Mesh and stubs its internals (no gw/connect).
const assert = require('assert');
const { Mesh } = require('..');
const { Model } = require('../lib/model');
let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

function mkMesh({ units = {}, silentMs = 150000 } = {}) {
  const m = new Mesh();
  m.cfg = { units, mode: { silentMs }, retry: { idempotent: 2, attemptTimeoutMs: 10000 },
            timing: { replyTimeoutMs: 20000, sendSpacingMs: 3000 } };
  m.model = new Model();
  m._unitKey = async (t) => (String(t).startsWith('!') ? String(t) : '!' + t);
  m._cmdReliab = () => ({});
  return m;
}

(async () => {
  // 1. config override wins over everything
  {
    const m = mkMesh({ units: { '!aa': { mode: 'live' } } });
    m.model.heard('!aa', Date.now());              // recently heard, but override forces live
    ok(m.unitMode('!aa') === 'live', 'override: live wins over recent heard');
    m.cfg.units['!aa'].mode = 'dev';
    m.model.sleep('!aa', 1);                        // slp=1, but override forces dev
    ok(m.unitMode('!aa') === 'dev', 'override: dev wins over slp=1');
  }

  // 2. device slp state
  {
    const m = mkMesh();
    m.model.sleep('!bb', 1);
    ok(m.unitMode('!bb') === 'live', 'slp=1 -> live');
    m.model.sleep('!bb', 0); m.model.heard('!bb', Date.now());
    ok(m.unitMode('!bb') === 'dev', 'slp=0 + recently heard -> dev');
  }

  // 3. last-heard silence heuristic
  {
    const m = mkMesh({ silentMs: 100 });
    m.model.heard('!cc', Date.now() - 5000);
    ok(m.unitMode('!cc') === 'live', 'silent past silentMs -> live');
    m.model.heard('!cc', Date.now());
    ok(m.unitMode('!cc') === 'dev', 'recently heard -> dev');
  }

  // 4. default
  { const m = mkMesh(); ok(m.unitMode('!zz') === 'dev', 'no data -> default dev'); }

  // 5. dispatch routing. BOTH modes now go through the LEDGER — a dev command used to be
  //    direct and invisible, which meant most of what you sent left no record. The dev
  //    caller still gets its reply synchronously: the butler's immediate attempt does the
  //    work and dispatch waits for that entry to settle. See specs/request-ledger-sqlite.md.
  {
    const m = mkMesh({ units: { '!dd': { mode: 'dev' }, '!ee': { mode: 'live' } } });
    let q = null;
    m.queueCommand = async (u, v, a) => { q = { u, v, a }; return { id: 'q1', args: a }; };
    // Stand in for the butler: dispatch waits on it for the entry to settle.
    m.butler = { get: () => ({ id: 'q1', state: 'done', result: { type: 'status', ok: true } }) };
    const r1 = await m.dispatch('!dd', 'status', ['mem']);
    ok(q && q.v === 'status', 'dispatch dev -> ENTERS THE LEDGER (no longer bypasses it)');
    ok(r1 && r1.ok && !r1.queued, 'dispatch dev -> still returns the reply synchronously');

    q = null;
    const r2 = await m.dispatch('!ee', 'status', ['mem']);
    ok(q && q.v === 'status' && r2.queued && r2.mode === 'live', 'dispatch live -> queued ack, unchanged');
  }

  // 5b. A dev command whose entry never settles must hand back the id, not pretend it
  //     failed — the ledger keeps working on it.
  {
    const m = mkMesh({ units: { '!dd': { mode: 'dev' } } });
    m.queueCommand = async (u, v, a) => ({ id: 'q2', args: a });
    m.butler = { get: () => ({ id: 'q2', state: 'queued' }) };
    const r = await m.dispatch('!dd', 'status', [], { waitMs: 10 });
    ok(r.queued === true && r.id === 'q2' && r.state === 'queued',
       'dispatch dev: unsettled -> returns the id and its state, never a false failure');
  }

  // 6. danger guard in live
  {
    const m = mkMesh({ units: { '!ff': { mode: 'live' } } });
    let queued = 0;
    m.queueCommand = async () => { queued++; return { id: 'q', args: [] }; };
    let code = null;
    try { await m.dispatch('!ff', 'reboot', []); } catch (e) { code = e.code; }
    ok(code === 'ELIVE' && queued === 0, 'live danger verb without --force -> ELIVE, not queued');
    const r = await m.dispatch('!ff', 'reboot', [], { force: true });
    ok(r.queued && queued === 1, 'live danger verb WITH --force -> queued');
  }

  console.log(`mode OK: ${pass} assertions passed`);
})().catch((e) => { console.error('mode FAILED:', (e && e.stack) || e); process.exit(1); });
