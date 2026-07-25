'use strict';
// The device registry + devices(): OUR devices told apart from the rest of the mesh.
// Offline — a bare Mesh with a stubbed roster, no gw/connect. See specs/mesh-devices-route.md.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Mesh } = require('..');
const { Model } = require('../lib/model');
const { PayloadStore } = require('../lib/store');
const _cfg = require('../lib/settings').load({ config: {} });


let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const OMNI = '!2687afb1', BNCH = '!8cee336b', GARG = '!987ab80f', TA2M = '!da5af428';

// The live roster shape, as returned by gw.nodes() and normalised by _summaries().
const ROSTER = {
  nodes: {
    646426545:  { num: 646426545,  last_heard: 1784976984, hops: 0 },                       // OMNI: no user block
    2364420971: { num: 2364420971, last_heard: 1784976618, hops: 0, rssi: -56, snr: 5.8,
                  user: { long_name: '336b 2-260725-18', short_name: 'BNCH' },
                  position: { latitude_i: 510263300, longitude_i: -31588350 } },
    2558179343: { num: 2558179343, last_heard: 1784970000, hops: 0, rssi: -120, snr: -14,
                  user: { long_name: 'b80f 2-260724-3', short_name: 'GARG' },
                  position: { latitude_i: 510146831, longitude_i: -31282490 } },
    3663393832: { num: 3663393832, last_heard: 1784976000, hops: 2,
                  user: { long_name: 'B12PAC car', short_name: 'TA2m' } },                  // NOT ours
  },
};

