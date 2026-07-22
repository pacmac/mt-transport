---
task: ta2m-dm-observability
status: SPEC — adopt pkiRx* counters, surface them in the HB line, bump FW_VERSION; one bench flash.
source_hash: |
  src/MeshtasticTransport.h dc4c31196103befa4ce825bb8b1c85b68061f4347ae6416c00502af2679b307e
  src/MeshtasticTransport.cpp 0939b654be5c945d1b9f2e502d402a2b4b460e7b147f5ac4c8682f31886818bb
  (pac-garage-alarm) src/main.cpp 85b0f52e02066c96dacb8006260adfb9530bbf1b882f3a71743728a90ed2e670
project: mt-transport
scope:
  - specs/ta2m-dm-observability.md
  - src/MeshtasticTransport.h
  - src/MeshtasticTransport.cpp
  - ../pac-garage-alarm/src/main.cpp
---

# PKC RX observability — unblock the decisive TA2m DM test

## Why

A PKC packet the bench cannot decrypt is dropped inside `MeshtasticTransport::handleRxDone()`
before the application sees it, so "DM arrived and was rejected" and "DM never arrived" are
identical silence (Q&A Q2). The decisive TA2m test (handover §7 as amended) needs those outcomes
distinguishable on the bench's serial. Counters exist as an uncommitted working-tree diff; nothing
reports them. This task adopts the diff, reports the counters in the HB line, bumps FW_VERSION,
and flashes the bench once — Q&A Q9 work-order item 1.

## Change A — mt-transport: adopt the counter diff (NO further edits)

The working tree already contains the exact intended state. Phase 3 action is **commit only**.

`src/MeshtasticTransport.cpp` (in `handleRxDone()`, PKC branch): sets `_pkiLastFrom = h.from`
for every PKC packet seen, then increments exactly one of `_pkiRxNoKey` / `_pkiRxAuthFail` /
`_pkiRxOk`. Control flow (early returns) unchanged.

`src/MeshtasticTransport.h`: public accessors `pkiRxOk() / pkiRxNoKey() / pkiRxAuthFail() /
pkiLastFrom()` at :159–162; private members zero-initialised at :299.

Collision check done (Phase 1): the only occurrences of these names in
`src/ include/ test/ clients/ examples/` are the diff's own lines.

## Change B — pac-garage-alarm/src/main.cpp: two edits

### B1. HB line gains `pki=` and `pkifrom=` (line 3059–3065)

Before:
```c
            DBG("HB up=%lus boot=%u rst=0x%lx txfs=%lu csma=%lu tx=%u rx=%s%lus\n",
                (unsigned long)(nowHb / 1000), (unsigned)g_bootCount,
                (unsigned long)g_resetReason,
                (unsigned long)mesh.txFailStreak(),
                (unsigned long)mesh.csmaDeferrals(),
                (unsigned)(mesh.busy() ? 1 : 0),
                g_lastRxMs ? "" : "never/", (unsigned long)rxAge);
```

After:
```c
            DBG("HB up=%lus boot=%u rst=0x%lx txfs=%lu csma=%lu tx=%u rx=%s%lus"
                " pki=%lu/%lu/%lu pkifrom=%08lx\n",
                (unsigned long)(nowHb / 1000), (unsigned)g_bootCount,
                (unsigned long)g_resetReason,
                (unsigned long)mesh.txFailStreak(),
                (unsigned long)mesh.csmaDeferrals(),
                (unsigned)(mesh.busy() ? 1 : 0),
                g_lastRxMs ? "" : "never/", (unsigned long)rxAge,
                (unsigned long)mesh.pkiRxOk(), (unsigned long)mesh.pkiRxNoKey(),
                (unsigned long)mesh.pkiRxAuthFail(), (unsigned long)mesh.pkiLastFrom());
```

Field semantics:
- `pki=<ok>/<nk>/<af>` — PKC RX outcomes since boot: decrypted / no key held for sender /
  auth failure.
