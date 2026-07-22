---
task: v2-phase4-remove-dead-code
status: SPEC — not yet implemented. Decisions made on Peter's behalf 2026-07-22 (delegated).
priority: v2 Phase 4 — remove the now-dead v1 machinery. BREAKING (removes code paths).
source_hash: ~
project: pac-garage-alarm (jsonBuild + sch + 260 sends). Verify EVERY caller before deleting.
scope:
  - (pac-garage-alarm) src/main.cpp   # remove jsonBuild size-shedding, sch pagination, 260 sends
  - (mt-transport) docs/v2/APIV2.md   # confirm "Removed in v2" section matches reality post-removal
---

# v2 Phase 4 — remove dead code (BREAKING)

Only after Phases 2-3 have proven the replacements on the bench. This is a real removal that
partly unwinds fw 260721-11 (`json-builder-universal`).

## DECISIONS (made on Peter's behalf)
- **D4.1 Remove `jsonBuild` size-shedding:** the `JReq` MUST/OPTIONAL machinery, the fit-loop, and
  the reserved-brace accounting. The 237-byte cap they guarded no longer exists (chunking + whole-
  payload CRC). The builder collapses to **always-emit** every field.
- **D4.2 Remove `sch` pagination** (`{"t":"sch","p":P,"n":N,…}`, per-page header). Schema is a
  JSON-ptype payload (Phase 2), delivered whole.
- **D4.3 Remove the port-260 response sends** neutered in Phase 3.
- **D4.4 Removal is gated on a caller census.** `grep` every `jsonBuild` / `JReq` / `buildSchema`
  / `SCHEMA_PER_PAGE` / `PAC_ALARM_APP` use and confirm each is dead before deleting. This is the
  "verify every caller" rule (memory: no-patching-over-patches; the removal must be evidence-led,
  not optimistic). Record the census in the /idiot task notes.

## Tests
- **Regression:** the FULL accumulated offline suite (P1-P3) must stay green — the capabilities
  (status/config/schema/…) are asserted at the contract level, so removing the mechanism must not
  fail them. If a P1-P3 test goes red, the removal took a live path — stop.
- **On-air (bench):** every command exercised end-to-end post-removal against `!8cee336b`.
- Gate: `pio run` clean; flash size should DROP (dead code gone) — record before/after.

## Out of scope
Field cutover (Phase 5).
