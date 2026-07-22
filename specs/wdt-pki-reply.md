---
task: wdt-pki-reply
status: IMPLEMENTED + OBSERVED 2026-07-22 — fix verified on hardware (fw 2-260722-13); see Phase 4 results.
source_hash: src/MeshtasticTransport.cpp 0e08771f7b2dad73741aab5bea99808a8d242e6e3bb6b2f377e0073d862f0fe3; ../pac-garage-alarm/src/main.cpp 93fd63378649c9d18574698c2b0f5744872a127329c2a9411df25b9010ea53f0; ../pac-garage-alarm/platformio.ini b23d956729525d2860617a8e430b28cb9f0e2815fedea841e81f3e8d1c4158d3
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

---

# REVISION 2 (2026-07-22 ~22:30) — root cause + fix

## Trace result (instrumented repro, 22:12–22:15, fw 2-260722-12)

One repro (`@336b status` 22:12:59): `TXT enq 231 1` → frame dump → `REPLY pki OK` →
**silence** → WDT reset at +31 s (DOG count 39→…→43 across the day's crashes). No `cad`
ever fired. Reference: the post-reboot boot bundle ran five broadcasts through the full
`enq → cad → txgo → txdone` ladder cleanly. Confirmed decision-table row: **fault between
enqueue and CAD dispatch** — and additionally each field-side `ping` produced TWO crashes
(reboot wipes the dedupe ring; the mesh-relayed duplicate of the command is answered and
crashes the unit again).

## Root cause (measured, not inferred)

**Loop-task stack overflow.** The Adafruit nRF52 core runs `loop()` in a FreeRTOS task
with `LOOP_STACK_SZ = 256*4` WORDS = **4096 bytes** (`cores/nRF5/main.cpp:42`; identical
in RAK's fork and in Meshtastic's fork — verified all three). Per-function frames from
`-fstack-usage` on this exact build, worst chain for a PKC comfort reply:

```
loop()                                    368
  handleCommand()                        1104   (raw[64]+cmd[64]+reply[237]+list[150]+…)
    buildAndQueue()                       920   (meshtastic_Data ~270 + plain[237] + f[253])
      encryptCurve25519 + setDHPublicKey ~215
        Curve25519::eval                 1016   (14 × 32 B field elements)
          recip→pow250→mul→mulNoReduce  ~1032
                                        ≈ 4655  >  4096
```

The excursion runs ~550 B past the stack bottom into the heap, corrupting whatever is
allocated below. The HardFault fires when that memory is next touched — 0–1.5 s later,
in the CAD-wait window — which is why `sendPki()` returns fine, `REPLY pki OK` prints,
the last trace is `enq`, frame size does not matter, and one incident got an extra HB
out. FreeRTOS `configCHECK_FOR_STACK_OVERFLOW=1` cannot see it (samples SP only at
context switch, after the excursion returned). Boot-time key derivation survives because
its chain is only ~2.6 KB. Broadcast replies survive because `ctrCrypt` is a flat 344 B.

Upstream comparison: stock Meshtastic runs the SAME crypto on the SAME 4 KB loop stack
but keeps packets/buffers off the stack (heap packet pool, class members). We vendored
their engine without their memory discipline. The fix below adopts it.

**Latent second instance (fix in same pass):** inbound PKC decrypt —
`handleRxDone` 1208 + `decryptCurve25519` 176 + eval chain ≈ 3.8 KB. Not yet symptomatic
only because no PKC DM has been received (pki=0/0/0); TA2m DMs will exercise it.

## Fix — exact diff (function-local `static` buffers)

Rationale for form: function-local `static` keeps names, `sizeof(array)` semantics and
all downstream lines untouched (minimal diff, no header/include changes). Safe because
every one of these functions is called exclusively from the loop task (single transport
instance by design — see `_isrTarget`; ISR only sets a flag) and each buffer is fully
written before read on every path (verified per-branch for `reply`: every branch
snprintf/jsonBuilds it, zeroes it, or returns). Cost: ~2.4 KB BSS, from 256 KB.

### `src/MeshtasticTransport.cpp`

1. `buildAndQueue()` (~L150):
   `meshtastic_Data data = meshtastic_Data_init_zero;`
   → `static meshtastic_Data data; data = meshtastic_Data_init_zero;`
   (re-zeroed every call, exactly as before)
2. `buildAndQueue()` (~L157): `uint8_t plain[MAX_PAYLOAD];` → `static uint8_t plain[MAX_PAYLOAD];`
   (`sizeof(plain)` at L158 unchanged — still an array)
3. `buildAndQueue()` (~L171): `uint8_t f[FRAME_CAP];` → `static uint8_t f[FRAME_CAP];`
4. `handleRxDone()` (~L453): `uint8_t raw[FRAME_CAP];` → `static uint8_t raw[FRAME_CAP];`
   (`sizeof(raw)` at L460/L473 unchanged)
5. `handleRxDone()` (~L493): `uint8_t plain[MAX_PAYLOAD];` → `static uint8_t plain[MAX_PAYLOAD];`
6. `handleRxDone()` (~L517):
   `meshtastic_Data data = meshtastic_Data_init_zero;`
   → `static meshtastic_Data data; data = meshtastic_Data_init_zero;`
7. `handleRxDone()` (~L549): `RxPacket p;` → `static RxPacket p;`
   (every field assigned each call before `pushRx`; stale payload tail bytes are dead
   data guarded by `payloadLen`, same as with the uninitialized local today)

### `../pac-garage-alarm/src/main.cpp`

8. `handleCommand()` (~L1601): `char raw[64] = {0};`
   → `static char raw[64]; memset(raw, 0, sizeof(raw));`
   (the zero-fill is LOAD-BEARING: trim/strlen depend on NULs after the payload copy)
9. `handleCommand()` (~L1645): `char cmd[64];` → `static char cmd[64];` (strlcpy'd every call)
10. `handleCommand()` (~L1649): `char reply[237];` → `static char reply[237]; reply[0] = '\0';`
    (init added as hardening; today an unwritten branch would send stack garbage)
11. `nodes` listing (~L2308): `char list[150]; …` → `static char list[150]; …`
    (written from `o=0` every call)
12. `FW_VERSION` (L89): `"2-260722-12"` → `"2-260722-13"`

Added during Phase 4 static check (first `-fstack-usage` pass left `handleCommand` at
968 B — branch locals the inventory missed; same shape, all written-before-read):

13. `sleepfor` branch (~L2206): `char r[96];` → `static char r[96];` (snprintf'd first)
14. `wedge` branch (~L2226): `char r[128];` → `static char r[128];` (snprintf'd first)
15. `sch` branch (~L2248): `char schp[240];` → `static char schp[240];` (buildSchema fills it)
16. `buildStatus` (~L1429): add `__attribute__((noinline))` — it was inlined into
    handleCommand, so its JField table sat in handleCommand's frame for the whole
    call, including during the crypto chain. As a real call its frame is released
    before `sendPki()` runs.
17. `buildSchema` (~L2446): add `__attribute__((noinline))` — same reason.
18. `broadcastDebug` (~L1506): add `__attribute__((noinline))` — same reason (its
    JField table + pts[] buffer were the largest single block in handleCommand's frame).
19. `platformio.ini` upload_port (Change C defect, found when the Phase 4 flash failed
    twice): the by-id pin names the APPLICATION-mode USB identity
    (`usb-RAKwireless_WisCore_RAK4631_Board_<serial>`), but after the 1200 bps touch the
    bootloader enumerates as `usb-RAKWireless_WisBlock_RAK4631_<serial>` — the pinned
    path vanishes mid-cycle and pio's port-wait times out on every normal reflash.
    Fix: glob pinned to the SERIAL (matches both modes, still can never match the
    TimerCam): `upload_port = /dev/serial/by-id/*RAK4631*B8CBA9794FF6FA1E*`

Post-fix worst chain: 368 + ~130 + ~430 + 215 + 2048 ≈ **3.2 KB** (margin ~0.9 KB);
RX-decrypt chain ≈ **2.8 KB** (margin ~1.3 KB).

## Deliberately NOT changed (revision 2)

- Crypto (vendored engine + Curve25519 lib): byte-identical wire behaviour is the point.
- `LOOP_STACK_SZ`: a framework package file; patching it is invisible, unmaintainable,
  and lost on every platform update.
- The 9 TX-trace hooks: stay — cost is zero without a registered hook and they just
  proved their worth.
- `sendAck` (1024 B .su entry, likely an inlining artifact): re-measure after this fix;
  its callers' chains all shrink with buildAndQueue.
- No new task / no crypto-thread: complexity not justified once buffers are off the stack.

## Verify (Phase 4, revision 2)

1. Static: grep confirms the statics are in place; `-fstack-usage` rebuild MEASURED:
   `buildAndQueue` 920→96, `handleRxDone` 1208→192, `handleCommand` 1104→560 (four
   iterations; the <200 B first-draft gate for handleCommand was unreachable without
   noinline-ing every branch helper — the binding criterion is the CHAIN: worst PKI
   TX chain 4655→3247 B (~0.8 KB margin incl. IRQ/FPU stacking overhead ~170 B),
   RX-decrypt chain ≈2.8 KB (~1.3 KB margin). RAM cost +464 B BSS net (61456→61920,
   24.9 % of 248832).
2. Functional: flash bench → serial capture → `@336b status` → expect `REPLY pki OK`
   **followed by** `TXT cad/txgo/txdone` and unbroken 5 s HBs for 75+ s, no reboot,
   and the pong/status JSON surfacing at the gateway (the PKC DM actually delivered,
   pki counters advancing on any inbound).
3. Regression: `@336b nodes` broadcast reply still completes (`txdone`, JSON at gateway).
