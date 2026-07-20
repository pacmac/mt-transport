'use strict';
// END-TO-END push transfer: the REAL C++ engine against the REAL JS receiver,
// across a seeded lossy link. No radio, no device, deterministic.
//
// WHY CROSS-LANGUAGE. A JS fake device driving a JS receiver proves the two
// halves I wrote agree with each other, which is exactly the class of bug that
// survives into hardware. Here the device side is mylibs/mt-chunk-push compiled
// as-is — production firmware code — so a wire disagreement fails HERE instead
// of at 2.3 km with no OTA.
//
// HONEST LIMIT, stated up front because the pull harness passed and pull still
// failed on air: FakeLink loss is INDEPENDENT per frame. Real loss on this link
// is correlated and bursty (self-congestion from the gateway rebroadcasting our
// own stream, measured by node-dash at ~2.8 frames per chunk). So this proves
// PROTOCOL LOGIC under loss. It does NOT model RF dynamics, and passing here is
// not evidence the on-air transfer will work. That is step 7's job.
//
// Run: node test/e2e-push.js

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const p = require('../lib/chunk-push');
const { PushReceiver } = require('../lib/push-receiver');

const LIB = path.resolve(__dirname, '../../../../../mylibs/mt-chunk-push');
const SIM = '/tmp/push_device_sim';

// ---- build the real engine --------------------------------------------------
function buildSim() {
  const r = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', `-I${LIB}/src`,
    '-o', SIM, `${LIB}/test/push_device_sim.cpp`, `${LIB}/src/MtChunkPush.cpp`],
    { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
}

// ---- device under test (a real process) -------------------------------------
class Device {
  constructor() {
    this.proc = spawn(SIM, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = '';
    this.out = [];
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        this.out.push(line);
      }
    });
  }
  // Send a command and collect every TX line the engine emitted for it.
  async cmd(s) {
    this.out = [];
    this.proc.stdin.write(s + '\n');
    while (!this.out.includes('OK')) await new Promise((r) => setImmediate(r));
    return this.out.filter((l) => l.startsWith('TX ')).map((l) => Buffer.from(l.slice(3), 'hex'));
  }
  kill() { this.proc.stdin.write('Q\n'); this.proc.kill(); }
}

// ---- seeded lossy link ------------------------------------------------------
// Deterministic LCG so a failure is reproducible from its seed.
class Link {
  constructor(seed, { loss = 0, dup = 0 } = {}) { this.s = seed >>> 0; this.loss = loss; this.dup = dup; }
  rnd() { this.s = (this.s * 1103515245 + 12345) >>> 0; return (this.s >>> 8) / 16777216; }
  // Returns how many copies arrive: 0 (lost), 1, or 2 (duplicate).
  deliver() {
    if (this.rnd() < this.loss) return 0;
    return (this.rnd() < this.dup) ? 2 : 1;
  }
}

const expected = (len) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xFF));

// ---- one transfer -----------------------------------------------------------
async function transfer({ seed, len = 7156, loss = 0, dup = 0, dropStart = false,
                          reorder = 0, dieAfter = Infinity,
                          gapMs = 1500, idleMs = 8000 }) {
  const dev = new Device();
  const pid = 1;
  await dev.cmd(`PUB ${pid} ${len}`);

  const down = new Link(seed ^ 0xA5A5, { loss });        // client -> device
  const up = new Link(seed, { loss, dup });              // device -> client
  const rx = new PushReceiver(pid, { idleMs });

  let t = 0;
  let airFrames = 0;
  const held = [];
  let firstStart = true;
  // Kick it off exactly as the dashboard would.
  let pending = [p.encodeStart(pid)];

  // Simulated minutes, not wall clock. Overridable so a near-miss can be probed
  // for "does it converge given time?" rather than guessed at.
  const DEADLINE = Number(process.env.E2E_DEADLINE_MS || 20 * 60 * 1000);

  while (t < DEADLINE && !rx.done && !rx.failed) {
    // client -> device
    for (const f of pending) {
      // dropStart models the one message whose loss could strand a transfer.
      const forceDrop = dropStart && firstStart && f[0] === p.MSG.START;
      if (forceDrop) firstStart = false;
      if (!forceDrop && down.deliver() > 0) await dev.cmd(`RX ${f.toString('hex')}`);
    }
    pending = [];

    // device -> client. dieAfter models the device going away mid-stream
    // (battery, reboot, alarm preempting) — we stop servicing it entirely.
    const sent = airFrames >= dieAfter ? [] : await dev.cmd(`T ${t}`);
    for (const f of sent) {
      airFrames++;
      const copies = up.deliver();
      for (let i = 0; i < copies; i++) {
        // Reorder: hold a frame back one iteration so it lands after its
        // successor. Must be a non-event — the seq carries the position.
        if (reorder > 0 && up.rnd() < reorder) held.push(f);
        else rx.onFrame(f, t);
      }
    }
    while (held.length > 1) rx.onFrame(held.shift(), t);

    const out = rx.tick(t);
    if (out) pending.push(out);

    t += gapMs;
  }

  dev.kill();
  const asm = rx.assemble();
  return { rx, asm, t, airFrames, ok: !!asm && rx.done };
}

