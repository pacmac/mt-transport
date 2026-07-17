---
task: transport-lib
status: active
updated: 2026-07-17
---

# Spec: extract MeshtasticTransport from the passing spike (TX only)

## Goal

The public library exists and is provably no worse than the spike. SpikeSend
consumes it, and the Omni decodes both message types: telemetry (regression)
and a new NODEINFO_APP User packet ("MT Spike"/"SPKE") that makes the node
appear by name. Pass criterion unchanged: the Omni's NodeDB, nothing else.

## API (deviations must update this spec)

```cpp
struct MeshChannel  { const char *name; const uint8_t *psk; size_t pskLen; };
struct RegionParams { float freqMHz; float bwKHz; uint8_t sf; uint8_t cr;
                      uint8_t syncWord; uint16_t preambleLen; };
extern const RegionParams MT_EU868_LONG_FAST; // 869.525 / 250 / 11 / 5 / 0x2b / 16

class MeshtasticTransport {
public:
    // App owns the radio object (pins/wiring are board problems) and supplies
    // entropy (packet id = CTR nonce; predictable ids are a crypto failure).
    // begin() applies the PHY config sequence and fails without entropy.
    bool begin(SX1262 &radio, const RegionParams &region, const MeshChannel &ch,
               uint32_t nodeNum, uint32_t (*rng)());

    // portnum + pre-encoded protobuf payload. The library does not know about
    // Telemetry/User — message construction is the app's job.
    bool send(uint32_t portnum, const uint8_t *payload, size_t len,
              uint32_t to = 0xFFFFFFFF, uint8_t hopLimit = 3);

    bool busy();   // trivial while transmit() is blocking; real with RX work
    void sleep();  // radio to sleep; the app owns CPU sleep
};
```

## Files in scope

| file | action |
|---|---|
| `specs/transport-lib.md` | this file (new) |
| `src/MeshtasticTransport.{h,cpp}` | new — begin/send/busy/sleep |
| `src/mt_wire.{h,cpp}` | new — PacketHeader, xorHash, flags (verbatim from spike) |
| `src/mt_crypto.{h,cpp}` | new — nonce, CTR wrapper, setCounterSize(4), key-length cipher select |
| `src/generated/**` | moved from `examples/SpikeSend/src/generated/` |
| `examples/SpikeSend/src/main.cpp` | shrinks to wiring + messages + library calls; add NODEINFO |
| `examples/SpikeSend/platformio.ini` | `lib_extra_dirs = ../..`; drop `-Isrc/generated` |
| `tools/spike_oracle.py` | extend: decode NODEINFO/User frames |
| `library.json` | 0.1.0; export keeps `src/generated`, drops example vendoring |
| `README.md` | status + usage snippet |
| `CHANGELOG.md` | [0.1.0] |

## Out of scope

RX, sleep policy, pac-garage-alarm firmware, region table beyond EU_868.

## Verify order

1. Both build. 2. Serial FRAMEs pass the oracle (telemetry PASS + User decodes).
3. Flash. 4. Omni entry `1528619009` gains `user{MT Spike, SPKE}`, telemetry
   still advancing, two reads ≥30 s apart.
