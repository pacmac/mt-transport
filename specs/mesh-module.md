---
task: mesh-module
status: SKELETON BUILT + VERIFIED 2026-07-23 (phase 1). Bodies throw NotImplemented; later phases fill them.
source_hash: clients/mesh/index.js 15ed38de36d47beb4707a5ef80d70e65c79a512855d90c8fadee5a6b1a4a494e; clients/mesh/bin/mtmesh.js 3a5e9daed56609cf9c9320e0de20bc3b8fbbd4b6017565d908793fe8cbb5f2f5
project: mt-transport
scope:
  - specs/mesh-module.md
  - clients/mesh/package.json      # NEW
  - clients/mesh/index.js          # NEW — library entry, exported skeleton
  - clients/mesh/bin/mtmesh.js     # NEW — CLI verb dispatcher
  - clients/mesh/lib/*.js          # NEW — internal skeleton modules
---

# mesh domain module — skeleton design

## Goal (Peter)
Remove ALL knowledge of mesh mechanics / our API / protocols / timing from
node-dash and any other consumer. This module is the single place that knows it.
Designed from scratch (NOT the clients/node retrospective code). Three entry
points, one core: require-able library, structured CLI (firmware-style verbs),
long-running daemon. Talks DIRECTLY to mesh-gw (HTTP send / WS receive).

This spec covers the SKELETON only: exported surface + CLI grammar + layout, with
EMPTY function bodies (each throws `NotImplemented`). No logic yet.

## Identity
- Package name: `@pac/mesh` (working); dir `clients/mesh/`.
- Consumers see DOMAIN objects (nodes, detections, images, config, commands) —
  never ports, frames, chunks, channels, airtime, queues.
- New, isolated from clients/node (which stays as-is, retrospective).

## Layout
```
clients/mesh/
  package.json         main: index.js, bin: { mtmesh: bin/mtmesh.js }
  index.js             exports the public API (Mesh class + factory)
  bin/mtmesh.js        CLI: parse verbs -> call the same public API
  lib/
    gw.js              mesh-gw transport (HTTP POST send, WS /events receive)
    protocol.js        wire codec: 260 JSON, 261 chunk/push, @cmd grammar
    timing.js          queue, pacing, backpressure, no-retry policy
    model.js           live state model (nodes, images, config cache)
    images.js          image domain (available + fetch, hides chunk/push)
    config.js          config domain (schema-validated get/set)
    errors.js          domain errors (NodeOffline, ImageUnavailable, OutOfRange)
```

## Public API (index.js) — exported, EMPTY bodies
```js
class Mesh {
  constructor(opts)              // { gw, channel } — never channel 0
  async connect()                // open transport
  async close()

  // events (typed, domain-level): 'node','detection','image-available',
  //   'config','error'
  on(event, handler)
  off(event, handler)

  // live model (queryable, no I/O)
  nodes()                        // array of node summaries
  node(id)                       // one node: {id,name,uptime,battery,cam,...}

  // commands (domain intent; module owns grammar + timing + correlation)
  async command(node, verb, args)   // generic escape hatch
  async ping(node)
  async status(node, domain)        // '', 'mem', 'alarm'

  // images (hides chunk/push/timing entirely)
  async listImages(node)
  async getImage(node, pid, { onProgress, signal } = {})   // -> Buffer
  startImageListener()              // passive push receiver (auto-upload catch)

  // config (schema-validated)
  async getSchema(node)
  async getConfig(node)
  async setConfig(node, patch)      // validates vs schema BEFORE send
}
module.exports = { Mesh, connect /* factory */, errors, VERSION }
```

## CLI grammar (bin/mtmesh.js) — firmware-style verbs
```
mtmesh [--gw URL] [--channel N] <verb> [target] [args]

  nodes                       list known nodes
  status <target> [domain]    ping/status/status mem/status alarm
  ping <target>
  image list <target>
  image get <target> <pid> [--out FILE]
  config get <target>
  config set <target> <key> <value>
  listen                      run as daemon: hold model + image listener,
                              print domain events (optionally serve REST/WS)
