---
task: chunk-on-device
status: implemented and verified
source_hash:
  projects/timercam-chunk/src/main.cpp: ec325fa48459301a6a71a9d91d4f94c75071d0d445d81e1e63ca97eaa144ffad
  mylibs/mt-chunk/src/M5CameraSource.h: 9f752ca12b51531260537902e584de82b31071b386b585b9582d5f2305aa73b9
updated: 2026-07-19
scope: projects/timercam-chunk/src/main.cpp, mylibs/mt-chunk/src/M5CameraSource.h
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# Spec: fix the M5 camera I2C proxy — load the TX FIFO from `onReceive`

Implements options **1 + 2** chosen by Peter. Root cause is established in
`specs/m5-camera-i2c.md §5b`; this document only says what changes.

---

## 1. The mechanism, established in Phase 1

Two facts from the framework source, together, explain everything:

**(a) `onRequest` fires after the read has finished** — on classic ESP32 the
read clock-stretch path is `#ifndef CONFIG_IDF_TARGET_ESP32`, so `EVT_TX` is
queued in the `TRANS_COMPLETE` (STOP) branch (`esp32-hal-i2c-slave.c:797`).

**(b) `Wire.write()` in slave mode does not touch the hardware.** It fills a RAM
buffer; `onRequestService` (`Wire.cpp:635`) flushes it via `slaveWrite()` only
*after* `user_onRequest()` returns:

```c
wire->txLength = 0;
wire->user_onRequest();
if (wire->txLength) {
    wire->slaveWrite((uint8_t *)wire->txBuffer, wire->txLength);
}
```

So data written in `onRequest` lands in the FIFO **for the next read**. The
slave is one read behind, and no amount of settling, cursoring or flushing at
the master can change that.

**Why the earlier cursor attempt failed:** the cursor was correct. It staged
`g_out` properly and advanced properly. It simply inherited the same one-read
lag, because it still wrote from `onRequest`. I discarded a working idea for
the wrong reason.

**The fix:** `TwoWire::slaveWrite()` is **public** (`Wire.h:141`) and calls
`i2cSlaveWrite()` directly, writing the hardware TX FIFO with no buffer and no
callback. Called from `onReceive` when the SEEK arrives, the data is in the FIFO
*before* the master's read — eliminating the lag at its source rather than
compensating for it.

---

## 2. Change A — camera stages into the FIFO on SEEK

`projects/timercam-chunk/src/main.cpp`, `onReceive()`, `CMD_SEEK` case.

```diff
             memcpy(g_out, g_fb->buf + off, want);
             g_outLen = want;
             g_cursor = off + want;
         }
+        // Load the HARDWARE TX FIFO now, not in onRequest.
+        //
+        // Wire.write() in slave mode only fills a RAM buffer that
+        // onRequestService flushes AFTER user_onRequest() returns
+        // (Wire.cpp:635), and on classic ESP32 onRequest itself only runs at
+        // STOP of a completed read (esp32-hal-i2c-slave.c:797). Data written
+        // there therefore serves the NEXT read — the one-read lag that made
+        // every chunk contain the previous window.
+        //
+        // slaveWrite() is public and writes i2cSlaveWrite() directly, so the
+        // window is in the FIFO before the master reads it.
+        if (g_outLen)
+            Wire.slaveWrite(g_out, g_outLen);
```

## 3. Change B — offset prefix so misalignment is detectable

Every staged window is prefixed with its 4-byte big-endian offset. 4 bytes per
28-byte payload — **12.5% overhead, and the reason it is worth paying**: a
desynchronised stream currently produces plausible-looking JPEG bytes that fail
CRC only after the whole transfer. With the prefix the master detects it on the
first piece and can resynchronise.

Camera, `CMD_SEEK`:

