---
task: agc-sensitivity-fix
status: IMPLEMENTED + VERIFIED ON-AIR 2026-07-24 (fw 2-260724-3, bench b80f). Ported upstream
  resetAGC() into the firmware; removed the lib's drifted home-grown version. DECODED proof, two
  independent channels: (1) over-air debug frame — agcr climbed 0->32 while p8b5 stayed 1 and
  rxg=0x96 (old code: p8b5->0 after the first reset); (2) rak-debug serial tap — "RXPATCH: 0x8B5
  bit0 @agc -> 0" (resetAGC re-applying the patch, RADIOLIB_ERR_NONE). Switch OFF froze agcr (9->9);
  set on/cadence via the `agc` text verb; on=0/sec=30 SURVIVED a reboot (settings v9). Both repos build.
  DISCOVERY (Phase 3): applySet's {type:set} 260 path is UNREACHABLE over the text-only gateway, so
  the remote knob needed its OWN text verb (`agc [<on> [<sec>]]`) — added; CONFIG_FIELDS rows kept for
  schema discovery + local set + persistence.
source_hash:
  mt-transport/src/MeshtasticTransport.cpp: 4971789015e254a71865f146a243fe0145e154147d5a24eac0d6d916381e1e0d
  mt-transport/src/MeshtasticTransport.h: 27f7dabc191932aa38a84c7cb75c0d939b277ce202fdc80d0e2a9ce3b13ccdf8
  pac-garage-alarm/src/main.cpp: 8f47196b472f8568e49b8b91a7bf672023f0905e1fe2cda7da3b83db2e1df249
scope:
  # --- mt-transport LIB: retire the drifted home-grown reset; expose the RX re-arm seam ---
  - /usr/share/pac/dev/pio/projects/mt-transport/src/MeshtasticTransport.cpp
  - /usr/share/pac/dev/pio/projects/mt-transport/src/MeshtasticTransport.h
  # --- pac-garage-alarm FIRMWARE: host the faithful port (owns the Module) + the switch ---
  - /usr/share/pac/dev/pio/projects/pac-garage-alarm/src/main.cpp
# NOT changing:
#   - the 0x8B5 patch value/semantics (already correct at main.cpp:240) — we only make resetAGC RE-APPLY it.
#   - the DEBUG frame KEYS (p8b5/rxg/agcr already exist) — only agcr's value SOURCE moves lib->firmware (no size change).
#   - RadioLib (no fork, no subclass): g_radioMod.SPIsetRegValue/SPIwriteStream are already PUBLIC and already used.
---

# Spec: agc-sensitivity-fix — port upstream resetAGC() faithfully, make it switchable, verify on-air

## Root cause (audit 654, corrected)
The 0x8B5 RX-sensitivity patch IS applied (`main.cpp:240 applyRxSensitivityPatch`) and IS observable
(`DEBUG` frame keys `p8b5`, `rxg`, `agcr`). The bug: our **home-grown** `MeshtasticTransport::resetAGC()`
(lib, cpp:599) **drifted** from upstream — it (a) omits upstream's step-1 warm `sleep(true)`, and
(b) never re-applies 0x8B5 after `CALIBRATE_ALL` clears bit 0. So ~60s after boot the first periodic
reset flips `p8b5` 1→0 and it stays 0 until reboot — the exact "fixed then silently un-fixed" pattern.
Fix = stop reinventing: port upstream's `resetAGC()` + its 60s trigger verbatim, into the firmware
(the only owner of the `Module`, mirroring upstream where the interface owns both `lora` and `module`).

## Reference (ported verbatim, adapted only for object access)
- `mt-radar/firmware/src/src/mesh/SX126xInterface.cpp` — `SX126xInterface<T>::resetAGC()`
- `mt-radar/firmware/src/src/main.cpp:1333-1338` — the periodic trigger
- `mt-radar/firmware/src/src/mesh/RadioLibInterface.h:22` — `AGC_RESET_INTERVAL_MS (60*1000)`

Object mapping (ours ← upstream): `radio` ← `lora` (SX1262), `g_radioMod` ← `module` (Module),
`mesh.busy()` ← `sendingPacket||isActivelyReceiving` guard, `mesh.freqMHz()` ← `getFreq()`,
`mesh.resumeRx()` ← `startReceive()` (the ONE seam — the lib owns the DIO1 ISR + `_rxActive`).

