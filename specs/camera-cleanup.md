---
task: camera-cleanup
status: proposed
source_hash: ~
updated: 2026-07-19
scope:
  - projects/timercam-chunk/src/main.cpp
  - mylibs/mt-chunk/src/M5CameraSource.h
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# Spec: camera-cleanup — retire the diagnostic scaffolding now the fix is proven

Three loose ends left by the I2C fix, all recorded in
`specs/m5-camera-i2c-fix.md` §10 and re-verified present 2026-07-19. None is a
defect; all three make the next reader's job harder, and one actively teaches a
diagnosis that is **known wrong**.

The fix is now proven twice over: a live camera frame transferred over LoRa and
CRC-matched the camera's own computation (4,921 B, `1a9b4854`), after an
independent embedded-image verification (7,156 B, `65fbd5d9`).

---

## 1. Remove the I2C debug logging (`timercam-chunk/src/main.cpp`)

`loop()` prints a line per I2C transaction from ten `volatile` globals
(`g_dbgSeq`, `g_dbgCmd`, `g_dbgN`, `g_dbgOff`, `g_dbgWant`, `g_dbgStaged`,
`g_dbgFirst[4]`, `g_reqSeq`, `g_reqLen`, `g_reqFirst[4]`), populated inside the
I2C callbacks at lines 246, 299-301 and 321-323.

`m5-camera-i2c-fix.md` §6 said keep it *"until the fix is proven"*. It is proven.

**This was the measurement that actually solved the bug** — logging from the
camera's own side explained in one run what four master-side guesses could not.
It is being removed because it has done its job, not because it was wasteful.
The technique is recorded in `m5-camera-i2c.md` §2 so it can be reinstated.

Remove the `loop()` reporting block, the globals, and their assignments in the
callbacks. Writing to `volatile`s inside an ISR-adjacent callback on every
transaction is not free, and the `Serial.printf` per transaction is real cost on
a path that runs 22+ times per frame.

## 2. Correct the stale comment (`M5CameraSource.h:41-45`)

Five lines describe the **disproven** theory:

> *"10 ms was NOT enough for the first read after an INFO: the ESP32 had not
> processed the SEEK, so onRequest served the stale INFO reply…"*

That is the model that produced seven failed fixes. The real cause
(`m5-camera-i2c.md` §5b): on classic ESP32 the read clock-stretch path is
compiled out, so `onRequest` runs at STOP of an already-finished read, and
`Wire.write()` in slave mode only fills a RAM buffer flushed *after* the
callback returns — the slave was structurally one read behind, and **no
master-side timing change could ever have worked**.

Replace with the actual cause and point at §5b. Leaving it invites the next
reader to re-derive the wrong model and repeat the same seven attempts — which
is exactly how this bug consumed a session.

Note `CMD_SETTLE_MS` (25 ms) is **left alone**: reducing it is a measured
change and gets its own cycle (`m5-camera-i2c-fix.md` §10.3).

## 3. Right-size `g_out` (`timercam-chunk/src/main.cpp:114`)

`g_out` is `uint8_t[CHUNK_DATA_MAX]` = **224 bytes**. Nothing writes more than
32 into it any more:

- chunk data: `I2C_OFFSET_PREFIX (4) + I2C_DATA_PER_PIECE (28)` = 32 (line 281)
- INFO reply: 9 bytes (line 225)

`want` is clamped to `I2C_DATA_PER_PIECE` at line 265 before the `memcpy`, so
224 has been dead headroom since the fix. Size it by what actually writes into
it and add a compile-time assertion so the relationship is enforced rather than
described.

`CHUNK_DATA_MAX` **stays** — it documents protocol agreement with
`mtchunk::CHUNK_DATA_MAX` (line 92-94) and must not silently drift. It simply
stops being the thing that sizes this buffer.

---

## 4. Not in scope

- `CMD_SETTLE_MS` reduction — measured change, own cycle.
- Anything in `pac-garage-alarm` or `MtChunk.{h,cpp}`.
- The missing `cam` verb in `lib/commands.js` — parked to `bugs-enhancements`.

## 5. Verification

Cosmetic changes can still break a build or a wire format, so:

1. Both firmwares compile.
2. Camera flashed, boots (`=== timercam-chunk ===`, I2C slave `0x62` up).
3. **A live camera frame fetches over LoRa and CRC-matches the camera's own
   value.** This is the only check that proves the I2C staging still works after
   touching the buffer that staging writes into. A CRC match, not "an image
   arrived".

Hardware: DEV1 `!8cee336b` on the bench. Field unit `!987ab80f` never touched.
OMNI `!2687afb1`, channel 2 (Private) only.
The camera can be reset in software by pulsing DTR/RTS on `/dev/ttyUSB0` — no
cable handling needed.
