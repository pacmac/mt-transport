// Explicit-clock tests for the three-way idle gate (mesh-push-speed). No radio:
// drive tick(nowMs) with hand-picked clocks and assert WHICH wait applies.
//   actMs(4s) < quietMs(15s) < idleMs(35s)
//   known (done/complete)        -> actMs
//   manifest + quiet, not done   -> quietMs   (the win: query ~20s sooner)
//   no manifest (awaiting stream) -> idleMs    (startup patience preserved)
'use strict';
const assert = require('assert');
const P = require('../lib/protocol');
const { PushReceiver } = require('../lib/push-receiver');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const CH = P.CHUNK_DATA_MAX;
const payload = Buffer.alloc(500);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) % 251;
const COUNT = Math.ceil(payload.length / CH);           // 3 chunks
const CRC = P.crc32(payload);
const chunk = (s) => payload.subarray(s * CH, Math.min((s + 1) * CH, payload.length));
const manifest = () => P.encodeManifest(1, 2, payload.length, COUNT, CRC);

const IDLE = 35000, QUIET = 15000, ACT = 4000;
const mk = () => new PushReceiver(1, { idleMs: IDLE, quietMs: QUIET, actMs: ACT });
const typ = (buf) => (buf ? P.decodeFrame(buf).type : null);

// ---- 0. invariant -----------------------------------------------------------
ok(ACT < QUIET && QUIET < IDLE, 'gate ordering actMs < quietMs < idleMs');
{ const rx = mk(); ok(rx.actMs < rx.quietMs && rx.quietMs < rx.idleMs, 'receiver stores actMs < quietMs < idleMs'); }

// ---- 1. no manifest yet -> startup patience (idleMs), NOT quietMs -----------
{
  const rx = mk();
  ok(typ(rx.tick(0)) === P.MSG.START, 'no-manifest: first tick sends START (lastTx=0)');
  ok(rx.tick(QUIET + 1) === null, 'no-manifest: still quiet past quietMs — does NOT resend START early');
  ok(typ(rx.tick(IDLE + 1)) === P.MSG.START, 'no-manifest: resends START only after idleMs (startup preserved)');
}

// ---- 2. manifest + a recent chunk, gap < quietMs -> no mid-stream query ------
{
  const rx = mk();
  rx.onFrame(manifest(), 1000);
  rx.onFrame(P.encodeChunk(1, 0, chunk(0)), 2000);       // lastRx=2000, missing [1,2]
  ok(rx.tick(2000 + QUIET - 1) === null, 'manifest+streaming: gap < quietMs -> stay quiet (no premature query)');
}

// ---- 3. manifest + stream fell quiet (>= quietMs, < idleMs) -> PROGRESS_Q ----
{
  const rx = mk();
  rx.onFrame(manifest(), 1000);
  rx.onFrame(P.encodeChunk(1, 0, chunk(0)), 2000);       // missing [1,2], not done
  ok(rx.tick(2000 + QUIET - 1) === null, 'quiet just under quietMs -> not yet');
  const out = rx.tick(2000 + QUIET);                      // 17000 — well under idleMs 35000
  ok(typ(out) === P.MSG.PROGRESS_Q, 'quiet >= quietMs (and < idleMs) -> PROGRESS_Q — ~20s sooner than the old 35s');
}

// ---- 4. device said done -> actMs fast path (unchanged) ----------------------
{
  const rx = mk();
  rx.onFrame(manifest(), 1000);
  for (let s = 0; s < COUNT; s++) if (s !== 1) rx.onFrame(P.encodeChunk(1, s, chunk(s)), 2000); // missing [1]
  rx.onFrame(P.encodeProgress(1, COUNT, true), 3000);    // progressDone -> known
  ok(rx.tick(3000 + ACT - 1) === null, 'known: waits actMs');
  ok(typ(rx.tick(3000 + ACT)) === P.MSG.REPAIR, 'known (done): acts at actMs -> REPAIR the gap');
}

console.log(`receiver-gate OK: ${pass} assertions passed`);
