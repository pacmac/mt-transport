// Offline test for mesh-images — no radio. Covers the PushReceiver reassembly +
// repair, the store + partial resume, and the whole autonomous drive loop via a
// closed-loop DEVICE SIMULATOR (a fake gw that streams 261 frames back in
// response to the push control text, lossy to force a repair round).
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const P = require('../lib/protocol');
const { PushReceiver } = require('../lib/push-receiver');
const { PayloadStore } = require('../lib/store');
const { Images } = require('../lib/images');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(15); } return cond(); };
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mtimg-'));

const CH = P.CHUNK_DATA_MAX;
// ~5-chunk deterministic payload.
const payload = Buffer.alloc(1000);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) % 251;
const COUNT = Math.ceil(payload.length / CH);
const CRC = P.crc32(payload);
const chunkBytes = (s) => payload.subarray(s * CH, Math.min((s + 1) * CH, payload.length));

// ---- 1. PushReceiver reassembly + CRC (direct) ------------------------------
{
  const rx = new PushReceiver(1, { idleMs: 100, actMs: 100, quietMs: 100 });
  rx.onFrame(P.encodeManifest(1, 2, payload.length, COUNT, CRC), 1000);
  for (let s = 0; s < COUNT; s++) rx.onFrame(P.encodeChunk(1, s, chunkBytes(s)), 1000);
  ok(rx.missing().length === 0, 'reassembly: nothing missing');
  ok(rx.assemble().equals(payload), 'reassembly: bytes + CRC verify');
}

// ---- 2. repair round (direct, explicit clock) -------------------------------
{
  const k = 2;
  const rx = new PushReceiver(1, { idleMs: 100, actMs: 100, quietMs: 100 });
  rx.onFrame(P.encodeManifest(1, 2, payload.length, COUNT, CRC), 1000);
  for (let s = 0; s < COUNT; s++) if (s !== k) rx.onFrame(P.encodeChunk(1, s, chunkBytes(s)), 1000);

  let out = rx.tick(1200); // idle -> ask where the device is
  ok(P.decodeFrame(out).type === P.MSG.PROGRESS_Q, 'repair: idle -> PROGRESS_Q');
  rx.onFrame(P.encodeProgress(1, COUNT, true), 1250); // device says it finished the pass
  out = rx.tick(1500);
  const rep = P.decodeFrame(out);
  ok(rep.type === P.MSG.REPAIR && rep.ids.includes(k), 'repair: gap -> REPAIR of the missing id');
  rx.onFrame(P.encodeChunk(1, k, chunkBytes(k)), 1550);
  out = rx.tick(1800);
  ok(P.decodeFrame(out).type === P.MSG.COMPLETE && rx.done, 'repair: filled -> COMPLETE + done');
  ok(rx.assemble().equals(payload), 'repair: final bytes verify');
}

// ---- 3. store save + partial roundtrip + seed -------------------------------
{
  const tmp = mkTmp();
  const store = new PayloadStore({ dir: tmp });
  const p = store.save(payload, { pid: 1, ptype: 2, node: '!8cee336b' });
  ok(fs.existsSync(p) && p.endsWith('.jpg'), 'store.save writes a .jpg');

  const have = new Set([0, 2]);
  store.savePartial('n1', { pid: 9, crc: 0xABCD, count: 5, len: payload.length, have, buf: payload });
  const back = store.loadPartial('n1', 9);
  ok(back && back.crc === 0xABCD && back.count === 5 && back.have.size === 2 && back.have.has(2), 'partial roundtrip');

  const rx = new PushReceiver(9, { idleMs: 100 });
  rx.seed(back);
  ok(rx.manifest.count === 5 && rx.received === 2, 'seed: manifest + held chunks restored');

  store.clearPartial('n1', 9);
  ok(store.loadPartial('n1', 9) === null, 'clearPartial');
}

