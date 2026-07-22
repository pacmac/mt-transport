---
task: chunk-on-device
status: investigated — root cause found, fix not yet chosen
source_hash: ~  # no implementation proposed yet — this is a Phase 1 document
updated: 2026-07-19
scope: mylibs/mt-chunk/src/M5CameraSource.h, projects/timercam-chunk/src/main.cpp
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# Spec: M5 Timer Camera X I2C transport — INVESTIGATION ONLY

**This document deliberately proposes no fix.** It exists to hold the evidence
so the next change is driven by the ESP32 I2C slave's actual documented
semantics rather than by another guess. Seven guesses have already failed.

**No edits to the files in `scope` until §5 is answered.**

---

## 1. Symptom, stated precisely

The camera serves chunk data over I2C. Frames arrive with **correct length and
correct index**; only the payload bytes are wrong.

Diff of a LoRa-fetched payload against a serial dump of the **same held frame**:

```
ref 4736 crc=3792355d | got 4736 crc=657bf424
chunks differing: 21/22
first-diff offsets seen: [32]        <- always exactly one I2C piece in
  chunk 0: diff@32 ref 0b0a0b0e0d0c got ffd8ffe00010
  chunk 1: diff@32 ref 25262728292a got 135161072271
```

`ffd8ffe0` at byte 32 of chunk 0 is the **JPEG SOI — the frame start repeated**.

Interpretation: each 32-byte piece contains the window staged by the
**preceding** SEEK, not its own. The first piece of each chunk is correct only
because a prior seek happened to stage that window.

---

## 2. What the camera itself reports

Instrumenting the camera's own `onReceive`/`onRequest` (logged from `loop()`,
never from the callback) was the measurement that made this legible:

```
I2C RX cmd=03 n=6 off=0 want=32 staged=32 first=FFD8FFE0   <- SEEK arrives, stages correctly
I2C TX served=9  first=01000012                            <- but TX serves the OLD 9-byte INFO
...
I2C TX served=32 first=FFD8FFE0                            <- and later, correct
I2C TX served=32 first=33413429
```

**The SEEK is received and handled correctly.** The staging is correct. The
transmission serves something else. Everything blamed on the master, the wiring,
or the timing was therefore wrong.

---

## 3. Established facts — do not re-derive

| fact | evidence |
|---|---|
| Wiring is sound | boot scan: `i2c: 0x62 <- Timer Camera X`, `0x76 <- BME680` |
| `CAPTURE`/`INFO` over I2C work | `cam snap` returns len/crc that change per capture and match the camera's serial report |
| nRF52 master Wire buffer = **64 bytes** | `RingBuffer.h:29`, `SERIAL_BUFFER_SIZE 64`. A `requestFrom(224)` silently loses everything past 64 — **no error is reported** |
| Short serves are undetectable by length | master asks 32, slave writes 9, bus pads; `requestFrom` still returns 32 |
| The chunk protocol itself is sound | the embedded-image path transferred 7,156 B with CRC verified |

---

## 4. What was tried and did NOT work

All seven attempted at the master or in the camera's buffering, **none informed
by reading `esp32-hal-i2c-slave.c`**:

1. `CMD_SETTLE_MS` 10 → 25 ms
2. single output buffer (removed a reply/stage flag race)
3. auto-advancing read cursor
4. throwaway seek after every INFO
5. retry-on-short-read — never fires, see §3
6. warm-up read to absorb one stale serve
7. pipelined seek (stage *k+1*, read *k*) — **uncommitted, never tested**

That attempts 3 and 6 changed *where* the corruption appeared without removing
it should have been read as "the model is wrong", not "the fix was close".

---

## 5. QUESTIONS THE INVESTIGATION MUST ANSWER

Answer from **source and datasheet**, not from behaviour at the master.

1. **When does the ESP32 slave latch its TX data?**
   `esp32-hal-i2c-slave.c` exists at
   `framework-arduinoespressif32/cores/esp32/esp32-hal-i2c-slave.c`.
   Does `onRequest` fill a FIFO *on demand* during the read, or is the FIFO
   pre-loaded ahead of the transaction? If pre-loaded, a write→read sequence can
   never see data staged by that same write, and the whole two-phase
   SEEK-then-READ design is unsound on this part.

2. **Is `onReceive` guaranteed to run before `onRequest`** for a
   write-then-read pair with a STOP between? Both run from a task, not the ISR.
   What ordering does the implementation actually promise?

