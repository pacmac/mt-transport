# mt-transport (Node) — specification

**Status: skeleton. Interfaces are settled; most implementations are stubs.**
Where something is not built, the file says so and throws rather than returning
a plausible-looking empty result.

A Node client for everything the PAC alarm carries that **stock Meshtastic does
not**. Node-dash already handles standard Meshtastic — text, position,
telemetry, nodeinfo. This module owns the private surface on top.

---

## 1. Why this exists

The alarm speaks a private protocol over two portnums plus text commands.
Node-dash currently has to know about all of it inline. That has two costs:

1. **Every firmware change needs a matching dashboard change**, and a bound that
   drifts between the two produces a UI that submits values the device rejects.
2. **The knowledge is not reusable.** Anything else wanting to talk to these
   nodes reimplements the parsing.

This module is the single place that knows the private protocol.

---

## 2. What the alarm actually carries

| surface | portnum / form | direction | status here |
|---|---|---|---|
| debug telemetry | 260, JSON | device → us | **implemented** |
| config broadcast | 260, JSON | device → us | **implemented** |
| config set | 260, JSON | us → device | stub — needs raw-portnum send |
| commands | 1 (text), `@<target> <verb>` | us → device | **implemented** |
| command replies | 1 (text), JSON | device → us | **implemented** |
| chunked payloads | 261, binary | device → us | **implemented + tested** |
| chunk pull | text command | us → device | **implemented** |
| availability advert | 260, in heartbeat | device → us | stub — firmware side not built |
| config schema | 260, paginated | device → us | stub — firmware side not built |

---

## 3. The transport asymmetry — the central constraint

Verified against the live gateway on 2026-07-19:

**Receive is unrestricted.** Any unregistered portnum is emitted as a
`private_app` event carrying `payload_b64` on `ws://<gateway-host>/events`.
Ports 260 and 261 both arrive intact with no gateway changes.

*The event is built by mesh-gw's `app_router.py`, but that names the SERVICE, not
a port.* Measured 2026-07-19: `192.168.10.205:8000` fronts both the send route
(`POST /<nodeId>/messages`) and the event stream, so a single `host` serves both
— which is what `Client` assumes. Whether that is a proxy or co-located services
has not been established and this module does not depend on it.

**Send is text-only.** mesh-gw exposes send for text, admin and traceroute.
There is **no arbitrary-portnum send path**.

Consequence, and it shapes the whole design: **anything we send must be
expressible as a text command.** Hence `@<target> chunk pull <first> <count>`
rather than a 6-byte binary frame. The response is still binary on 261, so only
the request pays the text cost — roughly one frame per sixteen chunks.

Adding a raw-portnum endpoint to mesh-gw would be tidier and would let
`config set` work properly. It is deliberately **not** assumed here, because
mesh-gw is a live service.

Two gotchas, both cost real time to find:

- The WebSocket **needs `maxPayload: 0`**. The gateway opens with a multi-MB
  snapshot that trips ws's 1 MB default and closes with 1009.
- **Node ≥ 20.12** for native `zlib.crc32`. It is IEEE 802.3 reflected and
  matches the device's C++, the camera's ESP32 and Python's zlib. Several other
  CRC32 variants exist; substituting one breaks every transfer silently.

---

## 4. Module layout

```
index.js          facade — construct one Client, get everything
lib/events.js     WS subscription, private_app routing, reconnect
lib/chunk.js      wire codec + reassembly            [tested vs C++ encoder]
lib/queue.js      send queue, dedup, retry, backpressure
lib/commands.js   @target verb builder + reply correlation
lib/payloads.js   260 JSON: debug, config, adverts
lib/store.js      write payloads out (JPEG etc), retention
```

### Why a queue at all

The mesh is half-duplex, shared, and at SF11 a full frame is **2.156 s** of
airtime. Firing commands as fast as an operator clicks would:

- collide with the device's own heartbeats and the Omni's rebroadcasts;
- exceed what the device can answer, since each reply is itself ~2 s;
- make failures indistinguishable from congestion.

So `queue.js` serialises outbound traffic, one in flight at a time, with a
minimum spacing and a timeout. **Not throughput management — correctness.**

### What the queue must do

| behaviour | reason |
|---|---|
| one command in flight per target | replies carry no sequence number; two overlapping commands cannot be attributed |
| min spacing (default 3 s) | a reply is ~2 s of airtime; sending sooner guarantees collision |
| timeout → explicit failure | silence is the normal failure mode on an unacked broadcast link |
| dedup identical pending commands | an impatient double-click must not double the airtime |
| priority lane | a chunk pull must never delay an operator command |
| **never retry blindly** | a retried `@reboot` reboots twice; retry is opt-in per command |

That last row matters. Most of these commands are **not idempotent**.

---

## 5. Chunked transfer — the one part that is finished

Implemented and tested. See `lib/chunk.js`.

Wire format (big-endian, from `mylibs/mt-chunk/src/MtChunk.h`):

```
CHUNK    0x01  pid:2 idx:2 cnt:2  data:<=230
PULL     0x02  pid:2 first:2 count:1        (count clamped to 16 device-side)
MANIFEST 0x03  pid:2 ptype:1 bytes:4 cnt:2 crc32:4
ERR      0x04  pid:2 code:1                 (1=GONE 2=BADRANGE 3=NOSUCH)
GETMAN   0x05  pid:2
```

**Pull, never push** — the device holds the payload and answers bounded range
requests. It keeps no transfer state, so it is never mid-transfer and an alarm
never queues behind a burst. Retry policy is therefore *ours*: a stalled fetch
costs the device nothing and we simply ask again.

**No image conversion.** The camera emits JPEG; the chunker moves opaque bytes.
Reassembly is concatenate → CRC32 → write. Anything resembling a decode step
here is a bug.

**CRC is the pass criterion**, not completeness. A wrong-but-plausible
reassembly — stale pid, misordered chunk — is exactly what it exists to catch.
The reference value `0x65FBD5D9` for the test image is agreed by four
independent implementations.

Verified by `test/cross-cpp.js`, which parses the **exact bytes the C++
`ChunkServer` emits** — produced by `dump_frames`, the real device-side encoder.
13 assertions: manifest decode, full reassembly, byte-identical output, gap
detection, duplicate and reordered delivery, corruption detection, stale-pid
rejection, and a 237-byte frame bound.

```sh
npm run test:cross
```

`dump_frames` lives in **`pio/mylibs/mt-chunk`**, a *sibling* of `projects/` —
not under this repo. An earlier revision of this document implied otherwise and
also claimed these 13 assertions existed here when they only existed in the
mt-chunk library; node-dash caught both. The test is now genuinely in this
module and runs green against the compiled encoder.

---

## 6. Deliberately out of scope

- Anything stock Meshtastic already does — node-dash owns that.
- Image *processing*. This stores bytes; thumbnails and viewers are the UI's job.
- Device firmware. The advert and schema surfaces are stubs here because they do
  not exist on the device yet either.
- Modifying mesh-gw. Tempting for `config set`, but it is live.

---

## 7. Open questions

1. **Raw-portnum send.** Adding it to mesh-gw removes the text-command
   workaround and unblocks `config set`. Worth doing, but it changes a running
   service.
2. **Where does retention live?** `store.js` writes images; nothing yet decides
   when to delete them. The device's own retention is separate and also unbuilt.
3. **Multiple concurrent fetches.** Currently one at a time. The device is
   stateless so it would serve interleaved pulls happily, but the queue would
   need per-pid tracking.
