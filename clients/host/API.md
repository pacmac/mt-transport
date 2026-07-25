# pac-host API — v1 (SKELETON, evolving)

**Status: DRAFT.** The transport, envelope and module structure below are settled and
implemented. Individual module routes are still being filled in. This document is the
contract node-dash builds against — if something here changes, it changes *here first*.

Each section is marked:

| mark | meaning |
|---|---|
| **STABLE** | implemented, tested, safe to build against |
| **DRAFT** | shape agreed, implementation in progress — build against it, expect field additions |
| **PLANNED** | not implemented yet, do not call |

> **Not deployed yet.** Today `mtmesh` still serves its own *unversioned* daemon on
> `:8787` and `trial-logger`/`timelapse-pull` run as separate PM2 apps. The host in
> this document replaces all of them. Build against `/v1`; the cutover is tracked in
> `specs/single-service-host.md`.

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

### 6.1 `mesh` — **DRAFT** (module wrapper in progress)

The mesh domain: nodes, commands, images, config. Speaks **domain**, never mesh
mechanics — no ports, frames, channels or queues cross this boundary.

Existing daemon routes, to be re-mounted under `/v1/mesh` (shapes are current):

| | |
|---|---|
| `GET /v1/mesh/nodes` | node roster with last-heard, battery, hops |
| `GET /v1/mesh/queue` | butler ledger |
| `POST /v1/mesh/queue` | `{unit, verb, args?, ttlMs?}` → queued command entry |
| `POST /v1/mesh/command` | live/dev routed command |
| `POST /v1/mesh/mode` | set a unit's live/dev mode |
| `GET /v1/mesh/images/:pid` | **PLANNED** — binary image body |

**Commands are asynchronous by nature.** A unit may be asleep; a queued command returns
an **id** immediately and is delivered in the unit's next wake window. Poll
`GET /v1/mesh/queue` or watch events for the receipt. Do not expect a synchronous
device reply.

Events: `mesh.node`, `mesh.reply`, `mesh.detection`, `mesh.alert`,
`mesh.image-available`, `mesh.image`, `mesh.error`.

### 6.2 `recorder` — **DRAFT** (module built, not yet mounted)

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

### 6.3 `timelapse` — **PLANNED**

TimerCam frame puller + gallery/movie UI (currently its own service on `:8090`).
Needs host static/HTML support first.

### 6.4 `antenna` — **PLANNED**

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
- A handler returns JSON, or `{ status, body }`, or `{ raw, contentType }` for binary.
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
