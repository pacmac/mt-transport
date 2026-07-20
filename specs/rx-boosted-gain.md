---
task: adopt-meshtastic-csma (steps 7 + 8)
status: implemented 2026-07-20 (260720-5, flashed; 0x8B5 write verified on UART)
priority: HIGH — prime candidate for the unsolved DEV1 mute; field unit has no OTA
source_hash:
  projects/mt-transport/src/MeshtasticTransport.cpp: e792cbb2700f97201c648c0b11e2c5b7a2b50973ede099425503d4ede75bdbb8
  projects/pac-garage-alarm/src/main.cpp: 3302d3aa6448f6f84f33d25ad2bbb2ea47de5809ea77de52d1c0fc9a7fda7ce7
scope:
  - projects/mt-transport/src/MeshtasticTransport.cpp
  - projects/pac-garage-alarm/src/main.cpp   # FW_VERSION bump only (standing rule:
                                             # bump the moment the build diverges)
---

# Spec: rx-boosted-gain — stop listening in power-saving mode

## Why

We never call `setRxBoostedGainMode()`, so the SX1262 runs with
`REG_RX_GAIN = 0x94` (**power saving**) instead of `0x96` (**boosted**) — verified by
grep: no hit anywhere in `MeshtasticTransport.{h,cpp}`. Meshtastic enables boosted
gain; we do not. That is a straight RX-sensitivity deficit against the reference
firmware, and audit step 7 has been open since 2026-07-19.

Worse, RadioLib's own recovery path is **inert because of it**
(`SX126x_commands.cpp:33-38`):

```c
// re-apply RX boosted gain if it was configured
if(this->rxBoostedGainMode) { state = setRxBoostedGainMode(true); ... }
```

The flag is false for us, so every reconfigure/warm-start silently re-applies
nothing.

## What RadioLib already does for us (checked, not assumed)

`SX126x_config.cpp:399`:

- writes `REG_RX_GAIN` (0x08AC) = `0x96`;
- with `persist = true` (**the default**), writes the **RX gain retention** registers
  `0x029F..0x02A1` with `{0x01, 0x08, 0xAC}` — SX126x datasheet v2.1 §9.6 — so the
  gain setting is restored automatically on warm-start from sleep.

So a single call at `begin()` gets the register, the retention entry, **and** re-arms
RadioLib's own re-apply path.

## Honest scope limits — read before believing this fixes anything

- **This is an RX fix. It cannot explain the ~17% uplink loss measured 2026-07-20**,
  which is OMNI failing to hear DEV1. Boosted gain improves *our* hearing of OMNI,
  already steady at snr 6.0–6.5.
- **The 60 s figure is REAL — verified in Meshtastic source, not taken on trust.**
  Peter recalled it; he then said "don't take my word for it, research and find the
  truth", so it was checked against upstream:

  - `RadioLibInterface.h:22` — `#define AGC_RESET_INTERVAL_MS (60 * 1000)`
  - `SX126xInterface.cpp` `init()` sets **both** `setRxBoostedGainMode()` and the
    `0x8B5` bit-0 patch ("recommended by Heltec/Semtech for improved RX sensitivity").
  - `SX126xInterface<T>::resetAGC()` runs `standby → CALIBRATE_ALL(0x7F) →
    calibrateImage`, then re-applies **both**, with this comment:
    *"The CALIBRATE_ALL (0x7F) command above clears bit 0 of register 0x8B5 …
    Without this re-apply, every SX1262 node loses its RX boost ~60s after boot and
    never recovers until reboot."*

  So the mechanism is **not** a chip self-reset: the periodic recalibration clobbers
  the patch, which is why upstream re-applies on that cadence.

- **OUR exposure is different, and worse.** We never call `setRxBoostedGainMode` and
  never set `0x8B5` — so we are not losing them after 60 s, we **never had them**.
  We run permanently at `RX_GAIN = POWER_SAVING (0x94)` with the sensitivity patch
  absent. A permanent deficit against the reference firmware, from boot.

- **Therefore NO 60 s timer here.** We never run the periodic `CALIBRATE_ALL` that
  destroys the patch (RadioLib's own `resetAGC()` is the only `CALIBRATE_ALL` site
  and we never call it). Applying at `begin()` + re-applying at `wake()` covers every
  mechanism actually evidenced. **If we ever adopt a periodic AGC reset, this must be
  revisited** — that change would introduce the very clobbering upstream works around.