## Diffs

### A. mt-transport/src/MeshtasticTransport.cpp — REMOVE the drifted reset, ADD the re-arm seam
- DELETE `maybeResetAGC()` (587-592) and `resetAGC()` (599-610) entirely.
- DELETE the `maybeResetAGC();` call at the top of `service()` (617).
- In `begin()` DELETE `_lastAgcResetMs = millis();` (81). KEEP `_freqMHz = region.freqMHz;` (80).
- ADD a public re-arm the firmware's port calls as its final "resume receiving" step:
  ```cpp
  // Re-arm RX after the firmware's resetAGC() poked the radio directly (it owns the Module;
  // the lib owns the DIO1 ISR + _rxActive, so re-arming MUST come back through here).
  bool MeshtasticTransport::resumeRx()
  {
      if (!_radio) return false;
      _radio->setDio1Action(_onDio1Rx);
      _rxActive = (_radio->startReceive() == RADIOLIB_ERR_NONE);
      return _rxActive;
  }
  ```

### B. mt-transport/src/MeshtasticTransport.h
- DELETE members `_lastAgcResetMs` (348), `_agcResets` (358); DELETE `agcResets()` (220) and
  `AGC_RESET_INTERVAL_MS`/`maybeResetAGC`/`resetAGC` decls (385-387).
- ADD public: `bool resumeRx();` and `float freqMHz() const { return _freqMHz; }`.
- `busy()` (178) stays public — the port's guard uses it.

### C. pac-garage-alarm/src/main.cpp — host the faithful port + the switch
1. **Globals** (near g_chunkHopLimit, ~258): the switch (default ENABLED) + test cadence + counter.
   ```cpp
   static bool     g_agcOn      = true;     // periodic AGC reset — runtime switch, defaults ENABLED
   static uint32_t g_agcResetMs = 60000;    // upstream cadence; runtime-settable to test effect fast
   static uint32_t g_agcResets  = 0;        // cumulative; surfaced as DEBUG `agcr`
   ```
2. **The ported function** (place beside `applyRxSensitivityPatch`, ~242). VERBATIM from upstream
   SX126xInterface::resetAGC(), object-mapped; the ONLY non-verbatim line is the final resume:
   ```cpp
   static void resetAGC()   // faithful port of SX126xInterface<T>::resetAGC(); do not paraphrase
   {
       if (mesh.busy()) return;                        // upstream: sendingPacket||isActivelyReceiving
       radio.sleep(true);                              // 1. warm sleep — the actual AGC reset
       radio.standby(RADIOLIB_SX126X_STANDBY_RC, true);// 2. RC standby for stable calibration
       uint8_t cal = RADIOLIB_SX126X_CALIBRATE_ALL;    // 3. calibrate all blocks
       g_radioMod.SPIwriteStream(RADIOLIB_SX126X_CMD_CALIBRATE, &cal, 1, true, false);
       g_radioMod.hal->delay(5);                       // 4. wait for BUSY low (<=50ms)
       uint32_t t0 = millis();
       while (g_radioMod.hal->digitalRead(g_radioMod.getGpio())) {
           if (millis() - t0 > 50) break;
           g_radioMod.hal->yield();
       }
       if (g_radioMod.hal->digitalRead(g_radioMod.getGpio())) { mesh.resumeRx(); return; } // cal timeout
       radio.calibrateImage(mesh.freqMHz());           // 5. re-cal image for our region
       radio.setDio2AsRfSwitch(true);                  //    re-apply DIO2 RF switch
       radio.setRxBoostedGainMode(true);               //    re-apply boosted gain
       applyRxSensitivityPatch("agc");                 //    re-apply 0x8B5 (CALIBRATE_ALL cleared it)
       g_agcResets++;
       mesh.resumeRx();                                // 6. resume receiving (lib owns the ISR)
   }
   ```
3. **Periodic trigger** in `loop()` beside `mesh.service()` (~3434), ported from upstream main.cpp:
   ```cpp
   static uint32_t lastAgcReset = 0;
   if (g_agcOn && (millis() - lastAgcReset) >= g_agcResetMs) { lastAgcReset = millis(); resetAGC(); }
   ```
