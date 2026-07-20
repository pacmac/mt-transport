---
task: airtime-accounting-fixes (supersedes F1-F7 patching)
status: implemented 2026-07-20 (260720-8) — chunk transfer restored, 122s CRC MATCH
priority: HIGH — our homegrown accounting is implicated in a chunk-transfer regression
source_hash:
  projects/mt-transport/src/MeshtasticTransport.h: 33adb6fdd8fa1c2c73fc05c244efcc8fde508d1b9a12e65fd42e936175b9eacc
  projects/mt-transport/src/MeshtasticTransport.cpp: 729b55c23e1f340e62cb2891661dc2a2ba8bb722911fec5fc26f8561d39dd018
  projects/pac-garage-alarm/src/main.cpp: c218432f8661a96e94ba11307ed04de29339e979593672b6e6b748c0d1bd7f84
scope:
  - projects/mt-transport/src/MeshtasticTransport.h
  - projects/mt-transport/src/MeshtasticTransport.cpp
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: adopt-mt-airtime — stop reinventing airtime accounting

## Why (Peter: "why can we just copy the official mt firmware method?")

Because we should have. This is the third time today the answer was "upstream already
solved this" (CSMA RX re-arm, boosted gain + 0x8B5, now airtime). Our version was
invented, and patching it (F1–F4) did not stop it producing wrong numbers — it is
now implicated in a **chunk-transfer regression**:

```
260720-1   85 s ok       260720-5  146 s ok, 148 s ok
260720-6   31/32 FAIL    260720-7  16/32 FAIL ("no serve, no busy")
```

The failures begin at the build where airtime accounting changed.

### The actual defect, and it is ours

`getTxDelayMsec()` sizes the contention window from channel utilisation:

```c
cw = CWMIN + util*(CWMAX-CWMIN)/100;  span = 1<<cw;  delay = rand(span) * slotTime
util 20% -> cw 4 -> max 0.42 s        util 100% -> cw 8 -> max ~7.1 s per transmit
```

and utilisation came from `(_txAirUs + _rxAirUs) / airWindowMs()`, where the window is
**"time since the reader last called `resetAirWindow()`"**. Three changes landed the
same day, each defensible alone:

1. **F1** — count CRC-failed frames (correct: occupancy is an RF fact, and upstream
   agrees — see below).
2. **F4** — accumulate microseconds in `uint32_t`, which **wraps at ~71 min of
   accumulated airtime**.
3. **Change-gated telemetry** — `sendDeviceMetrics()` now returns early, so
   `resetAirWindow()` may not be called **for up to 6 h** (the keepalive).

Together: a denominator that grows for hours, a numerator counting noise, and a
counter that can wrap. A wrapped numerator yields an arbitrary utilisation, which
sizes the backoff — presenting exactly as "device does not serve".

## What upstream does (verified in source, not assumed)

`meshtastic/firmware/src/airtime.{h,cpp}`:

- **Three counters, deliberately separate.** Header comment:
  `TX_LOG` transmitted; `RX_LOG` "valid and routable mesh packets"; `RX_ALL_LOG`
  "all received lora packets... includes packets that are not for meshtastic
  devices", and notes `RX_ALL_LOG - RX_LOG = Other lora radios on our frequency`.
- **Channel utilisation is a FIXED ROLLING WINDOW owned by the library**:
  ```c
  channelUtilization[getPeriodUtilMinute()] += airtime_ms;   // outside the if/else:
                                                             // EVERY log counts
  getPeriodUtilMinute() = (secondsSinceBoot / 10) % 6;       // 6 x 10 s buckets
  channelUtilizationPercent() = sum / (6*10*1000) * 100;     // 60 s window
  ```
  So noise **does** count toward channel utilisation (F1 was right) — but the
  denominator is a constant 60 s, never "since someone last looked".
- **TX duty cycle is a separate hour-long ring**: `utilizationTX[60]`, one bucket per
  minute, `utilizationTXPercent() = sum / MS_IN_HOUR * 100`.
- Buckets hold at most one bucket-period of airtime, so **nothing can wrap**.

## Design — port the model, not the code

Ported (their structure, our naming/threading):

- `_chanUtil[6]` — **10 s buckets, 60 s rolling window**, milliseconds. Every frame
  on air counts: our TX, and every RX the radio completed (valid or not).
- `_txUtil[60]` — **1 min buckets, 1 h rolling window**, for TX duty cycle.
- Cumulative totals `_txMs / _rxValidMs / _rxAllMs` kept for reporting only —
  `_rxAllMs - _rxValidMs` is "other radios on our frequency", per upstream's note.
- Rotation happens on **write and on read**, driven by `millis()`; buckets that have
  been skipped are zeroed. No thread needed — we have `service()`.
- **Milliseconds, not microseconds.** F4's precision fix is unnecessary once airtime
  is bucketed (each bucket holds ≤10 s), and µs is what made wrapping possible.

Deliberate divergence from upstream, with reason: upstream logs `RX_ALL_LOG` and
`RX_LOG` on separate paths, so a valid packet can land in `channelUtilization` twice.
We count channel occupancy **once per received frame** and record validity
separately. Occupancy is a physical fact about the channel; counting it twice is a
bug we do not need to inherit.

## API change

Removed: `airTxMs()`, `airRxMs()`, `airWindowMs()`, `resetAirWindow()` — the last of
these is the F7 defect itself (reader owns the denominator). **Removing it deletes
that bug rather than documenting it.**

Added: `channelUtilizationPercent()`, `utilizationTxPercent()`, plus
`airTxMsTotal()/airRxMsTotal()/airRxAllMsTotal()` for diagnostics.

`getTxDelayMsec()` uses `channelUtilizationPercent()` — a bounded 0–100 over a fixed
60 s window, so the contention window can no longer be driven by a stale denominator
or a wrapped counter.

`pac-garage-alarm` telemetry uses the two percent accessors directly and no longer
resets anything.

## Verify

1. Static: no `resetAirWindow`/`airWindowMs` references remain anywhere.
2. Functional: flash; `channel_utilization` and `air_util_tx` are plausible on a
   quiet channel (single figures), read from the bench's OWN telemetry
   (`from_num` scalar match — a substring match on a bulk blob gave a wrong answer
   earlier today).
3. **Regression that matters: chunk transfer completes, CRC-verified.** This is the
   test the port exists to fix.
