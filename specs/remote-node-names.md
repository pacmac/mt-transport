---
task: remote-node-names
status: active
source_hash:
  pac-garage-alarm/src/main.cpp: b2c1ad1bd3d7d7112f9ec4eb6ef55986277d0d516668dfd4a8c03b3824657a64
updated: 2026-07-19
scope: pac-garage-alarm/src/main.cpp (tracked here; that repo is not a registered mcpp project)
---

# Spec: remote-node-names — set short and long name over the air

Pre-deployment item. Everything else discussed this session (`config-schema`,
`mt-chunk`) is design-only and explicitly parked.

## The problem, in three parts

**1. The rename never reaches the mesh.** `sendNodeInfo()` (`main.cpp:626-636`)
reads `g_unit->shortName` / `g_unit->longName` straight from the compile-time
`MESH_UNITS` table:

```c
if (g_unit) {
    snprintf(u.long_name, sizeof(u.long_name), "%s %s", g_unit->longName, FW_VERSION);
    strlcpy(u.short_name, g_unit->shortName, sizeof(u.short_name));
}
```

`g_shortName[16]` (`:145`) already exists as a live RAM copy and is used for
command matching (`:843`, `:1088`) — so a renamed unit would **answer to the new
name while advertising the old one**. That split state is worse than no rename,
because the dashboard and the radio would disagree.

**2. Nothing persists.** `PersistedSettings` (`:153-165`) is entirely
`uint32_t`/`int32_t`. No string fields exist.

**3. The config path is numeric-only.** `applySet()` takes `long v`, and
`handlePrivateApp()` (`:1099-1100`) parses the value with `strtol`.

## The migration is the load-bearing part

`loadSettings()` (`:245`) returns early on a version mismatch:

```c
if (n != sizeof(s) || s.magic != SETTINGS_MAGIC || s.version != SETTINGS_VERSION)
    return; // wrong size/era: defaults stand
```

Bumping `SETTINGS_VERSION` 3 → 4 therefore **silently discards DEV1's
over-the-air tuning** (`det 4→10`, `interval 30s→5min`) on the first boot after
reflash. Those settings cost a 90-minute round trip to establish.

So v4 must **migrate** rather than reject a v3 record. This is the single most
important line in the change and the reason it is step 1.

## Diffs

### 1. `PersistedSettings` + migration

```diff
     uint32_t sleepOn;
+    char     shortName[16]; // "" = no override, use the MESH_UNITS default
+    char     longName[32];  // "" = no override
 };
 static const uint32_t SETTINGS_MAGIC = 0x50414353; // 'PACS'
-static const uint32_t SETTINGS_VERSION = 3;
+static const uint32_t SETTINGS_VERSION = 4;        // v3 records are MIGRATED, not dropped
```

`loadSettings()` gains a v3 path that reads the old layout, carries every
numeric field forward, and leaves the names empty. **Empty string is the
sentinel for "no override"** — that keeps the `MESH_UNITS` default working and
makes "reset to default" expressible later.

### 2. Live long name

```diff
 static char g_shortName[16] = "";
+// LIVE long name, same rationale as g_shortName: seeded from MESH_UNITS,
+// overridden by a persisted value, and it is what NodeInfo actually sends.
+static char g_longName[32] = "";
```

`setup()` (`:1153-1157`) seeds **both** from the table, then `loadSettings()`
overrides each if the persisted value is non-empty. Order is load-bearing:
table first, flash second.

### 3. `sendNodeInfo()` uses the live names

```diff
     if (g_unit) {
-        snprintf(u.long_name, sizeof(u.long_name), "%s %s", g_unit->longName, FW_VERSION);
-        strlcpy(u.short_name, g_unit->shortName, sizeof(u.short_name));
+        snprintf(u.long_name, sizeof(u.long_name), "%s %s", g_longName, FW_VERSION);
+        strlcpy(u.short_name, g_shortName, sizeof(u.short_name));
     } else {
```

The `g_unit == nullptr` fallback is **unchanged** — that is the unconfigured
board path and is independent of this feature.

### 4. String-valued set

New `applySetStr(const char *path, const char *v)` handling `name` and `lname`.
`handlePrivateApp()` detects a quoted `"val"` and routes to it; the numeric path
is untouched.

`applySet()` keeps its `long v` signature. Widening it would touch nine working
call sites hours before a deployment for no benefit.

### 5. Validation — functional, not cosmetic

| | rule | why |
|---|---|---|
| short | 1..4 chars, printable ASCII, **no spaces** | the parser tokenises `@target verb`; an embedded space breaks addressing for that unit |
| long | 1..24 chars, printable ASCII | `snprintf(long_name, 40, "%s %s", name, FW_VERSION)` — a longer name truncates the **firmware version**, the only way the phone app surfaces it for a remote node |

