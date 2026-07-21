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

## Status: TX + RX + command handshakes, proven on air (0.4.x)

The spike gate (`docs/spike.md`) passed 2026-07-17; the same day the library
grew `receive()` (filtered, decrypted, deduped), protocol ACKs, same-id
`resend()` for one-shot messages on lossy links, CSMA listen-before-talk on
every transmit (fail-open), and threaded replies (`Data.reply_id`). All of
it verified over the air against real Meshtastic 2.7/2.8 nodes, and running
in a live field deployment at 2.3 km. Known limitation: Meshtastic 2.8
rejects PSK-encrypted direct messages ("legacy DM") — commanding rides on
broadcasts within a private channel until X25519 PKI lands. The API will
still move; SemVer is honest.

**Airtime accounting (0.4.x)** is ported from Meshtastic's `AirTime`: occupancy
accumulates into **fixed rolling windows** held as rings of buckets, rotated on
`millis()` on both read and write (buckets skipped while the radio was quiet are
zeroed, so stale airtime cannot inflate the window). The two windows are
deliberately different: **channel** utilisation uses **6 × 10 s = 60 s**, short
enough to size the contention backoff responsively, while **TX** utilisation uses
**60 × 1 min = 1 h**, the span that matters for duty cycle. Exposed as
`channelUtilizationPercent()` / `utilizationTxPercent()` — each divides by its own
fixed denominator and is bounded 0..100 by construction. That utilisation sizes the CSMA contention window in
`getTxDelayMsec()`, which is a scheduled `millis()` offset, never a blocking
`delay()`. The earlier reader-reset API (`airWindowMs()` + `resetAirWindow()`)
is **gone**: it made the denominator "time since the caller last read", which
produced meaningless ratios and mis-sized the backoff.

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

    mt::RxPacket rx;                 // bounded listen (Class-A ready);
    if (mesh.receive(50, rx))        // loop it for continuous RX
        handle(rx);                  // filtered, decrypted, deduped
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