```
Verb dispatch table mirrors the firmware `@target verb` pattern: one table,
`{verb, handler}`, so `help` / usage is generated from it (no drift — the lesson
from command-help-sync).

## mesh-gw transport contract (GROUNDED against live OpenAPI 2026-07-23)
Authoritative docs: mt-radar/mesh-gw/docs/{API_REST,API_SSE,API_V1_V2,OVERVIEW}.md.
gw.js uses ONLY these:
- SEND (our private surface): `POST /{gwId}/messages {text, channel}` — the only
  send path; @commands + chunk/push requests go as text (transport asymmetry).
- RECEIVE: event stream `/events` (SSE — see API_SSE.md) → private_app events
  (260/261) + text events. WS needs maxPayload 0 (multi-MB snapshot).
- STANDARD data (read): `GET /nodes`, `/status`, `/{gwId}/info`, `/{gwId}/nodes`.
- TWO SCHEMA SOURCES, do not conflate:
  * mesh-gw `/schema/{section}` + `/{node}/config` = STANDARD Meshtastic config
    (channel/owner/position/radio). Not ours.
  * OUR private config schema = device-side, via the `sch` command (port 260,
    paginated). config.js owns this one; mesh-gw does not know it.
- `/help` exists on mesh-gw (200) — reference, not a dependency.
mesh-gw is LIVE — never modify it; the module adapts to it.

## Daemon
`mtmesh listen` = long-running: connect, hold the live model, run
startImageListener(), emit domain events to stdout; later, optionally expose a
clean domain REST/WS for non-Node dashboards. Skeleton: the command exists and
wires the (empty) core; serving is a later step.

## Config — config.yaml (NOTHING hard-coded)
No hard-coded vars, NO hard-coded paths, all timings are vars. Single
`config.yaml` is the source; CLI flags + env override it; sane defaults in code
only as last resort. Covers at least:
```yaml
gw:      { host: localhost, port: 8000, sendPort: 8000, eventsPath: /events }
channel: 2                 # never 0
paths:   { store: ./payloads, log: ./mtmesh.log }
timing:  { sendSpacingMs: 3000, replyTimeoutMs: 20000, wsMaxPayload: 0,
           chunkAnswerMs: ..., idleMs: ..., pushDeadlineMs: ... }
retry:   { commands: false }   # no blind retry (non-idempotent)
listen:  { autoFetchImages: true, alerts: [motion, fault, ...] }
```
Loader: `lib/config.js` (find config.yaml via --config / env / cwd; merge
defaults < file < env < flags). Every timing/path used anywhere reads from here.

## Listeners (daemon + programmatic)
First-class, not just images:
- UPLOAD listener — catches device-initiated push (image-available), optionally
  auto-fetches (config listen.autoFetchImages).
- ALERT listener — surfaces important alarms/alerts (motion detection, faults)
  as domain events; the daemon forwards them (stdout/JSON now, webhook/REST later).
Exposed as events (`on('image-available')`, `on('alert')`) AND run by
`mtmesh listen`.

### Alert routing — pluggable transports
Alerts flow: event → `lib/notify.js` router → one or more NOTIFIER TRANSPORTS.
Transports are plugins behind a common interface (`send(alert)`); each
self-contained, added without touching the core. Config-selected + config-
routed:
```yaml
notify:
  transports:
    console: { enabled: true }
    email:   { enabled: false, to: ..., ... }   # stubs; impl later
    webhook: { enabled: false, url: ... }
    whatsapp:{ enabled: false, ... }
  routes:                       # which alert kinds go to which transports
    motion: [console, email]
    fault:  [console, email, whatsapp]
```
Skeleton: the router + a `console` transport stub + the transport interface;
email/whatsapp/etc are registered but empty (throw NotImplemented). Structure
first so any transport drops in later.

## Tooling
pnpm ONLY (never npm). Lockfile pnpm-lock.yaml. Scripts invoked via pnpm.

## NOT in this task
- No implementation of function bodies beyond `throw NotImplemented` (this spec).
- Domain REST/WS server surface (daemon step, later).
- v2 protocol specifics — the abstraction is designed so v2 is an internal change.

## Verify (skeleton step)
- `require('./clients/mesh')` returns { Mesh, ... } without error.
- `node bin/mtmesh.js nodes` dispatches and throws NotImplemented cleanly (proves
  wiring), `mtmesh` with no verb prints generated usage from the verb table.
- Every exported function exists and throws NotImplemented.
