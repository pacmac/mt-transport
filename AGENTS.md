# mt-transport

**Meshtastic as a transport, not an operating system.**

A minimal library that sends **and receives** Meshtastic-compatible encrypted
LoRa packets from a bare RadioLib sketch:

```cpp
mesh.send(PortNum_DETECTION_SENSOR_APP, payload, len);
mesh.receive(rxWindowMs, pkt);            // bounded window — see docs/rx-and-commands.md
```

No NodeDB. No router. No PowerFSM. No filesystem. No BLE stack. **No opinion
about when your CPU sleeps** — that belongs to the application.

RX is in scope: a remote device that can only talk has no config, no OTA
trigger, no interrogation. Decode is ~50 lines (AES-CTR is symmetric — the
fork's `decrypt()` literally calls `encryptPacket()`). The cost is **power**, not
code: continuous RX ≈ 10-15 mA is fatal to the budget, so the device is **deaf by
default** and opens a Class-A style listen window after each TX
(~4 mAh/day total ⇒ ~13 years). Worst-case command latency = one heartbeat.
**Replay is a real attack on an alarm** — CTR gives confidentiality, not
freshness. See `docs/rx-and-commands.md`.

**Important**: Update `CHANGELOG.md` after making any changes to this project.

## Status

**Spike PASSED 2026-07-17.** `examples/SpikeSend/` is proven wire-compatible:
a real Meshtastic node decodes its packets (0 hops, RSSI −51). See
`docs/spike.md` §Results. `docs/spec.md` is the design; the library gets
written by refactoring the working spike code.

## Why this exists

Read `docs/background.md` first — it is the evidence, not an opinion. Summary:

A remote garage alarm (RAK4631 + PIR + SHTC3, Li-SOCl2 primary cell) needs to
sleep at ~30 µA, wake on PIR, and heartbeat periodically. Meshtastic's SENSOR
role cannot do this, and a 2026-07-16 investigation found the cause is
structural — Meshtastic owns the scheduler, power, peripheral rails, storage,
identity and boot, and each of those broke the use case:

| Failure | Owner |
|---|---|
| 5 s pre-TX grace silently overwritten → deep sleep truncated every packet for 12 h | OSThread scheduler |
| Blind 30-min `delay()` sleep, uninterruptible, no GPIO wake | `cpuDeepSleep` |
| PIR's WisBlock rail cut before sleep (`PIN_3V3_EN` LOW) | shutdown path |
| GPREGRET values that can format LittleFS or strand the node in DFU | boot path |
| 81-node NodeDB on a leaf that talks to one gateway | NodeDB |
| Node identity regenerated on 2.7→2.8 (`device_state_version` 24→25) | device state |
| SHTC3 driver refactor (Adafruit → arduino-sht auto-detect) silently killed env telemetry | sensor layer |

The shipped nRF52 sleep path still carries its own admission:

```c
// FIXME, configure RTC or button press to wake us
sd_power_mode_set(NRF_POWER_MODE_LOWPWR);
delay(msecToWake);
NVIC_SystemReset();
```

SENSOR mode was an afterthought and has never had an owner: GPIO wake
unimplemented ([#6655](https://github.com/meshtastic/firmware/issues/6655), open
since Apr 2025, no PR), nRF52 RTC wake closed unimplemented
([#2822](https://github.com/meshtastic/firmware/issues/2822)), TX truncation
unfixed until 2026-07-08 ([#10890](https://github.com/meshtastic/firmware/issues/10890)
/ [#10939](https://github.com/meshtastic/firmware/pull/10939)), and the only
low-power detection attempt is a stalled draft
([#8778](https://github.com/meshtastic/firmware/pull/8778), draft since Nov 2025).

**Not a reason to build this: power.** Both a stripped Meshtastic (~4 mAh/day)
and bare-metal (~2 mAh/day) land past a 19 Ah Li-SOCl2 cell's ~10-year
self-discharge-limited life. Build it for **ownership and reliability**, not
microamps. That argument does not survive contact with the battery's shelf life.

## Scope

**In:** send and receive Meshtastic-compatible encrypted packets on a named
channel; a command channel over RX windows (config, interrogation, OTA trigger).

**Out (deliberately):** routing/relaying, NodeDB, position, MQTT, BLE stack,
storage, **sleep policy** (the application owns sleep — that is the entire
point).

## Docs — read in this order

| file | what |
|---|---|
| `docs/background.md` | **why** — the 2026-07-16 investigation. Evidence, not opinion. |
| `docs/wire-format.md` | the verified format. Every fact cites `file:line` in the fork. |
| `../pac-garage-alarm/docs/hardware.md` | **private repo** — nodes, PSKs, the oracle, gateway rules, deployment constraints |
| `docs/rx-and-commands.md` | RX windows, power budget, replay security |
| `docs/spec.md` | the design + the spike gate |

## Hardware / test rig

See `../pac-garage-alarm/docs/hardware.md` (private repo — nodes, PSKs, BLE
PIN, gateway rules live there, **not** here). Short version:

- **Spike target**: RAK4631 "PAC Garage" `!caaee4ea`. On the bench. Its
  Meshtastic env telemetry is already broken, so there is nothing to lose by
  reflashing it.
- **Oracle**: RAK4631 "Peter Omni RAK" `!2687afb1`, E9:B0:3F:17:27:91. Always
  awake, `rebroadcast_mode: ALL`, holds the `Private` channel, and has been
  **proven** to decode garage packets (0 hops, RSSI −37). If it decodes our
  packet, we are wire-compatible.
- **Gateway**: mesh-gw on `:8001` (BLE→JSON bridge, owns all BLE), node-dash on
  `:8000`. **Never use `bluetoothctl`.** `meshtastic --ble` hangs while mesh-gw
  runs — its BlueZ pairing agent rejects it.

## Reference implementation

The Meshtastic fork is at `/usr/share/pac/dev/projects/mt-radar/firmware/src`
(a git repo despite the name; `origin`=pacmac/firmware,
`upstream`=meshtastic/firmware). **Read it for the wire format; do not depend on
it.** Every `file:line` in `docs/wire-format.md` points there.

It is also the **oracle for byte-diffing**: capture what real firmware emits on
`Private` and compare against our output.

## Build

PlatformIO, `env:rak4631`. Dependencies are deliberately tiny:
RadioLib + nanopb + an AES-CTR implementation. `protobufs/` should be added as a
submodule of `github.com/meshtastic/protobufs` — **do not hand-roll the
protobufs**, and do not reach into the fork's copy.

## House rules

- Every claim in the docs cites a `file:line` in the fork. If you cannot cite
  it, verify it before writing it down.
- The spike gates everything. If the Omni does not decode our packet, the
  library does not get written.