// ---- cases ------------------------------------------------------------------
let pass = 0, fail = 0;
const log = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name} ${extra}`); }
  else    { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

(async () => {
  buildSim();
  const want = expected(7156);

  console.log('clean link');
  {
    const r = await transfer({ seed: 1 });
    log(r.ok, 'completes', `${r.rx.received}/${r.rx.count} chunks, ${r.airFrames} frames on air, ${r.t / 1000}s`);
    log(r.asm && r.asm.equals(want), 'CRC-verified bytes identical');
    log(r.rx.stats.repairsSent === 0, 'no repairs needed', `(repairs=${r.rx.stats.repairsSent})`);
  }

  console.log('lossy link — missing chunks are NORMAL, not an error state');
  for (const loss of [0.1, 0.2, 0.3, 0.5]) {
    let okCount = 0, rounds = 0, frames = 0, secs = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const r = await transfer({ seed: seed * 977, loss });
      if (r.ok && r.asm.equals(want)) okCount++;
      rounds += r.rx.stats.repairsSent; frames += r.airFrames; secs += r.t / 1000;
    }
    log(okCount === 5, `${(loss * 100).toFixed(0)}% loss`,
        `${okCount}/5 seeds, avg ${(rounds / 5).toFixed(1)} repair rounds, ` +
        `${(frames / 5).toFixed(0)} frames, ${(secs / 5).toFixed(0)}s`);
  }

  console.log('loss + duplicates + the tail case');
  {
    const r = await transfer({ seed: 4242, loss: 0.2, dup: 0.2 });
    log(r.ok && r.asm.equals(want), '20% loss + 20% duplicates',
        `dupes seen=${r.rx.stats.dupes}`);
  }

  console.log('the failures this design exists for');
  {
    // The one message whose loss could leave a transfer un-started.
    const r = await transfer({ seed: 7, dropStart: true });
    log(r.ok && r.asm.equals(want), 'START lost -> receiver re-asks and recovers',
        `(starts sent=${r.rx.stats.startsSent})`);
    // The harness sends the initial START (as the dashboard would) and it is
    // force-dropped, so ANY start from the receiver is the self-heal firing.
    log(r.rx.stats.startsSent >= 1, 'receiver re-sent START itself',
        `(receiver starts=${r.rx.stats.startsSent})`);
  }
  {
    // Heavy loss guarantees some manifests AND some tails are lost, which is the
    // lost-last-chunk case arising naturally rather than being staged.
    const r = await transfer({ seed: 99, loss: 0.4 });
    log(r.ok && r.asm.equals(want), '40% loss -> recovers via progress+repair',
        `manifests seen=${r.rx.stats.manifests}, queries=${r.rx.stats.queriesSent}, ` +
        `repairs=${r.rx.stats.repairsSent}`);
    log(r.rx.stats.progressReplies > 0, 'progress query was actually used');
  }

  console.log('reordering is a non-event');
  {
    const r = await transfer({ seed: 313, loss: 0.15, dup: 0.15, reorder: 0.3 });
    log(r.ok && r.asm.equals(want), '15% loss + 15% dup + 30% reordered',
        `dupes=${r.rx.stats.dupes}, repairs=${r.rx.stats.repairsSent}`);
  }

  console.log('device dies mid-stream — must fail LOUDLY, never hang');
  {
    const r = await transfer({ seed: 5, dieAfter: 10 });
    log(!r.ok, 'does not report success');
    log(!!r.rx.failed, 'reports a clear reason', `"${r.rx.failed}"`);
    log(r.asm === null, 'assemble() refuses a partial set');
    // The receiver held real chunks and knows exactly what it lacks — an
    // interrupted transfer is resumable, not lost.
    log(r.rx.received > 0 && r.rx.received < r.rx.count,
        'holds a usable partial', `${r.rx.received}/${r.rx.count}`);
  }

  console.log('device-side accounting');
  {
    const r = await transfer({ seed: 11, loss: 0.25 });
    // The free loss measurement: device says how far it got, we know what we hold.
    log(r.rx.stats.deviceCursor !== null, 'device reported its cursor',
        `cursor=${r.rx.stats.deviceCursor}, we hold ${r.rx.received}/${r.rx.count}`);
    log(r.ok, 'still completed');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