4. **Sleep resume**: after the successful `mesh.wake()` (~3120), add `resetAGC();` so a slept unit
   gets the full reset+patch on resume (Peter: "periodically when awake OR on sleep resume").
5. **DEBUG source swap** (1740): `mesh.agcResets()` → `g_agcResets` (same key, no size change).
6. **Config surface** — two rows in `CONFIG_FIELDS[]` (~2701) + `applySet` (~2781) + globals above:
   ```
   {"agc.on",  'b', "AGC reset",   1,   true, false, 0,    0},
   {"agc.sec", 'n', "AGC reset s",  60,  true, true,  5,    3600},
   ```
   ```cpp
   else if (!strcasecmp(path, "agc.on"))  g_agcOn      = v != 0;
   else if (!strcasecmp(path, "agc.sec")) g_agcResetMs = (uint32_t)v * 1000UL;
   ```
   Bump `SCHEMA_VERSION` 1→2 (self-describing; clients re-pull).
7. **Persistence** (survive reboot — deployed unit has no OTA):
   - Freeze current struct as `PersistedSettingsV8` (verbatim copy of today's `PersistedSettings`).
   - Append `uint32_t agcOn; uint32_t agcResetMs;` to `PersistedSettings`; bump `SETTINGS_VERSION` 8→9.
   - `saveSettings()` initializer: append `g_agcOn?1u:0u, g_agcResetMs`.
   - `loadSettings()`: add a v8→v9 migration branch (mirror the existing v5..v8 branches) that loads a
     v8 record and defaults `g_agcOn=true, g_agcResetMs=60000`; clamp `agcResetMs` to [5000,3600000].
8. **Boot init**: nothing extra needed — `resetAGC()` reads the globals live; `loadSettings()` seeds them
   before `loop()` runs. (begin()/wake() still call `applyRxSensitivityPatch` as today.)
9. **`agc` TEXT verb** (the REMOTE knob — added Phase 3): the `{type:set}`/applySet path is unreachable
   over the text-only gateway (config.js:13-15), so a text verb is required, mirroring `chunk cfg`:
   `agc [<on 0|1> [<sec 5-3600>]]` — no args = report; sets g_agcOn/g_agcResetMs + saveSettings; reply
   `{"type":"agc","on":N,"sec":N,"agcr":N}` (agcr lets a poll of `agc` prove the reset is/isn't firing).
   Reachable as `mtmesh <t> cmd agc [on] [sec]`. (config.js COMMAND_MAP integration for `config set
   agc.*` is a follow-up — out of this spec's scope; the raw `cmd agc` path fully satisfies remote config.)

## Observe (decoded side-effects ONLY — the evidence was always in the DEBUG frame)
1. **Static**: grep confirms the lib `resetAGC`/`maybeResetAGC` are gone and the firmware `resetAGC()`
   re-applies 0x8B5 (`applyRxSensitivityPatch("agc")`).
2. **Offline build**: both build — `pio run -e rak4631_camuart` (firmware) and the lib's compile_check.
3. **On-air, bench b80f ONLY** (GARG untouched), all via the DEBUG frame:
   - Set `agc.sec 10` (fast cadence for the test). Poll DEBUG.
   - **Regression proof of the OLD bug** (git stash / prior build): `p8b5` reads 1 at boot then →0 after
     the first reset and STAYS 0. **Fix**: `p8b5` stays **1** across resets; `agcr` increments each cadence;
     `rxg` stays boosted. This is the causal, decoded proof — never timing coincidence.
   - **Switch works**: `agc.on 0` → `agcr` STOPS incrementing; `agc.on 1` → resumes. Survives `@reboot`
     (read back `agc.on`/`agc.sec` from the persisted record).
   - Restore `agc.sec 60` after the test (persisted-config-outlives-tests).

## Split
Two commits: (1) mt-transport lib (remove drift + resumeRx/freqMHz seam), (2) pac-garage-alarm
(port + trigger + wake + switch + persistence + FW bump). Lib builds standalone before the firmware
consumes it.
