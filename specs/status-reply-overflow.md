---
task: status-reply-overflow
status: implemented 2026-07-20 (260720-3, flashed + verified on air)
priority: HIGH — silent, deployment-critical, unfixable in the field (no OTA)
source_hash:
  projects/pac-garage-alarm/src/main.cpp: 95704964923ec685b8fcfc352eb3085db02745ad6e3bce522314b3f5c69ace5b
scope:
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: status-reply-overflow — status JSON must never be malformed

## The bug (measured, not theorised)

`buildStatus()` writes into `char reply[208]`, and appends the **closing brace last**:

```c
snprintf(buf, len, "{...\"sim\":%d", ...);   // no closing brace yet
if (cons >= 0) strlcat(buf, ",\"cons\":%.0f", len);
strlcat(buf, "}", len);                      // <-- silently does NOTHING when full
```

`strlcat` truncates rather than overflows, so once the payload reaches the buffer
size the final `}` is **silently dropped** and the device transmits **unparseable
JSON**. It still logs `REPLY: OK` — verified on the bench UART, where every reply
logs OK including ones that never appeared downstream. The failure is invisible from
both ends.

Measured 2026-07-20 on `!8cee336b` (FW 260720-2):

| case | bytes | headroom (208) |
|---|---|---|
| status as sent today | **186** | 22 |
| + `cons` (coulomb gauge fitted) | 199 | 9 |
| + `upt` 7-digit, `trig` 6-digit, `boot` 4-digit | **210** | **OVERFLOW** |

A/B on air: `ping` 4/4 replies (47 B); `status` 2/3 (187 B).

**Why this is deployment-critical:** `upt` and `trig` grow monotonically. A field
unit up for months WILL cross 208 and then emit malformed JSON permanently — and the
deployed unit has **no OTA**, so it cannot be fixed without a site visit.

## Design — shed low-priority keys, never corrupt (Peter's call)

> "this should be handled gracefully, maybe we prioritise some key/values to be
> optional if space allows?"

- **Always reserve one byte for the closing `}`.** It is the one character that must
  never be lost; today it is the first thing lost.
- **Append fields in priority order**, each only if it fits *including* the reserved
  brace. If a field does not fit, skip it and continue (a later, shorter field may
  still fit) — the payload stays valid JSON at every step.
- Priority order (highest first):
  1. `type`, `fw` — identity. Always present.
  2. `upt`, `boot` — liveness/reset context.
  3. `vbat`, `batt` — power.
  4. `env`, `temp`, `hum` — sensor.
  5. `trig`, `beat`, `detn`, `detw` — detection config/counters.
  6. `txp`, `cfg`, `slp`, `sim`, `cons` — least critical.
- Consumers already treat keys as optional, so a shed key degrades gracefully;
  a missing brace does not.

## Change (main.cpp only)

**Peter's direction: this must not be special-cased to status — it is the function
that should construct EVERY packet**, with the optional fields supplied in priority
order. So the fix is a general, reusable builder, not a one-off in `buildStatus()`:

```c
jsonBegin(buf, cap);                              // writes "{"
jsonAdd(buf, cap, "\"upt\":%lu", secs);           // printf-style field; adds its own comma
jsonEnd(buf, cap);                                // writes "}" — always fits
```

- `jsonAdd()` includes a field **only if** it still leaves room for the closing
  brace, and **drops** (never half-appends) a field that overflows its own scratch
  buffer — a truncated fragment could cut inside a quoted string and break the very
  JSON the builder guarantees.
- Guarantees for ANY input: valid JSON, NUL-terminated, within cap.
- Keep existing key names/formats byte-identical so node-dash needs no change.
- Bump `FW_VERSION`.

**Rollout:** builder + `buildStatus()` converted first (status is the only payload
near the limit today, and the only one measured failing). The remaining **36
`snprintf(reply, …)` sites** are a mechanical sweep to the same API — most are short
fixed strings that cannot overflow, so they are lower risk, but converting them all
is the point: one safe way to build a packet, no exceptions.

## Verify

1. **Worst case offline:** a host-side check that max-width values (`upt` 10-digit,
   `trig` 10-digit, `boot` 5-digit, `cons` present, negative `temp`) still yield
   valid JSON ending in `}`.
2. Build (rak4631), flash bench, `status` round-trips and parses.
3. Tell node-dash on the xsession channel that status may legitimately omit
   low-priority keys under pressure — optional, never malformed.
