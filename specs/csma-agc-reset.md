---
task: adopt-meshtastic-csma (step 8)
status: IMPLEMENTED + FLASHED (b80f) 2026-07-23. Build rak4631_camuart clean. ON-AIR b80f: DEBUG frame now carries `agcr`, incrementing 0→1→2→3 at ~60s cadence — the periodic reset FIRES on schedule; RX intact (both @-form and bare-verb DM ping return pong after the resets, txdr 0). BENEFIT DEFERRED: b80f's strong bench link (hops 0, −37 dBm) shows csma near-zero, so the deferral-inflation drop isn't bench-measurable — the prediction (csma/transmit → ~0) applies to the marginal deployed 336b (1.25/transmit measured on HOME at −121 dBm) and needs a field flash to confirm. 0x8B5 patch still out of scope (writeRegister protected).
source_hash:
  src/MeshtasticTransport.h: 0c24dde40198aa8f8c9ffd80d48f00421af916af15c42a3b3786c93e14a4f09d
  src/MeshtasticTransport.cpp: b2dd6f542e43bdc1cc45ebe4aa51e32e5a5bdc3fb72d02227e382093db6e4fb8
  ../pac-garage-alarm/src/main.cpp: 4c61f37c395d1f8e0719876cd77f9aa3874a573f3825e7b43012bcf83b0e14f3
scope:
  - specs/csma-agc-reset.md
  - src/MeshtasticTransport.h                       # _freqMHz/_lastAgcResetMs/_agcResets, AGC_RESET_INTERVAL_MS, agcResets(), resetAGC()/maybeResetAGC() decls
  - src/MeshtasticTransport.cpp                     # store freq in begin(); maybeResetAGC() from service(); resetAGC() impl
  - ../pac-garage-alarm/src/main.cpp                # surface "agcr" in the DEBUG frame (verifiability)
# NOT changing:
#   the 0x8B5 RX-sensitivity patch — still blocked (writeRegister protected); a separate item. calibrate() resets the AGC without it.
#   CAD params — byte-identical to upstream (refuted). The backoff ladder (step 4) is a separate step.
---

# Spec: csma-agc-reset (step 8) — periodic CALIBRATE_ALL so the AGC can't get stuck high

## Root-cause candidate (Phase 1)
`MeshtasticTransport::begin()` applies boosted RX gain (step 7) but there is **no periodic
AGC reset** — nothing re-run over time (`.cpp:63`). Upstream (`SX126xInterface.cpp:451-514`)
resets the AGC every 60s because the SX1262 loses RX boost ~60s post-boot and a plain
standby->startReceive does NOT reset it — only CALIBRATE_ALL does. A stuck-high AGC both
(a) inflates the CAD noise reference → false BUSY (the deferrals) and (b) eventually deafens
RX (the DEV1 mute). Time-progressive, recovers only on reset — matches the signature.

## Feasibility (Phase 1, confirmed against the BUILD's RadioLib, rak4631_camuart libdeps)
All primitives are PUBLIC: `calibrate(uint8_t)` (SX126x.h:204), `standby(uint8_t,bool)` (:242),
`calibrateImage(float)` (:817), `setRxBoostedGainMode(bool,bool)` (:489). Consts:
`RADIOLIB_SX126X_STANDBY_RC`=0x00, `RADIOLIB_SX126X_CALIBRATE_ALL`=0b01111111 (0x7F).
So no SX1262 subclass is needed for the AGC reset (only the 0x8B5 write needs one — out of scope).

## Diffs

### src/MeshtasticTransport.h
Accessor, next to `csmaDeferrals()` (~:217):
```diff
     uint32_t csmaDeferrals() const { return _csmaDeferrals; }
+    // CUMULATIVE count of periodic AGC resets performed (see resetAGC). Surfaced in the
+    // DEBUG frame so the reset's effect on csmaDeferrals is verifiable before/after.
+    uint32_t agcResets() const { return _agcResets; }
```
Private members (near the counters block ~:352) + interval + method decls:
```diff
     uint32_t _csmaDeferrals = 0;
+    uint32_t _agcResets = 0;          // cumulative; never reset
```
```diff
     TxState  _txState = TX_IDLE;
+    float    _freqMHz = 0.0f;         // stored from region in begin(), for calibrateImage()
+    uint32_t _lastAgcResetMs = 0;     // millis() of the last periodic AGC reset
```
Method decls (private, near other helpers):
```diff
+    static constexpr uint32_t AGC_RESET_INTERVAL_MS = 60000; // upstream cadence
+    void maybeResetAGC();   // per service(): fires resetAGC() when idle AND interval elapsed
+    void resetAGC();        // standby -> CALIBRATE_ALL -> calibrateImage -> re-apply gain -> startReceive
```

