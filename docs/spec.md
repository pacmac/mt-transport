---
task: meshtastic-transport-lib
status: proposal (spike first — do NOT write the library before the spike passes)
source_hash: ~
updated: 2026-07-16
---

# Spec: `MeshtasticTransport` — Meshtastic as a transport, not an operating system

## Thesis

For a leaf sender (alarm, sensor, tracker) you need **one verb**:

```cpp
mesh.send(PortNum_DETECTION_SENSOR_APP, payload, len);
```

You do not need a node database, a router, an airtime governor, a power state
machine, a filesystem, a BLE stack, or an opinion about when your CPU sleeps.
Meshtastic supplies all of them whether you want them or not.

## Why no library exists (measured, not assumed)

The transport is welded to global application state. Reference counts in
`RadioLibInterface.cpp` / `RadioInterface.cpp` / `Router.cpp`:

| global | refs |
|---|---:|
| `config.` | 36 |
| `nodeDB` | 20 |
| `channels` | 19 |
| `router` | 10 |
| `moduleConfig.` | 9 |
| `airTime` | 9 |
| `owner.` | 8 |
| `service` | 6 |

`RadioLibInterface.cpp` includes `NodeDB.h`, `main.h`, `PowerMon.h`. There is no
seam to cut — this is an app with a transport inside it, not a transport with
app features. Hence: reimplement the wire format; do not try to extract it.

## Evidence this matters (from the 2026-07-16 investigation)

Every failure that night was an OS-ownership failure, not a radio problem:

| Failure | Owner |
|---|---|
| 5 s pre-sleep TX grace silently overwritten by a `runOnce()` return value | OSThread scheduler (`Thread::setInterval` recomputes `_cached_next_run`) |
| Blind 30-min `delay()` sleep, uninterruptible, no GPIO wake | `cpuDeepSleep` |
| PIR's WisBlock rail cut before sleep (`PIN_3V3_EN` LOW) | someone else's shutdown path |
| Filesystem-format / DFU-strand hazards via GPREGRET | boot path |
| 81-node NodeDB on a leaf that talks to one gateway | NodeDB |
| Node identity regenerated on 2.7→2.8 (`device_state_version` 24→25) | device state |