// ---- device simulator + Images factory --------------------------------------
function makeDevice(ref, { drop = new Set(), repairOnly = false, from = '!8cee336b', pid = 1 } = {}) {
  const deliver = (frame) => setTimeout(() => { if (ref.obj) ref.obj.onFrame(frame, from); }, 0);
  const streamAll = () => {
    deliver(P.encodeManifest(pid, 2, payload.length, COUNT, CRC));
    for (let s = 0; s < COUNT; s++) if (!drop.has(s)) deliver(P.encodeChunk(pid, s, chunkBytes(s)));
  };
  return {
    pid, from,
    command: async (node, verb, args) =>
      (verb === 'push' && args[0] === 'stat')
        ? { up: pid, upst: 1, cnt: COUNT, crc: CRC, proto: P.PROTO_VERSION, fw: 'sim' } : {},
    gw: {
      sent: [],
      async sendText(gwId, text) {
        this.sent.push(text);
        // Control text may be bare ("push q 1") or legacy @-prefixed ("@grge push q 1").
        const m = text.match(/(?:^|@\S+\s+)push\s+(.*)$/);
        if (!m) return { id: 1 };
        const tok = m[1].trim().split(/\s+/);
        if (/^\d+$/.test(tok[0])) { if (!repairOnly) streamAll(); }        // START
        else if (tok[0] === 'q') deliver(P.encodeProgress(pid, COUNT, true)); // PROGRESS_Q
        else if (tok[0] === 'rep') {                                        // REPAIR
          for (const s of (tok[2] || '').split(',').filter(Boolean).map(Number)) deliver(P.encodeChunk(pid, s, chunkBytes(s)));
        }
        return { id: 1 };
      },
    },
  };
}
function makeImages(dev, tmp) {
  return new Images({
    gw: dev.gw, gwId: '!gw', channel: 2, protocol: P, timing: {}, model: null,
    cfg: { paths: { store: tmp }, timing: { pushIdleMs: 15, pushActMs: 15, pushQuietMs: 15, pushPollMs: 5, pushDeadlineMs: 6000 } },
    log: { debug() {}, info() {}, warn() {} },
    command: dev.command,
    send: (node, text) => dev.gw.sendText('!gw', text),   // control path (was gw.sendText w/ @token)
  });
}

// ---- 4. closed-loop get() with a lossy device -------------------------------
async function testGet() {
  const ref = {};
  const dev = makeDevice(ref, { drop: new Set([2]) });
  const images = makeImages(dev, mkTmp());
  ref.obj = images;
  const buf = await images.get('336b', 1);
  ok(buf.equals(payload), 'get(): resolves exact CRC-verified bytes through a repair round');
  ok(dev.gw.sent.some((t) => /push rep /.test(t)), 'get(): a REPAIR was issued (chunk 2 dropped)');
  ok(dev.gw.sent.some((t) => /push done /.test(t)), 'get(): finished with COMPLETE');
}

// ---- 5. autonomous catch: device initiates, no get() call -------------------
async function testAutonomous() {
  const ref = {};
  const dev = makeDevice(ref, { drop: new Set([3]) });
  const tmp = mkTmp();
  const images = makeImages(dev, tmp);
  ref.obj = images;
  let ev = null; let available = false;
  images.emit = (type, p) => { if (type === 'image') ev = p; if (type === 'image-available') available = true; };
  images.startListener();

  // Device initiates a push (manifest + chunks, chunk 3 lost).
  images.onFrame(P.encodeManifest(1, 2, payload.length, COUNT, CRC), dev.from);
  for (let s = 0; s < COUNT; s++) if (s !== 3) images.onFrame(P.encodeChunk(1, s, chunkBytes(s)), dev.from);

  await waitFor(() => ev, 6000);
  ok(available, 'autonomous: emitted image-available on auto-adopt');
  ok(ev && ev.bytes === payload.length, 'autonomous: caught + saved + emitted image (no get() call)');
  ok(ev && fs.existsSync(ev.path) && P.crc32(fs.readFileSync(ev.path)) === CRC, 'autonomous: saved file CRC-matches');
}

// ---- 6. resume: pre-seeded partial + repair-only device ---------------------
async function testResume() {
  const ref = {};
  const tmp = mkTmp();
  const dev = makeDevice(ref, { repairOnly: true }); // START streams NOTHING
  const images = makeImages(dev, tmp);
  ref.obj = images;

  // Persist a partial holding all chunks but [1,4]. Without it, the repair-only
  // device never sends a manifest, so completion is only possible via resume.
  const have = new Set();
  const pbuf = Buffer.alloc(payload.length);
  for (let s = 0; s < COUNT; s++) { if (s === 1 || s === 4) continue; chunkBytes(s).copy(pbuf, s * CH); have.add(s); }
  images.store.savePartial('336b', { pid: 1, crc: CRC, count: COUNT, len: payload.length, have, buf: pbuf });

  const buf = await images.get('336b', 1);
  ok(buf.equals(payload), 'resume: completes from a persisted partial (repair-only device)');
}

Promise.resolve()
  .then(testGet).then(testAutonomous).then(testResume)
  .then(() => console.log(`images OK: ${pass} assertions passed`))
  .catch((e) => { console.error('images FAILED:', e && e.stack || e); process.exit(1); });
