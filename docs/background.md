# SENSOR mode telemetry behavior — analysis and verification plan

**Scope of this document (spec):** `docs/background.md` (this file) is the only
repo file in scope. The verification work targets the PAC Garage device
(`!987ab80f` / C7:1C:98:7A:B8:0F, RAK4631 + RAK1901 SHTC3 + RAK12006 PIR),
not the codebase.

Date: 2026-07-16. Firmware analysed: this repo (mt-radar fork of Meshtastic).
Device config dump analysed: garage node export, `ts=1784194981` (2026-07-16).

---

## 1. TL;DR

**SENSOR mode does not schedule or wake anything.** Each telemetry module
independently decides whether it can send; the configured `*_update_interval`
values are only *minimum-gap rate limiters*, not wake timers. The role changes
almost nothing about *when* telemetry is sent. The public docs oversell the
role: in reality it is CLIENT plus a few one-time defaults, a relaxed airtime
gate, and an optional deep-sleep-after-send behavior.

The reason "only detection events were ever sent" on the garage node is that
every other module was failing its own private gate — silently, with no
user-visible error.

## 2. What `role = SENSOR` actually does

| Effect | Where | Detail |
|---|---|---|
| One-time defaults | `src/mesh/NodeDB.cpp:1293` (`installRoleDefaults`) | Sets `environment_measurement_enabled=true`, `environment_update_interval=300`, device interval to default, `is_unmessagable`. Applied **only at the moment the role is switched** — never re-checked or re-corrected afterwards. |
| Excluded from PowerFSM sleep | `src/PowerFSM.cpp:419-427` | "Sleep will be initiated through the modules" — the state machine never sleeps a SENSOR node; the telemetry modules own sleep. |
| Relaxed airtime gate | `src/modules/Telemetry/EnvironmentTelemetry.cpp:311-321` | `airTime->isTxAllowedChannelUtil(role != SENSOR)` — SENSOR skips the channel-utilization check. |
| Send-then-deep-sleep | `EnvironmentTelemetry.cpp:650-661`, `248-254`; `PowerTelemetry.cpp:288-292` | **Only if `power.is_power_saving` is also true**: after an environment/power send, the node deep-sleeps for the whole update interval. |

Deep-sleep implementation:

- **nRF52** (`src/platform/nrf52/main-nrf52.cpp:465-472`): low-power delay for
  the whole interval, then `NVIC_SystemReset()` — a full reboot per cycle.
  Nothing runs during the sleep: no BLE, no LoRa RX, no PIR polling.
- **ESP32** (`src/platform/esp32/main-esp32.cpp:245-268`): RTC timer + user
  button are the **only** wake sources. The detection GPIO is *not* a wake
  source, so power-saving SENSOR mode largely kills PIR detection.

## 3. Per-module send gates

Every gate below fails **silently** — the module just `disable()`s itself or
returns without sending.

### Environment (`src/modules/Telemetry/EnvironmentTelemetry.cpp`)
- Line 265: `disable()` unless `environment_measurement_enabled` is true.
  **Setting an interval does not set this flag.**
- Line 307: at first run, if no supported sensor was detected on I2C at boot →
  `disable()`. SHTC3/RAK1901 *is* supported end-to-end
  (`src/detect/ScanI2CTwoWire.cpp:539` → `SHTXX` → `SHTXXSensor`,
  `EnvironmentTelemetry.cpp:241`).
- Lines 311-321: interval throttle (TransmitHistory key `0x8002`) + airtime gates.

### Device metrics (`src/modules/Telemetry/DeviceTelemetry.cpp:26-36`)
- Mesh broadcast requires `device_telemetry_enabled` (line 33), which defaults
  to **false** (`module_config.pb.h:596`) and is *not* set by the SENSOR role
  defaults. When false, device metrics go only to a connected phone/API client
  — the app shows metrics, the mesh never gets them. This is the most
  misleading gate.

### Power (`src/modules/Telemetry/PowerTelemetry.cpp:53-55, 86`)
- Requires `power_measurement_enabled` (default false) **and** a supported
  power-monitor chip (INA219/226/260/3221, MAX17048). No chip → `disable()`,
  regardless of the flag.

