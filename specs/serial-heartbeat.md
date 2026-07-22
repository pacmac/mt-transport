---
task: serial-heartbeat
status: SPEC 2026-07-22 — silence on serial is ambiguous; make liveness unconditional.
priority: observability — the absence of this cost most of an evening
source_hash: (pac-garage-alarm) src/main.cpp 8232fda4a47a4781b6323a98fd6dfa94a328a3bd7ca7ed62e76aa580325a2a54
project: pac-garage-alarm
scope:
  - (pac-garage-alarm) src/main.cpp   # periodic heartbeat line on the debug serial
---

# Heartbeat on serial — so silence means exactly one thing

## The instruction (Peter, 2026-07-22)
> "why dont you add a heartbeat every second or every 5 seconds ?"

## Why this is the right fix
Today the firmware prints only on EVENTS: boot, RX, a send, a grab. So an empty capture has
four possible meanings and no way to tell them apart:
1. the device is dead or hung,
2. the device is fine but idle (nothing addressed to it),
3. the serial/CDC path is broken (DTR, enumeration, a stale handle),
4. the device is mid-reboot and the port has vanished.

Tonight I hit all four and could not distinguish them, so I kept re-opening the port to
generate evidence — which is precisely how the control-line damage happened
([[serial-log-no-control-lines]]). The tool was never the root problem: the root problem is
that **liveness is not observable**, so liveness had to be inferred by poking hardware.

With an unconditional heartbeat, silence has ONE meaning: the main loop is not running. No
probing, no crafted mesh traffic, no reset to "get a boot banner".

## The change
A single line emitted from `loop()` every `HEARTBEAT_MS`, millis-scheduled (never `delay()`),
carrying the state that answers the questions actually asked during a fault:

    HB up=<s> boot=<n> rst=0x<hex> txfs=<n> csma=<n> txq=<n> rx=<s ago> heap=<n>

- `up` — seconds since boot. A resetting unit shows `up` sawtoothing; a boot loop is obvious
  from the heartbeat alone, with no dmesg archaeology.
- `boot` / `rst` — boot count and reset reason, so the cause of the LAST reset is visible on
  every line rather than only in the boot banner that is lost when USB re-enumerates.
- `txfs` — `mesh.txFailStreak()`. This is the mute detector. Tonight the unit stopped
  delivering replies at 19:08:45 and it took an hour to even suspect TX; `txfs` climbing would
  have said so immediately.
- `csma` — `mesh.csmaDeferrals()`, to distinguish "deferring on a busy channel" from "radio
  wedged".
- `rx` — seconds since the last received packet. Separates "we are deaf" from "nobody is
  talking", which no other signal on the device does.
- `heap` — free heap, to catch a slow leak.

`HEARTBEAT_MS = 5000`. 1 s is unnecessary noise for a fault that develops over minutes, and it
would bury the event lines that carry the real detail; 5 s still detects a hang within one
window and makes a reboot loop visible in three lines.

## Cost, honestly
`Serial` is USB CDC and DTR-gated: with no host attached the writes are discarded, so on the
deployed unit this costs a `snprintf` plus a discarded write every 5 s and NO airtime — it never
touches the radio. That is why it can be unconditional rather than hidden behind a build flag
nobody remembers to set. If it ever needs silencing it belongs behind the runtime debug level
(a separate, larger change Peter has already asked about), not behind an `#ifdef`.

## Out of scope
- The runtime debug level / verbosity control. Wanted, discussed, separate task.
- Any change to the mesh reply path, the mute itself, or the wedge guard. This spec ONLY makes
  the device observable; it fixes no bug. Diagnosing the mute comes after, WITH this in hand.

## Test
- Build clean.
- Flash the bench (`!8cee336b`, `-e rak4631_camuart`) and confirm `HB` lines appear every ~5 s
  with a monotonically rising `up`, with no mesh traffic whatsoever.
- Confirm `rx=` grows while idle and resets to ~0 when a command is sent.
- Confirm a reboot is visible as `up` returning to a low value, and that `boot` increments.
