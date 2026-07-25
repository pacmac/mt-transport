# pac-host API — v1

**Status: LIVE.** The service is running: PM2 app `pac-host`, `http://127.0.0.1:8787/v1`.
The transport, envelope, module structure and every route listed below are implemented
and verified against real hardware. This document is the contract node-dash builds
against — if something here changes, it changes *here first*.

Each section is marked:

| mark | meaning |
|---|---|
| **STABLE** | implemented, tested, safe to build against |
| **DRAFT** | shape agreed, implementation in progress — build against it, expect field additions |
| **PLANNED** | not implemented yet, do not call |

> **Deployed 2026-07-25.** `pac-host` replaced the separate `mtmesh` and `trial-logger`
> PM2 apps; the old *unversioned* `:8787` daemon routes are gone. `timelapse-pull` is a
> **different project** and deliberately stays its own service on `:8090` — it shares
> no state or domain with the mesh.
>
> Quick check: `curl -s http://127.0.0.1:8787/v1/health`

---

## 1. Why a service and not a library — **STABLE**

Consumers **connect**; they never `require()` our code.

This is about ownership. An imported copy of the mesh module would open its **own**
mesh-gw connection and run its **own** command butler — two queues delivering to the
same radio units, duplicate sends, mis-correlated receipts, two image stores. This
service is the **single owner** of the mesh-gw connection, the butler queue, the image
store and the node model. Consumers own presentation.

Practical consequence for node-dash: **do not** talk to mesh-gw (`:8001`) directly for
anything this API covers, and **do not** import `@pac/mesh`. One socket, one owner.

## 2. Transport — **STABLE**

- **Reads and commands: plain HTTP.** `GET` for reads, `POST` for anything that
  changes state. Commands drive real radio hardware, so they are never implicit.
- **Live events: one SSE stream.** Server → client only.
- **Binary never travels on the event stream.** An event carries JSON metadata; the
  payload is fetched with an ordinary `GET` (e.g. an image).

Base URL: `http://127.0.0.1:8787/v1` (localhost by default — this drives real radio).

Versioning: everything is under `/v1`. Breaking changes get `/v2`; `/v1` keeps working.
New *fields* may be added to existing responses at any time — **ignore unknown fields**.

## 3. Envelope and errors — **STABLE**

Success: the resource as JSON (object or array). No wrapper.

Error:
```json
{ "error": "human readable", "detail": "optional" }
```

| status | meaning |
|---|---|
| `200` | fine |
| `400` | bad request / invalid JSON body |
| `404` | no such route or module |
| `503` | **the module exists but is not available** (it failed to start) — `detail` says why |
| `504` | **the radio unit did not answer** — asleep or out of range, not a server fault |
| `500` | handler threw; the host stays up |

`503` vs `404` matters: `503` means "this capability exists and is currently down" —
show it as degraded, keep polling. `404` means you have the path wrong.

## 4. Health — **STABLE**

```
GET /v1/health
```
```json
{
  "ok": false,
  "status": "degraded",
  "modules": [
    { "name": "mesh",     "status": "ready" },
    { "name": "recorder", "status": "failed", "error": "ENOENT: data dir" }
  ],
  "events": { "lastId": 4711, "oldestId": 4212, "clients": 1 },
  "uptimeMs": 3600000
}
```
`status` is `ready` | `degraded` | `down`. **A failing module never takes the service
down** — the rest keep serving and say so here. Poll this; drive your status UI from it.

`events.oldestId` is the earliest id still replayable — see §5.

## 5. Events (SSE) — **STABLE**

```
GET /v1/events          Accept: text/event-stream
```

Frames are standard SSE:

```
id: 4712
event: mesh.node
data: {"id":"!8cee336b","name":"BNCH","lastHeardMs":1690000000000}

```

- **`id`** is monotonic within a process lifetime.
- **`event`** is `<module>.<type>` — always namespaced.
- **`data`** is a single-line JSON object.
- A `: keepalive` comment arrives every ~25 s so idle proxies do not close the stream.

### Resume — the reason SSE was chosen

`EventSource` reconnects on its own and sends `Last-Event-ID`. The server replays
everything after that id from a ring buffer (default 500 events):

```js
const es = new EventSource('http://127.0.0.1:8787/v1/events');
es.addEventListener('mesh.node', (e) => update(JSON.parse(e.data)));
// reconnect + Last-Event-ID are automatic — do not hand-roll them
```

### `gap` — you missed events, and we say so

If the buffer has already rolled past your `Last-Event-ID`, you get **one** frame:

```
event: gap
data: {"from":120,"oldest":400,"latest":900}
```

**Treat `gap` as "re-sync from REST"** — your view has a hole. This is deliberate: a
silent gap is indistinguishable from "nothing happened", which is the exact failure
class this system is built to avoid. You will never be quietly lied to.

