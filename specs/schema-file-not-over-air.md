---
task: schema-file-not-over-air
status: IMPLEMENTED 2026-07-25. VERIFIED LIVE: GET /v1/mesh/schema/b80f returns all 20 fields
  in ~14 ms with ZERO airtime, and works for the SLEEPING deployed unit — which was impossible
  before. Version honesty confirmed on air: stale:true when the unit's build differs from the
  file's, stale:null when the unit's firmware is unknown. Suite 19 files green. The FIRMWARE
  half (removing the `sch` verb) is deliberately NOT done — it needs a flash.
source_hash:
  ../pac-garage-alarm/tools/gen_schema.py:      57c67de2847fdb87
  ../pac-garage-alarm/docs/config-schema.json:  407a269783395e67
  clients/mesh/lib/config.js:                   ed06bd8ad5ec7089
  clients/mesh/lib/settings.js:                 d81e9316df84efcd
  clients/mesh/index.js:                        fbdf6b485349ed7a
  clients/mesh/host-module.js:                  37cdc4e53a62543b
  clients/mesh/config.yaml:                     76320fab6394e245
  clients/host/host.config.json:                92c7fa0ea368b9ca
  clients/host/API.md:                          e3d6049a656d0c77
  clients/mesh/test/config.js:                  4fc2178692681450
  clients/mesh/test/timeouts.js:                6c87138b2bc1dbe1
scope:
  - specs/schema-file-not-over-air.md
  # FIRMWARE REPO (/usr/share/pac/dev/pio/projects/pac-garage-alarm) — its own commit:
  - ../pac-garage-alarm/tools/gen_schema.py   # NEW: generate the schema from CONFIG_FIELDS
  - ../pac-garage-alarm/platformio.ini        # run it as a pre-build step, like bump_fw.py
  - ../pac-garage-alarm/docs/config-schema.json # REGENERATED (currently stale: 10 of 20 fields)
  # THIS REPO:
  - clients/mesh/lib/config.js        # serve from the file; the over-air pull is gone
  - clients/mesh/lib/settings.js      # schema.file path; drop the dead schema* timeouts
  - clients/mesh/config.yaml          # same
  - clients/host/host.config.json     # same (the LIVE service reads this)
  - clients/mesh/host-module.js       # the route serves the file, no longer 501
  - clients/mesh/index.js             # drop `sch` from NO_REPLY + the onSchemaFrame route
  - clients/mesh/test/config.js       # asserts the FILE path, not the radio pull
  - clients/mesh/test/timeouts.js     # schema* keys no longer required
  - clients/host/API.md               # the contract node-dash builds against
# NOT changing: CONFIG_FIELDS itself — applySet() validates against it and that is
#   unrelated to emission. NOT changing the firmware's `sch` verb / buildSchema /
#   SCHEMA_PER_PAGE in this pass: removing them needs a FLASH, so it is bench-only and
#   waits for the next flash window. The verb becomes dead code that nothing calls.
---

# Spec: schema-file-not-over-air — the schema is a file, never radio traffic

## The decision

Peter, 2026-07-25: *"rip out schema. we will create a schema.yaml or .json file.
unbelievable 7 pages, that is the equivalent of a small image."*

## Why the over-air pull has to go

- 20 fields at `SCHEMA_PER_PAGE = 3` = **7 pages**, each a separate request/response round
  trip. The `config-schema` task specified **6 per page**; the code shipped 3.
- The device answers **30–90 s per page** when busy, so a full pull is minutes.
- A decoded page used **178 of the 237-byte cap** (59 wasted), and the 35-byte column
  header `["id","ty","lb","df","w","mn","mx"]` is **repeated on every page** — 245 bytes
  of pure redundancy across the 7.
- It has **never once succeeded**: the persistent cache is empty on every unit, every day.
- And it was never the intent. `docs/config-schema.json` (2026-07-18) says in its own
  first line: *"STATIC per firmware version (NEVER SENT OVER THE AIR) … Symlink into
  consumers (node-dash)."*

This is static, compile-time data. Moving it over a 2.5 km LoRa link is the wrong
mechanism no matter how well it is tuned.

## Where the file is generated, and why there

**In the firmware repo, at build time, from `CONFIG_FIELDS`.**

`main.cpp` already holds the single source of truth — one struct, one table, one line per
field:

```c
struct ConfigField { const char *id; char ty; const char *lb; long df;
                     bool w; bool bounds; long mn, mx; };
{"beat", 'n', "Heartbeat", 60, true, true, 30, 86400},
```

Generating from it **on every build** is what makes drift impossible. The alternative —
a hand-maintained file, or a parser living in this repo — is exactly what produced the
current mess: `docs/config-schema.json` has **10 entries against the firmware's 20**, and
a completely different field shape (`{path,label,cmd,type,min,max,unit,default}`). It
rotted because nothing forced it to keep up.

