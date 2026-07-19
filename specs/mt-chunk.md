---
task: mt-chunk
status: active
source_hash:  # steps 1,5,6,7 implemented (mylibs commit 16efaa3); 2,3 pending; 4 revised
  mylibs/mt-chunk/src/MtChunk.h: 1d4685729ba193507e42b0284d40aaa67cd95cac616befee8d641f6be8e15965
  mylibs/mt-chunk/src/MtChunk.cpp: ae9da365c5d6302e48539dec892edde010bd21f4c382c2bbf75e7788070cbdb3
  mylibs/mt-chunk/src/MtChunkCrc.h: 330d5758523dd2015856e21f595ab61eb648ff8ad8465e30dc52c8992aafdada
updated: 2026-07-19
scope: NEW library at pio/mylibs/mt-chunk (does not modify mt-transport or pac-garage-alarm)
---

# Spec: mt-chunk — pull-only chunked payload transfer

A separate library, layered **above** `mt-transport`, for moving payloads larger
than one Meshtastic frame. Peter, 2026-07-19: *"this should be a seperate lib /
module / include, it really opens up a LOT of scope."*

## Why it cannot borrow Meshtastic's

Verified in `protobufs/meshtastic/mesh.proto`:

- `Data` (`:1181`) has **no** fragmentation fields. Payload is one opaque
  `bytes`, 237 max, atomic.
- `ChunkedPayload` (`:2793`) exists with `payload_id`/`chunk_count`/
  `chunk_index`, and `ChunkedPayloadResponse` even defines `resend_chunks` —
  but **nothing references either**. Defined, never wired up.
- `LINK_PROVIDE_FIRSTHALF`/`SECONDHALF` (`:1293`) — upstream hit this wall in
  one module and hand-rolled a two-way split for that single message type.

So we build it above the transport. Nothing in MT needs to know.

## Architecture — the decision that makes testing possible

```
  app  ──▶ MtChunk  ──▶ IChunkTransport (interface)
                            ├── MeshChunkTransport   (real: mt-transport)
                            └── FakeChunkTransport   (native tests: loss, reorder, dupes)
```

`MtChunk` core is **plain C++ with no Arduino include**. The transport is
injected through a pure-virtual interface. That is what lets the entire protocol
run and be tested on a workstation with no radio and no device attached, which
is a requirement here, not a nicety — the hardware is about to be 2.3 km away
and every on-air test costs minutes.

## PULL, not push — and everything follows from it

The device holds a payload and answers *"give me chunks 8..15"*. It never
pushes.

- Device is **stateless** — no window tracking, no retransmit bitmap, no timers.
- Retransmit is not a concept. A lost chunk means the caller asks again.
- **Preemption is free.** One request, one bounded reply, so the device is never
  mid-transfer and there is nothing to suspend when an alarm fires. A push
  design needed a preemptible state machine solely because the device owned an
  in-flight burst. On a node whose one job is sending an alarm promptly, this is
  the whole argument.
- Flow control belongs to the caller.
- Resumability is free — the caller comes back and asks for what it lacks.

**Batching is what makes pull viable**, not a convenience. Without it every
chunk needs a request frame too: 2× frames, and at SF11 a tiny request costs
nearly as much as a full one because the preamble dominates.

| batch | overhead | preemption granularity |
|---|---|---|
| 1 | 100% | perfect |
| 8 | ~12% | ~10 s |
| 32 | ~3% | ~40 s |

Cap at 16. An unbounded batch is push with extra steps.

## Wire format (step 1 — settled here)

Binary. Base64 exists only because port-260 framing is JSON, and it costs 33%
for nothing — the MT payload field is `bytes`, not text.

### Chunk response — `PAC_CHUNK_APP`

```
 offset  size  field
      0     1  type      0x01 = CHUNK
      1     2  pid       payload id, big-endian
      3     2  idx       chunk index, big-endian
      5     2  cnt       total chunks, big-endian
      7     n  data      up to CHUNK_DATA_MAX bytes
```

7-byte header ⇒ **`CHUNK_DATA_MAX = 230`** of a 237-byte payload.

Compare JSON + base64: ~150 usable ⇒ **53% more payload per frame**. A 15 KB
image is 65 frames rather than 100.

`idx`/`cnt` are 2 bytes: up to 65535 chunks ≈ 15 MB. Far past anything sane,
but 1 byte would cap at 256 chunks ≈ 59 KB, which a 320×320 image can exceed.

### Pull request

