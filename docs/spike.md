# THE SPIKE — one packet, one verdict

**Timebox: one hour of active work.** This is the gate from `spec.md` §THE
SPIKE: no library code gets written until it passes.

## Pass criterion — exactly one

A bare RadioLib sketch (`examples/SpikeSend/`) transmits one
Meshtastic-compatible encrypted packet, and the oracle node — a stock-ish
Meshtastic RAK4631 that is always awake and holds the same channel — shows the
spike's node number in its NodeDB with our `device_metrics`:

```bash
curl http://localhost:8001/<oracle-node-id>/nodes   # keyed by node NUMBER
```

Nothing else counts. Not "TX completed", not RSSI on a spectrum scope, not a
serial log saying sent. The oracle either decoded us or it did not.

- **Pass ⇒** wire-compatibility is proven; the library gets written by
  refactoring the working spike code, so any later breakage is provably the
  refactor.
- **Fail ⇒** one hour lost, findings recorded below, and the
  fork-the-firmware route continues. That is also a result.

## The packet (values from `wire-format.md`, verified against the fork)

1. nanopb-encode `Data{ portnum: TELEMETRY_APP, payload: Telemetry{device_metrics} }`
2. Encrypt those bytes: AES128-CTR, 16-byte PSK, nonce =
   `packetId (u64 LE) ‖ fromNode (u32 LE) ‖ 4 zero bytes`
3. Prepend the 16-byte cleartext header:
   `to=0xFFFFFFFF, from=<node num>, id=<RNG>, flags=0x63, channel=<hash>, next_hop=0, relay_node=0`
4. TX: 869.525 MHz, BW 250 kHz, SF11, CR 4/5, sync `0x2B`, preamble 16, CRC on

## Decisions

| decision | choice | why |
|---|---|---|
| From-node number | fresh (not an existing node's) | appears unambiguously as a NEW entry in the oracle's NodeDB; immune to stale-cache confusion |
| Packet id | nRF52 hardware RNG | the id is the CTR nonce — reuse is keystream reuse, and a fixed id would also be a replay |
| Channel hash | computed from `secrets.h` at runtime | `xorHash(name) ^ xorHash(psk)` — hardcoding would silently break on any channel change |
| Flash path | USB serial DFU | node is on the bench; BLE stays out of the loop; bootloader untouched |
| TX power | low (~2 dBm) | oracle is metres away; 27 dBm would be pointless and unneighbourly |
| AES library | decided during implementation | candidate 1: rweather/Crypto (same lib the reference firmware uses, so CTR semantics match by construction); fallback mbedtls. Record the outcome below. |

## Order of trust — host oracle before radio

Before any flash, the exact bytes the sketch builds are verified on the host:
parse header → check channel hash → AES-CTR decrypt with the real PSK →
protobuf-decode → assert every field round-trips (`tools/spike_oracle.py`).

If the host oracle passes, the only remaining failure modes are PHY-level
(frequency, SF/BW, sync word, preamble, CRC) — a small, enumerable space.
If it fails, fix on the host with zero flash cycles.

## Contingency (only on fail, and only after checking in)

Byte-diff against real firmware: flash a RadioLib RX sketch to capture what a
genuine Meshtastic node emits on the same channel, and diff against our
output. Not done up front — the host oracle covers the same ground cheaper.

## Recovery

The spike overwrites Meshtastic on the target node. The Adafruit bootloader is
untouched (DFU lives there, not in the app), and the stock
`firmware-rak4631-2.7.26` OTA zip is retained on the gateway for a re-flash.

## Results

| item | value |
|---|---|
| Date | 2026-07-17 |
| Verdict | **PASS** |
| Oracle NodeDB entry | node `1528619009` (`0x5b1ce001`), `device_metrics: {battery_level: 101, voltage: 3.6, uptime_seconds: 127}` — exactly what the sketch encoded |
| RSSI / SNR / hops | −51 / 6.2 / 0 |
| AES library chosen | rweather arduinolibs via PIO registry **`operatorfoundation/Crypto`@0.4.0** (`rweather/Crypto` is not in the registry). Same `CTR<AES128>` + `setCounterSize(4)` the reference `CryptoEngine` uses. |
| Elapsed active time | ~30 min (inside the one-hour box) |
| Frame verified | `ffffffff01e01c5bd850be0a637e0000dcdc…` — device's actual TX output also passes `tools/spike_oracle.py` (host decrypt + decode with the meshtastic python protobufs) |

### Surprises / build notes (for the library task)

- **PIO's bundled Adafruit nRF52 core has no RAK4631 board or variant.** Both
  are vendored from the reference firmware: `boards/wiscore_rak4631.json` +
  `variants/WisCore_RAK4631_Board/variant.{h,cpp}`, wired up with
  `board_build.variants_dir = variants`. The library's examples will need the
  same arrangement (or an upstreamed variant).
- Step note had **BUSY wrong** (39): real pins are CS 42 / DIO1 47 / RESET 38 /
  **BUSY 46**, plus **`SX126X_POWER_EN` 37 must be driven HIGH** and TCXO on
  DIO3 at **1.8 V** (`variants/nrf52840/rak4631/variant.h`).
- `setCounterSize(4)` (`CryptoEngine.cpp:388`) — rweather CTR's default differs;
  without this, payloads spanning one AES block would decrypt as garbage.
- Adafruit TinyUSB CDC drops output unless **DTR is asserted** — `cat` on the
  port shows nothing; use pyserial with `dtr = True`.
- nanopb generator 0.4.9 from pip == the fork's version; protobufs submodule
  pinned to the fork's exact rev `36251667`.