Upstream bug [#10890](https://github.com/meshtastic/firmware/issues/10890) ate
12 hours of telemetry silently. "Upstream fixes flow to you" cuts both ways —
upstream *bugs* flow too, and you cannot fix them on your own schedule.

## Scope

**In:** transmit a Meshtastic-compatible encrypted broadcast on a named channel.

**Out (deliberately):** receive/decode, routing/relaying, ACK/retry, NodeDB,
position, admin, MQTT, BLE, storage, sleep policy. Sleep belongs to the
*application* — that is the entire point.

## Wire format — everything the library must produce

All verified against this tree.

### 1. PHY (RadioLib SX1262)

| Param | Value (EU_868 LONG_FAST) | Source |
|---|---|---|
| Frequency | **869.525 MHz** | `freqStart + bw/2000 + padding + channel_num*slotWidth` (`RadioInterface.cpp:1226`) |
| Bandwidth | 250 kHz | `modemPresetToParams()` (`MeshRadio.h:197`) |
| Spreading factor | 11 | ditto |
| Coding rate | 5 | ditto |
| Sync word | `0x2B` | `RadioInterface` |
| Preamble | 16 | `preambleLengthDefault` |
| CRC | on | |

**Frequency slot:** EU_868 spans 869.4–869.65 with `spacing=0, padding=0`
(`PROFILE_EU868`, `RadioInterface.cpp:57`), so
`freqSlotWidth = 0.25`, `numFreqSlots = round(0.25/0.25) = 1`.
**Any hash % 1 == 0 → every EU_868 node is on slot 0 = 869.525 MHz**, regardless
of channel name. (Other regions have many slots; then
`channel_num = hash(primaryChannelName) % numFreqSlots` — see
`RadioInterface.cpp:1195`. Region `overrideSlot`: `0`=channel-name hash,
`-1`=preset-name hash, `>0`=explicit.)

### 2. Header — 16 bytes, little-endian (`RadioInterface.h:34-55`)

```
offset 0  uint32 to           0xFFFFFFFF for broadcast
offset 4  uint32 from         our node number
offset 8  uint32 id           packet id (must be non-zero, non-repeating)
offset 12 uint8  flags
offset 13 uint8  channel      channel hash (see below)
offset 14 uint8  next_hop     0 = unknown/any
offset 15 uint8  relay_node   0 = not relayed
```

`flags` bit layout (`RadioInterface.h:24-28`, packed at `:1360-1361`):

```
0x07  PACKET_FLAGS_HOP_LIMIT_MASK    hop_limit (bottom 3 bits)
0x08  PACKET_FLAGS_WANT_ACK_MASK
0x10  PACKET_FLAGS_VIA_MQTT_MASK
0xE0  PACKET_FLAGS_HOP_START_MASK    hop_start << 5
```

For a leaf sender: `hop_limit=3`, `hop_start=3`, `want_ack=0`, `via_mqtt=0`
→ `flags = 3 | (3<<5) = 0x63`.

> **`next_hop`/`relay_node` are recent additions.** They are the main
> wire-format drift risk. Pin peer firmware versions and re-run the spike after
> any upstream bump.

### 3. Channel hash (`Channels.cpp:27-51`)

```c
uint8_t xorHash(p, len) { code = 0; for i: code ^= p[i]; return code; }
hash = xorHash(name) ^ xorHash(psk_bytes);
```

Verified for this deployment: name `"Private"` + its 16-byte PSK (in the
private repo's `docs/hardware.md`) → **hash = 126 (0x7e)**.
Note it is name+PSK derived, **not** index derived — a peer may hold the same
channel at any index and still decrypt.

### 4. Encryption (`CryptoEngine.cpp:355-404`)

- **AES-CTR.** Key length selects the cipher: **16 bytes → AES128**, else AES256
  (`encryptAESCtr`, `:374-380`). This deployment's PSK is 16 bytes → **AES128**.
- Nonce is 16 bytes, built by `initNonce()` (`:395-404`):
  ```c
  memset(nonce, 0, 16);
  memcpy(nonce,      &packetId, 8);   // uint64, LE
  memcpy(nonce + 8,  &fromNode, 4);   // uint32, LE
  // bytes 12..15 stay zero (extraNonce unused for channel crypto)
  ```
- **Only the payload is encrypted.** The 16-byte header goes out in clear —
  `channel` and `from` must be plaintext for peers to select a key.

### 5. Payload — protobuf `meshtastic_Data`

Encode `Data{portnum, payload}` with nanopb, then encrypt those bytes.
`protobufs/` is already a **git submodule** (`github.com/meshtastic/protobufs`)
— generate with nanopb; do not hand-roll.

Portnums for this use case:
- `DETECTION_SENSOR_APP` (detection events)
- `TELEMETRY_APP` (`meshtastic_Telemetry` → `device_metrics` / `environment_metrics`)

### 6. Packet id

Non-zero, non-repeating per (from, id) — it is the CTR nonce, so **reuse is a
crypto failure, not just a dedupe bug**. Upstream uses a rolling counter seeded
randomly (`Router.cpp:188`). A leaf that resets every wake must persist or seed
from a hardware RNG; a naive `id=1` each boot would reuse the keystream.

## Proposed API

```cpp
struct MeshChannel { const char *name; const uint8_t *psk; size_t pskLen; };

class MeshtasticTransport {
public:
    bool begin(RegionParams region, MeshChannel ch, uint32_t nodeNum);
    bool send(uint32_t portnum, const uint8_t *payload, size_t len,
              uint32_t to = 0xFFFFFFFF, uint8_t hopLimit = 3);
    bool busy();          // radio still transmitting
    void sleep();         // radio to sleep; app owns CPU sleep
};
```

Dependencies: RadioLib, nanopb + meshtastic protobufs, an AES-CTR impl
(mbedtls/tinycrypt/Crypto). **No** NodeDB, router, FSM, or filesystem.

Estimated ~400–600 lines.

## THE SPIKE — do this before writing anything else

**One hour. It de-risks the entire project.**

1. Bare RadioLib sketch on a spare RAK4631: PHY params above, build the header,
   AES128-CTR the payload with the `Private` PSK, channel hash `0x7e`, portnum
   `TELEMETRY_APP`, one `device_metrics` protobuf.
2. Transmit once.
3. **Pass = mesh-gw / the Omni RAK decodes it** and it appears in the node DB
   with correct metrics.

Reference oracle: the real firmware is *right there*. Capture what the garage
node emits on the same channel and diff byte-for-byte against the spike's
output. Compatibility stops being a guess.

If it decodes → the rest is mechanical.
If it doesn't → one hour lost, and the fork route continues.

## Consequences of adopting this

**Gained:** own the sleep (GPIOTE + RTC + `WFI`, ~10 lines, no adversary), own
the rail, own the boot, ~500 auditable lines, no 12k-commit fork to track,
no upstream bug can silently eat your packets.

**Lost:** no RX (leaf only, by design). Wire-format drift is yours to track —
testable once, then pin peers. Not an issue: **BLE OTA survives** — nRF52 DFU
lives in the *bootloader*, not the app (`BLEDfuSecure.cpp:124` merely sets
`GPREGRET = 0xB1` and resets), so ~5 lines plus a wake window keeps node-dash
OTA working.

**Not a reason to do it:** power. Both routes land past the Li-SOCl2 cell's
~10-year self-discharge-limited life (~4 mAh/day stripped-Meshtastic vs
~2 mAh/day bare-metal on a 19 Ah cell). Do this for *ownership and
reliability*, not microamps — that argument doesn't survive contact with the
battery's shelf life.

**Latency** is a real secondary win: ~200 ms wake→TX vs ~3–5 s of Meshtastic
boot. Only decisive if alert latency ever matters.

## Prior art

**Unverified — check before writing.** Spend 10 minutes searching for an
existing embedded Meshtastic-compatible sender library. If none exists, that is
itself a finding: the ecosystem assumes a handheld messenger that is awake, and
every battery sensor/alarm/tracker author hits this same wall.
