---
task: pir-image-pipeline
status: v1.1 IMPLEMENTED + PROVEN ON AIR 2026-07-23 09:26 (fw 2-260723-15) — edge→grab 1 s, held announcement aired on qualification, photo pulled CRC-exact.
        period PIR does not trigger and neither does the cam grab. but PIR should
        trigger a cam grab for the next deployment" + "do we need a status alarm
        command?" (yes). Minimal live version; the ESP32 multi-image queue stays future.
source_hash: ../pac-garage-alarm/src/main.cpp 8c7c768da46d288b0e5ffc160f03e81f2829e110bb2d425b5f60c1cf10dcbe52
project: pac-garage-alarm
scope:
  - specs/pir-image-pipeline-v1.md
  - ../pac-garage-alarm/src/main.cpp
---

# pir-image-pipeline v1 — mute window, PIR→grab, status alarm

## A. `mute` — persisted power-up quiet period
- New config field `mute` (seconds, default **180**, bounds 0–3600, writable):
  while `millis() < mute*1000`, PIR triggers are COUNTED (trig/ISR untouched)
  but the detection window logic does not run — no alarm, no auto-grab.
- The hardware floor stays: effective gate = `max(mute*1000,
  PIR_STARTUP_LOCKOUT_MS)` — the RAK12006 needs its 60 s stabilisation even
  when mute=0 (bench).
- Persistence: settings **v7** by the frozen-struct pattern (freeze current
  layout as PersistedSettingsV6; append `uint32_t muteS`; migrate v6 records
  with muteS=180; loader clamps).

## B. PIR → cam grab (CAM_UART builds)
- Factor the `cam grab` command's machine-start block into
  `camGrabBegin(pidOv, rxId)` — shared entry, zero behaviour change for the
  command path.
- In the detection decision (the `g_motionMs >= detectT` branch), after
  `sendAlarmWithRetry`: if machine idle and ≥60 s since the last auto-grab,
  `camGrabBegin(-1, /*rxId=*/0)`. rxId 0 → the finish JSON **broadcasts** —
  home sees `{"type":"grab","pid":...}` as the capture announcement and pulls
  the image on demand (transfer-on-demand, per the Layer-B direction).
- Failure is already safe: absent/dead camera → the machine's st=255 timeout
  in ≤9 s, cam flag → 0, mesh unaffected.

## C. `status alarm` domain (the status-namespace pattern)
`{"type":"alarm","on":1,"mute":<s remaining>,"det":<s>,"win":<ms active last
window>,"edges":n,"mot":n,"trig":n,"stuck":0|1}` — the PIR/alarm internals
(already tracked for the debug frame) plus mute countdown, interrogable from
home.

## v1.1 REVISION (Peter, same morning): EARLY grab, held announcement
The v1 design grabbed at window close — up to ~17 s after first motion, subject
gone. v1.1: **grab on the FIRST PIR edge** (shutter ~0.5–2 s later; the AM312's
release-fire polarity means ~2.5 s after motion onset — physics, not code), and
the 15 s window runs IN PARALLEL deciding whether to ANNOUNCE:

- First edge (post-mute, machine idle, ≥60 s since last auto-grab) →
  `camGrabBegin(-1, 0)` immediately, from the trigger-delta block.
- Auto-grab (rxId 0) now finishes SILENTLY: success JSON is HELD in a one-slot
  buffer with a 60 s TTL (error JSON is dropped — the alarm and cam:0 already
  tell that story).
- Window closes QUALIFIED → alarm as before + the held announcement airs (or,
  if the grab is still in flight, an announce-on-finish flag airs it when done).
- Window closes noise → nothing airs; the announcement expires. The IMAGE is
  retained locally regardless (pushAvailable shows it) — auditable, zero airtime.
- The 60 s TTL (rather than discard-at-noise-close) covers the edge straddling
  a window boundary: motion that qualifies in the NEXT window still gets its
  picture announced.
- Cost of a false edge: one camera wake+capture (~5 s ESP32, RAK-powered), max
  once per 60 s. Mute covers deployment handling.

## Deliberately NOT in v1
- ESP32-side multi-image queue / RAK-local store (Layer B proper).
- Auto-PUSH of the captured image (announcement + pull-on-demand only — the
  2.5 km uplink at 17-20 % loss is not the place for unattended bulk push).
- `detn` cleanup (vestigial since the window model; parked in bugs-enhancements).

## Verify
1. Build; `config` shows mute:180; `status alarm` returns the packet with a
   live mute countdown after a reboot.
2. Bench PIR test with `detect 2` + mute elapsed: wave → within one 15 s
   window: ALARM broadcast + camera LED + `{"type":"grab"}` announcement;
   push-pull the pid, CRC match.
3. Regression: `cam grab` command path unchanged; second wave inside 60 s
   alarms (subject to window) but does NOT grab again.
