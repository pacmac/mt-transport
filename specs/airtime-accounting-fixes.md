---
task: airtime-accounting-fixes
status: F1-F4 implemented 2026-07-20 (260720-6). F7 REOPENED — see below.
source_hash:  # F1-F4 (steps 2-5) landed; F7 reopened by measurement; step 6 outstanding
  src/MeshtasticTransport.cpp: 6257cbcbaf5535f274280c6858106bf9d4e2df40aedc425e3df2733d160221ef
  src/MeshtasticTransport.h: c15d910cecb57150815e3a076045cc1294215b129231a66d4843b9ed087af200
updated: 2026-07-20
---

# Spec: airtime-accounting-fixes — make 0.4.0's counters honest

## Goal

0.4.0 shipped `airTxMs()`/`airRxMs()`/`airWindowMs()`/`resetAirWindow()`. Code
review of a81930b found the counters biased in **both directions at once**: RX
undercounts on a busy channel while TX overcounts on failed transmits. A
reading of "0% channel, 5% TX" is currently indistinguishable from a healthy
mesh, which is worse than shipping no metric at all. This task corrects the
accounting and removes the per-packet SPI cost the feature introduced.

No public API change — same four accessors, same units (ms). Only the values
they return change.

## Files

| file | change |
|---|---|
| `specs/airtime-accounting-fixes.md` | this file |
| `src/MeshtasticTransport.h` | private `transmitFrame()`; µs counters; getters divide |
| `src/MeshtasticTransport.cpp` | fixes F1–F4, F6 below (F5 = no change) |
| `README.md` | status heading 0.3.1 → 0.4.x; airtime API in the feature paragraph |
| `library.json` | 0.4.1 |
| `CHANGELOG.md` | [0.4.1] |

**NOT changing:** `pac-garage-alarm` — no API change, inherits by rebuild.
Wire format untouched. `docs/wire-format.md`, `docs/rx-and-commands.md`
unaffected.

## RE-ANCHOR 2026-07-20 — the line numbers below are STALE

`nonblocking-radio` restructured this file after this spec was written. Step 1's
`transmitFrame()` helper is now **`startSending()`** (async: it calls
`startTransmit()` and returns; TX-done arrives as a DIO1 interrupt). Every line
reference in the Findings section is therefore wrong. Verified current sites:

| finding | was | **now** |
|---|---|---|
| F2, F4 (TX credited before transmit) | `.cpp:85`/`:207` | **`.cpp:193`**, before `startTransmit()` at `:197` |
| F1, F3, F4 (RX gated on clean decode; unvalidated length) | `.cpp:141`/`:142` | **`.cpp:276`**, bounds check at `:278` |
| consumer of the numbers | — | **`.cpp:170`** `getTxDelayMsec()` — utilisation drives the backoff |
| storage | `.h` | **`.h:249`** `_txAirMs/_rxAirMs/_airWindowStart` |

**Confirmed still live on 2026-07-20:** all four correctness findings F1–F4.

**Field evidence that this matters:** DEV1 reports `channel_utilization` **9.4–19.7 %**
on a channel measured at 15 frames per 6.5 min (Peter: under a dozen messages a day).
The number is not merely cosmetic — `.cpp:170` feeds it into the contention window.

### Exact changes (current code)

**1. `.cpp:276` — F1 + F3: clamp BEFORE accounting, and count CRC failures**

```diff
-    int st = _radio->readData(raw, rawLen > sizeof(raw) ? sizeof(raw) : rawLen);
+    const size_t airLen = rawLen > sizeof(raw) ? sizeof(raw) : rawLen;
+    int st = _radio->readData(raw, airLen);
     float rssi = _radio->getRSSI(), snr = _radio->getSNR();
-    if (st == RADIOLIB_ERR_NONE && rawLen > 0)
-        _rxAirMs += _radio->getTimeOnAir(rawLen) / 1000; // channel occupancy
+    if (airLen > 0)
+        _rxAirUs += _radio->getTimeOnAir(airLen);
```

**2. `.cpp:193` — F2: credit only once the transmit actually starts**

```diff
-    _txAirMs += _radio->getTimeOnAir(it.len) / 1000;
     _rxActive = false;
     ...
     if (_radio->startTransmit(it.frame, it.len) != RADIOLIB_ERR_NONE) { ...drop... }
+    _txAirUs += _radio->getTimeOnAir(it.len);   // only now is it going on air
```

