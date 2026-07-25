---
task: single-service-host
status: proposal
source_hash: ~
scope:
  - specs/single-service-host.md
  - clients/host/**                     # NEW package: the one service
  - clients/mesh/lib/daemon.js          # lift the HTTP/WS server out; keep event fan-out
  - clients/mesh/lib/settings.js        # pure config injection (no process.cwd discovery)
  - clients/mesh/lib/log.js             # setSink()
  - clients/mesh/index.js               # expose the module contract
  - clients/trial-logger/trial-logger.js # script -> module with start(ctx)/stop()
  - ecosystem.config.cjs                # one app instead of two
# NOT changing: the Mesh domain API, the butler/queue semantics, the protocol layers,
#   mesh-gw's own WS interface (that is THEIRS — gw.js keeps consuming ws:8001/events
#   unchanged; this spec only governs the interface WE publish).
---

# Spec: single-service-host — one service, one API

## Decisions already taken (do not re-open)

1. **One PM2 service**, not two. Modules are internals; the service is the contract.
2. **API-first.** Consumers CONNECT; they never `require()` our code. This is about
   ownership: an imported copy of `@pac/mesh` would open its **own** mesh-gw connection
   and run its **own** butler — two queues delivering to the same units, duplicate
   sends, mis-correlated receipts, two image stores. The service is the **single owner**
   of the mesh-gw connection, the butler queue, the image store and the node model.
   Consumers own presentation.
3. **Transport = REST (GET/POST) + SSE.** Not WebSocket, not MCP.

## Why SSE (recorded so it is not re-argued)

- Our stream is genuinely **one-way**; commands go up by POST.
- **Reconnect + resume are in the protocol.** `Last-Event-ID` lets a dropped dashboard
  resume without missing mesh events. We hand-rolled that reconnect logic for WS in
  `lib/gw.js`; here we delete it.
- Plain HTTP: proxies trivially, `curl -N` debuggable, native `EventSource`.

**The obligation this creates:** emit a **monotonic event id** and honour
`Last-Event-ID` from a replay buffer. Without it SSE reconnects but silently skips —
and missed mesh events are exactly the failure class this project keeps fighting.

## Current state (audited, do not re-derive)

`clients/mesh/lib/daemon.js` is already most of the way there:

- Constructor is **dependency-injected**: `{ mesh, cfg, log, out, json }` — no globals.
- **One fan-out point**, `_dispatch(record)` → `out` + WS clients. SSE replaces WS here.
- Events: `node, reply, image-available, image, detection, alert, error`.
- Routes: `POST /queue`, `POST /command`, `POST /mode`, `GET /queue`, `GET /health`,
  `GET /nodes`. Binds `127.0.0.1:8787`.

Gaps: `trial-logger` has **no exports at all** (137-line script, everything top-level);
`settings.find()` falls back to `process.cwd()/config.yaml` then the module's **own**
shipped `config.yaml`; `log.js` writes straight to `process.stderr` with no sink.

## Design

### Module contract (uniform, so a 3rd service is one line)
```js
module.exports = {
  name: 'mesh',
  async start(ctx) {            // ctx = { config, log, bus }
    …
    return {
      routes: [ ['GET', '/nodes', handler], ['POST', '/queue', handler] ],
      async stop() { … },
    };
  },
};
```
- `ctx.config` — the module's slice, **passed in**. The module must never read a file.
- `ctx.log` — a child logger owned by the host.
- `ctx.bus.emit(type, payload)` — how a module publishes to the SSE stream.

### The host (`clients/host/`)
Owns config, logging, the HTTP listener, the SSE hub and lifecycle. Starts each module
in `try/catch` and **survives a module failing**. Mounts each module's routes under its
namespace. One PM2 app.

### Wire surface
| | |
|---|---|
| `GET /v1/health` | aggregate + per-module readiness |
| `GET /v1/mesh/nodes`, `GET /v1/mesh/queue` | reads |
| `POST /v1/mesh/queue`, `/command`, `/mode` | commands (mutate a real radio) |
| `GET /v1/mesh/images/:pid` | binary body — **never** on the event stream |
| `GET /v1/recorder/...` | trial-logger reads |
| `GET /v1/events` | **SSE**, all modules, namespaced |

**Event names are a published contract and are NOT our internal EventEmitter names.**
Internals change; the wire must not. Map explicitly:
`node → mesh.node`, `reply → mesh.reply`, `image → mesh.image`,
`detection → mesh.detection`, `alert → mesh.alert`, `error → mesh.error`,
plus `recorder.*` from trial-logger.

SSE frame: `id: <monotonic>`, `event: <namespaced>`, `data: <json>`.

### Rules the host enforces
- **Versioned** base path `/v1`.
- **Replay buffer** (ring, ~500 events) serving `Last-Event-ID`.
- **Slow-consumer policy:** a client that cannot keep up is **dropped**, never allowed
  to back up the service that is also delivering commands to the units.
- **Bind localhost by default** — it drives real radio hardware.

## Implementation order (one commit per step — this is too big for one)

1. `clients/host/` skeleton: config, logger, HTTP listener, SSE hub + replay, `/v1/health`.
2. Module contract + mount logic; mesh mounted, still WS-free.
3. `@pac/mesh` host-safe: pure config injection, `log.setSink()`.
4. `trial-logger` → module (`start(ctx)/stop()`, ws + interval handles held).
5. Event namespacing + the documented wire schema.
6. Cutover: `ecosystem.config.cjs` one app, `pm2 save`; **verify CSV continuity and
   butler continuity across the switch** (the recorder must not lose a day, and queued
   commands must survive).
7. `API.md` — the consumer contract.

## Observe
1. **Static** — one PM2 app; no `process.cwd()` in the config path; no `console.*`/
   `process.exit` outside `bin/`.
2. **Functional** — `curl -N /v1/events` streams; kill the client mid-stream and
   reconnect with `Last-Event-ID`, assert **no gap**; `curl /v1/health` shows both
   modules ready; a queued command still round-trips to a unit.
3. **Regression** — the CSV keeps appending across the cutover; the existing `mtmesh`
   CLI still works against the module; the butler queue survives a restart.

## Risks
- **Cutover is the risky moment**, not the code: two services stop and one starts. The
  recorder is our evidence trail — verify the CSV before and after, same file, no gap.
- A module that throws during `start()` must not take the host down (try/catch + health
  reporting `degraded`, not a crash).
- Port: the host should take `:8787` so existing consumers/scripts keep working, with
  the old unversioned routes optionally aliased for one release.
