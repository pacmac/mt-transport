---
task: json-builder-universal
status: PARTIAL — builder + the DATA/GROWING packets done, flashed + verified (fw 260721-11).
        DONE: jsonBuild(json,cap,fields[],n) array builder + js/jn/jf/jb renderers; every
        OBJECT packet that carries data/grows migrated — status, config (nested det/alm as
        rendered field values), debug (the growing frame; pts[] is a budgeted nested-array
        field value), calc. Old jsonBegin/jsonAdd/jsonEnd removed. Verified on air: status
        185B/17 keys, config 127B/7 keys, debug 187B/20 keys — all VALID JSON.
        REMAINING (step 3 tail): the command-reply/error snprintf sites (err/camu/diag/grab
        busy/sleepfor/unknown cmd/interval/detect/alarm/name/hop/push/telemetry). All small,
        fixed or tightly bounded — cannot overflow — so consistency, not risk. Not yet routed
        through jsonBuild. Awaiting Peter's call on whether to migrate the bounded tail too.
        EXEMPT: schema positional array (pagination-managed).
updated: 2026-07-21
scope:
  - pac-garage-alarm/src/main.cpp
source_hash:
  pac-garage-alarm/src/main.cpp: 13172b459a111625d83590ce3634b3d44958ab23f4464545f3d131ad520a045c
---

# One array-driven JSON builder for every packet

## The rule (Peter)
`build(json, [fields])` — a buffer plus an **array of fields**, each **MUST-HAVE or OPTIONAL**.
Append in an **iterative loop that size-checks every iteration**: MUST fields always emitted,
OPTIONAL fields only while they still fit (reserving the closing brace), never a half field,
always a closing `}`. **Every key/value packet** goes through it. Completes 571 (whose spec
already said "construct EVERY packet" but only `buildStatus` complied — and `buildSchema`,
added today, bypassed it too).

## API
```c
enum JReq { JOPT = 0, JMUST = 1 };
struct JField { const char *key; const char *val; JReq req; };   // val PRE-RENDERED
// Writes a valid JSON object into json[0..cap). MUST fields always included; OPTIONAL
// fields included only if the field + closing brace still fit. Returns bytes written.
size_t jsonBuild(char *json, size_t cap, const JField *fields, size_t n);
```

### Algorithm (the size-checked loop)
```
json = "{"; first = true
for each f in fields:
    piece = "\"<key>\":<val>"                 // val already rendered (quotes/true/false/number)
    need  = (first?0:1) + len(piece) + 1      // comma + field + reserved '}'
    if f.req == JMUST:
        append comma?+piece                   // always (must-haves are minimal, fit by design)
    else if used + need <= cap:
        append comma?+piece                   // optional: only if it fits with brace reserved
    else:
        skip                                  // shed this optional, keep scanning (a shorter one may fit)
append "}"
```
A MUST field that cannot fit is a design error (keep the must-have set small); asserted/logged
in debug, never silently truncated.

### Rendering values into the array (the one part not yet specified — proposing this)
Values are heterogeneous, so each is rendered to a string first. A tiny rotating-scratch helper
keeps the call-site an array literal:
```c
const char *js(const char *s);      // "\"escaped\""     (quoted string)
const char *jn(long v);             // "1800"
const char *jf(float v, int dp);    // "3.97"
const char *jb(bool b);             // "true" / "false"
// each returns a pointer into a static ring of >= JMAX_FIELDS slots, valid until the ring wraps;
// all of one packet's renders happen before jsonBuild, and the ring >= field count, so every
// pointer in the array is still valid when jsonBuild runs.
```
Call site becomes the array you described:
```c
JField f[] = {
  { "type", js("status"),           JMUST },
  { "fw",   js(FW_VERSION),          JMUST },
  { "upt",  jn(millis()/1000),       JMUST },
  { "vbat", jf(v,2),                 JOPT  },
  { "cons", jf(cons,0),              JOPT  },
};
jsonBuild(buf, sizeof(buf), f, sizeof(f)/sizeof(f[0]));
```
(If you'd rather avoid the rotating ring, the alternative is per-field local `char[24]` buffers —
more verbose, no shared state. Your call; ring is proposed for the clean literal.)

## Migration (step 3) — every object packet
`buildStatus` (from the hand-ordered jsonAdd calls), `buildConfig`, `broadcastDebug` (the
unguarded, growing one — the real reason this matters), `calc`, and the command replies/errors
(`err`/`camu`/`diag`/`grab busy`/`sleepfor`/`unknown cmd`). Each becomes a JField array with
MUST = identity + the field's essential data, OPTIONAL = everything sheddable.

**Exempt:** the schema frame `{"t":"sch","f":[[...]]}` — a positional ARRAY, not an object,
size-managed by pagination. It keeps its own builder; noted, not forced.

## Keep / replace
`jsonBegin/jsonAdd/jsonEnd` are the current per-call form; `jsonBuild` supersedes them. Remove
them once all sites migrate (or implement `jsonBuild` on top of `jsonAdd`'s fit-check to reuse the
proven size math).

## Verify (step 4)
- Static: every object emit site calls `jsonBuild`; no raw `snprintf("{...}")` remains (grep).
- Functional: status/config/debug/calc/errors still valid JSON on air.
- The point: force `debug` (or status) past the cap (inflate a counter / add optionals) and confirm
  it sheds OPTIONAL fields while MUST fields + `}` always survive — i.e. never malformed.

## Risk
Touches every emit site (bench flash; field unit untouched). Must-have sets must fit the cap by
construction — that's the one invariant to get right per packet.