```
      0     1  type      0x02 = PULL
      1     2  pid
      3     2  first     first chunk index wanted
      5     1  count     how many, 1..PULL_BATCH_MAX (16)
```

Server **clamps `count` itself** — never trust the caller's range.

### Manifest (reply to a pull for an unknown/complete payload, and the advert detail)

```
      0     1  type      0x03 = MANIFEST
      1     2  pid
      3     1  ptype     1=SCHEMA 2=IMAGE 3=LOG
      4     4  bytes     total payload length, big-endian
      8     2  cnt       total chunks
     10     4  crc32     over the WHOLE payload
```

### Error

```
      0     1  type      0x04 = ERR
      1     2  pid
      3     1  code      1=GONE (evicted) 2=BADRANGE 3=NOSUCH
```

`GONE` matters: silence would make a caller retry forever against a payload that
no longer exists.

## CRC32 over the whole payload

4 bytes, once, in the manifest. Reassembly is then **verified**, not assumed.
Per-chunk CRC was rejected: the LoRa PHY already CRCs each frame, so a per-chunk
CRC re-checks what the radio checked and costs 4 bytes on every single chunk.
The failure this must catch is a *reassembly* fault — wrong order, missing
chunk, stale `pid` — which only a whole-payload CRC detects.

## Monotonic pid — a real bug if skipped

`pid` **must** persist across reboot. A counter restarting at 1 means a caller
holding cached `pid=1` pulls a *different* payload under the same id and cannot
detect it. `bootlog.bin` already solves exactly this problem in
`pac-garage-alarm`; reuse the pattern.

## MEASURED CONSTRAINT — the RAK cannot be the image store

`LFS_FLASH_TOTAL_SIZE = 7 * FLASH_NRF52_PAGE_SIZE` (`InternalFileSystem.cpp:34`,
`flash_nrf5x.h:30`) ⇒ **28,672 bytes of LittleFS in total**, shared with
`settings.bin` and `bootlog.bin`, before LittleFS's own metadata at 128-byte
blocks (224 blocks — proportionally heavy).

A real OV3660 frame at 320×320 lands near 10–15 KB. That is *one* image with no
headroom, no room for a second, and nothing spare for LittleFS's
copy-on-write. **Step 4 as originally written — "payload store in LittleFS keyed
by pid" — is wrong for images.** It remains correct for the schema, which is a
few hundred bytes.

### Consequence: the RAK proxies, the camera stores

The M5Stack Timer Camera X has **8 MB PSRAM**. It is the natural store; the
RAK4631 holds **one chunk at a time (230 bytes)**, not the image.

```
  pull(idx) ──▶ RAK ──UART──▶ camera: "bytes [idx*230, +230)"
                RAK ◀────────  230 bytes
  chunk    ◀── RAK
```

**This falls out of the pull design for free.** Because pull is stateless and
chunk-addressed, the server can satisfy a request from a backing store it does
not own, with a 230-byte buffer. A push design would have had to buffer the
whole payload to iterate it — which the 28 KB partition makes impossible. The
pull choice was made for *preemption* reasons; it turns out to also be the only
thing that fits in the flash we have. Worth noting because the reasoning
generalises: statelessness bought two unrelated wins.

Implementation: `ChunkServer` gains an optional `IPayloadSource` (read
`(offset, len)`) alongside the current in-memory pointer. The in-memory path
stays for the schema; the sourced path serves the camera. The CRC must then come
from the camera with the manifest rather than being computed locally, since the
RAK never sees the whole payload at once.

## M5Stack Timer Camera X — integration notes (design only, no hardware yet)

Peter has several units. Relevant characteristics:

- ESP32 + **8 MB PSRAM** — holds many frames; the RAK holds none.
- **OV3660** 3 MP. Must be configured DOWN hard: 320×240 or smaller, high
  compression. A full-resolution frame is thousands of chunks and is simply not
  a LoRa payload.
- **BM8563 RTC gates power to the ESP32**, which is why deep sleep is ~2 µA —
  the ESP32 is genuinely off, not sleeping. Independently powered from its own
  270 mAh cell, so it does not load the alarm's battery budget.

**Open questions, to verify against the schematic rather than assume:**

1. **External wake.** The documented wake sources are the RTC alarm and the
   power button. Whether the RAK can assert wake on a pin — and which pin —
   needs checking against the board schematic. If there is no clean external
   wake, the fallback is the camera waking on its own RTC schedule and polling
   the RAK, which costs latency and battery but works. **Do not design around
   an external wake until it is confirmed.**
