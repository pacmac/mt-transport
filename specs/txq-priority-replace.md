---
task: txq-priority-replace
status: IMPLEMENTED 2026-07-25. Policy extracted to a NEW dependency-free module (mylibs/mt-txqueue,
  header-only) rather than living inside the radio driver — the transport includes RadioLib, so the
  queue could not otherwise be host-tested, and the test is mandatory for ring arithmetic a radio
  state machine reads concurrently. Priority scale + ordering + evict-when-full PORTED from
  Meshtastic's MeshPacketQueue; replace-by-key is ours (they never hold a backlog across a sleep
  cycle). offline_txqueue: 68 checks PASS. Build clean (RAM +8 B). Flashed to bench 336b.
  On-air burst test OUTSTANDING.
source_hash:
  ../../mylibs/mt-txqueue/src/MtTxQueue.h: c1e2d0402d8cdd0a3be980e7c784d22c34b44c0b9f94551dbd4e1f5011c9c6f1
  ../../mylibs/mt-txqueue/test/offline_txqueue.cpp: 8ae7964aeaa44ca97b880eb56e467235cfad38bdae29425c7c8b64eab3be4db5
  src/MeshtasticTransport.h: 387a03d8aebaff6bec726f75778e11f95ad93424b267d897f2cf53e82eac2a54
  src/MeshtasticTransport.cpp: 101f878eeca6697d3514d0a1c1220405d7bd79b55ce8a843123fa758ae48e530
  ../pac-garage-alarm/src/main.cpp: b2daa090dfc45d217a3f24d89d320950a4cf6b58f31175f54e2a1a9730300f59
scope:
  - specs/txq-priority-replace.md
  - ../../mylibs/mt-txqueue/                     # NEW MODULE (separate repo: pio/mylibs)
  - src/MeshtasticTransport.h     # delegates the ring to mttx::TxQueue; one-shot classifyNextTx()
  - src/MeshtasticTransport.cpp   # enqueueFrame() routes classification to the module
  - ../pac-garage-alarm/src/main.cpp        # classify the send sites (SEPARATE REPO)
  - ../pac-garage-alarm/platformio.ini      # lib_deps += symlink://../../mylibs/mt-txqueue
# NOT changing: TXQ_N (stays 16 — the fix is policy, not size; a bigger ring delays the
#   same failure), send() signature (classification is a one-shot setter, matching the
#   existing scheduleNextTxIn/wantResponseNext pattern), crypto/framing, the CSMA/CAD
#   state machine, dequeue-at-front, the ACK retransmit policy itself.
---

> **AMENDED DURING IMPLEMENTATION.** Two changes from the original proposal below, both
> made after reading Meshtastic's own implementation:
>
> 1. **The policy became its own module** — `mylibs/mt-txqueue` (`MtTxQueue.h`,
>    header-only, no Arduino/RadioLib/protobuf). `MeshtasticTransport.h` includes
>    `RadioLib.h`, so a test of `enqueueFrame` could not be host-compiled where the code
>    originally sat. The mandatory offline test drove the extraction, and the queue is a
>    single-responsibility unit rather than logic buried in a radio driver.
> 2. **The priority scale is Meshtastic's, not invented.** `meshtastic_MeshPacket_Priority`
>    already exists in our generated protobufs (BACKGROUND=10, DEFAULT=64, RESPONSE=80,
>    ALERT=110, ACK=120), so `TXP_BULK/NORMAL/HIGH` was dropped in favour of those values.
>    Ordering (highest-first, stable within equal priority) and evict-lowest-when-full are
>    ported from `MeshPacketQueue::enqueue`/`replaceLowerPriorityPacket`; because the queue
>    is kept sorted, the lowest priority is always at the back, so eviction is an O(1)
>    check exactly as theirs is.
>
> **Replace-by-key remains ours** — Meshtastic has no equivalent, because an always-on
> router never carries a backlog across a sleep cycle. That is the part that actually fixes
> the measured failure.

# Spec: txq-priority-replace — alarms jump the queue, stale state is superseded

## Problem (measured, not theorised)

Evidence: `pac-garage-alarm/docs/telemetry-ungate-trial-260724/`, bug `bugs-enhancements` id:1463.

The TX ring (`MeshtasticTransport.h:347`, `TXQ_N = 16`) is **strict FIFO with no notion of
what a frame is**. Dequeue happens only at `_txHead` (`cpp:364,405,609`), so nothing can
overtake anything. Two consequences, both observed on air 2026-07-24:

