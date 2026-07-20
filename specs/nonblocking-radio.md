---
task: nonblocking-radio
status: proposed — design phase, no code
priority: HIGH (Peter, 2026-07-20: "I see no reason to block the device under any
  circumstances")
source_hash: ~
updated: 2026-07-20
scope:
  - projects/mt-transport/src/MeshtasticTransport.cpp
  - projects/mt-transport/src/MeshtasticTransport.h
  - projects/pac-garage-alarm/src/main.cpp   # branch chunk-integration
---

# Spec: nonblocking-radio — no blocking in the message path, ever

## 1. Why

The firmware blocks the CPU in the radio path. Because RX is **poll-only**
(serviced only when `loop()` calls `mesh.receive()`), every block is a window
where the node hears nothing and services nothing. Measured/confirmed
(investigation 2026-07-20):

| block | where | cost |
|---|---|---|
| reply delay | `main.cpp:556,559` `delay(2000+rand%3000)`+`delay(3000)` | **5–8 s per command reply**, app fully stalled |
| blocking TX | `MeshtasticTransport.cpp:140` `_radio->transmit()` | **full time-on-air per frame** (~0.5–1.5 s at SF11); a heartbeat is 6 frames back-to-back |
| CSMA backoff | `MeshtasticTransport.cpp:110` `delay(30+rng%window)` | up to 8×≤509 ms per transmit, ×6 per heartbeat |

**MT does none of this.** Verified: `RadioLibInterface/SX126xInterface/
RadioInterface/Router/MeshService` contain **zero `delay()`** — the message path
is fully event-driven (`NotifiedWorkerThread` + `notifyLater`). Peter, 2026-07-20:
"nothing in the official MT firmware blocks, and that is how it should be." The
radio path must match that: **no `delay()` in any awake message path.**

Out of scope, and NOT blocking-bugs: `doSleep()`'s 1 s chunks (that IS the
sleep) and the deployment RTC sleep (`deployment-sleep` task). Camera-path
blocking (`M5CameraSource` I2C settle, capture poll) is `camera-fetch-stall`
territory, tracked separately.

## 2. Relationship to `adopt-meshtastic-csma`

That task's step 3 (listen-during-backoff, re-arm-after-TX) is done. Its later
steps 4/5 (contention window derived from channel utilisation, SNR weighting)
are **realised here** as the scheduled non-blocking delay — the async
restructure is the vehicle they always needed. This task is the architectural
change; the CSMA task's remaining derivation steps fold into step 4 below.

## 3. Design decision (step 1 — settle before any code)

Two mechanisms fit an nRF52 Arduino app (FreeRTOS underneath):