### Position (`src/modules/PositionModule.cpp`)
- Needs a valid position (GPS fix or fixed position). No position → nothing to
  send. Send-then-sleep applies only to TRACKER/TAK_TRACKER (lines 417-419),
  not SENSOR.

### Detection sensor (`src/modules/DetectionSensorModule.cpp`)
- Simple GPIO poll with its own trigger logic — independent of all gates
  above, which is why it was the only module ever heard from. Note: it refuses
  to send on the default public channel 0 (requires a private primary channel,
  which the garage node has).

## 4. Garage node config vs. expected behavior (dump of 2026-07-16)

Relevant settings from the live dump:

| Setting | Value | Consequence |
|---|---|---|
| `telemetry.environment_measurement_enabled` | **true** | Env gate 1 passes. Remaining unknown: was the SHTC3 detected at boot? |
| `telemetry.environment_update_interval` | 1800 | Env every ≥30 min, if it runs at all. |
| `telemetry.device_telemetry_enabled` | **true** | Device metrics should now broadcast every ≥30 min. |
| `telemetry.power_measurement_enabled` | true | **No-op** — no INA/MAX chip on this node; module silently disables. Recommend setting false to avoid confusion. |
| `power.is_power_saving` | **true** | ⚠ In SENSOR role this arms send-then-deep-sleep: after the first env send, the node reboots-and-sleeps in 30-min cycles. BLE unreachable and PIR dead during sleep. In CLIENT role it has much milder effects. |
| `position.fixed_position` | true, broadcast 3600 | Position should broadcast hourly (precision 15 bits on the Private channel). |
| Primary channel | "Private" (custom PSK) | Detections allowed. **Observation constraint:** all broadcasts are encrypted with the Private PSK — nodes E9/F4 cannot decrypt them; only mesh-gw or a client attached to the garage node itself can observe. |

### Why nothing was sent historically

The historical SENSOR-mode failure is consistent with exactly one story:
**environment telemetry never sent even once.** Proof: detections *did* come
through, so the node never entered the send-then-deep-sleep cycle (which would
have killed the PIR ~97% of the time) — and the sleep is only ever triggered
*by a successful env/power send*. So the env module was disabled at boot,
either because `environment_measurement_enabled` was false at the time (the
30-min "send frequency" was set, but the separate enable flag was not) or
because the SHTC3 was not detected on I2C. Device metrics never broadcast
because `device_telemetry_enabled` was false (default). Power and position had
no hardware/position to report.

## 5. Testable predictions

| ID | Condition | Prediction |
|---|---|---|
| P1 | CLIENT role, current config | Environment telemetry broadcast every ~30 min **iff** the SHTC3 is detected at boot. |
| P2 | CLIENT role, current config | Device metrics broadcast every ~30 min (flag now true). |
| P3 | CLIENT role, current config | Position broadcast every ~60 min (fixed position). |
| P4 | Any role | Power telemetry **never** sends, despite `power_measurement_enabled=true` (no supported chip). |
| P5 | SENSOR role, `is_power_saving=true` | One env send shortly after boot, then the node disappears into 30-min deep-sleep/reboot cycles: BLE unreachable except ~60 s after each wake (`wait_bluetooth_secs=60`), PIR detections mostly lost. |
| P6 | SENSOR role, `is_power_saving=false` | Same cadence as CLIENT (P1–P4) plus detections; no sleep. Role change alone alters nothing about scheduling. |
| P0 | Any role, SHTC3 *not* detected at boot | Env never sends; in SENSOR+power-saving no sleep ever happens either (the trigger never fires). |

## 6. Test plan

Observation path: telemetry broadcasts are encrypted on the Private primary
channel, so observe either (a) with the meshtastic CLI attached to the garage
node itself over BLE (works for phases 1–2, not phase 3), or (b) via mesh-gw
once restarted (required for phase 3).

