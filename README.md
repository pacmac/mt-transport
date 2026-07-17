# mt-transport

**Meshtastic as a transport, not an operating system.**

A minimal PlatformIO library for sending **and receiving** Meshtastic-compatible
encrypted LoRa packets from a bare [RadioLib](https://github.com/jgromes/RadioLib)
sketch:

```cpp
mesh.send(PortNum_DETECTION_SENSOR_APP, payload, len);
mesh.receive(rxWindowMs, pkt);   // bounded Class-A style listen window
```

No NodeDB. No router. No power state machine. No filesystem. No BLE stack.
**No opinion about when your CPU sleeps** — that belongs to your application.

## Status: TX works, proven on air (0.1.0). RX planned.

The spike gate (`docs/spike.md`) **passed 2026-07-17**: a real Meshtastic
node decodes this library's packets into its NodeDB — telemetry and NODEINFO
both, at 0 hops, RSSI −51. Receive windows and a command channel
(`docs/rx-and-commands.md`) are the next milestone; the API will move until
then.

```cpp
#include <MeshtasticTransport.h>

SX1262 radio = new Module(PIN_CS, PIN_DIO1, PIN_RESET, PIN_BUSY); // your board
mt::MeshtasticTransport mesh;

void setup() {
    mt::MeshChannel ch = {"YourChannel", psk, sizeof(psk)};
    // You bring the radio object and the entropy source — the packet id is
    // the AES-CTR nonce, so begin() refuses a null RNG.
    mesh.begin(radio, mt::EU868_LONG_FAST, ch, nodeNum, hwRand32);
    mesh.send(meshtastic_PortNum_TELEMETRY_APP, buf, len); // pre-encoded protobuf
}
```

See `examples/SpikeSend/` for the complete working sketch.

## Why

Meshtastic firmware is an application with a transport inside it, not a
transport with app features — the radio path has no seam to cut (measured in
`docs/spec.md`). For a battery leaf device (sensor, alarm, tracker) that must
own its own sleep, the firmware's scheduler, power FSM, peripheral-rail and
boot-path ownership each break the use case. `docs/background.md` is the
evidence: a device-level investigation that traced 12 hours of silent packet
loss to the firmware's deep-sleep path resetting the MCU mid-transmission
(meshtastic/firmware#10890).

If you have hit "my SENSOR-role node never sends telemetry on battery", that
document explains why.

## Scope

**In:** the wire format — PHY parameters, 16-byte header, channel hash,
AES-CTR payload encryption, protobuf `Data` payloads — for TX, and bounded
RX windows with a command channel (config, interrogation, OTA trigger).

**Out, deliberately:** routing/relaying, NodeDB, position, MQTT, BLE,
storage, and sleep policy.

## Docs

| file | what |
|---|---|
| [`docs/background.md`](docs/background.md) | why this exists — the investigation, evidence-first |
| [`docs/wire-format.md`](docs/wire-format.md) | the verified wire format; every fact cites firmware `file:line` |
| [`docs/rx-and-commands.md`](docs/rx-and-commands.md) | RX windows, power budget, replay security |
| [`docs/spec.md`](docs/spec.md) | design + the spike gate |

## License

GPL-3.0-or-later (see `LICENSE`). The wire format was documented from the
GPL-3.0 [Meshtastic firmware](https://github.com/meshtastic/firmware) —
attribution in `NOTICE`. Not affiliated with or endorsed by Meshtastic LLC.