- **A. FreeRTOS worker thread** (MT's model: `NotifiedWorkerThread`). Most
  faithful; a dedicated thread woken by DIO1 IRQ and timer notifications owns the
  radio. Largest change; introduces cross-thread ownership of the SPI/radio.
- **B. Loop-driven non-blocking state machine.** DIO1 IRQ sets an RX flag;
  `loop()` services RX promptly and never `delay()`s; TX is a queue + a
  `millis()`-scheduled state machine (`startTransmit()` then TX-done IRQ). No new
  thread; fits the existing single-`loop()` structure; the whole app must simply
  never block so `loop()` spins fast.

**DECIDED: B (loop-driven).** Peter, 2026-07-20: "my experience with FreeRTOS
(on the esp32) is flaky, loop driven is safer." A is rejected — the shared-radio
cross-thread ownership is exactly the flakiness risk to avoid.

### Concrete design (step 1 output — buildable on the RadioLib in libdeps)

RadioLib API confirmed present: `setDio1Action`, `setPacketReceivedAction`,
`setPacketSentAction`, `startTransmit`, `finishTransmit`, `startReceive`,
`getIrqFlags`, `startChannelScan` (async CAD).

**One ISR, one flag.** `setDio1Action(cb)` where `cb` sets
`volatile bool _radioEvent = true`. DIO1 fires for RX-done, TX-done and CAD-done
alike; the ISR does nothing but set the flag — no SPI in the ISR.

**A non-blocking `service()` called every `loop()` pass** (replaces the
blocking `receive(timeoutMs)` poll). It:
1. If `_radioEvent`, clear it and read `getIrqFlags()`:
   - `RX_DONE` → `readData()`, hand the packet to the app (callback/out-queue),
     `startReceive()` to re-arm.
   - `TX_DONE` → `finishTransmit()`, TX state → IDLE, `startReceive()`.
   - `CAD` result → feed the TX state machine (busy → `startReceive()` +
     reschedule; free → `startTransmit()` the queued frame).
2. Drive the TX state machine (below). Return immediately — **never `delay()`**.

**TX state machine + small outbound queue.** Each queued frame carries
`tx_after` (ms). States: `IDLE` → (queue non-empty) `WAITING` → (now ≥ tx_after)
`SCANNING` (async CAD via `startChannelScan`) → CAD-done: free → `SENDING`
(`startTransmit`), busy → `startReceive` + `tx_after = now + reschedule` back to
`WAITING`. TX-done IRQ → `IDLE`, service next. `send()` just enqueues with
`tx_after = now + getTxDelayMsec()` and returns — no block.

**CAD is async too.** `startChannelScan()` + CAD-done IRQ, not the synchronous
`scanChannel()` (which blocks ~4 symbols ≈ tens of ms). This keeps step 3's
"listen on busy" behaviour with zero block.

**App integration (`pac-garage-alarm`).** `loop()` calls `mesh.service()` each
pass (non-blocking) and handles any delivered packet. `sendReplyWithRetry`
becomes: enqueue the reply with a scheduled delay, enqueue the resend with a
later `tx_after`, return — **both `delay()`s gone**. `doSleep()` is untouched
(intentional sleep). The awake path must contain no `delay()` — that is the
invariant step 6 checks.

## 4. The changes (steps 2–5)

**Step 2 — RX by IRQ.** Attach a DIO1 interrupt (`setDio1Action`/`setPacketReceivedAction`)
that sets a volatile `_rxReady` flag. `receive()`/a new non-blocking `poll()`
services it with no `delay()` spin; the SX1262 stays armed continuously.
Liveness stops depending on the `delay(2)` poll cadence.

**Step 3 — TX async.** `startTransmit()` + a TX-done IRQ instead of blocking
`transmit()`. Outbound frames go on a small queue; the TX state machine sends
one, waits (via IRQ, not `delay()`) for done, re-arms RX. `loop()` is never held
for the airtime.

**Step 4 — scheduled, derived, non-blocking delay.** Replace:
- `sendReplyWithRetry`'s `delay(2000+rand%3000)`+`delay(3000)`, and
- `waitForClearChannel`'s per-attempt `delay(...)`,
with a `millis()`-scheduled send time computed from channel utilisation (the MT
`getTxDelayMsec` = `random(0, 2^CWsize) * slotTime`, `CWsize` mapped from
utilisation; SNR-weighted for replies). No CPU block — the frame just leaves
later. Ties to `airtime-accounting-fixes` for honest utilisation.

**Step 5 — don't TX over an inbound packet.** Add an `isActivelyReceiving`
guard before dequeuing a TX (MT `canSendImmediately`): if mid-reception, reschedule.
This retires `_rxDroppedByTx` from *counting* the loss to *preventing* it.

## 5. Verification (step 6, bench unit only)

1. **Static:** `grep delay( ` shows none in the awake message path (transport TX/RX,
   `sendReplyWithRetry`, CSMA). `transmit()` (blocking) gone; `startTransmit()` present.
2. **Loop liveness:** instrument max `loop()` interval; it must never exceed a
   small bound (target < ~50 ms) even across a heartbeat bundle and a command reply.
   Today it exceeds **seconds**.
3. **The headline proof:** a command `@ping`/`@status` sent so it arrives *during*
   a heartbeat bundle still gets answered — impossible today because the node is
   deaf through the whole bundle.
4. **No regression:** heartbeats decode; a full chunk transfer still completes and
   CRC-matches.
5. **Hardware rules:** bench unit only; OMNI ch2; remote unit never touched.
   Register/IRQ setup must be re-applied in `wake()` (survives sleep), per the
   standing `adopt-meshtastic-csma` constraint.

## 6. Sequencing note

This is a substantial, sensitive refactor of the transport that both firmwares
depend on. It is staged 2→3→4→5 so each lands and is verified on air before the
next. Do NOT attempt it as one big edit. Step 1 (design sign-off) first.