**3. `.h` — F4: accumulate microseconds, divide in the getters (public API unchanged)**

```diff
-    uint32_t airTxMs() const { return _txAirMs; }
-    uint32_t airRxMs() const { return _rxAirMs; }
+    uint32_t airTxMs() const { return _txAirUs / 1000; }
+    uint32_t airRxMs() const { return _rxAirUs / 1000; }
-    void resetAirWindow() { _txAirMs = 0; _rxAirMs = 0; _airWindowStart = millis(); }
+    void resetAirWindow() { _txAirUs = 0; _rxAirUs = 0; _airWindowStart = millis(); }
-    uint32_t _txAirMs = 0, _rxAirMs = 0, _airWindowStart = 0;
+    uint32_t _txAirUs = 0, _rxAirUs = 0, _airWindowStart = 0;
```

**4. `.cpp:170`** — utilisation must use the same units:
`100.0f * (float)(_txAirUs + _rxAirUs) / 1000.0f / (float)win`.

`uint32_t` µs wraps at ~71 min of *accumulated airtime*; `resetAirWindow()` is called
each telemetry interval, so a window holds seconds. Noted, not guarded.

## Findings

Ordered by severity. F1–F4 are correctness; F5–F8 are cost and consistency.
**NOTE: the line numbers in this section are pre-async — see the RE-ANCHOR above.**

### F1 — RX airtime skips CRC-failed frames (`.cpp:141`)

`if (st == RADIOLIB_ERR_NONE && rawLen > 0)` gates accounting on a clean
decode. Two neighbours collide, the SX1262 raises RX_DONE, `readData()`
returns `RADIOLIB_ERR_CRC_MISMATCH` — the frame occupied ~500 ms of air at
SF11 and is counted as zero. In a congested mesh most received energy *is*
corrupted frames, so `channel_utilization` reads near zero in exactly the
situation the metric exists to detect.

Occupancy is an RF-level fact. A frame that arrived and failed CRC still used
the channel.

### F2 — TX airtime credited before the transmit, never backed out (`.cpp:85`, `.cpp:207`)

`_txAirMs +=` precedes `transmit()`. When `transmit()` returns
`RADIOLIB_ERR_TX_TIMEOUT` or an SPI error, nothing (or a truncated burst) went
on air but the full time-on-air was already booked. `send()` returns false,
the app retries via `resend()`, and the same non-transmission is counted twice.
`air_util_tx` inflates precisely when the radio is misbehaving.

### F3 — `getTimeOnAir(rawLen)` trusts an unvalidated length (`.cpp:142`)

Accounting reads `rawLen` at line 142; the `rawLen > sizeof(raw)` bounds check
is at line 144. A corrupt frame reporting `getPacketLength() == 255` against
`sizeof(raw) == 253` gets its airtime booked from the bogus length before the
next line rejects it as oversized. The length is distrusted for parsing and
trusted for arithmetic — pick one.

### F4 — truncating division gives a monotonic downward bias (`.cpp:85,142,207`)

`getTimeOnAir()` returns **microseconds** (confirmed: `SX126x.h:634`). `/1000`
per packet discards up to 999 µs each time, and the error only ever accrues in
one direction. Thousands of events lose seconds of airtime; short frames on
low-SF/wide-BW presets lose a larger fraction.

### F5 — `getTimeOnAir()` is a blocking SPI round-trip (`.cpp:142`) — MINOR

Not a pure computation: `SX126x::getTimeOnAir()` opens with `getPacketType()`,
which is `SPIreadStream(CMD_GET_PACKET_TYPE)` and waits on BUSY
(`SX126x_commands.cpp:205`). 0.4.0 added that transaction to all three paths.

**Downgraded after checking the radio state machine.** The first draft of this
spec claimed the RX-path call widened a window where the radio is deaf. That
is false, on two counts:

- `startReceive()` arms with `RADIOLIB_SX126X_RX_TIMEOUT_INF` (0xFFFFFF) =
  **Rx continuous** (`SX126x_commands.h:78`). In continuous mode the chip
  stays in RX after RX_DONE; it does not fall back to standby.
