---
task: command-help-sync
status: DEFERRED to v2-phase3 (608) 2026-07-24 — NOT implemented. This interim CMD_LIST const is the "parallel name-list that just relocates the drift" Peter's task note warned against; the real fix is a runtime verb TABLE that dispatch walks + help/schema emit from, done when v2-phase3 rewrites dispatch. Kept as the interim design if ever wanted. CLI is functionally complete now (cmd passthrough reaches all 27 verbs); this is discoverability-only.
source_hash: ~
scope:
  - mt-transport/specs/command-help-sync.md
  - pac-garage-alarm/src/main.cpp     # CMD_LIST const; help `cmds` + schema `list` both use it
# NOT changing: the verbs themselves; the mesh CLI (its `cmd` passthrough already reaches all).
---

# Spec: command-help-sync — one canonical verb list for help + schema

## Why
`help.cmds` lists 15 verbs; `schema.list` lists a STALE mix (verbs + event names motion/alarm/
cleared/calc). Both omit the whole cam/camu/chunk/push surface + agc/hop/name/lname/nodes/
telemetry/sch. Two hand-maintained strings = they drift (this bug). Fix: ONE const, used by both.

## The canonical list (27 live verbs, from a handleCommand dispatch census)
`agc alarm cam camu chunk config debug detect echo env help hop interval lname name nodes ping
push reboot sch schema simenv sleepfor sleepmode status telemetry wedge`

## Frame budget (reply[237]; a DM'd reply loses ~17B to the PKC envelope -> JSON <= ~220)
- help WITH `use` field = 242 B -> OVERFLOWS. Drop `use`: `api:2` already denotes the
  `@<target> <verb>` grammar. help WITHOUT `use` = 217 B (fits, verified on-air).
- schema `{"type":"schema","ver":1,"list":"<CMD_LIST>"}` ~= 195 B (fits).

## Diffs (pac-garage-alarm/src/main.cpp)

### 1. One shared const (near API_VERSION ~109, or just above handleCommand)
```cpp
// SINGLE SOURCE for capability discovery — help.cmds AND schema.list both read this, so the two
// can never drift (the command-help-sync bug). Keep sorted; add a verb here when adding a verb.
static const char CMD_LIST[] =
    "agc alarm cam camu chunk config debug detect echo env help hop interval lname name nodes "
    "ping push reboot sch schema simenv sleepfor sleepmode status telemetry wedge";
```

### 2. help reply (~2724) — use CMD_LIST, drop the `use` field to fit the frame
```diff
-                 "{\"type\":\"help\",\"fw\":\"%s\",\"api\":%d,\"use\":\"@<unit|*> <verb>\","
-                 "\"cmds\":\"ping echo status env interval detect alarm simenv sleepmode "
-                 "sleepfor wedge config schema reboot help\"}",
-                 FW_VERSION, API_VERSION);
+                 "{\"type\":\"help\",\"fw\":\"%s\",\"api\":%d,\"cmds\":\"%s\"}",
+                 FW_VERSION, API_VERSION, CMD_LIST);
```

### 3. schema reply (~2625) — use CMD_LIST, drop the stale event-name mix
```diff
-                 "{\"type\":\"schema\",\"ver\":1,\"list\":\"pong status env "
-                 "interval detect alarms simenv sleep sleepfor config reboot help "
-                 "err schema motion alarm cleared debug calc\"}");
+                 "{\"type\":\"schema\",\"ver\":1,\"list\":\"%s\"}", CMD_LIST);
```

## Observe
1. Static: grep CMD_LIST used in BOTH help and schema; the old 15-verb/stale strings gone.
2. Build + flash bench b80f. LIVE: `cmd help` returns VALID JSON (not truncated) whose `cmds`
   contains cam, camu, chunk, push, agc (the previously-missing surface); `cmd schema` likewise.
3. Regression: `cmd help` still carries fw + api; a normal verb (`ping`) still replies.
