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
ALL VERIFIED ON HARDWARE 2026-07-22 (flashed, `Hash of data verified`).

**1. Self-sleep from a cold boot, with no RAK involvement — PASS.** Reset pulsed via RTS,
captured with DTR/RTS deasserted so the open neither resets nor holds the board:
```
 0.77s  === timercam-chunk === wake=0 psram=4194304     <- POWERON_RESET, cold boot
 1.14s  uart link on RX=13 TX=4 @115200                 <- last stamp (end of setup)
 4.15s  idle 3004ms — sleeping
 4.15s  sleeping; wake = RAK pulls Grove SCL low
```
3004 ms after the final stamp. Before this change that boot left the camera awake and lit
indefinitely.

**2. A full grab still completes — PASS. This was the gating test**, because 3 s sits
deliberately close to the RAK's 2 s `WAIT_SEEK`; a wrong margin would show up here as a failed
or truncated transfer. `@336b cam grab` on the private channel:
```
camera:  4.71s  rst:0x5 (DEEPSLEEP_RESET)       <- it WAS asleep (watchdog put it there)
         5.33s  === timercam-chunk === wake=2   <- wake=2 = EXT0, woken by the RAK
         5.93s  capture OK id=2977 len=3593 crc=3C893728 qn=1 in 211ms
         6.35s  sleeping; wake = RAK pulls Grove SCL low
RAK →   {"type":"grab","pid":2977,"len":3593,"n":16,"crc":"3C893728","bat":5540,"cam":"asleep"}
```
The CRC matches on both sides independently, and `reply_id` correlated to the sent packet
(313523150). Full cycle proven: self-slept → woke on demand → served the whole grab → slept.

Note the 6.35 s sleep is `CMD_SLEEP` from `camGrabFinish()`, not the watchdog (which would be
3 s) — so both paths work and neither pre-empts the other.

**3. Not separately tested:** the RAK-dies-mid-grab case. It shares the exact mechanism proven
in (1) — the stamp ages out and the same code path runs — so it is covered by construction
rather than by observation. Stated plainly rather than claimed as tested.

## Dependency
Flashing needs the TimerCam's USB connected. Peter disconnected it deliberately on 2026-07-22
to remove the ambiguity between the two USB serial devices while I was repeatedly opening the
wrong one. **Reconnected 2026-07-22 18:45**, so this is now testable.

Do not record that the camera was "flashed with nRF firmware by mistake" — an earlier draft of
this spec said so and it is FALSE. The camera completed a full `cam grab` (2891 B, 13 chunks,
CRC verified) that same evening; it was never damaged. The real hazard was the port confusion,
which is why `upload_port` is pinned to the by-id path.
