'use strict';
// Layer 0 — OFFLINE test of the JS chunk FETCH LOOP (index.js Client.fetch).
//
// WHY THIS EXISTS. The C++ chunk *protocol* has an offline harness
// (mylibs/mt-chunk/test/test_chunk.cpp + fake_transport.h) that sails through
// 50 % loss. The JS fetch/pacing loop — the device-obey, re-pull, resume and
// idle-guard logic in index.js, where every failed on-air fix lived — had NO
// offline test and was only ever exercised on-air (flaky, non-deterministic,
// conflating every layer). This closes that gap: a fake ChunkServer + a lossy
// FakeLink drive the REAL Client.fetch with NO radio, deterministically, in ms.
//
// It is the JS twin of fake_transport.h. Same idea: inject the transport, make
// loss/dup/reorder seeded and reproducible, assert the transfer COMPLETES and
// CRC-VERIFIES. Run: `node test/offline-fetch.js`.

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Client, chunk } = require('../index');

const CDATA = chunk.CHUNK_DATA_MAX; // 224

// ---- deterministic PRNG (LCG, Numerical Recipes constants) ------------------
// Seeded so a failure is reproducible from its seed alone — the whole point of
// an offline harness over on-air runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// A payload whose bytes are a function of the seed — content is irrelevant, only
// its length (→ chunk count) and CRC matter. 7156 B → 32 chunks, mirroring the
// real Layer-A test image (test_image.h) so the loop runs at production shape.
function makePayload(bytes, seed) {
  const b = Buffer.alloc(bytes);
  const r = lcg(seed ^ 0x9e3779b9);
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(r() * 256);
  return b;
}

// ---- FakeServer — the device side, stateless like ChunkServer ---------------
// Answers GETMANIFEST (→ MANIFEST frame + the JSON text reply the real device
// sends alongside it) and PULL (→ CHUNK frames, or a MSG_BUSY on a seeded
// schedule). Byte layout matches src/MtChunk.cpp / lib/chunk.js exactly.
class FakeServer {
  constructor(payload, pid, { busyEvery = 0, retryAfterMs = 30, serveMax = Infinity } = {}) {
    this.payload = payload;
    this.pid = pid;
    this.count = Math.ceil(payload.length / CDATA);
    this.crc = chunk.crc32(payload);
    this.busyEvery = busyEvery;
    this.retryAfterMs = retryAfterMs;
    // Serve only chunks with idx < serveMax; higher ranges return nothing. Used
    // to force a DETERMINISTIC stall+partial (no wall-clock deadline race) for
    // the resume test — the client re-pulls the gap, hears silence, and gives up.
    this.serveMax = serveMax;
    this.pulls = 0;   // total PULLs seen
    this.busies = 0;  // BUSY frames emitted (assertions read this)
    this.served = 0;  // CHUNK frames produced (pre-link, i.e. before loss)
  }

  manifestFrame() {
    const b = Buffer.alloc(14);
    b[0] = chunk.MSG.MANIFEST;
    b.writeUInt16BE(this.pid, 1);
    b[3] = chunk.PT.IMAGE;
    b.writeUInt32BE(this.payload.length, 4);
    b.writeUInt16BE(this.count, 8);
    b.writeUInt32BE(this.crc, 10);
    return b;
  }

  chunkFrame(idx) {
    const off = idx * CDATA;
    const data = this.payload.subarray(off, Math.min(off + CDATA, this.payload.length));
    const b = Buffer.alloc(chunk.CHUNK_HEADER_LEN + data.length);
    b[0] = chunk.MSG.CHUNK;
    b.writeUInt16BE(this.pid, 1);
    b.writeUInt16BE(idx, 3);
    b.writeUInt16BE(this.count, 5);
    data.copy(b, chunk.CHUNK_HEADER_LEN);
    return b;
  }

  busyFrame() {
    const b = Buffer.alloc(5);
    b[0] = chunk.MSG.BUSY;
    b.writeUInt16BE(this.pid, 1);
    b.writeUInt16BE(this.retryAfterMs, 3);
    return b;
  }

  // `chunk info <pid>`: manifest frame on the binary port AND a JSON text reply
  // (the device sends both — see main.cpp chunk-info handler). The text reply is
  // what resolves the command queue; the binary frame is what sets haveManifest.
  onInfo(pid) {
    if (pid !== this.pid) {
      return { frames: [], reply: { type: 'err', msg: 'refused', pid, held: this.pid } };
    }
    return {
      frames: [this.manifestFrame()],
      reply: { type: 'chunk', pid: this.pid, len: this.payload.length,
               n: this.count, crc: this.crc.toString(16) },
    };
  }