3. **Does repeated-START vs STOP change it?** The nRF52 master issues
   `endTransmission()` (STOP) then `requestFrom()` (fresh START). Would
   `endTransmission(false)` — repeated START — bind them into one transaction the
   slave handles atomically?

4. **What is the ESP32 slave TX FIFO length?** If under 32 bytes, part of every
   piece is padding regardless of ordering.

5. **Is a request-response protocol appropriate here at all**, or should the
   camera expose a *register-style* interface (write address, read data) which
   is what I2C peripherals conventionally do and what the ESP32 slave API may
   assume?

---

## 5b. ANSWERS — from source, 2026-07-19

`esp32-hal-i2c-slave.c`. Two mutually exclusive dispatch paths selected by
target, and **the Timer Camera X is a classic ESP32** (`board = m5stack-timer-cam`).

**Non-ESP32 targets** (S3/C3/…), line 813, `#ifndef CONFIG_IDF_TARGET_ESP32`:

```c
if (cause == I2C_STRETCH_CAUSE_MASTER_READ) {
    event.event = I2C_SLAVE_EVT_TX;   // queued when the read BEGINS
    i2c_slave_send_event(...);        // clock stays stretched
}
```
…and `i2c_slave_task` (line 921) clears the stretch **after** `request_callback`
returns. The master is held while `onRequest` runs.

**Classic ESP32**, line 797, inside the `I2C_TRANS_COMPLETE` (STOP) branch:

```c
if (slave_rw) {  // READ
#if CONFIG_IDF_TARGET_ESP32
    if (i2c->dev->status_reg.scl_main_state_last == 6) {
        event.event = I2C_SLAVE_EVT_TX;   // queued when the read has ENDED
```

**The stretch block is not compiled for classic ESP32.**

### ROOT CAUSE

**`onRequest` fires AFTER the read completes.** Its `Wire.write()` →
`i2cSlaveWrite()` (line 464) loads the hardware TX FIFO for the **NEXT** read.
The slave is therefore **structurally one read behind**, and a request-response
protocol whose reply depends on a command sent in the same exchange is
**impossible on this part**.

Not a timing bug — an architectural mismatch. That is why all seven timing
fixes failed: none of them *could* have worked.

| Q | answer |
|---|---|
| 1. When is TX latched? | After the transaction, into the FIFO, for the next read |
| 2. Ordering of the callbacks? | Both drain one FreeRTOS queue in `i2c_slave_task`, order preserved — but `EVT_TX` is enqueued at STOP |
| 3. Repeated START? | Does not help; the TX event still only fires at STOP on this target |
| 4. TX FIFO length? | `SOC_I2C_FIFO_LEN` = 32 on ESP32, plus a `tx_queue` spill. 32-byte pieces fit exactly |
| 5. Is request-response appropriate? | **No.** A register/auto-increment model is what this API actually supports |

**Corollary:** `CMD_INFO` appears to work only because `refresh()` polls
repeatedly and the value is stable across polls. It is lagged too. Any fix must
make that explicit rather than keep relying on the accident.

---

## 6. Alternatives to weigh once §5 is answered

Listed so the fix is chosen, not stumbled into:

- **Repeated START** — bind write+read into one transaction (Q3).
- **Register-file model** — camera maintains a memory-mapped window; master
  writes an address then reads, no staging callback involved.
- ~~**Abandon I2C for UART.**~~ **STRUCK 2026-07-19.** Peter: *"as soon as you
  use the UART you will lose debugging."* Correct, and I had mispriced this as
  merely a pin cost.

  `Serial1` **is** the debug mirror, added today in `firmware-hardening` step 5
  precisely because USB CDC needs VBUS and is silent on a battery unit. It is
  the only diagnostic that survives in the field. Its absence is what made the
  2026-07-18 investigation cost a full day, and the measurement that finally
  explained THIS bug — logging I2C from the camera's own side — arrived over a
  UART.

  Trading the field unit's only diagnostic channel to solve a bench problem is
  the wrong direction. A second UARTE1 exists on the nRF52840 in principle, but
  needs two free WisBlock pins (unverified) and is moot if the cursor-stream
  approach works.
- **Camera-push instead of RAK-pull over I2C** — the camera streams the frame on
  request and the RAK buffers one chunk. Inverts who drives, sidesteps the
  slave-response problem entirely.

**Do not implement any of these until §5 is answered.**