```diff
-        size_t want = (uint8_t)Wire.read();
-        if (want > CHUNK_DATA_MAX)
-            want = CHUNK_DATA_MAX;
+        size_t want = (uint8_t)Wire.read();
+        if (want > I2C_DATA_PER_PIECE)
+            want = I2C_DATA_PER_PIECE;
...
-            memcpy(g_out, g_fb->buf + off, want);
-            g_outLen = want;
+            // [off:4][data:want] — the master verifies the offset matches what
+            // it asked for, so a lagged or dropped transaction is caught at the
+            // first piece instead of surfacing as a CRC failure minutes later.
+            g_out[0] = (uint8_t)(off >> 24); g_out[1] = (uint8_t)(off >> 16);
+            g_out[2] = (uint8_t)(off >> 8);  g_out[3] = (uint8_t)off;
+            memcpy(g_out + 4, g_fb->buf + off, want);
+            g_outLen = want + 4;
```

New constant beside `CHUNK_DATA_MAX`:

```c
// 28 bytes of payload + 4 bytes of offset = 32, one full TX FIFO on ESP32
// (SOC_I2C_FIFO_LEN). Keeping the whole piece inside the FIFO avoids the
// tx_queue spill path entirely.
static const size_t I2C_OFFSET_PREFIX  = 4;
static const size_t I2C_DATA_PER_PIECE = 28;
```

## 4. Change C — master verifies the prefix

`mylibs/mt-chunk/src/M5CameraSource.h`, `read()`. Replaces the pipelined-seek
experiment (attempt 7, uncommitted and never tested) with a plain
seek-then-read per piece, now that the lag is gone:

```c
static const size_t I2C_OFFSET_PREFIX  = 4;
static const size_t I2C_DATA_PER_PIECE = 28;

size_t read(uint32_t offset, uint8_t *dst, size_t len) override
{
    if (len > CHUNK_DATA_MAX) len = CHUNK_DATA_MAX;
    size_t done = 0;
    while (done < len) {
        size_t want = len - done;
        if (want > I2C_DATA_PER_PIECE) want = I2C_DATA_PER_PIECE;
        const uint32_t off = offset + done;

        if (!seekOnly(off, want)) return 0;

        uint8_t piece[I2C_OFFSET_PREFIX + I2C_DATA_PER_PIECE];
        const size_t expect = want + I2C_OFFSET_PREFIX;
        if (_bus.requestFrom((int)_addr, (int)expect) != expect) return 0;
        size_t n = 0;
        while (_bus.available() && n < expect) piece[n++] = (uint8_t)_bus.read();
        if (n != expect) return 0;

        // The offset the camera says it served must match what we asked for.
        const uint32_t got = ((uint32_t)piece[0] << 24) | ((uint32_t)piece[1] << 16) |
                             ((uint32_t)piece[2] << 8)  |  (uint32_t)piece[3];
        if (got != off) return 0;   // desync — fail loudly, never pad

        memcpy(dst + done, piece + I2C_OFFSET_PREFIX, want);
        done += want;
    }
    return done;
}
```

`seekOnly()` gains a length argument so it stages exactly the piece requested.

## 5. Removed

- the warm-up/throwaway read (attempt 6) — the lag it absorbed no longer exists
- the pipelined seek (attempt 7) — superseded
- `(void)seekOnly(0)` at the end of `refresh()` (attempt 4) — no longer needed
- the auto-advance in `onRequest` — the cursor is retained for `INFO`, but data
  is staged on SEEK; keeping both would reintroduce two writers to `g_out`
- `CMD_SETTLE_MS` stays at 25 ms: the FIFO load is now synchronous with
  `onReceive`, but `onReceive` still runs from a task, so a settle is still
  required. **Reducing it is a separate, measured change — not part of this fix.**

## 6. Files

| file | change |
|---|---|
| `projects/timercam-chunk/src/main.cpp` | stage into FIFO on SEEK; offset prefix; piece constants |
| `mylibs/mt-chunk/src/M5CameraSource.h` | seek-per-piece with length; verify prefix; drop attempts 4/6/7 |
| `specs/m5-camera-i2c-fix.md` | this file |

**NOT changing:** `MtChunk.{h,cpp}` — the chunk protocol is sound and proved
itself on the embedded-image path; `pac-garage-alarm` — no API change; the Node
client; `mt-transport`.

**The camera's I2C debug logging stays** for this round. It is what made the
root cause visible and it should not be removed until the fix is proven.

## 7. Verification

1. **Static** — no `Wire.write` in `onRequest`'s data path; `slaveWrite` present
   in `CMD_SEEK`; prefix constants defined on both sides and equal.
