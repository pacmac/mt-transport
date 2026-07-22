---
task: chunk-flow-control
status: proposed — design agreed with Peter 2026-07-20, no code yet
priority: HIGH — gates the deployment swap (Peter deferred the swap until chunking is reliable)
updated: 2026-07-20
scope:
  - mylibs/mt-chunk/src/MtChunk.h
  - mylibs/mt-chunk/src/MtChunk.cpp
  - projects/pac-garage-alarm/src/main.cpp
  - projects/mt-transport/clients/node/index.js
  - projects/mt-transport/clients/node/lib/chunk.js
  - projects/mt-transport/clients/node/test/run.js
  - projects/mt-transport/clients/node/test/offline-fetch.js
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# Spec: chunk-flow-control — the device drives the pace

## 1. Why (verified, not speculated)

Layer-A chunk transfer — **pid 1**, the real OV3660 outdoor image already embedded
in nRF **program flash** (`test_image.h`, 7156 B, CRC 0x65FBD5D9), **camera OUT of
the loop** — is intermittent after the async `nonblocking-radio` firmware (v4):

- Measured: **2 of 4** full transfers complete; latency 40 s / 128 s / or timeout
  (24/32) / or the manifest itself times out. High run-to-run variance.
- Feed-verified: the client re-pulls the **correct** range (e.g. `chunk pull 1 16 4`
  ×8, distinct packet_ids), so `requestNext` is not the bug. The device serves 0..N
  then the next range never completes.
- Peter: the RF area is **quiet except our own traffic**. So the loss is *timing*
  between our own pulls/chunks and the **OMNI rebroadcast of our own frames** (each
  frame is re-flooded ~4× over ~10 s at hop_limit 3). The client fires the next
  pull into that self-made storm and it collides.

The client cannot reliably infer when it is safe to pull — duplicates don't change
`received`, and the channel-quiet heuristic I tried is a guess (helped: 2/4, not a
fix). **The device is the only party that knows its own radio state** (TX queue
depth, CAD, when it last sent). So the device should drive the pace.

## 2. Design — device-driven `retry-after` (Peter's design)

A new control frame, **device → client**:

    MSG_BUSY { pid, retry_after_ms }

- On a PULL, if the device is **not ready to serve** — its TX queue is still
  draining a prior batch (`mesh.busy()`), OR less than the configured inter-serve
  gap has elapsed since its last chunk send — it replies **MSG_BUSY{N}** instead of
  serving, where `N` = estimate(remaining TX) + configured margin.
- The **client obeys**: on MSG_BUSY it waits `N` ms, then re-pulls the *same* range.
  It does not guess timing. This replaces the client channel-quiet heuristic entirely.
- **Fallback only:** MSG_BUSY is itself a broadcast that can be lost, so the client
  keeps a bounded fallback timeout — if it hears *nothing* (neither MSG_BUSY nor a
  chunk) within the bound, it re-pulls on its own. The device's word is primary; the
  timeout is the safety net.
- The device also **paces its own consecutive chunk sends** by the configured gap,
  so a served batch is not one dense burst that collides with its own rebroadcast.

Authority + all tuning live on the **device**. The client stays dumb (pull, obey,
fallback). This is the resolution to "one end or both": **device drives, client obeys.**

## 3. Config — device-side, over the mesh (runtime, persisted like name/interval)

- **chunk hop_limit** (default **1**): hop_limit for chunk frames (`g_chunkTx`).
  Safe at 1 because chunks are re-pulled — a chunk OMNI misses is simply re-requested
  (unlike a one-shot reply). Cuts the rebroadcast self-congestion at the source.
- **inter-serve gap `[min, max]` ms**: `min==max` = fixed gap (baseline); `min<max`
  = adaptive — the device raises the advertised `retry_after`/gap toward `max` on its
  own `sendFailures`/CAD deferrals, and eases toward `min` on clean serves. "Start
  fast, throttle on its own trouble" (Peter), computed device-side.
- Command grammar: extend the existing `chunk` command (e.g. `chunk cfg hop <n>`,
  `chunk cfg gap <min> [max]`), persisted in settings. [exact grammar settled in step 2]
- **Pull-command hop_limit is gateway-side** (mesh-gw), NOT here — flagged to
  node-dash in the Q&A; out of scope for this task.