### src/MeshtasticTransport.cpp
Store freq + arm the timer at the end of `begin()`, just before `return true;` (~:80):
```diff
     if (radio.startReceive() == RADIOLIB_ERR_NONE)
         _rxActive = true;
+    _freqMHz = region.freqMHz;     // for the periodic calibrateImage()
+    _lastAgcResetMs = millis();    // start the AGC-reset clock at boot
     return true;
```
Call the check at the top of `service()`:
```diff
 void MeshtasticTransport::service()
 {
+    maybeResetAGC();   // periodic AGC reset (only when idle; see resetAGC)
```
New methods (place near service()):
```c
// Fire the periodic AGC reset ONLY when the radio is idle (never mid-TX or with a frame
// queued — a standby then would corrupt the transmit). On a busy unit the reset simply
// waits for the next idle gap; the always-awake node has gaps every heartbeat.
void MeshtasticTransport::maybeResetAGC()
{
    if (busy()) return;                                              // TX in flight or queued
    if ((uint32_t)(millis() - _lastAgcResetMs) < AGC_RESET_INTERVAL_MS) return;
    resetAGC();
}

// The SX1262 loses RX boost ~60s after boot; only CALIBRATE_ALL resets the AGC (a plain
// standby->startReceive does not — upstream SX126xInterface.cpp:451-514). Briefly (~ms)
// leaves RX to calibrate: a frame arriving in that window is lost, accepted every 60s as
// the cost of never going permanently deaf. calibrate() CLEARS image cal + DIO cfg, so
// re-apply calibrateImage / DIO2 RF switch / boosted gain / DIO1 action, then re-arm RX.
void MeshtasticTransport::resetAGC()
{
    _radio->standby(RADIOLIB_SX126X_STANDBY_RC, true);
    _radio->calibrate(RADIOLIB_SX126X_CALIBRATE_ALL);
    _radio->calibrateImage(_freqMHz);
    _radio->setDio2AsRfSwitch(true);
    _radio->setRxBoostedGainMode(true);
    _radio->setDio1Action(_onDio1Rx);
    _rxActive = (_radio->startReceive() == RADIOLIB_ERR_NONE);
    _agcResets++;
    _lastAgcResetMs = millis();
}
```

### ../pac-garage-alarm/src/main.cpp — surface it in the DEBUG frame
After the `rxdt` JField (~:1739):
```diff
     { "rxdt", jn((long)mesh.rxDroppedByTx()),                 JOPT  },
+    { "agcr", jn((long)mesh.agcResets()),                     JOPT  },
```
(DEBUG frame is jsonBuild, capped at 237 with `pts[]` truncated oldest-first — ~14 B added, handled.)

## Risks
- A frame mid-reception during a reset (~ms) is lost — every 60s, accepted (upstream does the same).
- Never fires mid-TX (`busy()` guard). If the unit were continuously busy for 60s the reset waits — fine on the near-idle alarm.
- Radio-level standby/calibrate is NOT app sleep — unrelated to the no-sleep-on-deployed rule; still bench-first, deployed only after a validated field flash.

## Verify (Observe)
1. **Static:** grep confirms `resetAGC`/`maybeResetAGC`/`_agcResets` present; `service()` calls it.
2. **Build:** `pio run -e rak4631_camuart` clean (mt-transport lib recompiles via the symlink).
3. **Functional (b80f, flashed):** DEBUG frame now carries `agcr`, and it increments (~1/min) → the reset fires. **Benefit metric (Peter):** capture `csma` (csmaDeferrals) per transmit over a window BEFORE (prior fw 2-260723-27) vs AFTER — prediction: falls toward zero if a stuck AGC was inflating the CAD noise floor. Noisier under mesh congestion; note conditions.
4. **Regression:** `@b80f ping` / bare-verb DM still reply (RX path intact after the periodic reset); status upt shows no unexpected resets.