- `pkifrom=<hex8>` — nodeNum of the last PKC packet seen (any outcome), `00000000` = none since
  boot. Hex because nodeNum in hex IS the node id: TA2m's 3663393832 = `da5af428` = `!da5af428`.
  This pins WHICH node caused a count — a bare `nk` increment would not prove the sender was TA2m.

Serial-only line via `DBG` = `Serial.printf` (main.cpp:47); no radio frame, no length budget, and
nothing in `tools/ clients/ test/` parses the HB format (Phase 1 grep: no matches).

### B2. FW_VERSION bump (line 89)

Before: `static const char FW_VERSION[] = "2-260722-10";`
After:  `static const char FW_VERSION[] = "2-260722-11";`
Constraint at :88: ≤14 chars; `"2-260722-11"` is 11. Flash pins the on-air source state (Q5/Q6).

## Deliberately NOT changed

- `specs/serial-heartbeat.md` — its format line (:36) already disagrees with the implementation
  (documents `txq=`/`heap=`, implemented line has `tx=` and no heap). Pre-existing drift,
  REPORTED and parked (bugs-enhancements); updating it here would fold an unrelated correction
  into this task. This spec is the record for the new `pki=`/`pkifrom=` fields.
- `test/offline_pki_vectors.cpp` — no assertions on the counters; separate task if wanted.
- `HB_LOG_MS`, all other HB fields — untouched.

## Flash + verify (Phase 4)

Kill stray serial captures → `cd pac-garage-alarm && pio run -t upload` (whole procedure,
handover §3) → verify "Device programmed" in output AND USB PID back to `8029` → confirm on
serial via `tools/serial-log.py`: new HB shows ` pki=0/0/0 pkifrom=00000000` and node reports
FW `2-260722-11`.

## VERIFIED on hardware, 2026-07-22 21:07–21:11

- Flash: "Device programmed." in upload log; `lsusb` PID back to `239a:8029`.
- HB format live: `HB up=15s boot=2 rst=0x4 ... pki=0/0/0 pkifrom=00000000` (21:07:33 onward).
  Counters at 0 with no PKC RX — correct; full counter exercise DEFERRED to the TA2m DM test
  (requires Peter to send a DM; that is the point of this build).
- FW on air: OMNI nodedb `long_name: "Alarm Unit 336b 2-260722-11"`, last_heard 21:09.
- Regression (broadcast reply path): `@336b nodes` cmd packet 4255843897 at 21:11:02 → bench
  reply packet 603126277 (reply_id=4255843897) in the node-dash store at 21:11:05.
- Build: 1 pre-existing warning only (main.cpp:408 -Wmisleading-indentation, camuPoll — parked).

## INCIDENTAL FINDINGS (reported, NOT fixed here)

1. **Watchdog reset 30 s after a PKI comfort reply — evidence for open problem #2.** One sample:
   `@336b status` (comfort, OMNI key held) → `REPLY pki id=0x7bc87392 OK` at 21:08:18; HBs due
   :23–:38 never appeared (capture ran to 21:08:42 — loop stopped); next boot instant computes to
   ~21:08:49 (`up=135` at 21:11:04) with `rst=0x2` (DOG). Timing arithmetic only, causation NOT
   proven. Hypothesis to test: `sendPki(..., wantAck=true)` path (main.cpp:2360) blocks the loop.
   The PKI reply is pre-existing committed code; this task's diff touches only RX counters + a
   printf.
2. **Boot counter went 2 → 1 across that watchdog reset** (21:08 HB `boot=2`, 21:11 HB `boot=1`).
   Unexplained; GPREGRET2 is documented to survive resets.
3. `specs/serial-heartbeat.md:36` documents `txq=`/`heap=` fields; implementation emits `tx=`,
   no heap. Pre-existing spec/implementation drift.
4. Whether the 2.8 gateway ACCEPTED the PKC DM reply is still undetermined (packet 2076734354
   absent from mesh-gw's message list, but §5 says the store cannot show DMs; needs the WS
   /events stream open at send time — that is v2-phase1b step 7, unchanged).
5. Open problem #1 ("no replies since 19:08:45") is NOT a live condition: bench broadcast
   replies are in the store at 20:00:21 (pre-flash) and 21:11:05 (post-flash, 3 s latency).