## 4. Wire change (`mt-chunk`, both ends kept in sync)

- `MSG_BUSY` = a new `MSG` enum value (choose a free one; confirm against MtChunk.h).
- Layout: `[type:1][pid:2][retry_after_ms:2]` (5 bytes), big-endian to match the
  existing frames.
- `ChunkServer` (MtChunk.cpp) emits it; `ChunkClient` (chunk.js) decodes it and
  surfaces `retryAfterMs` to `fetch`.
- **Back-compat is free:** peers already drop frames of an unknown type, so an old
  client that never learns MSG_BUSY simply falls back to its own re-pull timeout —
  degraded, not broken.
- Update the cross-impl tests (`test/run.js` decode; `dump_frames`/`cross-cpp.js` if
  they enumerate frame types).

## 5. Client changes (`index.js`, `lib/chunk.js`)

- **Remove** the channel-quiet pacing (`lastFrameAt`/`sinceLastFrame` gate) — superseded.
- `ChunkClient.onFrame`: handle MSG_BUSY → record `retryAfterMs` (+ its pid).
- `fetch`: pull → if a MSG_BUSY came back, wait `retryAfterMs` then re-pull the same
  range; else collect the batch. Keep the bounded fallback timeout, `resume` (seed
  from persisted partial), and the `onProgress`/`deadlineMs` API.

## 6. Test plan — each layer independent (Peter)

- **Layer 0** (OFFLINE, no radio, deterministic) — `test/offline-fetch.js`. The C++
  chunk *protocol* already has an offline harness (`mt-chunk/test/test_chunk.cpp` +
  `fake_transport.h`, passes 50 % loss) but the **JS `fetch` pacing loop** — where
  every failed on-air fix lived — had NONE, so it was only ever exercised on-air
  (flaky, non-deterministic). L0 closes that: a fake ChunkServer (serves MANIFEST +
  CHUNKs for the test image, emits MSG_BUSY on a seeded schedule) behind a FakeLink
  (seeded loss / dup / reorder) drives the REAL `Client.fetch`. Asserts it completes
  and CRC-verifies under loss+BUSY, in ms, repeatably. To keep it fast the fetch
  timing constants (`answerMs`/`batchMs`/`pollMs`/`idleSleepMs`) become **injectable
  opts** with the current radio-tuned values as defaults — on-air behaviour unchanged.
  L0 must be green before flashing for Layer A.
- **Layer A** (pid 1, program flash → mesh → client, **camera OUT**): build the
  device retry-after + client-obey with a **FIXED** gap (`min==max`) first — isolates
  "is the radio/chunking reliable" from "is the adaptation right." Bar: **10/10
  consecutive** full transfers, CRC-verified (the 50 % flakiness needs a high bar).
  Then open the band (adaptive) and tune the gap **down** for speed while staying 10/10.
- **Layer B** (ESP32 → nRF I2C alone): `cam snap` + `cam diag`; previously exonerated.
- **Layer C** (full stack): only after A and B pass.

## 7. Sequencing — NOT one big edit

1. Wire: `MSG_BUSY` in mt-chunk (C++ + JS) + decode tests. Build + unit tests green.
2. Device: ChunkServer emits MSG_BUSY on not-ready (fixed gap) + paces its sends;
   `chunk cfg` command (fixed gap first), persisted. Compile.
3. Client: obey MSG_BUSY; remove channel-quiet; fallback timeout. Unit tests green.
4. Flash bench, verify Layer A **10/10** (fixed gap).
5. Adaptive gap + hop_limit config; tune for speed.
6. Layer B, then C.

Bench unit (`!8cee336b`) only; OMNI `!2687afb1` ch2; remote never touched. FW_VERSION
bumps the moment the build diverges from the deployed unit.

## 8. Relationship to other tasks

Supersedes `camera-fetch-stall` step 3's *client-pacing* approach (the device now
drives). Folds the chunk-specific config from `runtime-config-hops` (hop_limit) into
the device-side config here; the general command-config mechanism can still live in
that task. `nonblocking-radio` (async TX, the reason even Layer A now needs pacing)
is done (steps 2–4); its steps 5–6 remain deferred.
