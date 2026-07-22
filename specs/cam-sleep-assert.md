---
task: cam-sleep-assert
status: SPEC 2026-07-22 — camera stays awake forever after power-up; battery drain.
priority: battery//field defect — the camera is battery-powered and grabs rarely
source_hash: src/main.cpp 1541be13384ce6662eabef1ebdb5274004657e37aeba8d23de5f049d5f29b1aa
project: timercam-chunk
scope:
  - (timercam-chunk) src/main.cpp   # idle watchdog: the camera owns its own power state
---

# The camera owns its own sleep — idle watchdog

## Decision (Peter, 2026-07-22)
> "why not hand this over to the camera, on power up it goes to sleep, if it is awoken by
> noise go to sleep, if nothing is heard from the RAK for x seconds, go sleep"

This supersedes the first draft of this spec, which put the fix RAK-side. That approach was
wrong twice over:
- **It cannot work.** The RAK can reset mid-grab, never grab at all, or emit a stray byte with
  nobody left to undo it. Any RAK-side promise is one the RAK cannot keep — the design is
  fail-AWAKE.
- **It is self-defeating.** Every byte on the link is a wake pulse (a start bit pulling RX low
  into ext0). A RAK-side "CMD_SLEEP at boot" therefore WAKES the camera in order to tell it to
  sleep — strictly worse than doing nothing.

Camera-side, the design is fail-SAFE: any spurious wake self-heals within N seconds and the RAK
neither knows nor cares.

## The defect
`goToSleep()` is reached from exactly two places: `CMD_SLEEP` (0x04) and the `'s'` console key.
Nothing else ever sleeps the camera. So:
- `setup()` drives `digitalWrite(PIN_LED, HIGH)` (main.cpp:669) and returns. A **power-up leaves
  the camera awake and lit forever** unless the RAK completes a whole grab. Observed 2026-07-22.
- An ext0 wake from **any** stray edge (line noise, a RAK reset glitch, a debug byte) wakes it
  with nothing to put it back.
- If the RAK dies, resets, or times out **mid-grab**, the camera is left awake indefinitely.

On a battery unit that grabs at most once a day, each of these flattens the cell.

## The fix — one mechanism
A single idle watchdog covers all three cases; no other change is needed.

- `g_lastActivityMs`, stamped on **real activity only** — six sites: a CRC-valid UART frame and
  a raw `0x55` ping in `serviceUart()`, a console keypress in `serialConsole()`, capture
  completion in `loop()`, the end of `setup()`, and resume from light sleep in `goToSleep()`.
- In `loop()`: `if (millis() - g_lastActivityMs >= IDLE_SLEEP_MS) g_wantSleep = true;`

That is the whole design. It resolves each case for free:
| case | why it self-heals |
|---|---|
| power-up, RAK silent | nothing stamps → sleeps after the window |
| woken by noise | noise is not a CRC-valid frame → never stamps → sleeps |
| RAK dies mid-grab | commands stop → last stamp ages out → sleeps |

`goToSleep()` already does the rest correctly — LED off, and the tiered deep-vs-light choice on
`g_qn` (deep when the queue is empty, light while holding images). Nothing there changes.

### `IDLE_SLEEP_MS = 3000` — set by a hard constraint, not by taste
The risk is **asymmetric**, and that is what sizes it:

`camuSend()` (pac-garage-alarm/src/main.cpp:359) writes the `0x7E` SOF with **no leading wake
byte**. If the camera is asleep when a command arrives, that SOF *is* the ext0 wake pulse and is
consumed by it — the frame is lost, `WAIT_SEEK` expires, the grab fails. So sleeping too early
**breaks grabs**, while sleeping too late merely costs battery.

The floor is therefore the longest gap the RAK itself treats as normal: its `WAIT_SEEK` deadline,
**2000 ms**. 2 s sits exactly on that boundary, so **3 s** — one step clear.

Anything longer is unjustified. The RAK's other deadlines (`WAIT_READY` 9000, `SEEK` 8000) are
the RAK waiting for *us*, and during those the camera is booting or capturing — both of which
stamp. They are not idle time and must not inflate this number. (An earlier draft of this spec
used 15 s on exactly that mistaken basis.)

**Follow-on (out of scope, reported not fixed):** if `camuSend()` gained a throwaway wake byte
before the SOF — as the I2C path already documents doing — the lost-SOF failure mode disappears
entirely and this could drop to ~1 s. That is a `pac-garage-alarm` change and belongs in its own
task.

### Two stamps that are easy to miss
1. **Cold boot** — stamp at the end of `setup()`, so a power-up gets a full window rather than
   sleeping in the first loop pass while the RAK is still booting alongside it.
2. **Resume from LIGHT sleep** — `goToSleep()` RETURNS in the holding-images case. Without a
   stamp on resume, `loop()` immediately re-sleeps and the camera never serves the command that
   just woke it. This is a real deadlock, not a theoretical one.

## Out of scope
`pac-garage-alarm` — no RAK-side change at all, by the reasoning above. The grab protocol,
capture logic, and queue/max-hold behaviour are untouched.

## Test
- Build compiles. DONE: single env, `SUCCESS`.
- Power-cycle with the RAK silent → LED goes out ~3 s later, with no grab and no RAK
  involvement. NOT DONE — needs the TimerCam USB reconnected.
- `@336b cam grab` still completes end to end (13 chunks) — the stamps must keep it awake for
  the whole grab, which is the one thing the watchdog could plausibly break. **This is the
  gating test**: 3 s is deliberately close to the RAK's 2 s `WAIT_SEEK`, so if the margin is
  wrong at all it shows up here as a failed or truncated grab. NOT DONE.
- Grab interrupted (reset the RAK mid-transfer) → camera sleeps ~3 s later on its own. NOT DONE.

## Dependency
Flashing this needs the TimerCam's USB reconnected — Peter removed it intentionally on
2026-07-22 after it was flashed with nRF firmware by mistake. Build can be verified without it;
flash and on-hardware test cannot.
