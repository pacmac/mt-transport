---
task: firmware-hardening
status: active
source_hash: ~  # placeholder during step-5 implementation
updated: 2026-07-19
scope: pac-garage-alarm/src/main.cpp (tracked here; that repo is not a registered mcpp project)
---

# Spec: firmware-hardening — remove the brick paths, make the field unit diagnosable

Six defects that make a remote node either unrecoverable or undiagnosable.
Three are done (§1 brick, §4 telemetry, §8 `rst`); this covers the rest, with
step 5 detailed for implementation.

Sleep-related items have moved to `deployment-sleep`. Nothing here assumes the
deployment sleep architecture.

## Step 5 — Serial1 mirror (this step)

### The problem

All 17 diagnostic writes go to `Serial`, which is `SerialTinyUSB` — USB CDC.
The nRF52840 **requires VBUS** for the USB peripheral (PS §5.3.2: *"VBUS and
either VDDH or VDD supplies are required for USB peripheral operation"*), and
`Adafruit_USBD_CDC::operator bool()` returns `tud_cdc_n_connected()`, which is
DTR-based.

So **a battery-powered unit emits nothing, ever.** That is the gap that cost a
full day on 2026-07-18: with the unit on battery there was no way to see the
`WEDGE:` printf, the boot banner, or the per-packet `RX:` line, and every
diagnosis had to go over LoRa instead.

`Serial1` is the hardware UART on **pins 15/16** (`PIN_SERIAL1_RX = 15`,
`PIN_SERIAL1_TX = 16`, verified in the vendored variant), bound to `UARTE0`
(`Uart.cpp:266`). It is completely independent of VBUS. Peter's CH343 adapter
is already enumerating as `/dev/ttyACM0`.

### The change

Add to `setup()`, immediately after the existing `Serial.begin(115200)`:

```c
Serial1.begin(115200);   // UART on pins 15/16 — works on battery, unlike USB CDC
```

Introduce one diagnostic macro and route every existing call through it:

```c
// Diagnostics go to BOTH sinks. USB CDC (Serial) needs VBUS and is silent on a
// battery unit; the UART (Serial1) is not. Writing to both costs nothing when
// no adapter is attached — Adafruit_USBD_CDC::write() returns immediately when
// no host is connected, and UARTE just clocks bytes into the void.
#define DBG(...)   do { Serial.printf(__VA_ARGS__); Serial1.printf(__VA_ARGS__); } while (0)
#define DBGLN(s)   DBG("%s\n", (s))
```

Then replace the call sites: `Serial.printf(` → `DBG(`, and
`Serial.println(x)` → `DBGLN(x)`.

### POWER CONSTRAINT — must be resolved before deployment sleep

**An enabled UARTE on nRF52 is not free.** Leaving `UARTE0` enabled with no
traffic is a well-known nRF52 power trap (the peripheral must be stopped, and
in some cases fully powered down, to avoid a standing draw on the order of a
milliamp). Against `deployment-sleep`'s **30 µA** target — where *"every µA is
approximately 3 months of cell"* — a permanently-enabled UART would dominate
the entire budget.

This is acceptable NOW because the unit does not yet sleep and the ROADMAP
gates sleep behind the butler. It is NOT acceptable in the deployed
configuration. The options, to be settled in `deployment-sleep`, are:

- gate the mirror behind `#ifdef DEV` (matches Peter's stated direction), or
- `Serial1.end()` before sleeping and `begin()` on wake, or
- keep it and accept the cost only if measurement shows it is small.

Recorded here so the fix does not silently become a power regression the moment
sleep lands.

### Files in step 5

| file | change |
|---|---|
| `pac-garage-alarm/src/main.cpp` | `Serial1.begin()`; `DBG`/`DBGLN` macros; 17 call sites rerouted |
| `specs/firmware-hardening.md` | this file |

**NOT changing:** anything in `mt-transport` (no library change needed);
the `while(!Serial)` wait (that is §9); sleep behaviour (`deployment-sleep`).

### Verification

1. **Static:** no bare `Serial.printf(` / `Serial.println(` remain outside the
   macro definitions; `Serial1.begin()` present.
2. **Build:** `pac-garage-alarm` compiles.
3. **Functional, USB:** flash HOME and confirm output still appears on the CDC
   port — the mirror must not break the existing path.
4. **Functional, THE POINT OF THIS STEP:** with the CH343 adapter on pins
   15/16, confirm diagnostics appear on the UART. Ideally on battery, which is
   the case that has never worked.
5. **DEV1 is NOT flashed from this task.**

## Remaining steps (not this one)

- **§2** stuck-PIR bound — asserted with no edges across N windows is a fault,
  not motion. Prevents an alarm every 15 s forever at ~7% duty.
- **§3** randomise `ALARM_RESEND_MS` — fixed 3 s can land in the same part of
  the rebroadcast tail every time; the reply path already randomises.
- **§6** `GPREGRET2` is 8-bit, boot count wraps at 255 — folds into BUG 17
  (persist boot/reset to flash).
- **§7** two comments that state the opposite of the code (PIR polarity;
  `doSleep`'s ISR claim), plus documenting that the 1 s sleep chunk is
  load-bearing for PIR latency.
- **§9** `while(!Serial)` burns 5 s on every battery boot.