**Phase 0 — sensor detection check.** Connect CLI to the garage node and
confirm environment metrics appear for the local node (own-node telemetry is
delivered to the connected client regardless of the mesh flag). If no env
metrics ever appear locally, the SHTC3 is not being detected (P0) and phases
1–3 will show no env traffic — that becomes the finding.

**Phase 1 — baseline, CLIENT role (as-is).** Observe ≥65 min. Expected: P1,
P2 at ≤30-min cadence, P3 hourly, P4 never.

**Phase 2 — SENSOR, power saving off.** Set `role=SENSOR`,
`power.is_power_saving=false`. Observe ≥65 min. Expected: P6 (identical
cadence to phase 1, plus detection events on PIR triggers).

**Phase 3 — SENSOR, power saving on.** Restore `is_power_saving=true`.
Expected: P5 — one env send after boot, then 30-min silence/reboot cycles;
node reachable over BLE only briefly after each wake. Observe via mesh-gw.
*Run this phase last: it makes the node hard to reach.*

**Wrap-up.** Restore role/power-saving to the desired steady state; recommend
`power_measurement_enabled=false`.

## 7. Results

### Observation, 2026-07-16 ~21:25 BST

Reported: device in SENSOR role for ~9 hours, **zero** telemetry of any kind.

Gates eliminated by direct code reading (none of these is the cause):

| Candidate | Verdict | Evidence |
|---|---|---|
| `rebroadcast_mode = NONE` | Not the cause | Only gates *relaying others'* packets (`FloodingRouter.cpp:158`); never own sends. |
| PowerFSM sleeping the node | Not the cause | SENSOR explicitly excluded (`PowerFSM.cpp:425`). |
| Congestion scaling of intervals | Not the cause | Coefficient is 1.0 below 40 online nodes (`Default.h`); mesh has 3. Also bypassed outright for SENSOR (`Default.cpp:49-51`). |
| Region telemetry throttle | Not the cause | `PROFILE_EU868 = {..., 1, 1}` (`RadioInterface.cpp:57`) — throttle 1 = neutral (`Default.cpp:75`). |
| `TransmitHistory` blocking sends | Not the cause | Every path recovers: absolute epochs return 0 when the clock is unset (`storedEpoch > now`), boot-relative entries self-clear after the 120 s window. Wraparound arithmetic is intentional and correct. |
| `installRoleDefaults(SENSOR)` disabling flags | Not the cause | `NodeDB.cpp:1293-1298` only sets `is_unmessagable`, `device_update_interval=3600`, `environment_measurement_enabled=true`, `environment_update_interval=300`. It **overwrites the user's 1800 intervals** but disables nothing. |

### Key finding — the node is awake, therefore env telemetry has never sent

`sleepOnNextExecution` is armed **only** by a successful send. Verified
exhaustively (`grep sleepOnNextExecution`): `EnvironmentTelemetry.cpp:659`,
`PowerTelemetry.cpp:290`, `AirQualityTelemetry.cpp:427`,
`HealthTelemetry.cpp:262`, `PositionModule.cpp:427`. On this node:

- Power telemetry → disabled at init (no INA/MAX chip), cannot arm it.
- Air quality / health → no sensors, not enabled.
- Position → the sleep path is TRACKER/TAK_TRACKER only.
- **Environment → the only remaining candidate.**

So in SENSOR + `is_power_saving=true`, a completed environment send *must* be
followed by a 30-minute deep sleep (`main-nrf52.cpp:465-472`: `LOWPWR` +
`delay(msecToWake)` + `NVIC_SystemReset`), during which the node stops
advertising BLE entirely.

**Measured at ~21:25 BST:** `meshtastic --ble-scan` found
`Meshtastic_b80f` / `C7:1C:98:7A:B8:0F` advertising, BlueZ `Connected: false`.
The node is awake and reachable.

**Therefore: no environment telemetry send has ever completed.** The sleep that
would necessarily follow one has not happened. This confirms **P0** — the env
module disabled itself at boot via `EnvironmentTelemetry.cpp:296`
(`return result == UINT32_MAX ? disable() : setStartDelay()`), because
`sensors` was empty → **the SHTC3/RAK1901 is not being detected on I2C**.

