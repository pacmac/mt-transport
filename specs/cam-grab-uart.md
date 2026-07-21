---
task: cam-grab-uart
status: IMPLEMENTED + VERIFIED ON AIR 2026-07-21 (fw 260721-3). cam grab captured a real
        frame over UART (pid 7869, len 3034, 14 chunks), published to the push engine, and
        a full push completed CRC-verified — saved payloads/336b/pid-7869.jpg, valid JPEG
        (SOI+EOI). Old I2C st=2/len=0 path gone (retained under #else for the non-UART build).
priority: HIGH — the camera cannot be captured from the dashboard until this lands
updated: 2026-07-21
scope:
  - pac-garage-alarm/src/main.cpp   # the `cam grab` branch ONLY
source_hash:
  pac-garage-alarm/src/main.cpp: 234684e46ba3de8bf1d26cf08cb31b950b4f9a1b7089f3f5c8ab2c83d3cdae32
---

# cam grab: capture over UART, not the dead I2C driver

## Problem (verified root cause)

The camera was rewired from I2C to UART this session. `cam grab`
(`pac-garage-alarm/src/main.cpp:1634`) still drives the **I2C** `M5CameraSource g_cam`
(`main.cpp:314`; `mylibs/mt-chunk/src/M5CameraSource.h`, `Wire` addr `0x62`). With no
camera on the RAK I2C bus, `capture()` gets no ACK on its first byte
(`M5CameraSource.h:89-90`) and returns `false`; the handler then reports the driver's
**untouched defaults** `_status = ST_NOFRAME (2)` and `_len = 0`. So the observed
`{"type":"err","msg":"cam grab","st":2,"len":0}` means "no I2C device", not "no frame".

Wire evidence (read-only, 2026-07-21):

| link | probe | result |
|---|---|---|
| UART | `camu ping` / `camu cap` | `AA` / `st=1 len=3329` (real frame) — **alive** |
| I2C  | `cam info`               | `st=2 len=0 ok=false` — **dead** |

Not intermittent: a clean before/after the physical rewire. Pre-rewire I2C grabs
(59128/44456/55366) succeeded; every post-rewire grab fails.

## Fix

Give the `cam grab` branch a **UART capture path** under `#ifdef CAM_UART`, keeping the
existing I2C body under `#else` for the non-UART build. All primitives already exist:

- **nRF (this file):** `camuSend(p,n)` / `camuRecv(out,cap,toMs)` framed transport
  (`main.cpp:362-389`); `CMD_CAPTURE (0x02)` reply parse already done by `camu cap`
  (`main.cpp:1548-1559`); `mtchunkpush::crc32` (used by the I2C path at `main.cpp:1673`);
  `camPidFromCrc` (`main.cpp:338`); `g_camBuf`/`g_camLen`/`g_camCrc`/`CAM_BUF_MAX`
  (`main.cpp:327-330`); `g_push.publish` / `chunkCount` / `uploadState`.
- **camera (`timercam-chunk`, already flashed):** `uartDispatch` serves
  `CMD_CAPTURE (0x02)` — captures, pushes to queue, **SELECTs** it, deferred 9-byte
  `{st,len,crc}` reply from `loop()`; `CMD_SEEK (0x03)` `[off:4][n:1]` → `[off:4][data]`,
  `UART_SEEK_MAX = 200` B/window, read-past-end returns bare `[off:4]` (short read);
  `CMD_SLEEP (0x04)`.

### Flow (UART path)

1. Flush stale RX (`while (Serial1.available()) Serial1.read();`).
2. `CMD_CAPTURE`; `camuRecv(info, .., 3000)`. Require `rn >= 9 && info[0] == 1 (ST_READY)`;
   else emit the existing error shape with `st = info[0]` (or 255 on timeout), `len = 0`.
3. Parse `len` = `info[1..4]` BE, `ccrc` = `info[5..8]` BE. Reject `len == 0 || len > CAM_BUF_MAX`.
4. **SEEK loop** into `g_camBuf`, `got` from 0 to `len`, `want = min(len-got, 200)`:
   send `[0x03, off>>24, off>>16, off>>8, off, (uint8_t)want]`; `camuRecv(win, .., 500)`;
   require `wn == 4 + want` **and** the echoed offset `win[0..3] == got` (desync guard,
   same contract as the I2C `read()` offset check); `memcpy(g_camBuf+got, win+4, want)`.
   Any failure → `readOk = false`, break.
5. `crc = readOk ? mtchunkpush::crc32(g_camBuf, len) : 0`; `good = readOk && crc == ccrc`.
6. `CMD_SLEEP` (camera OFF from here — **always**, success or fail, mirroring the I2C path).
7. On `!good`: existing `{"type":"err","msg":"grab crc",...}` shape. On success:
   `g_camLen = len; g_camCrc = crc; long pid = camPidFromCrc(crc); sscanf(a+4,"%ld",&pid);`
   (keep the optional pid override the I2C path has), `g_push.publish((uint16_t)pid,
   mtchunkpush::PT_IMAGE, g_camBuf, g_camLen)`, then the existing success reply.

### Reply shapes — UNCHANGED (node-dash parses these; must not drift)

- success: `{"type":"grab","pid":%ld,"len":%lu,"n":%u,"crc":"%08lX","cam":"asleep","upst":%u}`
- capture fail: `{"type":"err","msg":"cam grab","st":%u,"len":%lu,"max":%lu}`
- crc fail: `{"type":"err","msg":"grab crc","got":%lu,"len":%lu,"crc":"%08lX","want":"%08lX"}`

## Exact edit

**One hunk**, the `else if (!strncasecmp(a, "grab", 4))` block at `main.cpp:1634-1702`.
Wrap the new UART implementation in `#ifdef CAM_UART` and move the current I2C body verbatim
into the `#else`. No other lines change. No new globals, no new helpers, no library change.

## Out of scope (named deliberately)

- **`cam snap` (`main.cpp:1585`)** — also I2C, also dead on UART wiring. Left as-is: it
  publishes to the PULL engine (`g_chunks`), and node-dash removed the pull path
  (`transport-adapter.js:98` "Pull … removed entirely"). No consumer, so no fix. It will
  keep returning st=2 on UART; harmless because nothing calls it.
- The I2C `M5CameraSource` and `mt-chunk` library — untouched.
- `pir-image-pipeline` (587) — this is a prerequisite slice of its §7, not the whole pipeline.

## Verification (Phase 4)

- **Static:** grep the grab branch shows the `#ifdef CAM_UART` UART path + intact `#else`.
- **Functional (on bench, fw bumped):** `@336b cam grab` → `{"type":"grab","pid":<hash>,
  "len":<~2-3k>,"n":<chunks>,"crc":"<HEX8>","cam":"asleep","upst":1}` with pid != 1 and a
  DIFFERENT pid after re-aiming the camera; then `push stat` shows `up = that pid`; then a
  full push completes CRC-verified (reuse the proven push path).
- **Regression:** `camu ping`/`camu count`/`camu cap` still answer (shared Serial1 framing
  not disturbed); a push of an existing pid still works.

## Risks

- **Field-flash-expensive firmware.** Bench-only fix, but bump `FW_VERSION` and validate
  fully before any field flash. Field unit `!987ab80f` untouched. Not gated by deployment
  (the bench is the flash target).
- ~17 SEEK round-trips for a 3329-byte frame at 500 ms each — confirm total capture stays
  within a few seconds and `camuRecv` is robust across that many windows.
- Serial1 is shared with `camu *` and (in this build) is the camera link only — no DBG
  mirror to corrupt (already handled by the CAM_UART guard).
