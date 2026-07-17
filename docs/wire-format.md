# Meshtastic wire format — verified reference

Every fact below was read from the fork at
`/usr/share/pac/dev/projects/mt-radar/firmware/src` on 2026-07-16.
Citations are `file:line` **in that tree**. Re-verify after any upstream bump.

---

## 1. PHY (RadioLib SX1262) — EU_868 / LONG_FAST

| Param | Value | Source |
|---|---|---|
| Frequency | **869.525 MHz** | `RadioInterface.cpp:1226` |
| Bandwidth | 250 kHz | `MeshRadio.h` `modemPresetToParams()` |
| Spreading factor | 11 | ditto |
| Coding rate | 5 | ditto |
| Sync word | `0x2B` | `RadioInterface` |
| Preamble | 16 | `preambleLengthDefault` |
| CRC | on | |

### Frequency slot — why EU_868 is trivial

```c
freqSlotWidth = spacing + padding*2 + bw/1000;                    // RadioInterface.cpp:1188
numFreqSlots  = round((freqEnd - freqStart + spacing) / freqSlotWidth);
channel_num   = hash(primaryChannelName) % numFreqSlots;          // :1195, :1215
freq = freqStart + (bw/2000) + padding + channel_num*freqSlotWidth; // :1226
```

`RDEF(EU_868, 869.4f, 869.65f, 10, 27, false, false, PROFILE_EU868, PRESET(LONG_FAST), 0)`
(`RadioInterface.cpp:111`) and `PROFILE_EU868 = {presets, spacing=0, padding=0, …}`
(`:57`).

⇒ `freqSlotWidth = 0.25`, `numFreqSlots = round(0.25/0.25) = **1**`.
**Any hash % 1 == 0.** Every EU_868 node sits on slot 0 = **869.525 MHz**
regardless of channel name.

> Other regions have many slots — then the primary channel *name* really does
> select the frequency. Region `overrideSlot`: `0` = channel-name hash,
> `-1` = preset-name hash, `>0` = explicit (`MeshRadio.h:19-20`).

---

## 2. Header — 16 bytes, little-endian (`RadioInterface.h:34-55`)

```
off  size  field        notes
 0     4   to           0xFFFFFFFF = broadcast
 4     4   from         our node number
 8     4   id           packet id — MUST be non-zero and non-repeating
12     1   flags        see below
13     1   channel      channel hash
14     1   next_hop     0 = unknown/any
15     1   relay_node   0 = not relayed
```

`flags` bits (`RadioInterface.h:24-28`, packed at `:1360-1361`):

```
0x07  HOP_LIMIT_MASK    hop_limit (bottom 3 bits)
0x08  WANT_ACK_MASK
0x10  VIA_MQTT_MASK
0xE0  HOP_START_MASK    hop_start << 5   (HOP_START_SHIFT = 5)
```

Leaf sender: `hop_limit=3, hop_start=3, want_ack=0, via_mqtt=0`
→ **`flags = 3 | (3<<5) = 0x63`**.

> ⚠ **`next_hop` / `relay_node` are recent additions.** They are the main
> wire-format drift risk. Pin peer firmware versions; re-run the spike after any
> upstream bump.

**The header is transmitted in clear.** `channel` and `from` must be plaintext
so receivers can select a key.

---

## 3. Channel hash (`Channels.cpp:27-51`)

```c
uint8_t xorHash(const uint8_t *p, size_t len) {
    uint8_t code = 0;
    for (size_t i = 0; i < len; i++) code ^= p[i];
    return code;
}
hash = xorHash(name) ^ xorHash(psk_bytes);          // Channels.cpp:46-50
```

**Name + PSK derived — NOT index derived.** A peer may hold the same channel at
any index and still decrypt. (This was verified empirically: the Omni carries
`Private` at idx=2 and decodes packets the garage sends from idx=0.)

Example (the real deployment values live in the private repo's
`docs/hardware.md`):

| channel | psk (hex) | hash |
|---|---|---|
| `"Private"` | `<your-16-byte-psk>` | `xorHash(name) ^ xorHash(psk)` — this deployment's works out to **126 (0x7e)** |
| `""` (default) | `01` | 1 (0x01) — well-known **public** key |

> The hash is safe to publish: it is transmitted in cleartext in every packet
> header anyway, and `xorHash` is 8-bit lossy — it cannot be inverted to
> recover the PSK.

---

## 4. Encryption (`CryptoEngine.cpp:355-404`)

**AES-CTR.** Key length selects the cipher (`encryptAESCtr`, `:374-380`):

```c
if (_key.length == 16) ctr = new CTR<AES128>();
else                   ctr = new CTR<AES256>();
```

This deployment's PSK is **16 bytes → AES128**.

Nonce is 16 bytes (`initNonce`, `:395-404`):

```c
memset(nonce, 0, 16);
memcpy(nonce,     &packetId, 8);   // uint64 LE
memcpy(nonce + 8, &fromNode, 4);   // uint32 LE
// bytes 12..15 remain zero (extraNonce unused for channel crypto)
```

**Only the payload is encrypted**, never the header.

> ⚠ **The packet id IS the CTR nonce.** Reuse is a **keystream-reuse crypto
> failure**, not merely a dedupe bug. Upstream uses a randomly-seeded rolling
> counter (`Router.cpp:188`). A leaf that resets on every wake must persist the
> counter or seed from a hardware RNG — naively starting at `id=1` each boot
> re-encrypts under the same nonce.

---

## 5. Payload — protobuf `meshtastic_Data`

Encode `Data{portnum, payload}` with nanopb, **then** encrypt those bytes.

Portnums for this use case:
- `DETECTION_SENSOR_APP` — detection events
- `TELEMETRY_APP` — `meshtastic_Telemetry` → `device_metrics` / `environment_metrics`

`protobufs/` is a git submodule of `github.com/meshtastic/protobufs`. Generate
with nanopb; do not hand-roll.

---

## 6. Assembly order

1. Build `Data{portnum, payload}` protobuf → `plain[]`
2. `encryptAESCtr(psk, nonce(id, from), plain, len)` → `cipher[]`
3. Emit `header(16) ‖ cipher[]`
4. TX at 869.525 MHz, BW250/SF11/CR5, sync `0x2B`

Max payload: `MAX_LORA_PAYLOAD_LEN + 1 - sizeof(PacketHeader)`
(`RadioInterface.h:66`).