- `readData()` does **not** call `standby()` in this RadioLib version — it
  checks IRQ, reads the buffer, clears flags.

So across `readData()` → `getTimeOnAir()` → `startReceive()` the chip is
listening the entire time. No deafness is introduced. The residual cost is a
few tens of µs of SPI against a 131 ms SF11/BW250 preamble.

The TX sites (`.cpp:85`, `.cpp:207`) *are* in standby — CAD ends in STDBY_RC —
but that is intended (we are about to transmit) and self-healing: `_rxActive`
is already false, so the next `receive()` re-arms. No lock-up state where the
radio can neither send nor receive.

**Decision: no code change.** Caching + interpolation is machinery in service
of a benefit that does not exist. Revisit only if profiling shows the SPI
transaction actually costs something, or if a future call site can run while
the chip is in *sleep* — where `getPacketType()` would return garbage and
`getTimeOnAir()` would fall through every modem branch.

### F6 — CSMA + accounting + transmit copy-pasted (`.cpp:84-86`, `.cpp:206-208`)

The two blocks are byte-identical. Any future transmit path must remember all
three steps; omitting the middle line silently drops that traffic from
`air_util_tx` with no compile error and no test failure.

### F7 — no rolling window (`.h:108`)

Meshtastic's `air_util_tx` is duty cycle over the trailing hour. An app that
follows the header comment but never calls `resetAirWindow()` gets
`airWindowMs() == uptime`; after a week a transmission burst moves the ratio
by a rounding error. The library documents the mapping but pushes the
windowing — the hard part — onto every caller.

**Decision: document, do not implement.** A ring of buckets costs RAM and an
opinion about time on a library whose whole thesis is that the application owns
scheduling. Header comment gains an explicit "call this hourly" instruction.

### F8 — README not synced (`README.md:17`)

`## Status: ... (0.3.1)` with four new public methods absent from the feature
paragraph, one commit after 8532995 whose stated purpose was docs-sync.

## Design

Single private helper owns every transmit:

```
bool transmitFrame();   // waitForClearChannel + transmit + credit airtime on success
```

- `send()` and `resend()` both `return transmitFrame();` — F2 and F6 close
  together, and the "credit only on `RADIOLIB_ERR_NONE`" rule lives in one place.
- Counters become `_txAirUs` / `_rxAirUs` (µs, `uint32_t`); `airTxMs()` and
  `airRxMs()` divide by 1000 at read time (F4). Range is unchanged in practice:
  µs overflow at ~71 min of *pure accumulated airtime* is unreachable inside any
  window an app would sample, and duty-cycle regulation caps it far below.
- RX: compute `size_t airLen = min(rawLen, sizeof(raw))` **before** any
  accounting, credit whenever RX_DONE fired and `airLen > 0`, regardless of
  `st` (F1, F3). Drop the `st == RADIOLIB_ERR_NONE` condition from the
  accounting line only — the filter chain at line 144 is unchanged.

## Step 1 — implementation (exact diffs)

**Scope: `transmitFrame()` only, behaviour-preserving.** F2 (credit on success)
is step 4 and F4 (µs) is step 5; both land *inside* this helper afterwards as
one-line changes. Step 1 deliberately does NOT change behaviour, so the diff
can be verified as a pure refactor — the device is remote with no OTA, and a
refactor entangled with three behaviour changes is not reviewable.

Baseline verified: `sha256(src/MeshtasticTransport.cpp)` ==
`fdbc359c26f16eefe8d82296644501df63af918d59e218f0703ba50b3e3351a5`, matching
the 0.4.0 hash this spec was written against. No drift.

### src/MeshtasticTransport.h — declare the helper

After `void waitForClearChannel();` (`:138`), add:

```diff
     void waitForClearChannel();   // CSMA: CAD + backoff, fail-open ~2 s
+    bool transmitFrame();         // the ONE transmit path: CSMA + airtime + transmit
```

Private. No public API change — `send()`, `resend()`, `sleep()` and all four
airtime accessors keep their existing signatures, so `pac-garage-alarm` and
`examples/SpikeSend` inherit by rebuild with no source edit.

### src/MeshtasticTransport.cpp — add the helper

New method, placed immediately after `waitForClearChannel()` (`:104`) so the
CSMA policy and its only caller sit together:

