---
task: camera-fetch-stall
status: investigated — mechanism established, root cause NOT yet measured
source_hash: ~
updated: 2026-07-19
scope:
  - mylibs/mt-chunk/src/M5CameraSource.h
  - projects/pac-garage-alarm/src/main.cpp   # branch chunk-integration — only if a debug command is needed to surface the instrument
---

# Spec: camera-fetch-stall — a proxied chunk fetch stalls partway

## 1. Symptom

A full fetch of a **camera-sourced** payload stalls before completing. The
embedded-image payload (served from flash) transfers fully and CRC-matches; the
camera payload does not.

Observed 2026-07-19, all via OMNI on channel 2, DEV1 on the bench:

```
18:43 baseline  camera fetch -> CRC failed after reassembly
19:09 baseline  camera fetch -> PASS 4921 B crc 1a9b4854
19:16 cleanup   camera fetch -> stalled 0/23
19:20 baseline  camera fetch -> stalled 5/23
19:29 cleanup   camera fetch -> timeout at 73%   (frame validly held)
```

Intermittent, and independent of the `camera-cleanup` change (the baseline
reproduces it). One completion in five attempts.

## 2. Two failure modes, and one is an artifact — do NOT confuse them

**Mode A — `st=0`/`0xFF`, "no frame held".** This was caused by the diagnostic
harness itself: opening `/dev/ttyUSB0` with pyserial's default line states
asserts DTR and **holds the ESP32 in reset**, so the camera answered nothing and
the RAK clocked out `0xFF`. Opening the port with `dtr=False, rts=False` before
`open()` removed it entirely. **Mode A is not a device bug.** Recorded so the
next person does not chase it.

**Mode B — stall partway with a valid held frame.** This is the real defect.
After a clean `cam snap`, `cam info` returns the correct pid/len/crc and the
camera's own serial logs `capture OK len=4893 crc=91D998C1`, yet the fetch
stalls at ~73%.

## 3. Mechanism — established from source, not guessed

`ChunkServer::sendChunk` (`MtChunk.cpp:93-97`):

```c
size_t got = _src->read(off, f + CHUNK_HEADER_LEN, (size_t)n);
if (got != n)
    return false; // short read: drop the chunk rather than pad
```

`M5CameraSource::read` (`M5CameraSource.h:167-202`) returns **0 on any failure**
of any of the ~8 I2C pieces that make up one 224-byte chunk:

- `seekOnly()` `endTransmission() != 0`      (line 175)
- `requestFrom() != expect`  — short read     (line 180/184)
- `got != off` — the camera served a different window (line 196)

So a **single** flaky I2C piece anywhere in a chunk makes `read()` return 0,
`sendChunk` drops that whole chunk, it is never transmitted, and the client
re-pulls the same gap indefinitely → the transfer stalls at the first flaky
chunk. That matches "stall at a stable %".

The embedded path (`_data`, `memcpy`) has no I2C step, which is exactly why it
never stalls. This isolates the fault to the per-piece I2C read under sustained
burst load.

## 4. What is NOT yet known — the measurement this task must take FIRST

Which of the three failures fires, and how often. The three imply different
fixes:

- **offset-mismatch** → the ESP32 `onReceive` task staged the window late; the
  25 ms settle is marginal under burst load (timing).
- **short read** → the FIFO was not loaded when the read arrived (staging).
- **seek endTransmission fail** → bus-level NAK/arbitration (electrical/bus).

Guessing here is precisely the mistake that cost seven fixes on the previous I2C
bug. `m5-camera-i2c.md §4` records that a blind retry-on-short-read was tried and
never fired against the *old* (systematic) bug — but that bug is fixed and this
one is *intermittent*, so a retry may or may not apply. **Measure before fixing.**

## 5. Plan

1. **Instrument only.** Add a lightweight counter to `M5CameraSource` — per
   failure kind (seek / short / offset) plus the offset of the first failure —
   exposed so it can be read after a stalled fetch. Prefer a counter surfaced
   through the existing debug/JSON path over per-transaction serial spam.
   Reinstating the camera-side I2C trace (`m5-camera-i2c.md §2`) is the
   fallback if the master-side counter is not conclusive.
2. **Run a full fetch, read the instrument.** Identify the dominant mode.
3. **Fix driven by that evidence.** State the mechanism the fix addresses and
   why the measured mode supports it. Candidate directions, to be chosen by the
   data, NOT before: a bounded per-piece retry; a larger/adaptive settle; or
   `sendChunk` retrying a 0-length `read()` a bounded number of times before
   dropping the chunk. Whichever is chosen, keep the offset-mismatch guard —
   it is what prevents silent corruption.
4. **Verify.** A full live camera fetch completes and CRC-matches the camera's
   own value, **repeatably — at least 3 consecutive runs**. Intermittent bugs
   need repeated success, not one.

## 6. Not in scope

- The `camera-cleanup` change (already committed; exonerated by the baseline).
- `CMD_SETTLE_MS` as a blind tweak — only as a *measured* response to step 2.
- Anything in the field unit. DEV1 `!8cee336b` on the bench only; OMNI
  `!2687afb1`, channel 2. Camera resettable via DTR/RTS on `/dev/ttyUSB0`, but
  a capture must **open with `dtr=False, rts=False`** or Mode A reappears.
