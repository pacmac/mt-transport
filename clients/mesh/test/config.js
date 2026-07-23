// Offline test for mesh-config (no radio). A stub device answers `config` / `chunk cfg`
// as text replies and `sch <page>` as port-260 schema frames (delivered back via
// onSchemaFrame). Proves schema assembly + cache, get() composition + honest `unread`,
// set() schema-validation (no airtime on invalid), the chunk.gap map, and read-back.
'use strict';
const assert = require('assert');
const { Config } = require('../lib/config');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real 18-field CONFIG_FIELDS table as ragged schema rows (fmtField shape).
const HEADER = ['id', 'ty', 'lb', 'df', 'w', 'mn', 'mx'];
const FIELDS = [
  ['beat', 'n', 'Heartbeat', 60, 1, 30, 86400],
  ['slp', 'b', 'Sleep', 0, 1],
  ['mute', 'n', 'Powerup mute', 180, 1, 0, 3600],
  ['push.auto', 'b', 'Auto upload', 1, 1],
  ['det.n', 'n', 'Detect count', 3, 1, 1, 10],
  ['det.win', 'n', 'Detect window', 10, 1, 5, 3600],
  ['alm.on', 'b', 'Alarms', 1, 1],
  ['alm.ovr', 'n', 'Over-temp', 60, 1, 30, 90],
  ['alm.und', 'n', 'Under-temp', 2, 1, -20, 15],
  ['alm.hum', 'n', 'Humidity', 90, 1, 50, 100],
  ['alm.ren', 'n', 'Renotify min', 30, 1, 1, 1440],
  ['name', 't', 'Short name', '', 1, 1, 4],
  ['lname', 't', 'Long name', '', 1, 1, 30],
  ['chunk.hop', 'n', 'Chunk hops', 1, 1, 0, 7],
  ['chunk.gap', 'n', 'Chunk gap ms', 3000, 1, 0, 60000],
  ['tele.chg', 'b', 'Telem onchange', 1, 1],
  ['tele.ka', 'n', 'Telem keepalive', 360, 1, 1, 1440],
  ['txp', 'n', 'TX power', 22, 0],   // read-only, unbounded
];
const PER_PAGE = 3;
const NPAGES = Math.ceil(FIELDS.length / PER_PAGE);
const pageFrame = (p) => ({ t: 'sch', v: 1, p, n: NPAGES, f: [HEADER, ...FIELDS.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE)] });

// A stub device with mutable state + call counters.
function makeDevice() {
  const state = { hop: 1, gap: 3000 };
  const counts = { command: 0, send: 0, chunkWrites: 0 };
  const cfg = new Config({
    log: { debug() {}, info() {}, warn() {} },
    schemaTimeoutMs: 500,
    command: async (node, verb, args = []) => {
      counts.command++;
      if (verb === 'config') return { type: 'config', ver: 1, beat: 60, txp: 22, slp: 0, det: { n: 3, win: 10 }, alm: { on: 1, ovr: 60, und: 2, hum: 90, ren: 30 } };
      if (verb === 'chunk' && args[0] === 'cfg') {
        if (args.length === 1) return { type: 'chunkcfg', hop: state.hop, gap: state.gap };
        counts.chunkWrites++;
        state.hop = Number(args[1]); state.gap = Number(args[2]);
        return { type: 'chunkcfg', hop: state.hop, gap: state.gap };
      }
      if (verb === 'name' || verb === 'lname') {              // text set: reply echoes the new value
        const was = state[verb] || '';
        state[verb] = args[0];
        return { type: verb, name: args[0], was, ok: true };
      }
      return {};
    },
    send: async (node, text) => {
      counts.send++;
      const m = text.match(/sch (\d+)/);
      if (m) setImmediate(() => cfg.onSchemaFrame(node, pageFrame(Number(m[1]))));
      return { id: 1 };
    },
  });
  return { cfg, state, counts };
}