```c
bool MeshtasticTransport::transmitFrame()
{
    waitForClearChannel();                              // also clears _rxActive
    _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
    return _radio->transmit(_frame, _frameLen) == RADIOLIB_ERR_NONE;
}
```

Airtime is computed **before** `transmit()`, unchanged from today. This
ordering is deliberate and must survive step 4: `getTimeOnAir()` opens with a
`getPacketType()` SPI read (F5), which is valid in standby — where CAD leaves
the chip — but returns garbage in *sleep*. Step 4 will keep the computation
here and move only the `+=` after the success check.

### src/MeshtasticTransport.cpp — `send()` `:84-86`

```diff
-    waitForClearChannel();
-    _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
-    return _radio->transmit(_frame, _frameLen) == RADIOLIB_ERR_NONE;
+    return transmitFrame();
 }
```

### src/MeshtasticTransport.cpp — `resend()` `:206-208`

```diff
-    waitForClearChannel(); // also clears _rxActive
-    _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
-    return _radio->transmit(_frame, _frameLen) == RADIOLIB_ERR_NONE;
+    return transmitFrame();
 }
```

The `if (!_radio || _frameLen == 0)` guard at `:204-205` stays in `resend()` —
it is a resend-specific precondition (nothing buffered yet), not a transmit
concern.

### Files in step 1

| file | change |
|---|---|
| `src/MeshtasticTransport.h` | one line: private `transmitFrame()` declaration |
| `src/MeshtasticTransport.cpp` | add helper; replace two 3-line blocks with one call each |
| `specs/airtime-accounting-fixes.md` | this section; `source_hash: ~` until Phase 5 |

**NOT changing in step 1**, and why:
- `library.json` / `CHANGELOG.md` — 0.4.1 ships when the whole task lands, not
  per step. Bumping now would advertise fixes that are not in yet.
- `README.md` — that is step 6.
- `pac-garage-alarm` — no API change; inherits by rebuild. Its 7 `mesh.send()`
  sites, one `mesh.resend()` (`:292`) and the four accessor reads (`:329-340`)
  are untouched.
- `examples/SpikeSend` — two `mesh.send()` calls, unaffected.
- `src/generated/**`, `mt_wire`, `mt_crypto` — wire format and crypto are not
  in scope for any step of this task.

### Step 1 verification plan

1. **Static:** `grep -n "transmitFrame" src/MeshtasticTransport.*` shows one
   declaration, one definition, two call sites; `grep -n "_radio->transmit("`
   shows exactly ONE occurrence, inside `transmitFrame()`.
2. **Behaviour-identical proof:** the three moved lines are byte-identical to
   the originals; `git diff` must show no change to the emitted sequence.
3. **Build:** compile via `examples/SpikeSend` (the library has no
   `platformio.ini` of its own) and via `pac-garage-alarm`, proving both
   consumers still build against the changed header.
4. **DEFERRED — native stub-radio test.** `test/` is empty and mt-transport
   has no `platformio.ini`; there is no native env to run one in. Building
   that harness is its own task, not step 1. Recorded here rather than
   silently skipped.
5. **On air, DEV1 only.** GARG is NOT flashed from this task — 90-minute round
   trip, no OTA.

## Verification

1. Static: grep `transmitFrame`, confirm no bare `_radio->transmit(` outside it.
2. Unit-ish (native): drive a stub radio returning known lengths and forced
   `CRC_MISMATCH` / `TX_TIMEOUT`; assert CRC-failed frames DO count toward
   `airRxMs()` and failed transmits do NOT count toward `airTxMs()`.
3. On air, DEV1 only: heartbeat + `@dev1` ping/pong still decode at the Omni
   event stream; report `airTxMs`/`airRxMs`/`airWindowMs` over serial and
   sanity-check `airTxMs` against packets-sent × known frame airtime.
4. GARG is NOT flashed from this task. Field flash is an hour's drive with no
   remote OTA — DEV1 must be fully green first, and this batches with whatever
   else is pending.

## Out of scope

Rolling-window buckets (F7 — documented, deliberately not built). CAD/listen
airtime in the RX total. Contention-window tuning from utilisation stats. Any
`pac-garage-alarm` change. The stuck-LED / sleep-hang symptom raised during
review — unrelated to this diff, belongs in a separate firmware-side task.
