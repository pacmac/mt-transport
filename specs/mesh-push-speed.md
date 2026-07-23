---
task: mesh-push-speed
status: IMPLEMENTED + VERIFIED 2026-07-23. Offline receiver-gate 10 + images 17 + full regression green. LIVE b80f before/after: time-to-first-PROGRESS_Q after the stream went quiet dropped +35s→+15s (the causal gate-split result); total 252s→170s (partly loss-variance: 1 vs 2 lost chunks), well under node-dash's 222s baseline; CRC 0x65FBD5D9 verified both runs. Streaming floor ~126s unchanged (firmware). 336b (deployed) DEFERRED — 41910 field campaign active, no contention. Firmware floor + end-of-pass signal = separate tasks.
source_hash: clients/mesh/lib/push-receiver.js 0047bd7b7ef616b15ccdb33044e46786b05bd9f83fa521e4ca145d8aea4bda7c; clients/mesh/lib/images.js 947943175b02818be9ae6ddc14f3c7c48cd2d985372833089600f844ac31f9b1; clients/mesh/lib/settings.js 77120d56a354ba9ca9b7d7c2e8cfbe2222f3b5cb03d92683b1a4657df4482b96; clients/mesh/config.yaml 5f828f1cfa633ab6ba6a10604883987ab728835a8274a79854520b16b2179567; clients/mesh/test/receiver-gate.js 4a3f8d20a08217a909d0112e15f2c40727531745fa79f9420e34775a61d8d554; clients/mesh/test/images.js c067d824d0df8faa74860c3f275b0ad807de45f8f8404837fc5b85f717200041
project: mt-transport
scope:
  - specs/mesh-push-speed.md
  - clients/mesh/lib/push-receiver.js   # three-way idle gate + quietMs param
  - clients/mesh/lib/images.js          # pass pushQuietMs through
  - clients/mesh/lib/settings.js        # timing.pushQuietMs default
  - clients/mesh/config.yaml            # document the knob
  - clients/mesh/test/receiver-gate.js  # NEW — explicit-clock gate tests
  - clients/mesh/test/images.js         # thread pushQuietMs into the sim (the new gate now governs its query path)
---

# mesh-push-speed (client) — split the idle gate, cut the post-stream tail

## Evidence (Phase 1, clean run b80f pid1, 32 chunks / 7156 B, 2026-07-23)
Total 252s: stat→START 4.7s · **streaming 30/32 ≈ 130s** (firmware-paced, avg
4.3s/chunk, **max steady inter-chunk gap 9s**, 2 lost) · **idle/query tail ≈ 100s**
· repair+complete 17s. The tail was TWO full 35s `idleMs` waits (the first
`PROGRESS_Q` got no reply). `idleMs=35s` is ~4× the device's real post-stream need.

The deployed unit (336b, marginal) can't be reflashed soon, so the CLIENT tail is
the only lever that helps it — and on a lossy link the tail is worse (more repair
rounds, each currently gated by 35s). This change is exactly that lever.

