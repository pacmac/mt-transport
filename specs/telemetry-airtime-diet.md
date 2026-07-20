---
task: telemetry-airtime-diet
status: implemented 2026-07-20 (260720-7, flashed + verified on air)
priority: HIGH — periodic telemetry competes with chunk transfer on a ~17%-loss link
source_hash:
  projects/pac-garage-alarm/src/main.cpp: 271f38327622be6cec6ca5e506f8033f0f0cc0bffbf9f2669cc621f65ef984c8
scope:
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: telemetry-airtime-diet — stop spending air on data that isn't changing

## Why

The heartbeat bundle sends **four** frames every heartbeat — `sendDeviceMetrics()`,
`sendEnvMetrics()`, `broadcastDebug()`, `broadcastCalc()` — plus nodeinfo+position
every `NODEINFO_EVERY_N` (20) beats. At the deployed 300 s heartbeat that is
**~48 frames/hour**, and DEBUG alone measured **168 B on air**.

That airtime is spent against a link measured at **~17% frame loss**, where a
32-chunk image already takes ~150 s and a pre-flight run timed out one chunk short.
Every periodic frame is contention the transfer has to survive.

The unit is **stationary** and its readings drift slowly, so most of that traffic
carries no new information.

## Changes (main.cpp only)

### 1. DEBUG becomes on-demand (biggest single win: 168 B per beat → 0)

Remove `broadcastDebug()` from **both** heartbeat bundles and add a `debug` command
that emits it. The DEBUG frame *is* the answer, so the text reply is suppressed
(`reply[0] = 0`) exactly as `chunk pull` does — a text ack would waste the airtime
this change exists to save.

Trade-off, accepted: we lose passive visibility of `csma/txfs/txdr/rxdt`. It is
recoverable on request, and a unit too broken to answer `debug` would not have got a
periodic frame out either.

### 2. Position becomes daily, decoupled from nodeinfo

Position currently rides `NODEINFO_EVERY_N` (~100 min at a 300 s beat) on a device
that does not move. Give it its own 24 h timer; nodeinfo keeps the beat counter
(identity refresh is cheap and useful).

First send still happens promptly after boot so the dashboard gets a position.

### 3. Compiled heartbeat default → 30 min

`heartbeatMs` default 60 s → 1 800 s. **This does NOT change the deployed unit** —
`heartbeatMs` is persisted and the unit holds 300 s in flash, which survives a
reflash. The default only governs a fresh/settings-lost unit, so it is a safety net
against degrading to a chatty 60 s beat.

**The live change is a command:** `interval 1800`.

### 4. Change-gated sending — SHIPPED (Peter chose to do it now, not park it)

Because there is **no OTA**, "add it later" costs a site visit — so it went in before
deployment rather than after. Settings **v6** (migrated from v5, verified preserving
the deployed unit's tuning).

- `sendDeviceMetrics()` gates on **battery** only — uptime and air_util change every
  beat by definition and would defeat the gate.
- `sendEnvMetrics()` gates on temp (±0.5 °C) / humidity (±2 %RH).
- `broadcastCalc()` gates on consumed mAh (±5).
- **Keepalive floor** (`teleKeepaliveMs`, default 6 h): a frame silent that long is
  sent regardless, so silence stays diagnostic — without it "nothing changed" and
  "the unit is dead" are indistinguishable.
- **`telemetry [<onchange 0|1> [<keepalive_min>]]`** — persisted. `onchange 0` is the
  **safety valve**: reverts to sending every beat if the gate misbehaves in the
  field. Persisted precisely so a reboot cannot silently re-enable a bad gate.

**NOT gated: position and nodeinfo.** Peter: *"my db might get reset and if so it
will never know it's position"*. These are **receiver-recovery** data — gating
assumes the receiver keeps state, which does not hold across a DB reset. A value
that never changes would never be re-sent. They stay on timers.

Deadbands are compile-time: sensor-physics constants, not operational tuning, and
every extra remote knob is another thing that can be set wrong on an unreachable
unit.

Unchanged: alarm/detection paths — those are event-driven and must stay immediate.
A change-gate there would be a safety defect, not an optimisation.

## Safety note

In `sleepMode` the device only listens in a ~8 s window after each heartbeat, so a
30-min beat would mean 30-min command latency. `slp:0` today (always awake), so this
is safe — **sleep must not be enabled without revisiting the heartbeat interval.**

## Verify

1. Static: `broadcastDebug()` gone from both bundles, present in the `debug` command.
2. Functional: `debug` command returns a DEBUG frame on port 260; bundle no longer
   carries one.
3. Regression: chunk transfer still completes; `ping`/`status` still answer.