  // `chunk pull <pid> <first> <count>`: chunks on the binary port, NO text reply
  // (main.cpp sets reply[0]=0 — chunks ARE the reply). May answer MSG_BUSY.
  onPull(pid, first, count) {
    this.pulls++;
    if (pid !== this.pid) return { frames: [] };
    if (this.busyEvery && (this.pulls % this.busyEvery === 0)) {
      this.busies++;
      return { frames: [this.busyFrame()] }; // busy: serve nothing this round
    }
    const frames = [];
    for (let i = first; i < first + count && i < this.count; i++) {
      if (i >= this.serveMax) continue; // beyond what this server will serve
      frames.push(this.chunkFrame(i));
      this.served++;
    }
    return { frames };
  }
}

// ---- FakeLink — the lossy channel -------------------------------------------
// Applies seeded loss / duplication / reorder to CHUNK frames only. MANIFEST and
// MSG_BUSY are control frames delivered reliably here (small, and re-requested /
// re-derived anyway) so each test isolates ONE failure mode of the data path.
class FakeLink {
  constructor({ loss = 0, dup = 0, reorder = 0, rng }) {
    this.loss = loss; this.dup = dup; this.reorder = reorder; this.rng = rng;
    this.dropped = 0; this.duped = 0;
  }
  shape(frames) {
    const out = [];
    for (const f of frames) {
      const isChunk = f[0] === chunk.MSG.CHUNK;
      if (isChunk && this.rng() < this.loss) { this.dropped++; continue; }
      out.push(f);
      if (isChunk && this.rng() < this.dup) { out.push(f); this.duped++; }
    }
    // Fisher–Yates, gated per-swap by `reorder` so it is a knob, not all-or-nothing.
    if (this.reorder && out.length > 1) {
      for (let i = out.length - 1; i > 0; i--) {
        if (this.rng() < this.reorder) {
          const j = Math.floor(this.rng() * (i + 1));
          const t = out[i]; out[i] = out[j]; out[j] = t;
        }
      }
    }
    return out;
  }
}

// ---- wire a real Client to the fake server over the fake link ---------------
// Overrides ONLY _sendText — the transport boundary. Everything above it (the
// command queue, ChunkClient, reassembly, CRC, resume, the fetch pacing loop) is
// the real code under test. Frames arrive on a later tick (setImmediate) to
// model async radio delivery, so the queue's reply-timer is armed before its
// reply lands — exactly as on air.
function makeClient(server, link, payloadDir) {
  const c = new Client({
    host: 'offline', gatewayId: '!offline', channel: 2,
    minSpacingMs: 0, timeoutMs: 100000, payloadDir,
  });
  c._sendText = async (text) => {
    let m;
    if ((m = text.match(/chunk info (\d+)/))) {
      const { frames, reply } = server.onInfo(parseInt(m[1], 10));
      setImmediate(() => {
        for (const f of link.shape(frames)) c._onChunk(f);
        if (reply) c._onText({ data: { text: JSON.stringify(reply) } });
      });
    } else if ((m = text.match(/chunk pull (\d+) (\d+) (\d+)/))) {
      const { frames } = server.onPull(+m[1], +m[2], +m[3]);
      setImmediate(() => { for (const f of link.shape(frames)) c._onChunk(f); });
    }
    return { ok: true };
  };
  return c;
}

// Fast timing so the loop LOGIC is tested in ms, not radio seconds. Defaults in
// fetch() stay the radio-tuned values; these overrides change only wait lengths.
const FAST = { batch: 16, answerMs: 60, batchMs: 60, pollMs: 4, idleSleepMs: 4 };

let tmpRoot;
function freshDir(tag) {
  const d = path.join(tmpRoot, tag);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---- test runner ------------------------------------------------------------
let pass = 0, fail = 0;
const jobs = [];
const t = (name, fn) => jobs.push(async () => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
});

// One full transfer. Returns the fetched buffer + server/link stats.
async function transfer(name, { bytes = 7156, pid = 1, seed = 1,
  loss = 0, dup = 0, reorder = 0, busyEvery = 0, batch } = {}) {
  const payload = makePayload(bytes, seed);
  const server = new FakeServer(payload, pid, { busyEvery, retryAfterMs: 25 });
  const link = new FakeLink({ loss, dup, reorder, rng: lcg(seed) });
  const c = makeClient(server, link, freshDir(name.replace(/\W+/g, '_')));
  const buf = await c.fetch('t', pid, { ...FAST, batch: batch ?? FAST.batch, timeoutMs: 60000 });
  return { buf, payload, server, link };
}

t('clean link — completes and CRC-verifies', async () => {
  const { buf, payload, server } = await transfer('clean', { seed: 7 });
  assert.ok(buf.equals(payload), 'bytes match');
  assert.strictEqual(chunk.crc32(buf), server.crc, 'CRC matches manifest');
});