1. **Backlog delays everything behind it.** A ~16-frame command burst filled the ring; the
   next wakes' telemetry aired **30 and 15 minutes late** — stale on arrival, and *looking*
   delivered. Had those been alarms, they would have been 30-minute-late alarms.
2. **A full ring drops outright.** `enqueueFrame` returns false when `_txCount >= TXQ_N`
   (`cpp:245`); that wake's telemetry was **never transmitted**, silently.

Recovery is automatic (45 min / 3 wakes at a 15-min beat) but scales with the heartbeat —
**~3 h at the 1 h beat the deployed unit is moving to**.

**Ungating telemetry (commit `fff83db`) raises the standing queue depth**: 2 state frames
every heartbeat instead of occasionally. The fix is more urgent after that change, not less.

## Principle

> **State is replaceable. Events are not.**

A frame reporting *current state* (telemetry, nodeinfo, position, calc) carries a value that
a newer frame supersedes — queueing both is worse than useless, because the stale one airs
first and corrupts the very stats grid the ungating just fixed. A frame reporting an *event*
(an alarm) records that something happened; no later frame carries that fact, so it must
never be replaced or dropped.

## Layering

`mt-transport` is **a transport, not an operating system** — it must not learn what an
"alarm" is. So the library provides *mechanism only*: an opaque priority and an opaque
replace-key. The application supplies the semantics. No Meshtastic port number or
application concept is hard-coded in the library.

## Change 1 — `src/MeshtasticTransport.h`

### 1a. Classification type (new, public)
```c
// Queue policy for the NEXT enqueued frame. The transport attaches no meaning to
// these beyond ordering and replacement — the application decides what is urgent
// and what is stale. See classifyNextTx().
enum TxPrio : uint8_t { TXP_BULK = 0, TXP_NORMAL = 1, TXP_HIGH = 2 };
static const uint8_t TXK_NONE = 0;   // no replace-key: this frame is unique, never superseded
```

### 1b. `TxItem` gains two bytes (`.h:337-342`)
```c
    struct TxItem {
        uint8_t  frame[FRAME_CAP];
        uint16_t len;
        uint32_t txAfter;
        uint8_t  attempts;
        uint8_t  prio;      // TxPrio — ordering only
        uint8_t  rkey;      // replace-key; TXK_NONE = never superseded
    };
```
Cost: 2 B x 16 = **32 bytes** (RAM currently 25.1%).

### 1c. One-shot setter (new, public) — matches `scheduleNextTxIn`/`wantResponseNext`
```c
    // The NEXT enqueued frame carries this priority and replace-key; consumed by
    // enqueueFrame() and reset, so it can never leak onto an unrelated later frame
    // (same one-shot discipline as scheduleNextTxIn/wantResponseNext).
    // rkey != TXK_NONE means "this frame reports state X": a newer frame with the
    // same key REPLACES the queued one in place rather than queueing behind it.
    void classifyNextTx(uint8_t prio, uint8_t rkey = TXK_NONE)
         { _nextPrio = prio; _nextRkey = rkey; _nextClassSet = true; }
```
Private state: `_nextPrio`, `_nextRkey`, `_nextClassSet` (alongside `_nextTxDelaySet` at `.h:300`).

**Unclassified sends keep today's behaviour exactly**: `TXP_NORMAL` + `TXK_NONE` = plain FIFO
append. Every existing call site — and any other consumer of this GPL library — is unchanged.

## Change 2 — `src/MeshtasticTransport.cpp` `enqueueFrame()` (`cpp:243-260`)

Order of operations (all before any `memcpy` of the new frame):

1. **Consume the one-shot class** (default `TXP_NORMAL`/`TXK_NONE`), reset the flag.
2. **Replace-in-place.** If `rkey != TXK_NONE`, scan the queued items for the same `rkey`
   and, if found, overwrite that slot's frame/len/attempts and refresh `txAfter`;
   **`_txCount` does not change**; return true.
   - **Skip the in-flight head.** If `_txState` is `TX_SCANNING` or `TX_SENDING`, index 0
     (`_txHead`) is being transmitted — never overwrite it; fall through to append.
   - Rationale: replacing keeps *one* slot per state type, so periodic telemetry can never
     accumulate, which is the actual anti-flood mechanism.
3. **Full-ring policy.** If `_txCount >= TXQ_N`:
   - If the new frame is `TXP_HIGH`, **evict the newest lowest-priority item** (tail-most
     item of the lowest priority present, never the in-flight head) and take its slot.
     An alarm must not be lost because bulk traffic filled the ring.
   - Otherwise return false, as today.
