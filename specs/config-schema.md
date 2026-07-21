---
task: config-schema
status: PARTIAL — flashed + verified on air (fw 260721-6). DONE: single-source table (step 2's
        table), applySet rewritten to validate from it, writability column (step 3), positional
        schema emit + pull pagination via the `sch [page]` verb (steps 1/4), reply grow (step 6).
        VERIFIED: `sch 0` returns {"t":"sch","v":1,"p":0,"n":6,"f":[header,...]} on port 260 (raw
        capture) — ragged-prefix bool, numeric bounds, header maps columns.
        DEFERRED (open): routing the TEXT verbs (interval/detect/alarm/telemetry/chunk cfg) through
        the table — they still carry inline clamps, so drift persists on the text/CLI path (node-dash
        uses the port-260 set path + schema, which ARE table-driven). Also open: advert (step 5),
        dashboard render + hardcoded-table deletion (step 7, node-dash side), debug frame (step 8).
        Live-set round-trip via port-260 not bench-tested here (couldn't send port-260 from the tool);
        the 9 original fields' bounds are preserved from the prior applySet.
priority: HIGH
updated: 2026-07-21
scope:
  - pac-garage-alarm/src/main.cpp
source_hash:
  pac-garage-alarm/src/main.cpp: 62ab243cab41e7fbdccf45b5b4a7e3faa3e9007b1bae122bf2c3c10a83e68bc4
---

# config-schema: self-describing settings over port-260 (positional array)

## Why
The dashboard hardcodes every field's name/bounds/label; every firmware setting change needs
a matching dashboard change, and any drift renders a UI that submits values the device
rejects. Make the device describe its own config so node-dash builds the form dynamically
with nothing hardcoded. Packet size forbids repeating keys per field, so each field is ONE
ARRAY and a single HEADER ROW maps the columns.

## Wire format (port 260, PAC_ALARM_APP)
```
{"t":"sch","v":1,"p":0,"n":2,"f":[
  ["id","ty","lb","df","w","mn","mx"],
  ["beat","n","Heartbeat",60,1,30,86400],
  ["slp","b","Sleep",0,1],
  ["name","t","Short name","",1,1,4]
]}
```
- `v` schema version, `p` page index, `n` page count. `f[0]` is the HEADER; the rest are fields.
- **Positional + ragged-prefix:** each field's present elements are a PREFIX of the header,
  truncated only from the tail (never reordered, never a gap). Consumer parses by index:
  element *i* is header column *i*.
- **Interior gap sentinel `"^"`** (a field with mx but not mn): `["retries","n","Max retries",3,1,"^",10]`.
  Unified consumer rule: a column applies IFF `i < row.length && row[i] !== "^"`.
- **Type-dependent bounds:** for `ty:"t"` (text), `mn`/`mx` are LENGTH bounds; for `n`, value bounds.
- Types: `b` bool (prefix len 5: id,ty,lb,df,w), `n` numeric (up to 7), `t` text (up to 7, mn/mx=length).

### Header column order — resolved
`[id, ty, lb, df, w, mn, mx]`. `w` (writability 0/1) is placed BEFORE the bounds because it is
universal (every field has it) and the prefix rule requires universal columns leftmost — a
bool must reach `w` without emitting `"^"` for the bounds it lacks. This refines the earlier
`[id,ty,lb,df,mn,mx]` (goal note) by inserting `w` at index 4; free now, no consumer yet.

## THE TABLE — single source of truth (step 2, the whole point)
One C table drives BOTH `applySet()` validation AND the schema emit, so they cannot drift and
a new setting cannot be added without appearing in the schema. Re-derived from the live code
(Phase 1); defaults/bounds are the actual compiled values:

| id | ty | label | default | w | mn | mx | backing var | notes |
|----|----|-------|---------|---|----|----|-------------|-------|
| beat | n | Heartbeat (s) | 60 | 1 | 30 | 86400 | heartbeatMs | also set by `interval` |
| slp | b | Sleep | 0 | 1 | | | sleepMode | |
| det.n | n | Detect count | 3 | 1 | 1 | 10 | detectN | |
| det.win | n | Detect window (s) | 10 | 1 | 5 | 3600 | detectT | `detect` text used 3..3600 — UNIFY to 5 |
| alm.on | b | Alarms | 1 | 1 | | | alarmOn | |
| alm.ovr | n | Over-temp (C) | 60 | 1 | 30 | 90 | alarmOtC10/10 | |
| alm.und | n | Under-temp (C) | 2 | 1 | -20 | 15 | alarmUtC10/10 | |
| alm.hum | n | Humidity (%) | 90 | 1 | 50 | 100 | alarmRhPct | |
| alm.ren | n | Renotify (min) | 30 | 1 | 1 | 1440 | alarmRenotifyMin | |
| name | t | Short name | "" | 1 | 1 | 4 | g_shortName | length bounds |
| lname | t | Long name | "" | 1 | 1 | 30 | g_longName | length bounds |
| chunk.hop | n | Chunk hops | 1 | 1 | 0 | 7 | g_chunkHopLimit | |
| chunk.gap | n | Chunk gap (ms) | 3000 | 1 | 0 | 60000 | g_chunkGapMs | |
| tele.chg | b | Telem on-change | 1 | 1 | | | g_teleOnChange | |
| tele.ka | n | Telem keepalive (min) | 360 | 1 | 1 | 1440 | g_teleKeepaliveMs/60000 | |
| txp | n | TX power (dBm) | TX_DBM | 0 | | | TX_DBM | READ-ONLY (w=0) |

16 fields. Row struct: `{ const char* id; char ty; const char* lb; long df; bool w; long mn; long mx; bool hasBounds; enum backing; }`
(text default is the empty string; bounds interpreted as length for `ty=='t'`).

### applySet rewrite (step 2 — the risky, gated part)
`applySet(path,v)` becomes: find the row by `id`; reject if `!row.w`; clamp/validate `v` against
`row.mn/mx` (or `validateName` length for text); write the backing var; `saveSettings()`.
**Kill the inline clamps** in `applySet` AND in the parallel text-command handlers (`interval`,
`detect`, `alarm *`, `telemetry`, `chunk cfg`) so the table is the ONLY place a bound is written
— Phase 1 found `detect` (3..3600) already drifted from `det.win` (5..3600). NO bound outside the table.

## Pull pagination (step 4)
`{"t":"sch"}` request -> device replies page 0; `{"t":"sch","p":N}` -> page N. ~6 fields/page at
~35 B/row within the 237 cap; 16 fields = ~3 pages. Self-contained per page (v,p,n + header + rows);
a lost page is just re-asked. No reassembly state on the device. Reuses handlePrivateApp request path.

## Supporting steps
- **reply[208] -> grow** (step 6) to a full 237-safe buffer; today it can truncate a full page.
- **Advert** (step 5): schema `v` in the heartbeat so a caller knows to refetch after a reflash.
- **Debug frame -> positional array** (step 8, AFTER config, BREAKING): the debug/telemetry frame
  becomes a VALUES-ONLY array in schema position order (~154 B -> ~55 B, ~3x). Guardrails:
  schema version IN the frame + decoder REFUSES on mismatch (a positional values array is
  meaningless without the exact schema), and the UART/DBG mirror stays labelled. Same prefix +
  `"^"` rules apply to the values array.

## node-dash consumer contract (posted to xsession)
Read `f[0]` (header) -> for each field row, `col = (i < row.length && row[i] !== "^") ? row[i] : n/a`.
Render by `ty` (`b`=checkbox, `n`=number with mn/mx, `t`=text with maxlength mn/mx). `w==0` -> read-only.
Submit via the existing port-260 `set` (`{"set":1,"path":id,"val":...}`). Delete the hardcoded field list.

## Verification (step 7)
Dashboard renders EVERY field with correct labels/bounds from the schema alone, hardcoded table
deleted. `applySet` accepts in-range / rejects out-of-range identically for the port-260 and text
paths (no drift). A full page round-trips under the 237 cap.

## Risks / gate
- **Step 2 rewrites `applySet` — the live command path today's proven image depends on.** Flash it
  on the BENCH only, validate every field set/reject before any field deployment. Field unit
  `!987ab80f` untouched.
- `detect` min changes 3 -> 5 (unifying to the table) — a minor behaviour change, called out.
- Debug-frame reshape (step 8) is breaking; do it last, after the schema mechanism is proven on config.