This also completes `config-schema` step 2, still open: *"Emit the schema rows from the
SAME table applySet() validates against (one source of truth)."*

`tools/gen_schema.py` runs as a pre-build step alongside the existing `bump_fw.py`, so it
regenerates whenever the firmware is built and the output is stamped with `FW_VERSION`.

## Output shape

Keyed by firmware version, and in the shape our parser already produces — so nothing
downstream changes:

```json
{ "fw": "2-260725-21", "ver": 2, "generated": "2026-07-25T20:15:00Z",
  "fields": [
    { "id": "beat", "ty": "n", "label": "Heartbeat", "def": 60,
      "writable": true, "bounded": true, "min": 30, "max": 86400 },
    { "id": "slp", "ty": "b", "label": "Sleep", "def": 0,
      "writable": true, "bounded": false } ] }
```

`ty`: `n` numeric · `b` boolean · `t` text. For `t`, `min`/`max` are LENGTH bounds — the
same type-dependent meaning the original design documented.

## How it is served

`Config.schema()` keeps its resolution shape but the device leg is replaced by the file:

**file → hot cache**, and nothing else. No radio, no `?refresh=1` round trip, no 504.

The file is found via a **config-declared path** (`schema.file`), never hardcoded — same
rule as identity and timeouts.

**Version honesty:** the file states which firmware it describes. If a unit reports a
different `fw`, the response carries `stale: true` **and both versions**, so a dashboard
can say so rather than silently rendering a form for the wrong build. A unit we have never
heard from has no known version — that is `stale: null` (unknown), not a lie in either
direction.

`GET /v1/mesh/config/:target` (live VALUES) is untouched — that genuinely needs the radio.

## Consequences

- `timing.schemaAnswerMs` / `schemaRetryMs` become dead: removed from `settings.js`, both
  config files, and the `REQUIRED` list in `test/timeouts.js` (which also asserts they
  differ from `chunkAnswerMs` — that assertion goes with them).
- `test/config.js` currently asserts the over-air assembly and **fails as of the block**.
  It is rewritten to assert the file path.
- `index.js`: `sch` leaves `NO_REPLY`; the `obj.t === 'sch'` route to `onSchemaFrame` goes.
- `API.md` §6.1 is rewritten — the cache/refresh/504 description is now wrong in every
  particular.
- **node-dash has been told three times about schema availability, each version wrong.**
  They get told once more, only after this is verified working.

## Observe

1. **Static** — `gen_schema.py` output has 20 fields matching `CONFIG_FIELDS`; no
   `_pullPage` remains; no `schemaAnswerMs` anywhere.
2. **Functional** — `GET /v1/mesh/schema/b80f` returns 20 fields **instantly** (no radio),
   and returns them for a SLEEPING unit too — the case that was impossible before.
3. **Regression** — `POST /v1/mesh/config/:target` still validates against the schema and
   still refuses an out-of-bounds write without spending airtime; full suite green.

## Risks

- **The generator parses a C table.** It is a well-formed literal, but a future edit could
  break parsing. Mitigated by failing the BUILD loudly rather than emitting a partial file.
- **Cross-repo dependency**: this repo reads a file produced by the firmware repo. That is
  why the path is config, and why the response carries the fw it describes.
- The firmware keeps a dead `sch` verb until the next flash — harmless, nothing calls it,
  and removing it needs a flash the deployed unit cannot take.

## Findings during implementation

**The generator's own guard caught a real gap on its first run.** It parsed 19 of 20 fields
and REFUSED to write, rather than silently emitting a schema missing `txp` — whose default
is the constant `TX_DBM`, not a literal. That is exactly how the predecessor file rotted to
10 of 20. Constants are now resolved, and anything unresolvable still fails the build.

**Text defaults had to match the firmware's own emitter.** The C table stores `0` for `name`
and `lname` only because `df` is a `long`; `fmtField()` emits `""` for `ty=='t'`. The
generated file now says `""` too — the file must say what the device would have said.

**A latent bug was exposed in the config WRITE path.** `_field()` degrades to built-in
bounds when the schema is unavailable, but it caught only the old over-air code `ESCHEMA`.
The file path raises `ESCHEMAFILE`/`ECONFIG`, which propagated — turning "schema file
missing" into a hard failure of every config write instead of a graceful degrade. Fixed and
covered by test/config.js.

**PlatformIO pre-build scripts have no `__file__`.** The generator resolves `$PROJECT_DIR`
via `Import("env")` like bump_fw.py, and still runs standalone from a shell.

## Not done, deliberately

The firmware still contains the `sch` verb, `buildSchema()` and `SCHEMA_PER_PAGE`. Removing
them needs a FLASH, which the deployed unit cannot take. It is now dead code that nothing
calls — `sch` has been removed from NO_REPLY and the 260 `t:"sch"` route is gone, so a page
arriving would simply be ignored. Clean it up at the next flash window.