4. **Priority insert.** Append at tail, then move the item forward past any queued items of
   **strictly lower** priority (never past the in-flight head). Equal priority keeps FIFO
   order, so ordering within a class is unchanged and reproducible.
   - Implementation: shift by whole `TxItem`s within the ring. Worst case 15 moves of 253 B
     — microseconds at 64 MHz, and it never runs while the radio is mid-transmit.

`getTxDelayMsec()`/`_nextTxDelay` handling is untouched.

## Change 3 — retransmit paths keep their class

- `cpp:655` pending-ACK retransmit re-enqueues `_pendingFrame`; `cpp:726` `resend()`
  re-enqueues `_frame`. Both would otherwise default to `TXP_NORMAL`/`TXK_NONE`.
- Store the class alongside the pending frame (`_pendingPrio`/`_pendingRkey`) and re-apply
  it before re-enqueue, so an alarm retransmit stays `TXP_HIGH`.
- A retransmit of a **replaceable** frame keeps its `rkey`: if newer state has since been
  queued it supersedes the stale retransmit, which is correct — nobody wants a 30-minute-old
  vbat re-sent.

## Change 4 — `pac-garage-alarm/src/main.cpp` (separate repo, separate commit)

App-side keys (application meaning lives here, not in the library):
```c
enum : uint8_t { RK_TELE_DEV = 1, RK_TELE_ENV = 2, RK_NODEINFO = 3,
                 RK_POSITION = 4, RK_CALC = 5, RK_DEBUG = 6 };
```
Classification of the 18 send sites:

| site(s) | class | key |
|---|---|---|
| `1444`, `1455` alarm (DETECTION_SENSOR_APP) | `TXP_HIGH` | `TXK_NONE` — every event distinct |
| `1323` telemetry via `sendTelemetryVariant` | `TXP_NORMAL` | `RK_TELE_DEV` / `RK_TELE_ENV` |
| `1589` nodeinfo / `1640` position / `1883` calc / `1865` debug | `TXP_NORMAL` | `RK_NODEINFO` / `RK_POSITION` / `RK_CALC` / `RK_DEBUG` |
| `1279`,`1804`,`2646`,`2758`,`2962`,`2975` replies/errors | `TXP_NORMAL` | `TXK_NONE` |
| `311`, `345` chunk pull/push | `TXP_BULK` | `TXK_NONE` |
| `3298`, `3778` `sendAck` | `TXP_NORMAL` | `TXK_NONE` |

**`sendTelemetryVariant` (`main.cpp:1317`) is shared by device and env metrics** — it gains
an `rkey` parameter so `sendDeviceMetrics`/`sendEnvMetrics` pass distinct keys. Without this
they would replace *each other* and only one would ever air. This is the subtlest edit in the
change and the one the offline test must cover.

Alarms are `TXK_NONE`, so distinct events are all preserved. Repeat notifications of an
*already-reported* condition are already coalesced upstream by the existing renotify timer —
which is what keeps a stuck PIR (id:1086 BUG 10) from filling the ring with alarms.

## Observe (Phase 4)

1. **Static** — grep shows `prio`/`rkey` in `TxItem`, `classifyNextTx` present, all 18 app
   sites classified.
2. **Functional — NEW `test/offline_txq.cpp`** (host-compiled, no radio), asserting:
   - unclassified sends behave exactly as today (FIFO, same order);
   - two `RK_TELE_DEV` frames → queue depth 1, **second payload wins**;
   - `RK_TELE_DEV` and `RK_TELE_ENV` **coexist** (the shared-function regression);
   - `TXP_HIGH` enqueued behind 10 `TXP_BULK` frames dequeues **first**;
   - equal priority preserves FIFO;
   - ring full + `TXP_HIGH` → evicts a bulk item, alarm is queued, `_txCount` still <= 16;
   - replace never targets the in-flight head while `TX_SENDING`.
3. **Functional — on air**: reproduce the incident deliberately on the bench (burst ~16
   command replies), confirm from the device log + CSV that telemetry still airs on the very
   next wake and that queue depth returns to baseline immediately (contrast: 45 min before).
4. **Regression** — full existing offline suite green; a normal heartbeat bundle still airs
   all its frames in the usual order; a chunk transfer still completes.

## Risks

- **Ring index arithmetic is the whole risk.** Insert/replace/evict all manipulate a modular
  ring that the TX state machine reads concurrently from `service()`. Mitigated by: never
  touching the in-flight head, doing all mutation inside `enqueueFrame` (already the single
  writer), and the offline test asserting depth/order invariants.
- A bug here degrades *every* frame the device sends, so the offline test is not optional.
- `library.json` 0.5.0 → 0.6.0 (additive API) — DONE.
