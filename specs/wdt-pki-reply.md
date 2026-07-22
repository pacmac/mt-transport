---
task: wdt-pki-reply
status: SPEC — TX-path trace instrumentation to pin the fault site of the PKC-reply crash.
source_hash: ~
project: mt-transport
scope:
  - specs/wdt-pki-reply.md
  - src/MeshtasticTransport.h
  - src/MeshtasticTransport.cpp
  - ../pac-garage-alarm/src/main.cpp
  - ../pac-garage-alarm/platformio.ini   # upload_port pin — added to scope 2026-07-22 (Peter approved)
---

# wdt-pki-reply — instrumentation to locate the crash site

## Established (Phase 1, 3/3 reproductions on hardware, 2026-07-22 21:08–21:25)

Every PKC comfort reply (status ×2, ping ×1) kills the main loop within ≤1.5 s of
`sendPki()` returning; the WDT resets the board 30 s later (all three boots at reply+31 s;
flash DOG count 39→40→41 across the session).

- **The DM never reaches the air**: mesh-gw's raw /events over the window contains nothing
  from the bench (it demonstrably surfaces even undecryptable packets as `encrypted`).
  Excludes gateway-rejection and every ACK-related theory — no ACK ever existed.
- **Crash ≤1.5 s after sendPki returns** (WDT−30 s arithmetic, two frame sizes):
  excludes serviceAck (+4 s), inbound-ACK decrypt (no ACK), and pkiEncrypt (the
  `REPLY pki OK` print follows it; incident 1 printed one more HB after that).
- **Size-independent**: 232 B and 88 B frames crash identically.
- **Signature is a dead stop** (no prints, WDT at exactly +30 s from last feed) —
  consistent with a HardFault spinning in the default handler, not a bounded wait.
- Transport TX path read end-to-end (driveTx/startSending/service/enqueueFrame/armRx/
  serviceAck/airtime/vendored engine): non-blocking throughout, all buffers FRAME_CAP,
  no fault site found by inspection.

Remaining unknown: which step inside the ~1.5 s window (CAD start → CAD-done →
startTransmit → early TX) executes last. This spec adds the minimum trace to answer that.

## Change A — mt-transport: optional TX trace hook

The library does no logging of its own (by design). Add a caller-registered hook; every
call site is guarded, so with no hook registered behaviour is byte-identical.

`src/MeshtasticTransport.h` (public, next to the other setters):
```c
    // TX-path trace hook (diagnostics). NULL by default; the library never logs.
    void setTxTrace(void (*fn)(const char *ev, uint32_t a, uint32_t b)) { _txTrace = fn; }
```
private members:
```c
    void (*_txTrace)(const char *, uint32_t, uint32_t) = nullptr;
    void trace(const char *ev, uint32_t a, uint32_t b) { if (_txTrace) _txTrace(ev, a, b); }
```

`src/MeshtasticTransport.cpp` call sites (exact placements):
1. `enqueueFrame()` on success, before `return true`: `trace("enq", len, _txCount);`
2. `driveTx()` TX_WAITING, fail-open branch: `trace("failopen", it.attempts, 0);`
3. `driveTx()` TX_WAITING, CAD started OK: `trace("cad", it.len, it.attempts);`
4. `driveTx()` TX_WAITING, CAD could-not-start branch: `trace("caderr", 0, 0);`
5. `startSending()` immediately before `startTransmit`: `trace("txgo", it.len, 0);`
6. `startSending()` startTransmit-failed branch: `trace("txerr", (uint32_t)st, 0);`
   (capture `int16_t st = _radio->startTransmit(...)` into a local — currently the
   return value is compared inline; the local changes nothing else)
7. `service()` TX-done branch, after `finishTransmit()`: `trace("txdone", 0, 0);`
8. `service()` CAD_DETECTED branch: `trace("cadbusy", _txq[_txHead].attempts, 0);`
9. `driveTx()` TX_SENDING 5 s force-finish branch: `trace("txto", 0, 0);`

## Change C — pac-garage-alarm/platformio.ini: pin upload_port (SAFETY, found during Phase 3)

`upload_port` was NEVER pinned in this project (git log -S: no history), contradicting the
handover's claim. Consequence observed 2026-07-22 21:40–21:50: with the RAK absent from USB
after a failed DFU, `pio run -t upload` auto-detected `/dev/ttyUSB0` — the TimerCam's FTDI
adapter — and performed a 1200 bps control-line touch + DFU probe on it, twice. Fix:

```
upload_port = /dev/serial/by-id/usb-RAKwireless_WisCore_RAK4631_Board_B8CBA9794FF6FA1E-if00
```

An absent RAK now fails the upload cleanly instead of attacking whatever port exists.
(timercam-chunk already pins its port — line 38 — and needs no change.)

## Change B — pac-garage-alarm/src/main.cpp: register the hook + FW bump

1. In `setup()`, immediately after the `mesh.begin` success path:
```c
    mesh.setTxTrace([](const char *ev, uint32_t a, uint32_t b) {
        DBG("TXT %s %lu %lu\n", ev, (unsigned long)a, (unsigned long)b);
    });
```
   (DBG = Serial.printf, USB CDC only; discarded with no host — free when deployed.)
2. `FW_VERSION` "2-260722-11" → "2-260722-12" (line 89).

## How this answers the question

One repro (`@336b status`) then reads the last TXT line before silence:
- last = `enq` → fault between enqueue and CAD dispatch (or in getTxDelayMsec path)
- last = `cad` → fault in the CAD window / CAD-done handling
- last = `cadbusy` → fault in the backoff/reschedule path
- last = `txgo` → fault inside startTransmit or mid-transmit (radio/ISR territory)
- `txdone` appears → fault is AFTER TX completes and the on-air absence needs re-examination

A healthy broadcast (`@336b nodes`) provides the reference sequence for comparison.

## Deliberately NOT changed

- No fix is attempted in this pass — the fix diff belongs to the next spec revision once
  the fault site is known (no patching over patches).
- No HardFault handler / fault-register persistence — fallback if the trace is
  inconclusive, not first resort (bigger change, flash writes from fault context).
- serviceAck, pkiEncrypt/pkiDecrypt, HB line: untouched.

## Verify (Phase 4)

Flash per standing procedure → `@336b nodes` (reference trace, must complete with
txdone, no reboot) → `@336b status` (crash trace, capture 75 s incl. reboot banner) →
report the last event. Counters/HB unchanged elsewhere.