### Slow consumers are dropped

A client that cannot keep up (≈1 MB queued) is disconnected rather than allowed to back
up the service that is also delivering commands to radio units. `EventSource`
reconnects and resumes; if you were too slow you will get a `gap`.

## 6. Modules

Routes are mounted at `/v1/<module>/…`, events are `<module>.<type>`. Modules are
independent: use whichever you need, ignore the rest.

### 6.1 `mesh` — **STABLE**

The mesh domain: nodes, commands, images, config. Speaks **domain**, never mesh
mechanics — no ports, frames, channels or queues cross this boundary.

| route | |
|---|---|
| `GET /v1/mesh/devices` | **OUR devices only** — the dynamic device list, see below |
| `GET /v1/mesh/nodes` | node roster (the WHOLE mesh): id, num, name, lastHeard, hops, `ours` |
| `GET /v1/mesh/nodes/:target` | one node + live/dev mode, `awake`, `slp` |
| `GET /v1/mesh/queue` | butler ledger (all units) |
| `GET /v1/mesh/queue/:target` | ledger for one unit |
| `GET /v1/mesh/mode/:target` | mode, `lastHeardMs`, `awake` |
| `POST /v1/mesh/queue` | `{unit, verb, args?, ttlMs?, maxAttempts?}` → queued entry with an **id** |
| `DELETE /v1/mesh/queue/:id` | cancel a pending command |
| `POST /v1/mesh/command` | `{unit, verb, args?, force?}` — live/dev routed |
| `POST /v1/mesh/mode` | `{unit, mode: dev\|live\|auto}` |
| `GET /v1/mesh/images/:target` | list images held on a unit — **needs a live round-trip** |
| `GET /v1/mesh/images/:target/:pid` | image bytes (`image/jpeg`) — **needs a live round-trip** |
| `GET /v1/mesh/schema/:target` | **the device's self-describing field table** — served from cache, see below |
| `GET /v1/mesh/config/:target` | current config values — **needs a live round-trip** |
| `POST /v1/mesh/config/:target` | `{field: value, …}` — schema-validated write |

`:target` accepts the full `!8cee336b` **or** the 4-hex short form `336b`.

**Routes marked "needs a live round-trip" fail for a sleeping unit** — it is deaf
outside its ~8 s wake window. You get **`504`** with
`{"error":"unit did not answer"}`, which means *asleep or out of range*, not broken.
Check `GET /v1/mesh/mode/:target` → `awake` first, or queue a command instead.

**Commands are asynchronous by nature.** A unit may be asleep; a queued command returns
an **id** immediately. Follow it by polling `GET /v1/mesh/queue`, or watch the
`mesh.request-*` events on the SSE stream.

### The outbox — every message you send, with its state

`GET /v1/mesh/queue` is the **record of everything sent**, not just what could not be
delivered at once. A command to an awake unit and a free-form text used to leave **no
trace at all**; both are in here now, trackable by id.

```
GET /v1/mesh/queue?unit=336b&state=queued&kind=text&limit=50&offset=0
```

```json
[{ "id": "ms0c1ei7.1", "unit": "!8cee336b", "kind": "command",
   "verb": "ping", "args": [], "body": null,
   "state": "done", "tries": 1, "maxTries": 5,
   "createdAt": 1784981736367, "triedAt": 1784981736380, "settledAt": 17849817391,
   "result": { "type": "pong", "rssi": -55, "snr": 7 }, "error": null }]
```

| state | what it means |
|---|---|
| `queued` | accepted, not tried yet — normally milliseconds |
| `trying` | attempt in flight |
| `done` | completed and **confirmed** — `result` holds what came back |
| `sent` | dispatched, **no confirmation is possible for this kind** — terminal |
| `failed` | gave up after `tries` |
| `expired` | not delivered within its time limit |
| `cancelled` | cancelled via `DELETE /v1/mesh/queue/:id` |

**`sent` and `done` are not the same tick.** A command gets a device reply, so `done`
means it genuinely arrived. A free-form text carries **no receipt of any kind** — the
most that can ever be said is that the gateway accepted it, so a text ends at `sent`.
Rendering both as "delivered" would show a message as confirmed when nothing confirms it.

**`error` is `{code, message}`** — `no_reply`, `unreachable`, `refused`, `expired`,
`error`. Branch on the code; the message is for people.

**A queued command is attempted IMMEDIATELY, then falls back to the wake window.** So
against an awake unit you normally get a result in seconds.

**A healthy command to a SLEEPING unit will show `tries: 1` and
`error.code: "no_reply"` within seconds, then return to `queued`.** That is the first
attempt missing a deaf radio — **not a failure**, and it must not be rendered as one.
Only `failed` and `expired` are real failures.

