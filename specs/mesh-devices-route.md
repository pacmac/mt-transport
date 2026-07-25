---
task: mesh-devices-route
status: IMPLEMENTED 2026-07-25. VERIFIED LIVE: GET /v1/mesh/devices returns exactly BNCH +
  GARG (gateway and the handheld excluded); GET /v1/mesh/nodes still returns all 4 with
  ours=true on our two. Offline suite 16/16 green (cache 32, devices 31 new assertions).
  Storage is FILE-backed; SQLite parked as task cache-sqlite-backend — Peter: "we will add
  sqlite later as it's scope is much wider than just cache."
source_hash:
  clients/mesh/lib/cache.js:        337608b3520b2fc4
  clients/mesh/lib/store.js:        b085827e37428e5f
  clients/mesh/lib/settings.js:     6cd545067b8904ef
  clients/mesh/index.js:            0ae1f7feb09801b1
  clients/mesh/host-module.js:      dc5751cae381a820
  clients/mesh/config.yaml:         c3dfde6e52d4ec6a
  clients/host/host.config.json:    f9b00c16631e304b
  clients/host/API.md:              15e24df3ff720d5e
  clients/mesh/test/cache.js:       0bfd7bcbbf0eb4ca
  clients/mesh/test/devices.js:     0b5ff61dabd0acc1
scope:
  - specs/mesh-devices-route.md
  - clients/mesh/lib/cache.js        # NEW generic persistent cache (get/put/all/del + TTL)
  - clients/mesh/test/cache.js       # NEW offline test for it
  - clients/mesh/lib/store.js        # persist the learned device set; schema delegates to cache
  - clients/mesh/lib/settings.js     # `devices` config default
  - clients/mesh/index.js            # registry: seed + learn; devices(); `ours` on summaries
  - clients/mesh/host-module.js      # GET /v1/mesh/devices
  - clients/mesh/config.yaml         # the device registry (standalone/CLI use)
  - clients/host/host.config.json    # the device registry (LIVE service — config is INJECTED
                                     #   under the host, so config.yaml is not read there)
  - clients/mesh/test/devices.js     # NEW offline test
  - clients/host/API.md              # document the route
# NOT changing: GET /v1/mesh/nodes keeps returning the WHOLE roster (Peter: "it's ok to
#   show other nodes in our db"), the Model, the butler, unitInfo/unitMode, or anything
#   about how frames are decoded. This adds a distinction; it removes nothing.
---

# Spec: mesh-devices-route — our devices, told apart from the mesh

## The problem

`GET /v1/mesh/nodes` returns the mesh-gw roster verbatim (`index.js:_summaries`) with
**no ownership marker**. Live right now it is four nodes:

```
!2687afb1  —     (OMNI gateway)
!8cee336b  BNCH  336b 2-260725-18   <- ours
!987ab80f  GARG  b80f 2-260724-3    <- ours
!da5af428  TA2m  B12PAC car
```

Two of those are our alarm units; the gateway is our radio but not an alarm device; TA2m
is Peter's handheld. Nothing on the wire says which is which, so node-dash cannot build a
device list without hardcoding ids — exactly the drift we removed for the config schema.

Peter, 2026-07-25: *"it's ok to show other nodes in our db, but we must be able to show
our devices and not mix them all in so node-dash can generate dynamic list of devices"*
and *"so we need devices/"*.

**Nothing existing answers "is this ours":**

- `cfg.units` is a **mode-override map only** (`settings.js:30`, `units.<id>.mode`). A
  unit with no override is absent from it, so it is not a registry. Using it would list
  whichever units happened to have been pinned — a silent, wrong answer.
- `Model` is not it either: `model.heard()` is called for **every** node that transmits
  (`index.js:107`), so the model holds third-party nodes too.

## The signal that IS reliable

**Only our firmware sends port 260 / 261.** `_onEvent` already branches on exactly that
(`index.js:124` `PORT_ALARM`, `:131` `PORT_CHUNK`). A node we have decoded a 260/261
frame from is running our firmware — that is a positive, self-maintaining proof of
ownership, not a naming convention.

It is not sufficient alone: a unit asleep since the last restart has sent us nothing, so
learning-only would hide GARG for up to 15 minutes after every service start.

**So the registry is a union of two sources**, and each entry says which it came from:

| source | what it means | why it is needed |
|---|---|---|
| `config` | declared in `config.yaml` `devices:` | authoritative; present even when the unit is asleep or has never been heard |
| `learned` | a 260/261 frame was decoded from it | picks up a newly-flashed unit with no config change; persisted so it survives a restart |

Per `no-hardcoded-identity`, the declared list lives in **config, not code**.

## Design

### 1. `config.yaml` — the declared registry

```yaml
devices:
  "!8cee336b": { label: "Bench alarm" }
  "!987ab80f": { label: "Garage alarm" }
```

`label` is optional and purely operator-facing; the id is the key. `settings.js` gains
`devices: {}` alongside the existing `units: {}` default.

### 2. A GENERIC cache, because this is the schema problem again

Peter, 2026-07-25: *"same issue as schema, on power up devices wont be known. we need a
cache folder and a generic get / put handler for anything we need to cache, not sure if
we need ttl as well?"*

Correct — and it generalises. `store.js` had grown schema-specific `saveSchema` /
`loadSchema` / `anySchemas`; the device set needs the same thing, and so will the align
reply window. So `lib/cache.js` is a namespaced persistent KV store:

```
put(ns, key, value, {ttlMs})   ttlMs OPTIONAL; omitted = never expires
get(ns, key)  -> {value, savedAt, ageMs, ttlMs, stale} | null
value(ns, key) -> value | null      (fresh or stale)
all(ns) / del(ns, key) / clear(ns)
```