Rejection replies with the reason. **Never silently clamp a name.**

### 6. Apply

On success: `saveSettings()`, `sendNodeInfo()`, `g_cfgChanged = true` — so the
change reaches the mesh immediately rather than at the next NodeInfo interval.

## Why this is safe to send to a remote unit

A bad name **cannot strand the node**. Command matching (`:829-843`) accepts the
4-hex MAC suffix **or** the short name **or** `*`, and the suffix derives from
FICR and cannot be misconfigured. Even an empty or garbled short name leaves two
working ways to reach the device.

**Do not regress this property.**

## Files

| file | change |
|---|---|
| `pac-garage-alarm/src/main.cpp` | settings v4 + migration, `g_longName`, NodeInfo, `applySetStr`, `@name`/`@lname` |
| `specs/remote-node-names.md` | this file |

**NOT changing:** `mt-transport` (application-layer only); `secrets.h`
`MESH_UNITS` (still the per-board default); `applySet()`'s numeric signature;
the `g_unit == nullptr` NodeInfo fallback.

## Verification — on HOME (`!987ab80f`), never DEV1

1. **Static:** `sendNodeInfo()` contains no `g_unit->shortName` /
   `g_unit->longName`; `SETTINGS_VERSION == 4`; v3 migration path present.
2. **Build:** `pac-garage-alarm` compiles.
3. `@<suffix> name TEST` → reply OK, and the gateway's NodeInfo shows `TEST`.
   Decoded from the gateway, not inferred from the reply.
4. `@TEST ping` → pong. The new name answers.
5. `@reboot` → the name survives. Persistence proven, not assumed.
6. Suffix addressing still works after the rename — anti-stranding intact.
7. Rejects: `name A B` (space) and a 30-char long name, both refused **with a
   reason**.
8. **REGRESSION, the one that protects DEV1:** set a non-default numeric value
   on the v3 image, flash the v4 image over it, confirm the value survived.
   **This must pass before DEV1 is flashed.**

## Results — 2026-07-19, HOME (`!987ab80f`)

All on air, decoded at the gateway or observed on the debug UART. Nothing below
is inferred from timing.

**Migration (the DEV1 protection).** The stored values happened to equal the
compiled defaults (`hb=60s det=3/10s` vs `main.cpp:51-53`), so comparing values
would have proved nothing either way. Proof is therefore a *causal side effect* —
the `migrated v3 -> v4` line executes only in the v3 branch and cannot print if
the record were dropped:

```
boot 4:  settings: migrated v3 -> v4
         settings: loaded from flash (hb=60s det=3/10s)
boot 6:  settings: loaded from flash (hb=60s det=3/10s)      <- no migration line
```

Migration ran exactly once, rewrote the record as v4, and later boots read it
natively. Survived two reflashes.

**Rename, decoded from the mesh:**

```
{"type":"name","name":"TS11","was":"HOME","ok":true}
{"type":"lname","name":"Renamed 11:42","was":"Alarm Home","ok":true}
```

UART showed `RX: port=1 len=15` then `NODEINFO` → `REPLY` → `REPLY2` → `CONFIG`,
i.e. the rename handler's immediate `sendNodeInfo()` fired.

**The new name answers:** `@TS11 lname ...` was accepted — addressed by the
runtime name, proving `g_shortName` matching is now genuinely live.

**Persistence:** `@TS11 reboot` → `{"type":"reboot","ok":true}`, then `@TS11 ping`
→ `{"type":"pong","upt":48,...}`. Uptime reset proves the reboot happened; the
new name still answering proves it was loaded from flash, not from the table.

**Rejections, each with its reason:**

```
@TS11 name A B      -> {"type":"err","msg":"no spaces in short name"}
@TS11 name TOOLONG  -> {"type":"err","msg":"short name max 4 chars"}
@TS11 lname <35ch>  -> {"type":"err","msg":"long name max 24 chars"}
```

**Restored** to `HOME` / `Alarm Home` after testing.

**DEFERRED:** the `(overridden)` suffix on the boot `names:` line, and the
matching assertion that `saveSettings()` stores an EMPTY string when the live
name equals the `MESH_UNITS` value. The logic is a plain `strcmp` at
`main.cpp:389-391`, but it was not exercised on hardware — the capture for that
reboot was started and the reboot never sent. It matters because storing a copy
of the table value would freeze it, masking a future `secrets.h` change forever.
Verify on the next boot of any unit.

**DEV1 was NOT flashed from this task.**
