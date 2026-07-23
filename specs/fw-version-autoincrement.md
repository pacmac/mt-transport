---
task: fw-version-autoincrement
status: SPEC 2026-07-23 — implementing during the deployment-candidate morning (Peter:
        "why are you manually updating the version, this should be done using a pio
        pre-compile script?"). Two manual slips today made the case.
source_hash: ~
project: pac-garage-alarm
scope:
  - specs/fw-version-autoincrement.md
  - ../pac-garage-alarm/tools/bump_fw.py       # NEW — pre-build stamper
  - ../pac-garage-alarm/platformio.ini          # extra_scripts hook
  - ../pac-garage-alarm/src/main.cpp            # FW_VERSION from generated header
  - ../pac-garage-alarm/.gitignore              # counter + generated header untracked
---

# Auto-stamped FW_VERSION — a pio pre-script, not a hand edit

## Why now
Manual bumping failed twice on 2026-07-23 alone: a candidate briefly named
"2-260722-16" after midnight, and a stale date Peter had to point out. Seven
flashes in one morning is the cadence where hand-stamping guarantees drift.
The `bump-fw-version-on-divergence` rule stays; the mechanism becomes automatic.

## Design
- `tools/bump_fw.py`, hooked as `extra_scripts = pre:tools/bump_fw.py`:
  1. today = local YYMMDD.
  2. Read `tools/.fw_counter` ("YYMMDD n"). Same day → n+1; new day → 1.
  3. Write counter back; emit `src/build_version.h`:
     `#pragma once` + `#define FW_VERSION_STR "2-YYMMDD-n"`.
- `main.cpp`: `static const char FW_VERSION[] = "2-260723-3";` →
  `#include "build_version.h"` + `static const char FW_VERSION[] = FW_VERSION_STR;`
  (the ≤14-char rule holds: "2-YYMMDD-nnn" = 12).
- `.gitignore` += `tools/.fw_counter`, `src/build_version.h` (machine-local state
  and generated output; the shipped version is recorded by the build log, the
  device itself, and commit messages).
- Every `pio run` bumps — including failed builds and no-change rebuilds. That is
  DELIBERATE: burning numbers is free (three digits), while any "only when changed"
  cleverness reintroduces the judgment call this removes. The dashboard shows
  whatever the device reports; gaps in the sequence mean nothing.
- Commit-message surfacing (task title's second half): convention only — quote the
  stamped version in the commit subject as done all session; no git hook.

## Verify
1. Build → build_version.h exists, FW_VERSION_STR = today's date, n increments
   across two consecutive builds.
2. Flash → boot banner + @status report the stamped version.
3. Day-rollover logic: unit-test by writing a stale date into .fw_counter and
   confirming n resets to 1.
