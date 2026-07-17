---
task: rx-commands-v0
status: active
source_hash: 8937e15d62642f67911550e3ef310445245df9839dfbbcd3583c62ba512bdfc1  # MeshtasticTransport.cpp; .h 6ece371f8a2b131c6ffd4e517f1e4048c9d00c694d659660f28970ba9ae5bcfc; garage main.cpp f54c2ebfc01374bc55c1642aa8873e042afa57777c0da2c5af8ff80115e3b264
updated: 2026-07-17
---

# Spec: rx-commands-v0 — receive() + first command handshake

## Goal

mt-transport gains bounded RX; the garage firmware answers a "ping" text with
a pong. Full command protocol (opcodes/counters/persistence) is the NEXT task.

**AMENDED during Phase 4 — commands are BROADCASTS, not DMs.** Meshtastic 2.8
rejects PSK-encrypted direct text messages outright ("Rejecting legacy DM",
Router.cpp:544) and requires X25519 PKI for DMs; we publish no public key, so
the Omni cannot even encrypt one to us (observed: DM never transmitted;
broadcast on the same channel arrives perfectly). Broadcast-on-private-channel
is the original trust model anyway — the PSK is the authentication. PKI
support → ROADMAP (rweather Crypto ships Curve25519).

PASSED 2026-07-17: broadcast "ping" → "pong up=33s rssi=-45 snr=7.2",
request_id echoing the ping's packet id, decoded off the air.

## Files that change

| file | change |
|---|---|
| `specs/rx-commands-v0.md` | this file (new) |
| `src/MeshtasticTransport.h` | `RxPacket` struct; `receive(timeoutMs, RxPacket&)`; `send(...)` gains `requestId = 0`; `sendAck(to, requestId)` |
| `src/MeshtasticTransport.cpp` | implementations (below) |
| `library.json` | version 0.2.0 |
| `CHANGELOG.md` | [0.2.0] |
| `../pac-garage-alarm/src/main.cpp` | command loop replacing `delay(50)`; ping handler |
| `../pac-garage-alarm/specs/` | receives a copy of this spec for its repo history |

**NOT changing:** `examples/SpikeSend/` (stays the frozen TX-only minimal
example — a `ReceiveDemo` example can come later), `mt_wire`/`mt_crypto`
(decrypt IS `ctrCrypt` — CTR is symmetric), `tools/spike_oracle.py`.

## Library additions

```cpp
struct RxPacket {
    uint32_t from, to, id;
    uint32_t portnum;
    uint32_t requestId;      // Data.request_id (ACKs reference this)
    uint8_t  hopLimit;
    bool     wantAck;
    float    rssi, snr;
    uint8_t  payload[237];
    size_t   payloadLen;
};

// Bounded listen. Returns true when a packet on OUR channel, addressed to us
// or broadcast, decrypts and protobuf-decodes, and is not a duplicate.
// Filter chain: len>=17 → header.channel==hash → from!=us (rebroadcast
// peers echo our own packets back) → to∈{us,broadcast} → ctrCrypt(id,from)
// → pb_decode(Data) → (from,id) dedupe ring (8 entries).
// [amended during Phase 4: own-echo drop added after observing the Omni
//  relay our telemetry back at RSSI −28]
// Non-matching/undecodable frames are dropped and the wait CONTINUES until
// the deadline — one garbage frame must not blind the window.
bool receive(uint32_t timeoutMs, RxPacket &out);

// send() gains requestId (default 0 = absent) → Data.request_id.
// sendAck(to, id): Routing{error_reason=NONE} on ROUTING_APP with
// request_id=id — stops the sender's ReliableRouter retransmissions
// (NextHopRouter.h:93: 3 retries over ~15-30 s) and turns the phone's
// "enroute" into "delivered".
bool sendAck(uint32_t to, uint32_t requestId);
```

RX mechanics: `startReceive()` → poll RX_DONE with a `millis()` deadline →
`readData()`/`getPacketLength()` → `standby()` on exit. (RadioLib's blocking
`receive()` timeout units are module-specific; the poll loop is deterministic.
Exact IRQ-flag calls verified against installed RadioLib 7.7.1 during
implementation.)

## garage-fw handler

Loop's `delay(50)` becomes `mesh.receive(50, pkt)` — continuous listen in
50 ms slices (always-awake bench; the sleep version later calls receive()
once per post-TX window — Class-A per docs/rx-and-commands.md).

On packet (amended): `portnum==TEXT_MESSAGE_APP && payload startswith "ping"`
→ ACK if it was a want_ack DM addressed to us (future-proofing; DMs currently
cannot reach us, see Goal) → reply broadcast
`"pong up=<uptime>s rssi=<rssi> snr=<snr>"` with `requestId = ping's id`.
Serial-log everything (frames feed the oracle). Other texts/ports: logged,
dropped.

## Deployment notes captured (design, not code)

Mesh holds nothing for sleepers: want_ack DMs die after 3 retries in
~15-30 s; broadcasts go once. ⇒ the GATEWAY queues commands and releases
on heartbeat (mesh-gw feature — ROADMAP). Handshake = loss detection.

## Verification

1. Static: grep receive/sendAck/RxPacket in library; handler in main.cpp.
2. Functional: Omni curl `POST /!2687afb1/messages {"text":"ping","to":"!5b1ce001"}`
   → serial shows RX + ACK + pong TX; pong visible from sender. Phone DM
   test equivalent (Peter).
3. Regression: heartbeat/env/detection unchanged on the Omni afterwards.

## Out of scope

Command opcodes/counter protocol, gateway queue, RX windows/sleep, relaying,
SpikeSend changes.