- **What it plausibly does address:** the unsolved DEV1 *mute* (unit stops answering).
  A sensitivity deficit degrades command reception, and the field unit sleeps ~99%
  of the time — so anything set once at init and lost on sleep would look perfect on
  the USB-powered bench and fail only in the field. That asymmetry is why this was
  never caught.
- **Power cost:** boosted RX gain raises RX current (~+1 mA). The unit is battery
  powered; RX windows are short and Meshtastic accepts the same cost by default, so
  this is judged worthwhile — but it IS a real cost on a battery budget.

## Change (MeshtasticTransport.cpp only)

### 1. `begin()` — enable boosted gain with retention

```diff
     radio.setCurrentLimit(140.0f);
     radio.setDio2AsRfSwitch(true);
     radio.setCRC(RADIOLIB_SX126X_LORA_CRC_ON);
+    // Boosted RX gain (REG_RX_GAIN 0x96) — Meshtastic parity; we were running the
+    // 0x94 power-saving default. persist=true (RadioLib default) also writes the
+    // RX-gain RETENTION registers, so the setting is restored on warm-start from
+    // sleep, and it sets rxBoostedGainMode so RadioLib's own re-apply path stops
+    // being a no-op. Costs ~1 mA in RX; accepted for sensitivity.
+    radio.setRxBoostedGainMode(true);
```

### 2. `wake()` — belt and braces after sleep

```diff
     if (!_radio)
         return false;
-    return _radio->standby() == RADIOLIB_ERR_NONE;
+    if (_radio->standby() != RADIOLIB_ERR_NONE)
+        return false;
+    // Retention should restore this, but the field unit sleeps ~99% of the time and
+    // a silently deaf node is unrecoverable without a site visit. Re-asserting one
+    // register costs one SPI write per wake.
+    _radio->setRxBoostedGainMode(true);
+    return true;
```

## Explicitly NOT changing

- **The `0x8B5` register patch** (step 7's other half). It is undocumented, and I have
  not established what our RadioLib version already does. Enabling boosted gain is
  well-founded on its own; bundling an unverified poke would make a regression
  impossible to attribute. Left open on step 7.
- **No periodic re-apply timer.** That is step 8's premise and rests on the
  unverified 60 s claim. `begin()` + `wake()` + retention covers every mechanism
  actually evidenced.
- `pac-garage-alarm` — inherits by rebuild, no API change.

## Addendum 2026-07-20 — read the settings BACK (Peter)

*"do we query the rx gain and other 8xx fix and include that in the debug packet?"*

We did not, and that was the wrong gap to leave: **a silent clear is the documented
failure mode.** Upstream re-applies `0x8B5` every 60 s precisely because
`CALIBRATE_ALL` wipes bit 0 without any indication. Setting a register at boot and
never reading it is faith, not verification — and the unit has no OTA.

Both are readable from the firmware because it owns the `Module`
(`Module::SPIgetRegValue()` is **public**, unlike `SX126x::readRegister()`):

```c
rxg  = g_radioMod.SPIgetRegValue(0x08AC);       // 0x96 = BOOSTED, 0x94 = power saving
p8b5 = g_radioMod.SPIgetRegValue(0x8B5, 0, 0);  // 1 = sensitivity patch applied
```

Added to the DEBUG frame as `"rxg"` (raw byte, so an unexpected third value is
visible rather than coerced to a boolean) and `"p8b5"`. The frame is **on demand**
now, so the two SPI reads cost nothing periodically.

This makes the RX-parity work *checkable in the field*: if a future change ever
introduces a periodic calibration, `p8b5` drops to 0 and we see it instead of
guessing at a sensitivity regression.

## Verify

1. **Static** — `setRxBoostedGainMode(true)` present in `begin()` and `wake()`.
2. **Functional** — build; flash bench; confirm the radio still receives (commands
   still answered) and note received SNR before/after for information only.
   **DEFERRED:** proving the *mute* is fixed needs the sleep path over days in the
   field; the bench runs on USB and rarely sleeps, so it cannot reproduce the failure
   this targets. Recorded rather than skipped.
3. **Regression** — DEV1 still answers `ping`/`status`; no change in TX behaviour.
