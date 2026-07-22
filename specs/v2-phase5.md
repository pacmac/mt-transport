---
task: v2-phase5-conformance-cutover
status: SPEC — not yet implemented. HUMAN-GATED: the field cutover cannot be done autonomously.
priority: v2 Phase 5 — conformance lock + coordinated field cutover. BREAKING + irreversible.
source_hash: ~
project: mt-transport (conformance suite) + the field cutover (device !987ab80f + node-dash).
scope:
  - clients/node/test/cross-cpp.js        # extend conformance to every v2 ptype + comfort DM
  - clients/node/test/onair-e2e.js         # NEW — full bench end-to-end, all commands
  - (mt-transport) docs/v2/README.md      # mark cutover done + record the deployment
---

# v2 Phase 5 — conformance + coordinated cutover (HUMAN-GATED)

## DECISIONS (made on Peter's behalf)
- **D5.1 Conformance is the merge gate.** Firmware generates fixtures; the node lib must decode
  them byte-for-byte (`cross-cpp.js` model), now covering ptype 4 (JSON) and the comfort DM shape.
  Firmware and lib cannot drift without a red test.
- **D5.2 Bench e2e before any field touch.** Every command, comfort + machine, round-trips on
  `!8cee336b` with the full v2 stack and the offline suite green.

## HARD STOP — field cutover is NOT autonomous
The final step flashes the **field unit `!987ab80f`**, which is OFF-LIMITS to automation:
no OTA, recovery = a physical drive (memory: field-flash-is-expensive, no-sleep-on-deployed-unit).
It is also a **coordinated, irreversible** flip with the separate node-dash consumer — a mismatch
= total comms loss. This step requires **Peter, on-site, with node-dash moving in lockstep**.
Automation takes everything to the bench-green line and stops here. `pre-v2` is the rollback tag.

## Deliverable of the autonomous portion
Conformance suite + bench e2e script, both green offline / ready for the bench. The field cutover
is handed off with a checklist, not executed.
