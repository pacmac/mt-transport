---
task: adopt-meshtastic-csma
status: active
source_hash:  # step 3 implemented; steps 1,4,5,6,7,8 outstanding (2 CLOSED as refuted)
  src/MeshtasticTransport.cpp: 6b6ea5be71231583a87aa2586317f257ad4b0fcbd4df86628e2adc8aa10c9541
  src/MeshtasticTransport.h: 691c049d6c065adb9b586bd235a35267225249ffd53f5431ed0ea49ea76de284
updated: 2026-07-19
priority: >
  Step 3 first (certain, small). Then step 8 (highest payoff, unproven).
  Step 2 is CLOSED — see "Refuted" below.
---

# Spec: adopt-meshtastic-csma — stop being deaf when the radio tells us a packet is arriving

## Why this task exists

Our CSMA was invented. Meshtastic's has been refined across a very large
deployment base. A systematic side-by-side of the two TX/RX paths found several
divergences, two of which plausibly explain the deployed node losing commands.

This task adopts their proven behaviour. It does **not** claim to have
diagnosed the 2026-07-18 DEV1 mute — that root cause is still unknown.

## Refuted before implementation — do NOT pursue

**CAD parameters are byte-identical between the two codebases.** Both program
`SetCadParams = {0x02, 24, 10, 0x00, 0, 0, 0}` — 4 symbols, `detPeak` 24,
`detMin` 10, exit-to-standby.

Meshtastic's `NUM_SYM_CAD = 2` is the **enum ordinal**, and `0x02` *means* 4
symbols (`SX126x_commands.h:256-260`). An earlier hypothesis that `symNum`
(4 vs 2) or `detPeak = SF+13` at BW250 was the divergence is **wrong**. Step 2
should be closed, not implemented. Chasing it would have meant changing a
setting that already matches.

## Measured baseline

`csmaDeferrals` per **transmit** (not per minute — that framing produced two
wrong figures before this was measured properly):

```
2026-07-19, HOME, interval 60, 4 transmits per heartbeat
  csma 26 -> 31  delta 5 over 61s  => 1.25 / transmit
  csma 31 -> 36  delta 5 over 60s  => 1.25 / transmit
```

**1.25 failed CADs per transmit.** Earlier claims of 3.8 and 0.9 were
arithmetic on guessed transmit counts, presented as measurements. They were not.

**Unresolved:** 1.25 on a channel carrying a dozen messages a day implies a
~56% per-scan false-alarm rate, which is high — *but* we send 4 frames
back-to-back and the Omni rebroadcasts them, so our own echo is an untested
alternative explanation. The discriminating test (does `csma` grow while we are
**not** transmitting?) has not been run.

## Step 3 — the change (this step)

### The defect, which is independent of the deferral rate

A CAD BUSY result **means a LoRa preamble was detected** — the chip is
reporting that a packet is arriving *now*.

| | on BUSY |
|---|---|
| Meshtastic (`RadioLibInterface.cpp:462-464`) | `startReceive()` → `setTransmitDelay()` → return. **Goes and receives the packet it just detected.** |
| ours (`MeshtasticTransport.cpp:95-99`) | leaves `_rxActive = false`, blocks in `delay(30..509)`. **Told a packet is inbound, then deliberately goes deaf for it.** |

At 1.25 deferrals/transmit that is roughly **one detected-but-discarded inbound
packet per transmit**. It does not matter how the false-positive question
resolves:

- detection **real** → we discard a packet the radio had already locked onto
- detection **false** → we go deaf for no reason at all

Both are pure loss, and neither improves if the rate falls.

**Second half, also rate-independent:** we never `startReceive()` after
`transmit()`. Meshtastic re-arms in the TX-done ISR path
(`RadioLibInterface.cpp:418`). We return from `transmitFrame()` with the chip
in `STDBY_RC` and stay deaf until the application next calls `receive()` —
unbounded from the library's point of view.

### Diffs

**`src/MeshtasticTransport.cpp` — `waitForClearChannel()`**

```diff
     _rxActive = false; // CAD ends in standby
     for (int attempt = 0; attempt < 8; attempt++) {
         if (_radio->scanChannel() == RADIOLIB_CHANNEL_FREE)
             return;
         _csmaDeferrals++;
+        // CAD said BUSY, which means a preamble was detected: a packet is
+        // arriving right now. Listen to it instead of sitting deaf through the
+        // backoff. Meshtastic does exactly this (RadioLibInterface.cpp:462).
+        if (_radio->startReceive() == RADIOLIB_ERR_NONE)
+            _rxActive = true;
         uint32_t window = 60u << (attempt < 3 ? attempt : 3);
         delay(30 + (_rng ? _rng() : 0) % window);
+        _rxActive = false; // the next scanChannel() puts us back in standby
     }
```