## Root cause
`push-receiver.js` `tick()` uses ONE `idleMs` (35s) for two different waits:
1. **awaiting the stream to begin** (no manifest yet) — must stay patient: the
   device needs ~17–21s to capture/prepare, and a short wait would resend START
   before the first chunk (a duplicate START can restart the device's stream).
2. **stream fell quiet, transfer incomplete, device hasn't said done** — here 35s
   is dead airtime: the device streams every few seconds, so once >~10s of true
   silence passes, the stream is over and we should query NOW.

The existing `known` fast-path (actMs=4s) only kicks in AFTER a `PROGRESS{done}`
arrives — which needs the first `PROGRESS_Q`, which is gated by the slow 35s.

## The change — a three-way gate (push-receiver.js)
Add a `quietMs` constructor param (default 15000). In `tick()` replace:
```js
const known = this.manifest && (this.progressDone || this.missing().length === 0);
const gate = known ? this.actMs : this.idleMs;
```
with:
```js
// Three-way gate. The old single idleMs conflated "waiting for the stream to
// start" with "stream fell quiet, go query" — the latter cost 2×35s on a transfer
// missing 2 of 32 (measured). Split them:
//   known (device said done / we hold all) -> actMs  : act at once
//   have manifest, stream quiet, not done  -> quietMs: query soon (measured max
//        inter-chunk gap 9s, so 15s clears streaming with margin, vs 35s dead air)
//   no manifest yet (awaiting START/stream)-> idleMs : stay patient (a short wait
//        resends START before the device's ~20s prepare and can restart its stream)
const known = this.manifest && (this.progressDone || this.missing().length === 0);
const gate = known ? this.actMs : (this.manifest ? this.quietMs : this.idleMs);
```
Constructor: `constructor(pid, { idleMs = 8000, maxStale = 8, maxUnanswered = 30,
actMs = 4000, quietMs = 15000 } = {})` → `this.quietMs = quietMs;`

Ordering invariant (comment it): `actMs (4s) < quietMs (15s) < idleMs (35s)`.
`quietMs` MUST stay comfortably above the device's max inter-chunk gap or we query
mid-stream. A premature query is only *wasted airtime*, never wrong: it can't
trigger a premature REPAIR (repair still gates on `progressDone`), so 15s is a
safe, deliberately-conservative floor (6s margin over the measured 9s).

This is an INTENTIONAL divergence from clients/node/lib/push-receiver.js (the
retrospective copy). node-dash's own comment flagged this exact tail as pending
("when mt-transport lands that, runs get shorter"). Not a simplification — a gate
added, every existing constant/comment kept.

## Wiring
- **images.js** `_startTransfer`: `new PushReceiver(pid, { idleMs, actMs: T.pushActMs,
  quietMs: T.pushQuietMs })` (undefined → receiver default 15000).
- **settings.js** DEFAULTS.timing: add `pushQuietMs: 15000`.
- **config.yaml** timing block: document `pushQuietMs: 15000  # post-stream quiet
  wait before PROGRESS_Q (must exceed the device's max inter-chunk gap ~9s)`.

## NOT in scope (separate tasks — Peter: "go after the floor too")
- Firmware **unsolicited PROGRESS{done}** at end-of-pass (kills the FIRST wait too,
  −~15s more). Firmware project, own /idiot task, validated on bench b80f.
- Firmware **inter-chunk pacing** (the ~130s streaming floor — the real prize).
  TX-pacing/CSMA territory (adopt-meshtastic-csma / nonblocking-radio) — delicate,
  own investigation, must not regress the self-deafness class of bugs.
- Neither reaches the deployed 336b without a field flash; this client change does.

## Verify (Observe)
1. **Offline gate unit test** (test/receiver-gate.js, explicit `nowMs` clocks, no
   radio): with a manifest present and chunks flowing, a gap < quietMs → `tick()`
   returns null (no mid-stream query); a quiet period ≥ quietMs but < idleMs →
   `tick()` returns a `PROGRESS_Q` (the win); with NO manifest, a wait ≥ quietMs
   but < idleMs → `tick()` returns null, and only ≥ idleMs → a START resend
   (startup patience preserved). Assert `actMs < quietMs < idleMs`.
2. **Regression**: test/images.js (closed-loop get + autonomous + resume), skeleton,
   transport, log, settings, cli-live, daemon all green; `require('..')` clean.
3. **LIVE before/after, b80f (clean control)**: re-run the Phase-1 instrumented
   transfer; confirm the tail drops from ~2×35s to ~2×15s and total lands < 222s
   (node-dash baseline). CRC must match 0x65FBD5D9.
4. **LIVE deployed 336b (the point)**: IF the 41910 field campaign is idle and the
   link is up (evening/cooler), one instrumented fetch to show the marginal-link
   benefit (more repair rounds × 20s saved each). Do NOT contend with the running
   campaign; note DEFERRED if it's active.
