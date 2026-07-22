---
task: strip-cam-i2c
status: SPEC 2026-07-22 — remove the I2C camera transport entirely. One transport: UART.
priority: foot-gun removal — a second build env is what cost a full day on the RAK side
source_hash: src/main.cpp 1541be13384ce6662eabef1ebdb5274004657e37aeba8d23de5f049d5f29b1aa; platformio.ini 01f204f82df9f3f31f212f638ca138211e6ad95a44fc4cef671cec6172816995
project: timercam-chunk
scope:
  - (timercam-chunk) src/main.cpp        # delete I2C slave block + all CAM_UART #ifdefs
  - (timercam-chunk) platformio.ini      # collapse two envs to one
---

# There is one camera transport: UART. Delete the other one.

## Why (Peter, 2026-07-22)
> "so why did you just say: timercam I2C environment - because you will say that again and then
> start re-programming it with I2C wont you"

Correct, and that is the whole justification. The danger is not the dead code itself, it is that
a **second build environment reads as a legitimate option**. On the RAK side that exact shape —
`rak4631` beside `rak4631_camuart` — meant a bare `pio run -t upload` silently flashed the wrong
build and mirrored debug output into the camera's UART. That cost a full day on 2026-07-22 and
was fixed by Peter's instruction: *"both branches, there are no 2 branches there is 1 branch.
strip out the IFDEF"*. The same instruction applies here.

The camera has been on UART since 2026-07-21 and always will be (*"CAM_UART is connected and
always will be"*). An option that can only ever be chosen by mistake is not an option.

## It is already dead — and provably so
`[env:timercam]` **does not compile**: `s_adcChars` is defined inside the `#ifdef CAM_UART`
block (src/main.cpp:582) but used unconditionally in `setup()` (line 696) —
`error: 's_adcChars' was not declared in this scope`. Verified pre-existing against a stashed
tree, so it broke when the UART work landed and nobody has built it since. Keeping a build that
cannot build is strictly worse than not having it.

## Changes — src/main.cpp
1. **Delete the I2C slave block, lines 382–531**: `buildInfo()`, `onReceive()`, `onRequest()`.
   Confirmed safe: the UART path stages into its own `g_ub` (line 258) via `uartDispatch()` and
   never calls `buildInfo()` or touches `g_out`. The two paths share only the transport-
   independent queue helpers (`selected()`, `dropById()`, `captureToQueue()`), which stay.
2. **Delete the I2C state and constants**: `#include <Wire.h>` (39), `I2C_ADDR` (81),
   `g_out`/`g_outLen` (128–129), `I2C_MAX_SERVE`, `I2C_OFFSET_PREFIX`, and the `static_assert`
   on `I2C_MAX_SERVE` (133).
3. **Make the UART path unconditional** — remove every `#ifdef CAM_UART` / `#else` / `#endif`
   pair at 246/280, 576/678, 713/719/725, 808/810, 822/826, keeping the UART half each time.
   The `#ifndef CAM_UART_RX/TX` pin defaults stay: those are overridable wiring config, not a
   transport switch.
4. **`setup()`**: keep `Serial1.begin(...)`, drop the `#else` `Wire.begin()` / `Wire.onReceive()`
   / `Wire.onRequest()` half.
5. **`goToSleep()`**: drop `Wire.end()` — nothing to end.

## Changes — platformio.ini
Collapse to a **single** `[env:timercam]`, with the UART pin defaults folded in and `-DCAM_UART`
gone (the code no longer tests it). One env means `pio run -t upload` cannot pick the wrong
build — the failure mode is removed structurally, not by remembering a flag.
`upload_port`/`monitor_port` stay pinned to the by-id path: that guard is about flashing the
wrong *board*, which is a different (and still live) hazard.

## Follow-on, NOT in this task
- The ~20 spec files and 3 memory files that still present I2C as current. They are a separate
  pass (destructive, and the historical design records deserve archiving rather than deletion) —
  see the "Spec and memory sweep" note on the task.
- `pac-garage-alarm` is untouched. Its `camuSend()` wake-byte gap is reported in
  [[cam-sleep-assert]] and is its own task.

## Test
- `pio run` builds ONE env, SUCCESS, with no `CAM_UART` in the flags.
- `grep -c "Wire\.\|I2C\|CAM_UART" src/main.cpp` → only the `CAM_UART_RX/TX` pin defines remain.
- Functional proof deferred: the TimerCam's USB is disconnected (Peter removed it deliberately
  on 2026-07-22 after it was flashed with nRF firmware by mistake), so this cannot be flashed or
  run on hardware until it is plugged back in. Build-only verification until then.