**`src/MeshtasticTransport.cpp` — `transmitFrame()`**

```diff
     waitForClearChannel();                              // also clears _rxActive
     _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
+    // If a frame arrived while we were backing off, transmitting now destroys
+    // it. We cannot deliver it — waitForClearChannel() is blocking, several
+    // frames deep in send(), with nowhere to hand a packet back to. So COUNT
+    // the loss instead of hiding it: silent loss is what made the 2026-07-18
+    // investigation so expensive.
+    if (_radio->getIrqFlags() & RADIOLIB_SX126X_IRQ_RX_DONE)
+        _rxDroppedByTx++;
     if (_radio->transmit(_frame, _frameLen) != RADIOLIB_ERR_NONE) {
         _txFailStreak++;
         return false;
     }
     _txFailStreak = 0;
+    // Re-arm RX immediately. Otherwise the chip sits in STDBY_RC — deaf —
+    // until the application happens to call receive() again.
+    if (_radio->startReceive() == RADIOLIB_ERR_NONE)
+        _rxActive = true;
     return true;
 }
```

**`src/MeshtasticTransport.h`** — accessor beside `csmaDeferrals()`, and the member:

```diff
     uint32_t txFailStreak() const { return _txFailStreak; }
+
+    // Frames that arrived but were destroyed by a transmit before we could
+    // read them. Non-zero means real inbound traffic is being lost to our own
+    // TX path — the blocking backoff cannot deliver a packet to the caller, so
+    // the loss is counted rather than hidden.
+    uint32_t rxDroppedByTx() const { return _rxDroppedByTx; }
```
```diff
     uint32_t _txFailStreak = 0;
+    uint32_t _rxDroppedByTx = 0;
```

### Why the counter matters more than it looks

It **measures the thing we cannot yet fix**. The blocking architecture means a
packet arriving mid-backoff is heard and then destroyed; the full fix is the
async restructure, which is far larger than step 3. Until then this turns an
invisible loss into a number.

It also **answers the open false-positive question from the other side**: if
`rxDroppedByTx` climbs, the CAD detections were **real traffic** (our own echo
or otherwise), because something genuinely arrived. If it stays at zero while
`csmaDeferrals` climbs, CAD is detecting preambles that never become frames —
i.e. false positives, which supports the AGC hypothesis in step 8.

That makes step 3 diagnostic as well as corrective, and it does it without the
separate idle-channel experiment.

`_rxActive` must be kept truthful in both places: it is the flag `receive()`
uses to decide whether to re-arm (`:122-126`), so a lie in either direction
either wastes an SPI round-trip or leaves us deaf.

### Files in step 3

| file | change |
|---|---|
| `src/MeshtasticTransport.cpp` | `startReceive()` during backoff; `startReceive()` after successful TX |
| `specs/adopt-meshtastic-csma.md` | this file |

**NOT changing in step 3:** the 8-attempt ladder and fail-open (audit-260719b
B5); the backoff formula (step 4, needs honest channel utilisation from
`airtime-accounting-fixes`); AGC/0x8B5/boosted gain (step 8); `library.json`
and `CHANGELOG.md` (version bumps when the task lands); `pac-garage-alarm`
(no API change).

### Verification

1. **Static:** `startReceive()` appears in `waitForClearChannel()` and in
   `transmitFrame()`'s success path; `_rxActive` set consistently at each.
2. **Build:** `pac-garage-alarm` and `examples/SpikeSend`.
3. **On air, HOME only:** heartbeats still decode at the gateway; `@ping` still
   answers. The change is meant to *add* listening, so nothing should regress.
4. **Sensitive measurement:** command-reply success rate across repeated pings,
   before vs after. Expect improvement or parity — never worse.
5. **DEFERRED:** proving we now *catch* the packets we previously discarded
   needs a second transmitter timed against our backoff window. Not available;
   recorded rather than skipped.
6. **GARG/DEV1 is NOT flashed from this task.**

## Later steps

- **8** — AGC reset + `0x8B5` + boosted gain, re-applied in `wake()`, not just
  `begin()`. The field unit sleeps ~99% of the time, so anything set once at
  init is lost on the first sleep — and would still test perfectly on the
  bench, where HOME runs on USB and rarely sleeps.
- **1 (remainder)** — idle-channel `csma` measurement. Pure observation.
  Arguably belongs *before* step 8, since a null result deflates the AGC line.
- **4, 5** — contention window and SNR weighting. Step 4 depends on
  `airtime-accounting-fixes` for honest channel utilisation.
- **6, 7** — remaining config divergences.
