---
task: v2-phase3-one-port
status: SPEC — not yet implemented. Decisions made on Peter's behalf 2026-07-22 (delegated).
priority: v2 Phase 3 — collapse to one port + retire @xxxx. FIRST DELIBERATELY-BREAKING phase.
source_hash: ~
project: spans pac-garage-alarm (command parser + reply routing) and clients/node (addressing).
         BREAKING: node-dash must move in lockstep — see "Coordination" below.
scope:
  - (pac-garage-alarm) src/main.cpp   # stop sending responses on 260; DM by nodeNum; drop @xxxx routing
  - clients/node/index.js             # address by nodeNum; drop @xxxx target grammar
  - clients/node/lib/commands.js      # command grammar without @name prefix
  - clients/node/test/offline-addressing.js  # NEW — assert nodeNum addressing, no @name
---

# v2 Phase 3 — one port + DM-by-nodeNum (BREAKING)

Only after Phase 2 has proven the JSON-ptype path in parallel. This phase removes the parallel
old routing: machine responses ride **261 only**, comfort replies are **DMs** (Phase 1 primitive),
and addressing is **by nodeNum**, retiring the `@xxxx` short-name prefix (which is also the
short-name addressing footgun).

## DECISIONS (made on Peter's behalf)
- **D3.1 Machine responses on 261 only.** The firmware stops calling `send(PAC_ALARM_APP=260, …)`
  for responses; every machine response is a chunk payload on 261. (260 send code is *neutered*
  here, physically *removed* in Phase 4, so this phase stays reviewable as a routing change.)
- **D3.2 Retire `@xxxx` name addressing → DM by nodeNum.** The device command parser no longer
  interprets a leading `@name`; node-dash addresses the device by its node number. Kills the
  "target by short name" trap flagged in memory (`no-hardcoded-identity`, naming-trap).
- **D3.3 Comfort replies are DMs** (`to=rx.from`, want_ack) using the Phase 1 send path — no
  longer broadcast text.
- **D3.4 Standard ports untouched.** TELEMETRY/NODEINFO/POSITION stay native (phone interop).

## Coordination (BREAKING — do NOT do autonomously)
A device/node-dash addressing+port mismatch = total comms loss. Device and node-dash MUST cut
over together. This phase is staged on a branch and **must not be merged or deployed without
Peter + the node-dash side moving in lockstep**. `pre-v2` remains the rollback point.

## Tests
- **Offline (`offline-addressing.js`):** assert the command builder emits NO `@name` prefix and
  addresses by nodeNum; assert responses are expected on 261 only. Contract-level, survives later
  phases.
- **On-air (bench):** full comfort + machine round-trip against `!8cee336b` with the new
  addressing; assert decoded replies. Bench only; field unit untouched.

## Out of scope
Deleting dead code (Phase 4). Field cutover (Phase 5). Channel-0 config (never v2).