(async () => {
  // ---- 1. schema: assembles all 18 fields, bounds correct, and caches ---------
  {
    const { cfg, counts } = makeDevice();
    const s = await cfg.schema('b80f');
    ok(s.fields.length === 18, `schema: 18 fields (got ${s.fields.length})`);
    const gap = s.fields.find((f) => f.id === 'chunk.gap');
    ok(gap && gap.ty === 'n' && gap.min === 0 && gap.max === 60000 && gap.writable, 'schema: chunk.gap bounds 0..60000, writable');
    const txp = s.fields.find((f) => f.id === 'txp');
    ok(txp && !txp.writable && !txp.bounded, 'schema: txp read-only + unbounded');
    const sendsAfterFirst = counts.send;
    await cfg.schema('b80f');                       // cached
    ok(counts.send === sendsAfterFirst, 'schema: second call is cached (0 new sends)');
    ok(sendsAfterFirst === NPAGES, `schema: pulled ${NPAGES} pages`);
  }

  // ---- 2. get: composes config + chunk cfg, honest unread ---------------------
  {
    const { cfg } = makeDevice();
    const { values, unread } = await cfg.get('b80f');
    ok(values['chunk.gap'] === 3000 && values['chunk.hop'] === 1, 'get: chunk.hop/gap present');
    ok(values['beat'] === 60 && values['det.n'] === 3 && values['alm.ovr'] === 60, 'get: config subset flattened to schema ids');
    ok(unread.includes('mute') && unread.includes('name') && !('mute' in values), 'get: unread lists fields with no read source');
  }

  // ---- 3. set chunk.gap: validates, sends chunk cfg, read-back confirms -------
  {
    const { cfg, state, counts } = makeDevice();
    const r = await cfg.set('b80f', { 'chunk.gap': 1000 });
    ok(r.confirmed && r.set['chunk.gap'] === 1000, 'set: returns confirmed');
    ok(state.gap === 1000 && state.hop === 1, 'set: device gap updated, hop preserved');
    ok(counts.chunkWrites === 1, 'set: exactly one chunk cfg write');
  }

  // ---- 4. out-of-range: throws ERANGE with ZERO airtime ----------------------
  {
    const { cfg, counts } = makeDevice();
    await cfg.schema('b80f');                       // cache schema (its sends don't count as set airtime)
    const writesBefore = counts.chunkWrites;
    let code = null;
    try { await cfg.set('b80f', { 'chunk.gap': 70000 }); } catch (e) { code = e.code; }
    ok(code === 'ERANGE', 'set: 70000 -> ERANGE');
    ok(counts.chunkWrites === writesBefore, 'set: invalid value never reached the air (no write)');
  }

  // ---- 5. unknown field + read-only ------------------------------------------
  {
    const { cfg } = makeDevice();
    await cfg.schema('b80f');
    let c1 = null, c2 = null, c3 = null;
    try { await cfg.set('b80f', { 'no.such': 1 }); } catch (e) { c1 = e.code; }
    try { await cfg.set('b80f', { txp: 10 }); } catch (e) { c2 = e.code; }
    try { await cfg.set('b80f', { 'chunk.gap': 'abc' }); } catch (e) { c3 = e.code; }
    ok(c1 === 'EFIELD', 'set: unknown field -> EFIELD');
    ok(c2 === 'EREADONLY', 'set: read-only field -> EREADONLY');
    ok(c3 === 'EVALUE', 'set: non-integer -> EVALUE');
  }

  // ---- 6. schema unreachable -> set() falls back to built-in bounds ----------
  {
    const state = { hop: 1, gap: 3000 };
    const counts = { chunkWrites: 0 };
    const cfg = new Config({
      log: { debug() {}, info() {}, warn() {} },
      schemaTimeoutMs: 300,                       // short: schema pull will fail fast
      command: async (node, verb, args = []) => {
        if (verb === 'chunk' && args[0] === 'cfg') {
          if (args.length === 1) return { type: 'chunkcfg', hop: state.hop, gap: state.gap };
          counts.chunkWrites++; state.hop = Number(args[1]); state.gap = Number(args[2]);
          return { type: 'chunkcfg', hop: state.hop, gap: state.gap };
        }
        return {};
      },
      send: async () => ({ id: 1 }),              // never delivers a schema frame
    });
    const r = await cfg.set('b80f', { 'chunk.gap': 1000 });
    ok(r.confirmed && state.gap === 1000, 'fallback: chunk.gap set works without device schema');
    let code = null;
    try { await cfg.set('b80f', { 'chunk.gap': 70000 }); } catch (e) { code = e.code; }
    ok(code === 'ERANGE', 'fallback: bounds still enforced (70000 -> ERANGE)');
    let ef = null;
    try { await cfg.set('b80f', { 'det.n': 5 }); } catch (e) { ef = e.code; }
    ok(ef === 'EFIELD', 'fallback: a non-mapped field without schema -> EFIELD (honest)');
  }

  // ---- 7. TEXT set (name/lname): confirm from the write reply + length bounds ----
  {
    const { cfg } = makeDevice();
    const r = await cfg.set('b80f', { name: 'BNCH' });
    ok(r.confirmed && r.set.name === 'BNCH', 'text: set name -> confirmed from write reply');
    const r2 = await cfg.set('b80f', { lname: 'BNCH' });
    ok(r2.confirmed && r2.set.lname === 'BNCH', 'text: set lname -> confirmed');
    let code = null;
    try { await cfg.set('b80f', { name: 'TOOLONG' }); } catch (e) { code = e.code; }
    ok(code === 'ERANGE', 'text: over-length name (7>4) -> ERANGE (no send)');
  }

  console.log(`config OK: ${pass} assertions passed`);
})().catch((e) => { console.error('config FAILED:', e && e.stack || e); process.exit(1); });