Requests are retained per unit (most recent ~500 settled); anything not yet settled is
never dropped.

### Devices vs nodes — build your device list dynamically, never from hardcoded ids

`/nodes` is **the whole mesh** and stays that way: our units are ordinary Meshtastic
nodes and third-party nodes are not hidden from you. But most of the mesh is not ours,
so `/devices` answers the different question — *which nodes are the alarm devices*.

```json
[{ "id": "!987ab80f", "num": 2558179343,
   "name": "b80f 2-260724-3", "shortName": "GARG", "label": "Garage alarm",
   "source": "config", "present": true,
   "mode": "live", "awake": false, "slp": 1,
   "lastHeard": 1784976618, "lastHeardMs": 1784976618000,
   "fw": "2-260724-3",
   "position": { "lat": 51.014683, "lon": -3.128249 },
   "hops": 0, "rssi": -120, "snr": -14 }]
```

- **`mode`/`awake`/`slp` are included deliberately** so you render a device list in ONE
  call instead of following up with N requests to `/mode/:target`.
- **`present: false` means we know the device but the gateway has no roster entry** —
  typically a unit that has not been heard since our last restart. It is still listed:
  a device must not disappear from your UI because it is asleep. Signal fields are
  `null` in that case, never zero.
- **`source`** is `config` (declared on our side) or `learned` (it spoke our private
  protocol). Informational — treat both as ours.
- **`fw`** is parsed from the long name and is `null` if it does not match the expected
  shape. We never guess a version.
- The **gateway is not a device.** `!2687afb1` is our radio, not an alarm unit, so it
  appears in `/nodes` but never in `/devices`.

`/nodes` additionally carries **`ours: true|false`** per entry, so a single combined
view can filter without a second call. Same information, two shapes — pick one.

Neither route does a device round-trip, so both are safe to poll and both work with
every unit asleep.

### Antenna alignment — the backend owns the whole view-model

| route | |
|---|---|
| `POST /v1/mesh/align/ping` | `{target, n?}` — opens/retargets the session, fires one burst |
| `POST /v1/mesh/align/stop` | end the session |
| `GET /v1/mesh/align` | the complete view-model (polling fallback) |
| `POST /v1/mesh/align/config` | `{replyWindowSec}` (5–120) — server-persisted |

The model is pushed complete on every change as the **`mesh.align`** SSE event, and is
byte-identical to what the previous WebSocket sent — same field names, so a rebuilt UI
needs no adapter.

**Every derived value is computed here**: `quality` (0–100), `label`, `cls`, `trendDir`,
`trendDelta`, `best`, `gapToBest`, `bestAgo`, `barPct`. The page renders and computes
nothing, so two phones on one session show identical screens.

```json
{ "kind": "align", "running": true, "target": 2364420971, "tx": "OMNI", "channel": 2,
  "nBurst": 4, "replyWindowSec": 30,
  "burst": { "active": true, "got": 1, "of": 4 },
  "warning": null, "best": { "n": 2 },
  "current": { "n": 3, "quality": 62, "label": "Good", "cls": "success",
               "isBest": false, "gapToBest": 15, "bestN": 2, "bestAgo": 1 },
  "readings": [{ "n": 1, "quality": 47, "label": "Fair", "cls": "warning",
                 "spread": 3, "got": 4, "of": 4, "rssi": -90, "snr": 0.5,
                 "yagi_q": 30, "omni_q": 50, "barPct": 42,
                 "isBest": false, "isCurrent": false, "trendDir": null, "trendDelta": null }] }
```

**It is a spot measurement, not a meter.** One press fires a *burst* of N pings ~1.2 s
apart and averages them, because a single ping jitters ~0.7 dB at a fixed position. A
reply takes ~16 s, so a burst takes tens of seconds. `POST /align/ping` returns as soon as
the pings are away — watch the event for the result. A second press while a burst is
gathering returns **409**.

**Three signals, do not conflate them.** `quality`/`rssi`/`snr` are **the device's own
reading of our ping**, measured at the antenna being turned — that is the primary number
and the one to align on. `yagi_q`/`omni_q` are *our* antennas hearing the device, and are
secondary. **A radio that heard nothing is `null`, never `0`** — render it as a gap, since
`0` would read as "terrible signal" when the truth is "no data from that antenna".

`warning: "No replies — try again."` means the burst landed nothing. No reading is
invented for a silent burst.

`channel` and `tx` are **reported** so the UI can display them; neither is accepted as
input. Channel selection, addressing and reply correlation stay on our side.

### Config schema — build your form from the DEVICE, not a hardcoded list

`GET /v1/mesh/schema/:target` returns the device's own description of every settable
field, so a config UI is generated rather than maintained:

```json
{ "ver": 3, "fetchedAt": 1784969000000, "fields": [
  { "id": "alm.ovr", "ty": "n", "label": "Over-temp", "def": 30,
    "writable": true, "min": 0, "max": 100, "bounded": true }
]}
```

`ty` is `n` numeric · `b` boolean · `t` text. `bounded` says whether `min`/`max` apply.
A field added in firmware appears in your UI with **no dashboard change** — that is the
point of exposing it.

**It is served from a PERSISTENT cache, and that is not an optimisation.** The schema is
pulled off the device by `sch` page requests, which only work while the unit is **awake**
— a 15-minute sleeper is unreachable ~99% of the time. So the schema is persisted on
disk and survives our restarts: without that, a dashboard could not render a config form
until the unit happened to wake. Resolution order is hot cache → disk → device.

- The schema only changes when **firmware** changes, so a cached copy stays valid.
- After a flash, force a re-pull with `?refresh=1`.
- If the device is unreachable and we hold no copy for it, you may get another unit's
  cached schema flagged **`"stale": true`** — the schema is firmware-global, so a
  sibling's copy describes it. A flagged form beats a blank page; check the flag.
- Only if nothing is cached anywhere do you get `504`.

**Writes:** `POST /v1/mesh/config/:target` with a `{field: value}` patch. We validate
against the schema and map each field to its own device verb. **Do not build port-260
`{"type":"set"}` payloads** — that channel is unreachable over the text gateway. This
route is the supported path.

Events: `mesh.node`, `mesh.reply`, `mesh.text`, `mesh.detection`, `mesh.alert`,
`mesh.image-available`, `mesh.image`, `mesh.error`, plus the request lifecycle:
`mesh.request-queued`, `mesh.request-trying`, `mesh.request-done`, `mesh.request-sent`,
`mesh.request-failed`, `mesh.request-expired`, `mesh.request-cancelled`.

Each request event carries the full ledger entry, so a UI can follow a command from
submission to result without polling. Watch `request-done` (confirmed) and
`request-sent` (dispatched, unconfirmable) as **different** outcomes — see §6.1.

### 6.2 `recorder` — **STABLE**

Whole-mesh raw packet recorder → daily CSVs, plus per-node missed-heartbeat alerts
derived from each node's own observed cadence.

| | |
|---|---|
| `GET /v1/recorder/status` | ws state, current CSV, row count, per-node liveness |
| `GET /v1/recorder/days` | available CSV dates (`YYYYMMDD`) |
| `GET /v1/recorder/alerts?limit=100` | recent alert lines |

Events: `recorder.packet` (one per recorded row), `recorder.alert`.

> **CSV caveat if you read the files directly:** a text payload may contain a newline,
> so these are RFC 4180 files with **multi-line records**. Use a real CSV parser —
> never `split('\n')`.

### 6.3 `antenna` — **PLANNED**

Rotator / antenna alignment. Will drive the rotator hardware **directly**; it will not
proxy node-dash.

## 7. Adding a module (internal) — **STABLE**

```js
module.exports = {
  name: 'thing',
  async start(ctx) {              // ctx = { config, log, bus }
    return {
      routes: [['GET', '/status', async ({ params, query, body }) => ({ ok: true })]],
      async stop() { /* release every socket and timer */ },
    };
  },
};
```

- `ctx.config` is the module's slice, **injected**. A module must never read config
  from disk — under the host, cwd belongs to the host.
- `ctx.bus.emit(type, data)` publishes to the SSE stream, namespaced automatically.
- A handler returns **plain data** (serialised to JSON), or an explicit envelope from
  `reply(status, body)` / `binary(buf, contentType)`. The envelope is marked with a
  **symbol**, never duck-typed: a domain object is free to have `status`, `body` or
  `raw` fields of its own (a mesh node carries a `raw` passthrough, which is exactly
  what broke `/nodes/:target` when the envelope was inferred from field names).
- `stop()` must leave nothing running — no timer, no socket, no pending reconnect.

## 8. Conventions

- **Ignore unknown fields.** They will be added without a version bump.
- **Times** are epoch milliseconds unless the field name says otherwise; CSV timestamps
  are UTC ISO-8601. (Operators read local/BST — convert at the edge.)
- **Node ids** are Meshtastic `!xxxxxxxx` hex form; the mesh module also accepts the
  last-4 short form on input.
- **Short names encode location, not identity** — `BNCH` (bench) / `GARG` (garage).
  They are toggled by hand when units are swapped, so do not treat a short name as a
  stable key. Key on the node id.

## 9. Open questions

- Auth: none today (localhost bind). Needed if this is ever exposed beyond the host.
- Pagination for `recorder` row queries.
- Whether `recorder.packet` should be opt-in per client (volume) rather than always on
  the shared stream.
- An MCP adapter over this same REST core, so an agent can drive the mesh as tools.