2. **UART pins on the RAK side.** `Serial1` (P0.15/P0.16) is already the debug
   mirror and must not be reused; a second UART or different WisBlock pins are
   needed. At 115200 a 15 KB image transfers in ~1.3 s, so speed is not the
   constraint — pin availability is.
3. Grove on the camera is I2C by default; bulk transfer wants UART.

**Sequencing that protects the alarm:** motion → alarm goes out *immediately*;
capture happens in parallel; the image is then merely *advertised*
(`pid`, `img`, bytes, chunks) and sits there until something asks. Nothing moves
until a caller decides to spend the airtime. That is the pull model doing
exactly what it was chosen for.

## Files (steps 1–2)

| file | purpose |
|---|---|
| `mylibs/mt-chunk/src/MtChunk.h` | core API, transport interface, wire constants |
| `mylibs/mt-chunk/src/MtChunk.cpp` | server (pull handler) + client (reassembler) |
| `mylibs/mt-chunk/src/MtChunkCrc.h` | CRC32, no dependencies |
| `mylibs/mt-chunk/test/fake_transport.h` | loss / reorder / duplicate injection |
| `mylibs/mt-chunk/test/test_chunk.cpp` | native harness, no radio |
| `mylibs/mt-chunk/test/Makefile` | `make && ./test_chunk` |
| `mylibs/mt-chunk/tools/make_test_image.py` | 240×240 and 320×320 JPEG fixtures |
| `mylibs/mt-chunk/library.json` | PlatformIO metadata |
| `specs/mt-chunk.md` | this file |

**NOT changing:** `mt-transport` (no library change needed — mt-chunk sends via
the existing send path and inherits CSMA and airtime accounting);
`pac-garage-alarm` (integration is a later step); the espcam hardware decision
(undecided).

## Verification (steps 1–2, native only)

Everything below runs on the workstation with no device attached.

1. **Round trip, no loss** — 240×240 and 320×320 JPEG in, identical bytes out,
   CRC match.
2. **Random loss** at 10/30/50% — caller converges by re-asking; assert final
   CRC matches and that it converges in a bounded number of rounds.
3. **Out-of-order and duplicate delivery** — reassembly must not care.
4. **Batch clamping** — a request for 999 chunks returns at most 16.
5. **`GONE`** — pull an evicted pid, expect `ERR/GONE`, not silence.
6. **Truncation/corruption** — flip a byte, assert the CRC *fails*. A test that
   only proves success proves little.
7. **Frame bound** — assert no emitted frame exceeds 237 bytes.

On-air verification is a later step and is explicitly NOT claimed here.

## Results — 2026-07-19, native harness, no hardware

`make && ./test_chunk` — **20 passed, 0 failed**, built with
`-fsanitize=address,undefined`.

| fixture | bytes | chunks | rounds (clean) | max frame |
|---|---|---|---|---|
| 240×240 JPEG | 4,939 | 22 | 3 | 237 |
| 320×320 JPEG | 6,927 | 31 | 3 | 237 |
| 48×48 JPEG | 1,008 | 5 | — | — |

Lossy link (loss + 10% duplicates + reordering, deterministic seed):

| loss | rounds | sent | dropped | dup |
|---|---|---|---|---|
| 10% | 9 | 37 | 5 | 2 |
| 30% | 20 | 49 | 17 | 5 |
| 50% | 50 | 70 | 38 | 2 |

Converges at 50% loss. `requested 255, server sent 16` confirms server-side
clamping. Guard tests passing: `ERR/GONE` on an evicted pid, CRC32 detects a
single flipped bit, a chunk bearing a stale pid is dropped rather than blended.

Clean transfer of 22 chunks takes 3 rounds — manifest, 16, then 6 — which is the
arithmetic working out exactly as the batch cap predicts.

**Caveats stated rather than buried:**

- The JPEG fixtures are synthetic test cards and compress better than
  photographs. A real OV3660 frame at these dimensions will be nearer 10–15 KB,
  so **expect roughly double the chunk count**. The fixture generator's airtime
  figures are therefore optimistic.
- `maxframe=237` sits exactly at the ceiling by design (230 + 7). The harness
  asserts no frame ever exceeds it.
- Two bugs were found and fixed by writing the harness, before any hardware
  existed: a 2-byte stack overflow in `sendManifest()` (a leftover placeholder
  wrote `put32` at offset 10 of a 12-byte array), and a protocol dead-end where
  `requestManifest()` sent a PULL with `count=0`, which the server clamped to 1
  and answered with chunk 0 — so a client could never learn the length or CRC.
  Hence `MSG_GETMANIFEST`.
