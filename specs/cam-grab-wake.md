---
task: cam-grab-wake
status: IMPLEMENTED + VERIFIED ON AIR 2026-07-21 (fw 260721-4). Acceptance test passed:
        two CONSECUTIVE cam grabs both returned real pids (19767, then 39662 on a camera
        left asleep by the first) — no st=255. Take-photo works every press.
priority: HIGH — the dashboard Take-photo button fails (st=255) on the 2nd+ press until this lands
updated: 2026-07-21
scope:
  - pac-garage-alarm/src/main.cpp   # the `cam grab` UART path ONLY
source_hash:
  pac-garage-alarm/src/main.cpp: 2d68de1e5e9bc46f2c2cea3719ce8b75cffe68045a9f73c55764a1995221cfec
---

# cam grab: wake the sleeping camera over UART before capturing

## Problem
`cam grab` (task cam-grab-uart, committed 0032132, fw 260721-3) works only on an
already-awake camera. It ends with `CMD_SLEEP` (`cam:"asleep"`), so the NEXT grab hits a
sleeping camera: `CMD_CAPTURE` gets no reply and the grab returns `st=255` (the timeout
sentinel). node-dash's Take-photo button therefore works once per wake, then times out —
observed on air: first press → pid 7869; next press → `{"type":"err","msg":"cam grab","st":255,...}`.

## Root cause (confirmed, code + live test)
- Camera sleeps after each grab. Wake is `ext0` on `PIN_GROVE_SCL` (timercam-chunk:513),
  wake-on-LOW — and that pin **is** `CAM_UART_RX` (G13). So a UART byte's start bit wakes it.
- The waking byte is lost: deep sleep (`g_qn==0`) reboots into `setup()` (~1.2 s); light
  sleep (`g_qn>0`, i.e. holding a grabbed image — our usual case) resumes fast. Either way
  the byte that woke it is not delivered to the app.
- The camera firmware documents the intended handshake (timercam-chunk:529-530):
  *"the nRF sends a throwaway wake byte then the real command (nRF-side, a later cycle)."*
- Live test on the sleeping camera: wake pulse → ~2 s settle → `camu ping` = `AA`. Works.

## Fix (nRF-side only)
In the `cam grab` `#ifdef CAM_UART` path (pac-garage-alarm/src/main.cpp), BEFORE the existing
flush + `CMD_CAPTURE`, add a wake step:

```c
// Wake the camera: it sleeps after each grab, and its ext0 wake pin IS the UART RX
// line — so a throwaway byte wakes it, but that byte is lost (deep sleep reboots into
// setup() ~1.2 s; light sleep resumes). Send it, let the camera boot/resume, THEN flush
// and capture. Camera firmware documents this handshake (timercam-chunk goToSleep()).
Serial1.write((uint8_t)0x00);   // wake pulse: start bit pulls RX low -> ext0 (no 0x55->AA echo)
delay(1500);                    // cover a deep-sleep reboot (~1.2 s) + margin
// (existing) flush stale/boot bytes, then CMD_CAPTURE — unchanged below
```

The existing `while (Serial1.available()) Serial1.read();` flush and everything after it stay
exactly as they are. This is the only addition.

## Exact edit
One insertion of 2 statements (+ comment) at the top of the `cam grab` `#ifdef CAM_UART`
block, immediately before the existing `while (Serial1.available()) Serial1.read();`. No other
lines change. No new globals/helpers. The `#else` I2C path is untouched (its `g_cam.wake()`
already does the equivalent).

## Cost / trade-off
Adds ~1.5 s to every `cam grab` (a one-time wake latency; capture + SEEK loop is on top).
Acceptable for a user-triggered "take photo". Could later be shortened by detecting light-
vs-deep sleep, but a fixed 1.5 s is correct and simple, and a grab already takes seconds.

## Verification (Phase 4)
- **Static:** the wake write + delay appear before the flush in the grab UART path.
- **Functional (bench, fw bumped):** with the camera ASLEEP (e.g. right after a prior grab),
  `@336b cam grab` returns a real `{"type":"grab","pid":<hash>,...}` — NOT st=255. Then a
  SECOND consecutive `cam grab` (camera left asleep by the first) ALSO returns a real pid.
  That is the acceptance test: two back-to-back grabs both succeed.
- **Regression:** a grab on an already-awake camera still works; `camu ping/cap` unaffected.

## Risks
- Field-flash-expensive firmware: bump `FW_VERSION`, validate on the bench; field unit
  `!987ab80f` untouched.
- 1.5 s may be marginal if a future camera build has a slower boot — if a cold (deep-sleep)
  grab ever returns st=255, raise the delay; it is the one tunable here.
