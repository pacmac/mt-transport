# mt-transport v2 — wire contract (APIV2)

> **This document is the single source of truth (SSOT).** Every implementation — device
> firmware, `clients/node`, the future `clients/python` — MUST comply with it. Where code and
> this document disagree, **this document wins and the code is wrong** (fix the code, or change
> the contract here *first* and then the code). Consumers may read this directly for context,
> but should depend on a `clients/<lang>/` library rather than hand-rolling the protocol.

**Contract version: 2.0** — frozen 2026-07-22 (the four Phase-0 decisions are resolved below;
no `TBD` remains). The machine-readable contract for v2. Byte offsets and constants below are
**verified against the current code** (`src/mt_wire.h`, `clients/node/lib/chunk.js`,
`src/main.cpp`). Big-endian throughout.

---

## 1. Ports

| port | role in v2 | notes |
|---|---|---|
| **1** (TEXT) | comfort lane | `ping`, `status` — text, sent as DMs |
| **261** (`PAC_CHUNK_APP`) | machine lane | all chunked responses + images (kept from v1; wire format unchanged) |
| 260 (`PAC_ALARM_APP`) | **RETIRED** as a response port | no more raw JSON frames |
| `TELEMETRY`/`NODEINFO`/`POSITION` | unchanged | native Meshtastic interop |

One private port carries every machine response; the chunk **message type** (byte 0)
disambiguates, exactly as pull/push already coexist today.

## 2. Transport header (every packet — 16 bytes, unchanged from v1)

`src/mt_wire.h` — `struct PacketHeader` (`static_assert(sizeof==16)`):

| offset | field | bytes | notes |
|---:|---|---:|---|
| 0 | `to` | 4 | `0xFFFFFFFF` = broadcast. **v2: set to the requester (`rx.from`) for DMs** |
| 4 | `from` | 4 | sender node number |
| 8 | `id` | 4 | non-zero, non-repeating; also the AES-CTR nonce |
| 12 | `flags` | 1 | `hop_limit | want_ack<<3 | via_mqtt<<4 | hop_start<<5` |
| 13 | `channel` | 1 | `xorHash(name) ^ xorHash(psk)` (channel hash, not index) |
| 14 | `next_hop` | 1 | 0 = unknown/any |
| 15 | `relay_node` | 1 | 0 = not relayed |

**v2 reliability = two existing bits:** address `to = rx.from` and set the `want_ack` bit
(flags bit 3). `packFlags(hopLimit, hopStart, wantAck, viaMqtt)` already accepts `wantAck` — v1
simply never passes `true`. The destination returns a routing ACK; the sender retransmits on
no-ACK via `resend()`.

## 3. Payload budget

```
MESH_PAYLOAD_MAX = 231   # NOT 237 — the protobuf envelope (portnum + payload tags/varints)
                         # eats 6 bytes; a 231+ payload makes send() silently return false.
CHUNK_HEADER_LEN = 7
CHUNK_DATA_MAX   = 224   # 231 - 7
PULL_BATCH_MAX   = 16
```

## 4. Chunk protocol (machine lane)

### 4.1 Message types (byte 0)
Two disjoint blocks share the port; the first byte decides.

| block | value | message | direction |
|---|---:|---|---|
| pull | `0x01` | CHUNK | device → client |
| | `0x02` | PULL (request range) | client → device |
| | `0x03` | MANIFEST | device → client |
| | `0x04` | ERR | device → client |
| | `0x05` | GETMANIFEST | client → device |
| | `0x06` | BUSY (retry-after) | device → client |
| push | `0x10`–`0x16` | mt-chunk-push mirror | device streams |

### 4.2 Frame layouts (verified against `chunk.js`)

**MANIFEST (14 B)** — describes one payload:
```
[type=0x03:1][pid:2][ptype:1][bytes:4][count:2][crc32:4]
```
**CHUNK (7 B header + ≤224 data)**:
```
[type=0x01:1][pid:2][idx:2][count:2][data:0..224]
```
**PULL request (6 B)** — "give me `count` chunks from `first`":
```
[type=0x02:1][pid:2][first:2][count:1]      # count clamped to PULL_BATCH_MAX (16)
```
**ERR (4 B)**:
```
[type=0x04:1][pid:2][code:1]                # code: GONE=1, BADRANGE=2, NOSUCH=3
```
**BUSY (5 B)** — device-driven flow control:
```
[type=0x06:1][pid:2][retry_after_ms:2]
```

### 4.3 Payload types (`ptype`, in the MANIFEST)

| ptype | meaning | status |
|---:|---|---|
| 1 | `SCHEMA` | v1 legacy — **superseded by `JSON` (4)** in v2; schema is now a `JSON` payload |
| 2 | `IMAGE` | camera JPEG (binary) |
| 3 | `LOG` | exists |
| **4** | **`JSON`** | **v2 — the one generic ptype for every machine-lane JSON response** (`config`, `schema`, `debug`, `calc`, `env`). The JSON's own `t` field names the specific response; the consumer routes on `t`, not on the ptype. |

**This is the whole of "chunk everything":** a JSON response (`config`/`schema`/`debug`/`calc`/`env`)
becomes a `JSON`-ptype payload, published exactly like an image. No frame-format change.

## 5. Comfort lane (text DMs)

Commands whose reply a human reads directly. Reply is a **text DM** back to `rx.from` with
`want_ack` set.

| command | reply | comfort? |
|---|---|---|
| `ping` | `pong` (text) | yes |
| `status` | short status (text) | yes |

The comfort lane is exactly `ping` + `status`. Everything else — `env`, `config`, `schema`,
`debug`, `calc`, image — goes to the machine lane (§4). `env` is machine-lane because its
reading is structured data a consumer parses, not a one-glance human line.

## 6. Request / response flows

**Comfort (e.g. `status`):**
```
node-dash --(text DM "status", to=device, want_ack)--> device
device    --(text DM reply, to=node-dash, want_ack)--> node-dash
                (no ACK within timeout -> device resend())
```

**Machine, pull (e.g. `config`):**
```
node-dash --(GETMANIFEST pid, DM)-------------------> device
device    --(MANIFEST: ptype, bytes, count, crc)----> node-dash
node-dash --(PULL first,count)----------------------> device
device    --(CHUNK × n, each DM+want_ack)-----------> node-dash
node-dash  (reassemble; verify whole-payload crc; re-PULL any missing idx)
```

**Machine, push (small/self-initiated):**
```
device    --(MANIFEST, then CHUNK × n, DM+want_ack)-> node-dash
node-dash  (reassemble; request repair of any gap at the end)
```

**Default is pull:** the client asks (`GETMANIFEST`), the device manifests, the client pulls and
reassembles (§6 "Machine, pull"). Push (device streams unsolicited) stays for images and
event-driven payloads (motion / alarm), **not** for command responses.

## 7. Removed in v2
- Raw JSON frames on port 260.
- `sch` pagination (`{"t":"sch","p":P,"n":N,...}`, header repeated per page) — schema is now a
  `SCHEMA`-ptype chunk payload.
- `jsonBuild` size-shedding (`JReq` MUST/OPTIONAL, fit-loop, reserved-brace) — the cap it
  guarded against no longer exists. Builder collapses to always-emit. **Every `jsonBuild` /
  `JReq` caller must be checked before deletion** (partly unwinds fw 260721-11).
- `@xxxx` short-name addressing — replaced by DM to nodeNum.

## 8. Not part of v2 (do not conflate)
- Channel-0 private-vs-primary config (channel/hash layer; independent).
- Standard telemetry/nodeinfo/position ports.
