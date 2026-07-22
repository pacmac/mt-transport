---
task: serial-log-no-control-lines
status: SPEC 2026-07-22 — the capture tool asserts RTS for no reason and can reset/DFU the board.
priority: hardware safety — this class of mistake has cost ~2 hours twice in one day
source_hash: tools/serial-log.py 3c0c99af2149243db0dbc9d075438e402c890722f21a246ae67a216843461cd9
project: mt-transport
scope:
  - (mt-transport) tools/serial-log.py   # stop manipulating control lines
---

# Read the port. Do not touch the control lines.

## The instruction (Peter, 2026-07-22)
> "I did NOT say dont open the Port, I said stop fucking around with the control lines"

That is the exact boundary, and I had it wrong in both directions tonight — first by treating
DTR/RTS as free to poke, then by over-correcting into "never open the port". **Opening and
reading the port is fine. Asserting, toggling or pulsing DTR/RTS is not.**

## What the tool does wrong
`open_port()` sets, on every open and every auto-reconnect:
```python
s.dtr = True
s.rts = True      # <- no justification whatsoever
```
- **RTS is never needed for CDC output.** It was added on the assumption that "more control
  lines = more likely to work". On a board whose control lines are the documented reset/DFU
  vector, that is a gratuitous risk.
- It is applied **repeatedly**, because the tool auto-reconnects: every reconnect re-asserts
  both lines. A board that drops off USB therefore gets its control lines driven again the
  moment it comes back — precisely when it is most fragile.

## Evidence
The bench RAK ran **47 minutes with no USB disconnect** (18:36:46 -> 19:23:27, dmesg), covering
two successful `cam grab` cycles. Every disconnect since then falls around a port open by this
tool or by an inline script:
```
19:23:27  DISCONNECT   (logger connected 19:23:15)
19:28:35  DISCONNECT   (+305s)
19:31:32  DISCONNECT   (+177s)
```
Not proof of causation — a capture at 19:13 used the same tool and disturbed nothing — but the
only proven-stable period tonight is the period nothing drove its control lines. That is enough
to remove the risk rather than argue about it.

## Changes — tools/serial-log.py
1. **Delete `s.rts = True`.** Explicitly set `rts = False` BEFORE open instead, so pyserial's
   default assertion never reaches the board.
2. **Set the lines before `open()`, never after**, using an unopened `Serial()` and assigning
   `port`/`baudrate`/`dtr`/`rts` first. Assigning after open drives a transition on a live
   device; assigning before makes it part of the initial port state.
3. **Never toggle or pulse either line.** No reset pulses, no 1200-baud touches, no "kick the
   board" helpers — not in this tool, not inline, ever. If a board needs resetting, that is
   Peter's call and a physical action.
4. Keep DTR asserted: the RAK's CDC genuinely stays mute without it (that is why this tool
   exists). DTR is the ONE line that may be set, once, as initial state.

## Out of scope, reported not fixed
The auto-reconnect loop. It is what wedged the board this morning by re-grabbing the port
through a flash, and it re-drives the control lines on every reconnect. With RTS gone and the
lines set pre-open it is far less dangerous, but a capture that attaches ONCE and exits when the
device goes away is the safer design. Separate change — flagged, not made here.

## Test
- `grep -n "rts" tools/serial-log.py` -> only `rts = False`, set before open.
- No assignment to `.dtr` or `.rts` on an already-open handle anywhere in the file.