// Each mesh gets its OWN store dir unless one is passed deliberately (the restart and
// union cases below share a dir on purpose). Learning PERSISTS, so a shared dir would
// leak a learned device from one block into the next and mask a real failure.
const tmpDirs = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pac-dev-${tag}-`));
  tmpDirs.push(d);
  return d;
}

function mkMesh({ devices = {}, learned = [], dir = tmp('x') } = {}) {
  const m = new Mesh();
  m.cfg = { devices, units: {}, mode: { silentMs: 150000 } };
  m.model = new Model();
  m.images = { store: new PayloadStore({ query: _cfg.store, dir }) };
  m._ours = new Set([...Object.keys(devices), ...m.images.store.loadDevices()]);
  for (const id of learned) m._markOurs(id);
  m.gw = { nodes: async () => ROSTER };
  return m;
}

(async () => {
  // 1. DECLARED devices only — the mesh has 4 nodes, 2 are ours.
  {
    const m = mkMesh({ devices: { [BNCH]: { label: 'Bench alarm' }, [GARG]: { label: 'Garage alarm' } } });
    const d = await m.devices();
    ok(d.length === 2, 'devices(): only OUR devices, not the whole roster');
    const ids = d.map((x) => x.id).sort();
    ok(!ids.includes(OMNI), 'the GATEWAY is not a device — it is our radio, and sends no 260/261');
    ok(!ids.includes(TA2M), 'a third-party node (the handheld) is not a device');
    ok(ids.includes(BNCH) && ids.includes(GARG), 'both declared units are listed');

    const nodes = await m.nodes();
    ok(nodes.length === 4, '/nodes still returns the WHOLE mesh — nothing is hidden');
    ok(nodes.filter((n) => n.ours).length === 2, '/nodes marks exactly our two as ours');
    ok(nodes.find((n) => n.id === TA2M).ours === false, 'a third-party node is ours:false');
  }

  // 2. The enriched fields a dashboard renders without a second call.
  {
    const m = mkMesh({ devices: { [GARG]: { label: 'Garage alarm' } } });
    m.model.sleep(GARG, 1);
    const g = (await m.devices())[0];
    ok(g.label === 'Garage alarm', 'label comes from config');
    ok(g.source === 'config', 'source: config for a declared device');
    ok(g.shortName === 'GARG', 'shortName from the roster user block');
    ok(g.fw === '2-260724-3', 'fw parsed from the long name "<suffix> <version>"');
    ok(g.present === true, 'present: true when it is in the roster');
    // `awake` is a MEASUREMENT: this fixture has never been heard (no lastHeardMs), so the
    // honest answer is null = UNKNOWN. It must NOT be false just because mode is 'live' —
    // mode is the operator's routing override and describes no physical fact.
    ok(g.slp === 1 && g.mode === 'live' && g.awake === null,
       'liveness included (no extra /mode call); awake is null when never heard, not false');
    ok(Math.abs(g.position.lat - 51.0146831) < 1e-6, 'position decoded from latitude_i');
    ok(Math.abs(g.position.lon - (-3.1282490)) < 1e-6, 'longitude decoded (negative preserved)');
    ok(g.rssi === -120 && g.snr === -14, 'signal carried through for the record');
  }

  // 2b. `fw` must parse the REAL long-name shapes, not just the degraded hex fallback.
  //     The old regex demanded a 4-hex prefix — which is the name a unit carries when its
  //     ROLE NAME HAS NOT BEEN APPLIED — so it parsed only misconfigured units and returned
  //     null for every correctly-named one. That silently disabled the schema staleness
  //     check on the deployed unit (audit-260725a-truth). Anchor on the VERSION, not the
  //     prefix.
  {
    const m = mkMesh({ devices: { [GARG]: { label: 'Garage alarm' } } });
    const fw = (name) => {
      const mm = typeof name === 'string' ? name.match(/(?:^|\s)(\d+-\d{6}-\d+)\s*$/) : null;
      return mm ? mm[1] : null;
    };
    ok(fw('b80f 2-260725-21') === '2-260725-21', 'fw: hex fallback name still parses');
    ok(fw('Garage 2-260725-20') === '2-260725-20', 'fw: a ROLE-named unit parses (the old regex returned null)');
    ok(fw('Bench 2-260725-9') === '2-260725-9', 'fw: single-digit build parses');
    ok(fw('GARG 2-260725-20') === '2-260725-20', 'fw: short-name prefix parses');
    ok(fw('B12PAC car') === null, 'fw: a name with no version is null, never a guess');
    ok(fw('Garage') === null, 'fw: prefix alone is null');
    ok(fw(null) === null, 'fw: a missing name is null');
    void m;
  }

  // 2c. `awake` is a MEASUREMENT. Heard recently => true; heard long ago => false; never
  //     heard => null. It must never be inferred from cfg mode (audit-260725a-truth).
  {
    const m = mkMesh({ devices: { [GARG]: { label: 'Garage alarm' } } });
    m.cfg.units = { [GARG]: { mode: 'live' } };       // operator override says "live"...
    m.model.heard(GARG, Date.now());                  // ...but we just heard it
    ok((await m.devices())[0].awake === true, 'awake: true when heard inside silentMs, DESPITE mode=live');
    m.model.heard(GARG, Date.now() - 10 * 60 * 1000);
    ok((await m.devices())[0].awake === false, 'awake: false when last heard beyond silentMs');
  }

  // 3. A DECLARED device the gateway has never seen still appears.
  //    This is the point of declaring: a sleeper must not vanish from the list.
  {
    const m = mkMesh({ devices: { '!deadbeef': { label: 'Spare' } } });
    const d = await m.devices();
    ok(d.length === 1, 'an unheard declared device is still listed');
    ok(d[0].present === false, 'present: false when absent from the roster');
    ok(d[0].num === null && d[0].rssi === null && d[0].fw === null,
       'unknown fields are null, never invented');
  }

  // 4. LEARNED: a 260/261 frame proves ownership without any config change.
  {
    const m = mkMesh({});
    ok((await m.devices()).length === 0, 'nothing declared, nothing learned -> empty');
    m._markOurs(BNCH);
    const d = await m.devices();
    ok(d.length === 1 && d[0].id === BNCH, 'a protocol frame makes a node ours');
    ok(d[0].source === 'learned', 'source: learned when not declared');
    ok(d[0].label === null, 'a learned device has no label');
  }

  // 5. Learning PERSISTS — the restart case. A unit asleep since the last start has
  //    sent us nothing, so without this it would drop off the list entirely.
  {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-dev-persist-'));
    const m1 = mkMesh({ dir: sub });
    m1._markOurs(BNCH);
    m1._markOurs(GARG);
    const m2 = mkMesh({ dir: sub });                 // simulates a service restart
    const d = await m2.devices();
    ok(d.length === 2, 'learned devices survive a restart');
    ok(d.every((x) => x.source === 'learned'), 'they are still marked learned');
    fs.rmSync(sub, { recursive: true, force: true });
  }

  // 6. Declared + learned UNION, and declared wins on source labelling.
  {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-dev-union-'));
    const m1 = mkMesh({ dir: sub });
    m1._markOurs(GARG);                              // learned only
    const m2 = mkMesh({ devices: { [BNCH]: { label: 'Bench alarm' } }, dir: sub });
    const d = await m2.devices();
    ok(d.length === 2, 'union of declared and learned');
    ok(d.find((x) => x.id === BNCH).source === 'config', 'declared -> config');
    ok(d.find((x) => x.id === GARG).source === 'learned', 'learned -> learned');
    fs.rmSync(sub, { recursive: true, force: true });
  }

  // 7. _markOurs is called per FRAME — a repeat must not re-write the file.
  {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-dev-idem-'));
    const m = mkMesh({ dir: sub });
    m._markOurs(BNCH);
    let writes = 0;
    const realSave = m.images.store.saveDevices.bind(m.images.store);
    m.images.store.saveDevices = (ids) => { writes++; return realSave(ids); };
    for (let i = 0; i < 50; i++) m._markOurs(BNCH);
    ok(writes === 0, 'an already-known device does not touch the disk again');
    m._markOurs(GARG);
    ok(writes === 1, 'a genuinely new device does persist');
    fs.rmSync(sub, { recursive: true, force: true });
  }

  // 8. A roster failure must not take the device list down — a declared device is
  //    still known to us even when the gateway is unreachable.
  {
    const m = mkMesh({ devices: { [GARG]: { label: 'Garage alarm' } } });
    m.gw = { nodes: async () => { throw new Error('gw down'); } };
    const d = await m.devices();
    ok(d.length === 1 && d[0].present === false, 'gw failure -> still listed, present:false');
  }

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`devices OK: ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
