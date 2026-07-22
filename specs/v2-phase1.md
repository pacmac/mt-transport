---
task: v2-phase1-reliability
status: SPEC — not yet implemented. Peter away 2026-07-22; decisions below made on his
        behalf per explicit delegation ("make informed decisions… create a spec for any
        decisions you would have otherwise asked me"). Review the DECISIONS block first.
priority: v2 Phase 1 — the reliability layer; gates nothing but is the foundation the rest sits on
source_hash: ~   # set to the src/MeshtasticTransport.cpp hash when implementation begins
project: mt-transport (the transport library). Non-breaking; runs alongside v1.
scope:
  - src/MeshtasticTransport.h      # add wantAck param + pending-ack retransmit API/state
  - src/MeshtasticTransport.cpp    # want_ack flag + transport-owned no-ACK retransmit driver
  - test/offline_wire_flags.cpp    # NEW — deterministic host C++ check of the want_ack bit layout
  - clients/node/test/onair-reliability.js    # NEW — bench: read ack counters, prove no unrecovered send
  # firmware end (sibling repo, same phase — "lands both ends"):
  - ../pac-garage-alarm/src/main.cpp  # sendText/sendReply gain to+wantAck; comfort replies (ping/status)
                                      # become DM+want_ack; ack counters exposed in the debug frame
---

# v2 Phase 1 — reliability layer (want_ack + transport-owned retransmit + DM addressing)

Realizes the intent already written in `pac-garage-alarm/src/main.cpp:949-957`:
*"If guaranteed delivery is ever needed, do it the MT way (want_ack + ACK-triggered
retransmit), not a blind copy."* Today `send()` hardcodes `packFlags(hopLimit, hopLimit)` —
want_ack is never set — and every reply is a broadcast, so loss is silent and unrecoverable.

## DECISIONS (made on Peter's behalf — review these)
- **D1.1 Retransmit is TRANSPORT-owned, not app-owned.** The phase must be "independently
  testable — force a drop, prove the retransmit" (README phase table), and v2's whole point is
  one reliable code path. Consumers must not hand-roll ACK correlation.
- **D1.2 API = append `bool wantAck=false` as the LAST `send()` param.** Appending (not inserting)
  keeps every existing positional caller valid → non-breaking. Signature becomes
  `send(portnum, payload, len, to=BROADCAST, hopLimit=3, requestId=0, replyId=0, wantAck=false)`.
- **D1.3 want_ack is honored only for directed sends** (`to != BROADCAST_ADDR`). A broadcast with
  `wantAck=true` silently drops the flag — broadcasts are never ACKed (matches the main.cpp:950
  note). Documented, not asserted-away.
- **D1.4 ONE pending-ack slot** (single outstanding reliable send). The device answers one command
  at a time and node-dash serialises, so one slot suffices. A new reliable send while one is
  pending **abandons** the previous (increments a dropped-ack counter) rather than blocking.
  A ring can come later if a real need appears — YAGNI now.
- **D1.5 The chunk lane does NOT use transport per-frame retransmit.** Chunk loss is already
  recovered by re-PULL (application-level ARQ: the client re-requests missing indices). Adding
  per-frame want_ack to an N-frame batch would need N slots and duplicates existing recovery.
  → Phase 1 auto-retransmit covers **single directed sends (comfort replies)** only.
  **Reconcile APIV2 §6** at implementation: change "CHUNK × n, each DM+want_ack" to state that
  chunk recovery is re-PULL; want_ack on individual chunks is optional. (APIV2 is SSOT — edit it
  in the same PR so code and contract never diverge.)
- **D1.6 ACK detection is internal.** In `handleRxDone()`, a decoded `ROUTING_APP` packet whose
  `request_id == _pendingId` clears the pending slot. It is still delivered to `poll()` (harmless;
  the app may want to observe the ACK).
- **D1.7 Retransmit stores its OWN frame copy.** `resend()` re-enqueues `_frame`, which any later
  `send()` overwrites — so a pending retransmit is unsafe on it. Add `_pendingFrame[FRAME_CAP]`,
  `_pendingLen`, `_pendingId`, `_pendingDeadline`, `_pendingAttempts`; retransmit re-enqueues the
  stored bytes verbatim (same id → receivers dedupe).
- **D1.8 Timeout = 4000 ms, max 3 attempts** (original + 2 retransmits; worst case ~12 s, inside
  the observed ~10-15 s reply tolerance and the "device reply window 10 s" memory). Both
  configurable via setters (`setAckTimeoutMs`, `setAckMaxAttempts`). RAM-only, not persisted.

## Changes
1. `send()`: append `wantAck`; set flags `packFlags(hopLimit, hopLimit, wantAck && to != BROADCAST_ADDR)`.
2. On a directed reliable send, snapshot the frame into the pending slot (id, bytes, len,
   deadline = now + timeout, attempts = 1).
3. `service()`: if a pending slot exists and `now >= _pendingDeadline`: if `attempts < max`,
   re-enqueue the stored frame, `attempts++`, reset deadline; else give up (increment
   `_ackFailTotal`, clear slot).
4. `handleRxDone()`: clear the pending slot on a matching ROUTING_APP ACK (D1.6).
5. Counters + introspection for tests: `pendingAckId()`, `ackFailTotal()`, `ackRetransmits()`.
6. **Firmware end (this phase's "both ends"):** `sendReply()` in `pac-garage-alarm/src/main.cpp`
   sends the comfort reply as a **DM to `rx.from` with `wantAck=true`** instead of
   `sendText()` broadcast. (Add `pac-garage-alarm/src/main.cpp` to scope at implementation;
   separate /idiot task in the pac-garage-alarm project since it is a different repo.)

## Tests (no-hallucinate; assert the CONTRACT)
- **D1.9 Offline tier is a C++ host-check, not a node test.** want_ack is a device↔device
  `PacketHeader.flags` bit; the node client (post-gateway) never sees it, so a node offline test
  cannot assert it. `test/offline_wire_flags.cpp` host-compiles `mt_wire.cpp` and pins the exact
  bit layout `send()` sets and `handleRxDone()` reads (v1=0x63, reliable=0x6B, delta = bit 3), plus
  the directed-gating contract. **Runs now, deterministic:**
  `g++ -std=c++17 -Isrc test/offline_wire_flags.cpp src/mt_wire.cpp -o /tmp/wf && /tmp/wf`.
  Follow-up: wire it into `npm test` (spawn g++) alongside the node suite.
- **On-air (`onair-reliability.js`, bench `!8cee336b` only):** reads the device ack counters via
  `debug` (needs the firmware-end fields `ackRt`/`ackFail` — task step 4), drives directed
  want_ack replies, and asserts the CONTRACT: every reliable reply confirmed AND `ackFailTotal`
  did not climb (nothing left unrecovered); retransmits absorbed are reported, not failed on.
  A hard drop-test (guaranteed retransmit via device-side ACK suppression) is a follow-up hook.
  **Not self-runnable without the bench + rig; staged for the bench.**
- A C++ compile (`pio run -e rak4631` in pac-garage-alarm, which symlinks this lib) is the
  minimum gate before any on-air claim — **done: clean, RAM 22.3%, Flash 25.5% (+928 B).**
  Offline host-check **done: PASS** (output above).

## Out of scope
Chunk-everything (Phase 2), port collapse / @xxxx retire (Phase 3), dead-code removal (Phase 4),
channel-0 config (never part of v2).