**TTL: supported, off by default, and expiry NEVER deletes.** An expired entry returns
with `stale: true` and the caller decides. Both current consumers must outlive any
window — a schema expiring while GARG sleeps is exactly the bug the persistent schema
cache fixed, and `stale: true` is already our idiom for the sibling-schema fallback.
Delete-on-expiry would quietly reintroduce it.

Writes are tmp-file + `rename()`, so a crash mid-write cannot leave a file that reads as
corrupt. Reads are memoised, because `_markOurs` runs on every protocol frame.

**Storage backend: files now, SQLite parked** (task `cache-sqlite-backend`). Peter
raised SQLite; the check that decided it: `node:sqlite` needs Node ≥ 22.5 and this box
is **v20.19.2**, but `better-sqlite3` 12.11.1 is installed for node-dash and was
**verified loading on this exact Node** — so the native-build cost is already paid and
the objection I first raised was wrong. What it is NOT worth doing *today* is the
dependency plumbing: `@pac/mesh` has no local `node_modules` at all (`ws`/`yaml` resolve
from `/usr/share/nodejs`), so it will not resolve just because node-dash has it. The
interface above is therefore deliberately backend-agnostic and no caller learns where
bytes live. Peter: *"the cache function can be changed later to use sqlite."*

`store.js` schema methods now delegate to it (`ns: 'schema'`) with an unchanged return
shape, plus a one-time read-and-promote of the legacy `<store>/<node>/schema.json` so an
existing install does not lose a schema it already spent a wake window fetching.

### 3. Learning + persistence

- `index.js` gains `_ours` (a `Set`), seeded at `connect()` from `cfg.devices` **and**
  `store.loadDevices()`.
- In `_onEvent`, both the `PORT_ALARM` and `PORT_CHUNK` branches call
  `this._markOurs(ev.from)`. New id → add to the set and `store.saveDevices([...])`.
  Already known → no write (this runs per frame; it must not touch the disk every time).
- `store.js` gains `saveDevices(ids)` / `loadDevices()` — one `devices.json` at the store
  root, same defensive shape as `loadSchema` (absent or corrupt ⇒ `[]`, never throw).

### 4. `devices()` — the enriched list

Returns **only** our devices, each merged from the three things we know:

```js
{
  id: '!987ab80f', num: 2557370895,
  name: 'b80f 2-260724-3', shortName: 'GARG',
  source: 'config',            // 'config' | 'learned'
  label: 'Garage alarm',       // from config, else null
  present: true,               // is it in the gateway roster at all
  lastHeard: 1784976618,       // gateway roster (unix s)
  lastHeardMs: 1784976618000,  // our own model (ms) — the one mode uses
  mode: 'live', awake: false, slp: 1,
  position: { lat: 51.014683, lon: -3.128249 } | null,
  fw: '2-260724-3' | null,
  hops: 0, rssi: -56, snr: 5.8,
}
```

`mode`/`awake`/`slp` come from the existing `unitInfo` path, so a dashboard gets the
device list and its liveness in **one** call instead of N+1 round-trips to
`/mode/:target`. `fw` is parsed from the long name (`<suffix> <version>`), which is where
the firmware puts it — `null` if it does not match, never a guess.

A declared device that the gateway has never seen still appears, with `present: false`
and null signal fields. **A device we know about must not vanish because it is asleep** —
that is the whole point of declaring it.

### 5. `ours: true` on `/nodes`

`_summaries` marks each entry `ours: true|false`. Same information, so a consumer that
wants one combined list can filter it without a second call, and `/nodes` still returns
the whole roster unchanged otherwise (Peter: other nodes stay).

### 6. Route

```
GET /v1/mesh/devices        -> [ {…}, … ]   our devices only
```

No parameters. Cheap: roster + model, no device round-trip, so it is safe to poll and
works with every unit asleep.

## Changes

1. `clients/mesh/config.yaml` — add the `devices:` block above.
2. `clients/mesh/lib/settings.js` — `devices: {}` in DEFAULTS beside `units: {}`.
3. `clients/mesh/lib/store.js` — `saveDevices(ids)` / `loadDevices()`.
4. `clients/mesh/index.js` — `_ours` set, seeded in `connect()`; `_markOurs()` called
   from the two app-port branches of `_onEvent`; `ours` in `_summaries`; new
   `async devices()`.
5. `clients/mesh/host-module.js` — `['GET', '/devices', async () => mesh.devices()]`.
6. `clients/mesh/test/devices.js` — offline, no radio.
7. `clients/host/API.md` — new §, and a note on `/nodes` that `ours` now exists.

## Observe

1. **Static** — `grep -n "devices" host-module.js index.js` shows the route and the
   method; `devices:` present in `config.yaml`.
2. **Functional** — `curl /v1/mesh/devices` returns exactly BNCH + GARG, with GARG
   `present: true, awake: false` while it sleeps; `curl /v1/mesh/nodes` still returns all
   four, with `ours` true on two. Restart the service and re-curl: **still two devices**
   (the seed/persistence assertion — the case learning alone would fail).
3. **Regression** — `/nodes/:target`, `/mode/:target` and a queued command are unchanged;
   the offline test suite passes.

## Risks

- **The learned set can only grow.** A node that once ran our firmware stays "ours"
  forever. That is the safe direction (a device is never silently dropped), and the file
  is operator-editable, but it is not self-cleaning — noted deliberately.
- The gateway (`!2687afb1`) is **not** an alarm device and must not be listed. It is our
  radio, not our device; it never sends 260/261 and is not declared, so both sources
  agree — but it is the obvious thing to get wrong, hence the explicit assertion in the
  functional check.