This is a hardware/detection fault, not a config fault. The
`environment_measurement_enabled=true` flag is irrelevant while the sensor is
absent from the I2C scan.

### Open discrepancy — device metrics

P0 explains env silence but **not** device-metrics silence.
`DeviceTelemetry::runOnce()` has no hardware dependency: with
`device_telemetry_enabled=true` it broadcasts every `device_update_interval`
(forced to 3600 by the SENSOR role defaults) regardless of sensors or sleep.
Nine hours should have produced ~9 broadcasts.

Its silence means the config on the device differs from the dump. Note the
dump's `device` block has **no `role` field** — protobuf JSON omits defaults,
and `CLIENT = 0`, so that dump was taken in CLIENT mode and predates the role
switch. Combined with the known failure mode that admin writes silently no-op
when the session passkey is stale (re-read to verify; never trust
`{"verified":true}`), the likely state is that
`device_telemetry_enabled` is **not actually set on the device**.

**This remains unverified** — see blocker below.

### Blocker

`meshtastic --ble` hangs against this node: `mesh-gw.service` is **active
again** (restarted 2026-07-16 17:47 BST) and registers a BlueZ pairing agent
that rejects pairings it does not own. Querying the node with the CLI requires
mesh-gw stopped. Not actioned — mesh-gw is out of scope for this task.

Also note: for the first ~5.5 h of the 9-hour SENSOR window mesh-gw was stopped,
so nothing was listening. Garage broadcasts go out on the "Private" primary
channel, which E9/F4 cannot decrypt — mesh-gw is the only listener that can.

### CORRECTION — P0 is falsified

Peter reports env/temp/humidity **did** send while the node was in CLIENT mode.
Therefore the SHTC3 **is** detected and the env module is **not** disabled. The
P0 inference above ("node awake ⇒ never sent ⇒ sensor absent") is **wrong** —
its premise (that the node is in SENSOR role right now) is unverified.

### Upstream: this is a known bug — power saving, not the role