2. **Functional, decisive** — `@336b cam snap`, then `chunk pull 2 0 2`, and
   assert chunk 0 begins `FFD8FFE0`. That was the exact failing observation.
3. **Full path** — fetch the live frame over LoRa and require **CRC match**
   against the camera's own reported CRC. Completeness alone is not a pass.
4. **Regression** — the embedded-image path (pid 1, `publish` not
   `publishSource`) must still transfer and verify; it shares `sendChunk()`.
5. **Camera-side log** — confirm `I2C TX served=` now matches the SEEK that
   preceded it, rather than the one before.

---

## 8. RESULTS — 2026-07-19, all four checks pass

**1. Static.** `Wire.slaveWrite` present in `CMD_SEEK`; the auto-advancing
cursor is gone from `onRequest` (0 references); `I2C_OFFSET_PREFIX = 4` and
`I2C_DATA_PER_PIECE = 28` identical on both sides; no throwaway read, no
pipelining, and every `requestFrom` result checked in `read()`.

**2. The decisive check** — the exact observation that failed for seven attempts:

```
CHUNK idx=0 data=ffd8ffe0     <- JPEG SOI, correct
```

**3. Live camera over LoRa** — the whole chain, camera → I2C → RAK → LoRa → Node:

```
bytes 4753   crc32 6b734197   (camera reported 6b734197)
jpeg  SOI ok / EOI ok
wall  105.7s
```

CRC matches the camera's own computation. Completeness alone was never the pass
criterion; this is.

**4. Regression, embedded-image path** — PASS:

```
bytes 7156 (expect 7156)   crc 65fbd5d9 (expect 65fbd5d9)   wall 151.6s
```

It first appeared to fail, returning the camera's 4,753 bytes when pid 1 was
requested. That was **not** a fault in this fix: publishing the camera frame
evicts pid 1, because `ChunkServer` holds one payload at a time. A reboot
re-publishes the embedded image at boot and the check then passed cleanly,
proving the shared `sendChunk()` path is unaffected.

**But the way it failed exposed a separate defect** — see §9.

---

## 9. DEFECT FOUND BY CHECK 4 — not fixed here, deliberately

Requesting pid 1 returned pid 2's payload **and reported success**. Three
things combine:

1. `@<t> chunk info` carries **no pid** — pid was added to `chunk pull` only.
2. The device answers `sendManifest()` unconditionally, describing whatever
   `_pid` it currently holds.
3. `ChunkClient` sees a different pid in the manifest, **resets and adopts it**.

So a caller can ask for one payload and be silently handed another. The device
should have answered `ERR/GONE`, since pid 1 was evicted.

This is the same class as the corruption just fixed, one layer up: **a wrong
answer that looks like a right one.** The offset prefix now guards the byte
stream; nothing guards payload identity.

Out of scope here (§6 excludes `pac-garage-alarm` and `MtChunk.*`). It gets its
own `/idiot` cycle — it is a distinct defect needing its own verification.

---

## 10. Follow-ups left open (verified present 2026-07-19)

Not defects, but loose ends this change created or left:

1. **Remove the camera's I2C debug logging.** §6 said keep it "until the fix is
   proven". It is proven — the live transfer verified by CRC. It costs a
   `Serial.printf` per transaction in `loop()`.
2. **`M5CameraSource.h:41-45` is a stale comment** describing the pre-root-cause
   theory ("10 ms was NOT enough for the first read after an INFO…"). That was
   the wrong diagnosis; the real one is `specs/m5-camera-i2c.md` §5b. Leaving it
   invites the next reader to re-derive the wrong model.
3. **`CMD_SETTLE_MS` is still 25 ms and may now be far too generous.** The FIFO
   is loaded synchronously in `onReceive`, so the settle only covers the task
   dispatch. Reducing it would speed every chunk — but it is a **measured**
   change, not a guess, and belongs in its own cycle.
4. **The camera's `CHUNK_DATA_MAX` (224) no longer governs staging** —
   `I2C_DATA_PER_PIECE` (28) does, and `g_out` is sized 224 for a 32-byte
   payload. Harmless; confusing.
