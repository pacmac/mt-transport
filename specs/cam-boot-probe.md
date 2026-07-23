---
task: cam-boot-probe
status: IMPLEMENTED + OBSERVED 2026-07-23 (fw 2-260723-9) — cam:1 on air; first probe run exposed a camera wedged since 07-22 19:13, revived by reset pulse.
source_hash: ../pac-garage-alarm/src/main.cpp 0b58ed271fa93731105fc734f8bdfc325215a156f6e99f650f87868bfdeb4370
project: pac-garage-alarm
scope:
  - specs/cam-boot-probe.md
  - ../pac-garage-alarm/src/main.cpp
---

# cam=0/1 — camera liveness, probed at boot and tracked live

## Why (Peter, 2026-07-23, morning of the swap)
The likeliest camera failure at the site is a Grove cable knocked loose in
transport; today that is only discoverable by a failed grab. A liveness flag in
`@status` answers "is the camera wired and alive?" remotely in one command.
Camera is powered BY the RAK at the site (Peter), so no battery/BAT_HOLD gating.

## Design — boot probe + LIVE tracking (not boot-only)
- `static bool g_camAlive = false;` (defined unconditionally; only ever set under
  CAM_UART, so a non-camera build honestly reports cam:0).
- Boot probe, setup() right after `Serial1.begin` (CAM_UART only): the raw
  `camu ping` exchange (0x55 → expect 0xAA, the pre-protocol wire test), up to
  2 attempts × 400 ms — the first byte doubles as a wake pulse if the camera
  already idled into sleep; the retry then gets a clean answer. Bounded ≤ ~1 s,
  runs before the WDT starts. `DBG("CAMPROBE: ...")` either way.
- Live updates thereafter (a boot flag goes stale the moment the cable does):
  - `camGrabService()` deadline-blown (the st=255 path) → false.
  - grab completed (publish path) → true.
  - `camu ping` verb → set from the result.
- `@status` gains `{ "cam", jn(g_camAlive ? 1 : 0), JOPT }` in the diagnostics
  tier (before stk/heap; sheds after config echoes under the DM cap).

## Bundled (same flash): stk/heap flip to USED percent
Peter read "free %" as "used %" twice within minutes — the representation was
wrong, not the reader. Both fields become USED: stk = peak stack usage since
boot (% of 4096), heap = heap used (% of total). High = bad, matching every
dashboard convention. HB line and status field both flip; spec
serial-heartbeat.md gets a correction note.

## Verify
1. Boot with camera attached: `CAMPROBE` OK on serial, status shows `cam:1`.
2. stk/heap read as used% (stk ~59-80 after a PKC reply, heap ~6).
3. Regression: `cam grab` still works and leaves cam:1; `camu ping` agrees.
   (Unplugged-cable case: DEFERRED to the bench after the swap-return — not
   unplugging the only camera's cable right before deployment; the code path is
   the same probe that proves the attached case.)