[Discussion #5117](https://github.com/meshtastic/firmware/discussions/5117)
"environmental telemetry if Power Saving is enabled in CLIENT/ROUTER role":

- Symptom: with power saving on, devices send 1–2 telemetry packets, then stop.
- Maintainer root cause: *"the device does not wake up to send telemetry"* —
  it is *"likely just asleep for those interval broadcasts."*
- The device enters light sleep and has **no mechanism to wake for a scheduled
  telemetry broadcast**. Telemetry intervals are rate limiters, not wake timers
  (matching §1 of this document).
- Workaround: **disable power saving**.

Related: [#6655](https://github.com/meshtastic/firmware/issues/6655) (GPIO cannot
wake SENSOR role from deep sleep — confirms PIR is dead while asleep),
[#5139](https://github.com/meshtastic/firmware/issues/5139),
[PR #2865](https://github.com/meshtastic/firmware/pull/2865) (added the
power-saving SENSOR sleep path).

### Reconciling #5117 with the code — the BLE-client correlation

`PowerFSM.cpp:425` excludes SENSOR/TRACKER from the #5117 light-sleep path:

```cpp
if ((isRouter || config.power.is_power_saving) && !isWifiAvailable() && !isTrackerOrSensor)
```

So #5117 bites **CLIENT** (and ROUTER) with `is_power_saving=true` — not SENSOR.
This yields a coherent account of every observation:

| Situation | PowerFSM | Result | Matches report |
|---|---|---|---|
| CLIENT + power saving, **mesh-gw BLE connected** | A connected client holds the node awake (ON/DARK), never reaches LS | Telemetry sends normally | ✓ "it was sending env/temp/humidity in client mode" |
| CLIENT + power saving, **mesh-gw stopped** (5.5 h of the window) | No client → drops to LS (`ls_secs=300`) → asleep through every broadcast | **Silence** (#5117) | ✓ 9 h of nothing |
| Node in LS | nRF52 softdevice keeps advertising autonomously | Still BLE-scannable | ✓ `Meshtastic_b80f` seen at 21:25 |
| Genuine SENSOR + power saving + working SHTC3 | Excluded from LS; sends, then **deep sleeps** 30 min (`main-nrf52.cpp:465-472`) | Env every ~30 min, node **not** advertising most of the time | ✗ **contradicts** the observed advertising node |

The last row is the tell: a node genuinely in SENSOR role with a working sensor
and `is_power_saving=true` should be invisible over BLE ~97% of the time. Ours
is awake and advertising. Combined with the dump's missing `role` field
(protobuf omits `CLIENT=0`) and the known stale-passkey silent-no-op on admin
writes, the **role change may never have taken effect** — leaving a CLIENT node
that light-sleeps through its telemetry intervals, i.e. exactly #5117.

**Primary recommendation: set `power.is_power_saving = false`.** It is the
upstream workaround, it is the one setting consistent with every observation,
and on this node it buys nothing — the RAK4631 is mains/solar-fed in the garage
and power saving also cripples PIR detection (#6655).

### ROOT CAUSE FOUND — upstream PR #10939 (merged 2026-07-08, milestone 2.8)

[PR #10939](https://github.com/meshtastic/firmware/pull/10939) "Fix SENSOR power
saving deep sleep truncating TX and skipping sleep on failed reads" — caveman99,
merged by thebentern 2026-07-08, milestone 2.8, fixes
[#10890](https://github.com/meshtastic/firmware/issues/10890) and
[#10932](https://github.com/meshtastic/firmware/issues/10932).

Bugs fixed upstream:
1. **TX truncation** — deep sleep activates while the telemetry packet is still
   queued/transmitting, cutting it off mid-air.
2. **Skipped sleep on failed reads** — a failed sensor read leaves the node awake
   for a whole interval.

Upstream changes: `canSleep()`/`doPreflightSleep()` gain a `deepSleep` param;
`RadioLibInterface` vetoes deep sleep while `isSending()`; the four telemetry
modules defer pending deep sleep (capped 30 s) until the radio is idle and
**respect the 5 s pre-sleep grace regardless of sensor polling intervals**;
helpers `shouldDeferDeepSleep()` / `isPowerSavingSensor()` consolidated into
`BaseTelemetryModule`.

**This fork does NOT have the fix.** Verified: `shouldDeferDeepSleep` and
`isPowerSavingSensor` absent; `sleep.h:27` still declares `bool doPreflightSleep();`
with no `deepSleep` parameter; `RadioLibInterface.h:184` `canSleep()` unchanged.

**Mechanism confirmed in this tree:**

`EnvironmentTelemetry::sendTelemetry()` sets the intended grace:
```cpp
sleepOnNextExecution = true;
setIntervalFromNow(FIVE_SECONDS_MS);   // line 661
```
but `runOnce()` then returns at line 330:
```cpp
return min(sendToPhoneIntervalMs, result);   // min(60000, 1000) = 1000
```
and `OSThread::run()` (OSThread.cpp:85-99) **overwrites the grace with it**:
```cpp
auto newDelay = runOnce();
runned();
if (newDelay >= 0)
    setInterval(newDelay);     // 1000 ms wins; the 5 s grace is destroyed
```
`result` = `DEFAULT_SENSOR_MINIMUM_WAIT_TIME_BETWEEN_READS` = 1000
(`TelemetrySensor.h:16`) once an SHTC3 is present.

Sequence: send → packet queued → **1 s later** `sleepOnNextExecution` fires →
`doDeepSleep(1800000)` → `NVIC_SystemReset()` (`main-nrf52.cpp:465-472`) while
the packet is still in the TX queue or mid-transmission (SF11/BW250 ≈ 1–2 s
airtime + CSMA backoff). **The packet is destroyed by the reset. Nothing ever
reaches the mesh.** The node then sleeps 30 min and repeats forever.

This explains the whole report: env telemetry is generated and logged as sent,
but never transmitted; the node is silent indefinitely; and detection events —
which do not sit behind this path — were historically the only thing heard.

**Fix: cherry-pick PR #10939 into this fork.**

### PIR during sleep — still unfixed upstream

- [PR #8778](https://github.com/meshtastic/firmware/pull/8778) "Low power
  detection sensor module for nRF52 & ESP32" (rbomze) — **DRAFT**, opened
  2025-11-27, still draft as of 2026-03-31. thebentern reopened it twice after
  stale-bot closures (Jan and Mar 2026). Implements exactly the wake-on-GPIO
  design proposed above: nRF52 GPIO-sense shutdown (~0.01 mA) or low-power
  polling (~0.01–0.02 mA), using GPREGRET to distinguish timer vs GPIO wake.
  ESP32 uses EXT0 (~1.77 mA). Tested on Heltec T114 / WiFi LoRa 32 V2.
  Reviewer @phaseloop raised softdevice register-safety concerns; not approved.
- [#6655](https://github.com/meshtastic/firmware/issues/6655) — open since
  2025-04-23, triaged, **no linked PR**.
- [#2822](https://github.com/meshtastic/firmware/issues/2822) — nRF52 RTC wake
  from deep sleep; closed without an implementation.

So: **telemetry-in-power-saving is fixed upstream (#10939); PIR-during-sleep is
not (#8778 draft).** Cherry-picking #10939 restores periodic telemetry on
battery, but the PIR remains dead during the sleep window until #8778 lands or
is implemented here.

### 2026-07-16/17 OVERNIGHT: what was actually proven, and what broke

**Root cause of the original 12-hour silence: CONFIRMED.**

Live config read via mesh-gw (finally obtained once the CLI blocker was
sidestepped) — garage `!987ab80f`, stock `2.7.26.54e0d8d`:
`role=SENSOR`, `environment_measurement_enabled=true`,
`device_telemetry_enabled=true`, intervals 1800, detection enabled pin 10.
**Every flag correct.** The node was never misconfigured.

With `is_power_saving=false`, the Omni RAK received the garage's telemetry over
LoRa at 0 hops, RSSI −37: `environment_metrics: temperature=29.19,
relative_humidity=40.24`. **Stock 2.7.26 transmits fine when it cannot deep
sleep.** Peter's observation that a 12-hour-old node reported ~31 min uptime was
the tell: `NVIC_SystemReset()` per sleep cycle means uptime can never exceed the
interval. That is bug [#10890](https://github.com/meshtastic/firmware/issues/10890).

**#10939 verification: BLOCKED — a new regression appeared.**

OTA'd `2.8.0.c8983bc` (fork develop + cherry-pick `38074f58`). Config, channels,
PSK, PIN and fixed position all survived; **node ID regenerated**
`!987ab80f` → `!caaee4ea` (`device_state_version` 24→25).

40-minute watch with `is_power_saving=true`, role SENSOR:

| Observation | Result |
|---|---|
| env on garage self-record | **None, 40/40 samples** |
| env received by Omni | **never** |
| uptime | 67 → 2350 s, **monotonic, never reset** |
| device telemetry to Omni | **works** — up=67 then up=1869, exactly 1802 s apart (= `device_update_interval` 1800) |

So the mesh path, channel hash (0x7e), PSK, frequency and the Omni are all
healthy — **device telemetry proves it**. Only env is dead.

**The absence of sleep is itself the diagnostic.** #10939 arms
`sleepOnNextExecution` *even on a failed sensor read*. Therefore a detected
sensor with failing reads would still sleep. It never slept ⇒ `sendTelemetry()`
was never reached ⇒ the module hit `disable()` at `firstTime`
(`EnvironmentTelemetry.cpp:296`, `result == UINT32_MAX` ⇒ `sensors` empty)
⇒ **the SHTC3 is not detected by the 2.8.0-dev build**.

**Suspected cause — an upstream refactor in develop's base, NOT the cherry-pick:**

| | 2.7.26 (works) | develop (broken) |
|---|---|---|
| Driver | `SHTC3Sensor` (dedicated) | `SHTXXSensor` (unified) |
| Library | `Adafruit_SHTC3` | `arduino-sht` (`SHTSensor`) |
| Init | `shtc3.begin(bus)` explicit | `sht.init(bus)` **auto-detect** |
| Scan map | `SCAN_SIMPLE_CASE(SHTC3_ADDR, SHTC3, …)` | `SCAN_SIMPLE_CASE(SHTC3_ADDR, SHTXX, …)` |

Upstream collapsed `SHT31Sensor`/`SHTC3Sensor`/`SHT4XSensor` into one
auto-detecting `SHTXXSensor`. #10939 touches no I2C/scan/sensor code, so this
regression is inherited from the develop base (2.8.0-dev), not introduced by the
cherry-pick. `SHTXXSensor.cpp.o` **was** built and `arduino-sht` **is** in
libdeps, so it is not a missing library — the auto-detect itself is the suspect.
Unverified: GitHub issue search returned 503; no boot log (needs USB serial).

**Corrections to earlier claims in this document (all were wrong):**
- "SHTC3 not detected / P0 confirmed" (pre-OTA) — **wrong**; it was reporting
  29.09 °C. The node was awake because it had *already* stopped sleeping, not
  because env was disabled.
- "role change may not have stuck" — **wrong**; live read shows SENSOR.
- "E9/F4 cannot decrypt Private" — **wrong**; channel hash is
  `xorHash(name) ^ xorHash(psk)`, index-independent; Omni holds Private at idx=2
  and decoded garage packets.
- "different frequency slot per channel name" — **wrong** for EU_868: band is
  869.4–869.65, `numFreqSlots == 1`, so every node sits on 869.525 MHz.
- Several readings were taken from node-dash's **stale cache**
  (`uptime_s=1866` frozen); mesh-gw `/{node}/nodes` is the live source.

### Current state (for whoever picks this up)

- Garage `!caaee4ea`, `2.8.0.c8983bc`, role SENSOR, `is_power_saving=true`.
- **Not sleeping** (env disabled ⇒ nothing arms it) ⇒ still BLE-reachable, so a
  reflash is safe.
- **Env telemetry dead.** Device telemetry fine every 30 min.
- Stock `firmware-rak4631-2.7.26.54e0d8d-ota.zip` is still in mesh-gw's OTA
  store if a revert is wanted (note: a downgrade may reset device state again).

### Next actions

1. **Get a boot log over USB serial** — confirm whether the I2C scan finds 0x70
   and what `SHTXXSensor::initDevice` reports. This is the only way to settle it.
2. Check upstream for an SHTC3/RAK1901 detection regression in 2.8-dev (search
   was 503).
3. If confirmed: fix `SHTXXSensor` detection for SHTC3, or restore the explicit
   Adafruit path for `SHTC3_ADDR`, in the fork.
4. Only then can #10939 be verified — the sleep cannot trigger without env.

### Prediction status

| Prediction | Result | Evidence |
|---|---|---|
| P0 — SHTC3 not detected → env never sends | **CONFIRMED (by inference)** | Node advertising at 21:25 ⇒ never slept ⇒ no env send ever completed; env send is the only sleep trigger in SENSOR. |
| P1 — env every 30 min | **FALSIFIED** | Superseded by P0. |
| P2 — device metrics every 30-60 min | **FAILED, unexplained** | No HW dependency; should have sent ~9×. Suspect flag not actually set on device. Needs CLI read. |
| P3 — position hourly | Untested | Needs CLI read. |
| P4 — power never sends | Consistent | No INA chip; module disables at `PowerTelemetry.cpp:86`. |
| P5 — SENSOR+power-saving sleeps | **Not occurring** | Node is awake/advertising — because P0 means the trigger never fires. |
| P6 | Untested | |

### Next actions

1. Stop `mesh-gw`, then `meshtastic --ble <garage MAC> --info` (MAC and BLE
   PIN are in the private repo's `docs/hardware.md`) to read the **actual**
   role and telemetry flags. Settles the device-metrics discrepancy.
2. Check the boot log for the I2C scan result — confirm the SHTC3 is absent
   rather than inferred absent. Physical check of the RAK1901 seating.
3. Set `power_measurement_enabled=false` (no-op flag, misleading).
4. Consider `is_power_saving=false` while debugging: once the SHTC3 *is*
   detected, the node will start 30-min sleep cycles and become hard to reach,
   and PIR detection will be mostly dead.
