---
task: cam-grab-async
status: IMPLEMENTED + VERIFIED ON AIR 2026-07-21 (fw 260721-9). Grab is now a loop()-driven
        state machine: no delay() and no blocking read in the grab path (0 `delay(` in the
        block); it advances when the camera replies, bounded by millis() deadlines.
        RESULT: cold grabs (camera asleep, NO preceding ping) succeed — pid 23791 first,
        then 39531 + 44851 back-to-back. Before the fix: 0/2 repeats. A 3rd grab in one run
        drew no reply, consistent with the standing ~17% link loss but NOT proven; call it
        2/3 in that run, not "100%".
        NOTE two self-inflicted detours recorded so they are not repeated: (a) an early build
        went SILENT on repeats (machine never terminated) — fixed by draining stale frames;
        (b) adding a 600 ms time-based grace window then ATE the real capture reply when the
        capture was fast, producing st=255 while the camera LED showed it HAD captured. The
        LED observation is what pinpointed it. camuFlush() after CMD_CAPTURE is sufficient;
        do NOT add a timed discard window.
priority: HIGH — cold grabs fail; and the grab blocks loop() for seconds
updated: 2026-07-21
scope:
  - pac-garage-alarm/src/main.cpp
source_hash:
  pac-garage-alarm/src/main.cpp: f30a2efa18f9974697a738a3d962d6ffbc08f32bac0f25184d9872797a7e3b0d
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# cam grab: non-blocking state machine

## Problem
Two defects in the same code path.

1. **Fixed-delay wake is wrong.** The wake step sends a byte then `delay(1500)`. A deep-sleep
   wake *reboots* the ESP32 into `setup()`, which re-runs `cameraInit()` — that can exceed
   1500 ms, so `CMD_CAPTURE` lands mid-boot, is dropped, and the grab returns `st=255`.
   Observed live: two cold grabs failed; a grab 4 s after a `camu ping` succeeded (pid 61467).
   That is the signature of too short a settle — **not** a missing wake. `cam grab` already
   auto-wakes; a caller must never have to wake the camera manually.
2. **It blocks, and this project does not block.** `delay(1500)` blocks; and the grab was
   *already* blocking — `camuRecv()` blocks up to 3 s for the capture reply, and the SEEK loop
   does ~16-17 further blocking reads at 500 ms each. A grab holds `loop()` for seconds.
   Replacing the delay with a *polling wait* would be just as wrong.

## Fix: advance on reply, never wait

### A. `camuPoll()` — non-blocking frame reader
Replaces blocking `camuRecv()` for the grab path. Drains whatever `Serial1.available()` has and
assembles `[7E][len][payload][crc16]` **across `loop()` calls** in a small static state:

```c
// returns: >0 = payload len of a complete valid frame (in g_camuFrame)
//           0 = nothing complete yet (never waits)
//          -1 = frame completed but CRC failed
static int camuPoll();
```
State: `hunt SOF -> len -> payload -> crc`. No `millis()` loops, no `readBytes()`, no waiting.

### B. Grab state machine, driven from `loop()`
```
GS_IDLE
GS_WAIT_READY   // retry CMD_INFO on an interval until the camera answers (covers reboot+cameraInit)
GS_CAPTURE      // send CMD_CAPTURE once
GS_WAIT_INFO    // await the 9/11-byte {st,len,crc[,batt]} reply
GS_SEEK         // send CMD_SEEK(got, want) for the next window
GS_WAIT_SEEK    // await [off:4][data]; verify echoed offset; copy; got += want
GS_DONE / GS_FAIL
```
- Every timeout is a **`millis()` deadline** compared each pass — never a `delay()`.
- `GS_WAIT_READY` re-sends `CMD_INFO` every ~300 ms until a reply arrives, bounded by an overall
  deadline (~8 s). This is what makes a cold grab work regardless of boot time.
- One SEEK window per pass; the loop keeps running between windows.

### C. Command + reply
- `cam grab` **starts** the machine and returns immediately (`reply[0] = 0`, no text reply yet).
  It saves `rx.id` so the eventual grab JSON is sent via `sendText(msg, savedRxId)` — **`reply_id`
  correlation is preserved** for node-dash.
- Reply shapes UNCHANGED: success `{"type":"grab","pid":..,"len":..,"n":..,"crc":..,"bat":..,"cam":"asleep","upst":..}`;
  failures keep the existing `{"type":"err","msg":"cam grab"...}` / `{"msg":"grab crc"...}` shapes.
- On DONE **and** FAIL: send `CMD_SLEEP`, emit the JSON, return to `GS_IDLE`.

### D. Concurrency
- A second `cam grab` while one is in flight -> immediate `{"type":"err","msg":"grab busy"}`.
- `camu ping|count|cap` (blocking bench scaffolding, left as-is) is **rejected while a grab is in
  flight** — they share Serial1 and a blocking read would steal the machine's bytes.

## Out of scope
- `camu ping|count|cap` stay blocking (bench test scaffolding, not a product path) — only guarded.
- The I2C `#else` grab path is untouched.

## Verification (Phase 4)
- **Static:** no `delay(` in the grab path; `camuPoll()` present; state machine advanced from `loop()`.
- **Functional (the acceptance test):** leave the camera asleep (a prior grab ends with `CMD_SLEEP`),
  then issue **one** `cam grab` with **no preceding `camu ping`** -> it must return a real
  `{"type":"grab","pid":<hash>,...}` first time. Repeat twice more back-to-back.
- **Non-blocking evidence:** the unit keeps answering other traffic (e.g. `status`) while a grab is
  mid-flight, which the old blocking version could not do.
- **Regression:** push of the grabbed pid still completes; `camu` verbs still work when idle.

## Risks
- Bench flash (field unit `!987ab80f` untouched).
- The deferred grab reply changes reply TIMING (arrives seconds later, not inline). `reply_id` is
  preserved so correlation is unaffected; node-dash already treats grab as best-effort with a retry.