t('MSG_BUSY obeyed — busy every 2nd pull, no loss', async () => {
  // Small batch → many pulls → BUSY trips repeatedly, so we prove the client
  // obeys it more than once, not just survives a single throttle.
  const { buf, payload, server } = await transfer('busy', { seed: 3, busyEvery: 2, batch: 4 });
  assert.ok(server.busies >= 3, `device throttled repeatedly (got ${server.busies} BUSY)`);
  assert.ok(buf.equals(payload), 'still completes despite repeated BUSY');
});

t('20% chunk loss — re-pulls the gaps, completes', async () => {
  const { buf, payload, link } = await transfer('loss20', { seed: 5, loss: 0.20 });
  assert.ok(link.dropped > 0, `link actually dropped frames (${link.dropped})`);
  assert.ok(buf.equals(payload), 'recovered every dropped chunk');
});

t('20% loss + 20% dup + reorder — completes and verifies', async () => {
  const { buf, payload, link } = await transfer('chaos', {
    seed: 11, loss: 0.20, dup: 0.20, reorder: 0.5 });
  assert.ok(link.dropped > 0 && link.duped > 0, 'loss and dup both exercised');
  assert.ok(buf.equals(payload), 'reassembly is order/dup independent');
});

t('loss + BUSY together — completes', async () => {
  const { buf, payload, server, link } = await transfer('loss_busy', {
    seed: 13, loss: 0.15, busyEvery: 3 });
  assert.ok(server.busies > 0 && link.dropped > 0, 'both paths exercised');
  assert.ok(buf.equals(payload), 'device pacing + gap re-pull compose correctly');
});

// Loss sweep across seeds — this is where the JS idle-guard (abort after 12 empty
// windows) gets stress-tested. We REPORT the survival rate per loss level rather
// than tuning to pass, so a too-tight guard shows up as a number, not a green tick.
t('loss sweep — report completion rate at 10/30/50%', async () => {
  const levels = [0.10, 0.30, 0.50];
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const summary = [];
  for (const loss of levels) {
    let ok = 0;
    for (const seed of seeds) {
      try {
        const { buf, payload } = await transfer(`sweep_${loss}_${seed}`, { seed, loss });
        if (buf.equals(payload)) ok++;
      } catch { /* timeout / idle-guard abort counts as a non-completion */ }
    }
    summary.push(`${Math.round(loss * 100)}%: ${ok}/${seeds.length}`);
  }
  console.log(`       sweep → ${summary.join('   ')}`);
  // Hard assertion only at a loss level the design MUST survive; higher levels
  // are reported for insight (an unrecoverable link is allowed to fail).
  const at10 = summary[0];
  assert.ok(at10.endsWith(`${seeds.length}/${seeds.length}`),
    `10% loss must be 100% reliable, got ${at10}`);
});

t('resume — an interrupted transfer continues from the persisted partial', async () => {
  const dir = freshDir('resume');
  const pid = 9, seed = 21;
  const payload = makePayload(7156, seed);
  const count = Math.ceil(payload.length / CDATA);

  // Run 1: a server that serves only the first 20 chunks. The client gets 20,
  // re-pulls the rest, hears silence, and aborts via the idle guard — a genuine
  // interruption with a 20/32 partial persisted. Deterministic, no timing race.
  const s1 = new FakeServer(payload, pid, { serveMax: 20 });
  const c1 = makeClient(s1, new FakeLink({ rng: lcg(seed) }), dir);
  let threw = false;
  try { await c1.fetch('t', pid, { ...FAST, timeoutMs: 60000 }); } catch { threw = true; }
  assert.ok(threw, 'run 1 stalled and aborted');
  const partial = c1.store.loadPartial('t', pid);
  assert.ok(partial && partial.have.size > 0 && partial.have.size < count,
    `a genuine partial was saved (${partial ? partial.have.size : 0}/${count})`);

  // Run 2: a full server, same pid + dir → must seed from the partial (start
  // above 0, not from scratch) and finish.
  const s2 = new FakeServer(payload, pid, {});
  const c2 = makeClient(s2, new FakeLink({ rng: lcg(seed + 1) }), dir);
  let firstReceived = null;
  const buf = await c2.fetch('t', pid, { ...FAST, timeoutMs: 60000,
    onProgress: (p) => { if (firstReceived === null) firstReceived = p.received; } });
  assert.ok(firstReceived >= partial.have.size,
    `resume seeded from the partial (first progress ${firstReceived} >= ${partial.have.size})`);
  assert.ok(buf.equals(payload), 'resumed transfer verifies');
});

(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mtchunk-offline-'));
  console.log('mt-transport offline fetch harness (Layer 0 — no radio)\n');
  try {
    for (const j of jobs) await j();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
})();
