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
  m.cfg = { units, mode: { silentMs }, retry: { idempotent: 2, attemptTimeoutMs: 10000 } };
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

  // 5. dispatch routing: dev -> command (direct); live -> queueCommand
  {
    const m = mkMesh({ units: { '!dd': { mode: 'dev' }, '!ee': { mode: 'live' } } });
    let cmd = null, q = null;
    m.command = async (u, v, a) => { cmd = { u, v, a }; return { type: v, ok: true }; };
    m.queueCommand = async (u, v, a) => { q = { u, v, a }; return { id: 'q1', args: a }; };
    const r1 = await m.dispatch('!dd', 'status', ['mem']);
    ok(cmd && cmd.v === 'status' && r1.ok && !r1.queued, 'dispatch dev -> direct command, returns reply');
    const r2 = await m.dispatch('!ee', 'status', ['mem']);
    ok(q && q.v === 'status' && r2.queued && r2.mode === 'live', 'dispatch live -> queueCommand, returns queued ack');
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
