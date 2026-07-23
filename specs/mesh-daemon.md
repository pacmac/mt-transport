---
task: mesh-daemon
status: IMPLEMENTED + VERIFIED 2026-07-23 (phase 7). daemon 17 offline (lifecycle/error-safety/format/serve http+ws round-trip) green + full regression green. LIVE: mtmesh listen stays up, image listener ON, GET /health /nodes /nodes/:id served real roster+telemetry, WS /events accepts+greets, SIGTERM → clean stop (port released, "daemon stopped"). Live domain-event broadcast link-limited (marginal garage; ping 336b ETIMEOUT) — broadcast path carried by the offline real-socket test.
source_hash: clients/mesh/lib/daemon.js 71a78f14e906b06fd08d93af982702161db0895e4c5b6a195c339542c32a2757; clients/mesh/lib/settings.js b4ebf4c65e6e6a2c13eb578498a58a908418b798941194c4f48338b7f6f6440d; clients/mesh/config.yaml a2b8aa365534d5d5e3c923a377b8905ac6868214b3c40f37e99cd46c38aed67c; clients/mesh/index.js d3d93b45f61395b2c9291bd4bb5fcf0b84ca6a486ea9c4177974b1cacb8103a1; clients/mesh/bin/mtmesh.js 1618e49142a954b1b526b08809ccfcfaece726401df29d994e9310a6c294c5ad; clients/mesh/test/daemon.js 1d0611ef55342b82be776e5b476d1670238b0b188e3a68a61e3b58e3b31755d9
project: mt-transport
scope:
  - specs/mesh-daemon.md
  - clients/mesh/lib/daemon.js       # NEW — the daemon
  - clients/mesh/lib/settings.js     # +daemon{} defaults + opts/env override
  - clients/mesh/config.yaml         # +daemon block
  - clients/mesh/index.js            # export Daemon + listen() convenience
  - clients/mesh/bin/mtmesh.js       # listen verb -> daemon path, --serve/--port, signals
  - clients/mesh/test/daemon.js      # NEW — offline lifecycle + format + serve round-trip
---

# mesh-module phase 7 — `mtmesh listen` daemon

Make the module RUN. Today `mtmesh listen` calls `startImageListener()` and then
`main()` immediately `close()`s and exits — no daemon. This phase turns it into a
long-running process that:

1. holds the live model and the WS event stream open,
2. runs the **autonomous image listener** continuously (this is where "no human
   intervention" becomes always-on — the whole point of mesh-images),
3. streams DOMAIN events to stdout (NDJSON with `--json`, else human lines),
4. optionally serves a **read-only domain HTTP+WS surface** for non-Node
   consumers (`daemon.serve`, default OFF) — the phase-8 cutover enabler,
5. shuts down cleanly on SIGINT/SIGTERM.

Everything mesh (ports/frames/chunks/queues) stays hidden; consumers of the feed
or the HTTP surface see only nodes / replies / images.

## 1. lib/daemon.js — class Daemon
`constructor({ mesh, cfg, log, out })`
- `mesh` — a CONNECTED Mesh (EventEmitter). Injected (testable with a fake).
- `cfg` — resolved settings (`mesh.cfg`); reads `cfg.daemon.{serve,host,port}`.
- `out` — writable for the event feed (default `process.stdout`). stderr stays
  the logger's (log.js); the feed is DATA, so it goes to stdout and honors json.
- `json` — from `cfg` is not where it lives; pass explicitly via opts (bin sets
  it from `--json`). Default false → human lines.

State: `this._subs = []` (unsubscribers), `this._imgStop = null`, `this._server =
null`, `this._wss = null`, `this._clients = new Set()`, `this._startedAt` (ms),
`this._stopped = false`.

### start()
- Subscribe to the domain events and record removers. EVENTS =
  `['node','reply','image-available','image','detection','alert','error']`.
  - `'reply'` carries `(reply, from)` — record `{type:'reply', from, reply}`.
  - `'error'` MUST be subscribed even if we only log it: an unhandled `'error'`
    on an EventEmitter THROWS and would kill the daemon. Record + log.warn.
  - all others carry a single payload object — record `{type, ...payload}`.
  - each handler calls `this._dispatch(record)`.
- `this._imgStop = mesh.startImageListener()` — autonomous catch ON.
- if `cfg.daemon.serve` → `this._startServer()`.
- log.info the mode (feed only / serving host:port), return `this`.

### _dispatch(record)
- stamp `record.t = Date.now()` (Node runtime; fine).
- write to the feed: `out.write((json ? JSON.stringify(record) : this._fmt(record)) + '\n')`.
- broadcast to every live WS client (`_clients`): `ws.send(JSON.stringify(record))`
  inside try/catch (a dead client must not break the loop).
- `_fmt(r)`: one compact human line, e.g.
  `node !8cee336b` · `reply from !8cee336b {ok:1,...}` (JSON-tail, truncated) ·
  `image !8cee336b pid 41910 (12345 bytes) -> <path>`. Never dump `raw`.

### _startServer()  (only when serve)
`http.createServer` handling GET routes (405 otherwise), bound to
`cfg.daemon.host:cfg.daemon.port` (port 0 allowed → ephemeral, for tests):
- `GET /health` → 200 `{ ok:true, uptimeMs, nodes:<liveModelCount>, serving:true }`.
- `GET /nodes` → 200 `await mesh.nodes()` (full roster; async — try/catch → 502
  `{error}`). This is the domain roster, chunk/port-free.
- `GET /nodes/:id` → `await mesh.node(id)` → 200 or 404 `{error:'unknown node'}`.
- unknown path → 404 `{error:'not found'}`.
- JSON body + `Content-Type: application/json` on every response.
Attach a WS server for the live feed: `this._wss = new WebSocketServer({ server,
path:'/events' })`; on `connection` add the socket to `_clients`, greet with
`{type:'hello', t}`, and drop it from `_clients` on close. `server.listen(port,
host)`; expose `address()` → `this._server.address()` (test reads the real port).

### stop()   (idempotent)
- guard `_stopped`; set it.
- run every unsubscriber in `_subs`; clear.
- `if (_imgStop) _imgStop()` (stops the image listener; aborts active receivers).
- close all `_clients` then `_wss.close()` then `_server.close()` (guarded).
- log.info('daemon stopped'). Does NOT close the mesh — the caller (bin) owns the
  Mesh lifecycle and closes it after stop().

Robustness: `start()`/handlers never throw into the process; a handler wraps its
body so one bad event can't kill the feed (mirrors gw.js handler discipline).

## 2. settings.js — daemon defaults + overrides
- DEFAULTS gains: `daemon: { serve: false, host: '127.0.0.1', port: 8787 }`.
- env: `MTMESH_SERVE` (truthy unless '0'/'false' → serve on), `MTMESH_SERVE_PORT`
  (Number → daemon.port).
- opts: `opts.serve` (bool → daemon.serve), `opts.servePort` (Number → daemon.port).
  Undefined ignored, consistent with the rest of load().

## 3. config.yaml — document the block
Append:
```
daemon:
  serve: false          # opt-in read-only domain HTTP+WS surface (mtmesh listen --serve)
  host: 127.0.0.1       # loopback only by default
  port: 8787            # GET /health /nodes /nodes/:id ; WS /events (domain feed)
```

## 4. index.js — export + convenience
- `const { Daemon } = require('./lib/daemon');`
- `listen(opts = {})` method: builds `new Daemon({ mesh:this, cfg:this.cfg,
  log:require('./lib/log').log.child('daemon'), out:opts.out, json:opts.json })`,
  stores `this.daemon`, returns `daemon.start()`. (Library consumers:
  `const mesh = await connect(); mesh.listen();`.) Requires connect() first
  (cfg set) — throws ECONFIG-style if `this.cfg` is null.
- export `Daemon` in module.exports.

## 5. bin/mtmesh.js — daemon path
- `parse()`: add `--serve` to the BOOLEAN flags (like `--json`), so it doesn't
  swallow the next token. `--port N` already parses as a value flag.
- verb table: mark the `listen` entry `daemon: true`, args `'[--serve] [--port N]'`,
  help `'run as a daemon: hold model + autonomous image listener + event feed'`.
- `main()`: when `match.daemon`, take the DAEMON path instead of one-shot:
  - build Mesh with `serve: flags.serve, servePort: flags.port` in opts (flow to
    settings → cfg.daemon), `await m.connect()`.
  - `const d = m.listen({ json: flags.json })`.
  - print a startup line to STDERR: mode + (serving URL if serve) + "Ctrl-C to stop".
  - install SIGINT + SIGTERM → `await d.stop(); await m.close(); process.exit(0)`
    (once; guard against double-fire). Do NOT close on the normal path — the
    process stays alive on the open WS/server.
  - never reach the one-shot `console.log(out)/m.close()`.

## 6. NOT in scope
Notify/alert transports (notify.js still a stub — a later slice), model-full
typing (phase 6), mesh-config (phase 5), any WRITE route on the HTTP surface
(read-only by design — commands still go through the CLI/lib, not an open port).

## 7. Verify (Observe)
Offline `test/daemon.js` (no radio) — fake mesh = EventEmitter + `startImageListener`
(spy returning a stop spy) + async `nodes()/node()` stubs:
1. **Lifecycle/wiring**: `start()` calls startImageListener; emitting `'node'`
   writes a feed line to a captured `out`; `stop()` removes subs (a post-stop
   emit writes nothing) and calls the image-stop spy; `stop()` twice is safe.
2. **error-safety**: emitting `'error'` on the mesh does NOT throw (subscribed).
3. **Format**: json:true → each feed line `JSON.parse`s and has `type` + `t`;
   human mode → non-JSON compact line containing the id.
4. **Serve round-trip** (serve:true, port:0): read `address().port`; `GET /health`
   → 200 `{ok:true}`; `GET /nodes` → the stub roster; open a WS to `/events`,
   emit `'node'` on the mesh, assert the client receives the record; `stop()`
   closes the server (a follow-up connect fails).
5. **Regression**: skeleton still green (listen no longer in pending — it never
   was; `getSchema/getConfig/setConfig/startAlertListener` remain the pending
   set); settings/transport/log/cli-live/images all green; `require('..')` +
   `Daemon` export present.
- **LIVE**: `mtmesh listen` against the real gateway stays up (does not exit),
  logs "image listener ON", and prints a domain line when a node telemetry 260
  arrives; Ctrl-C stops cleanly. `mtmesh listen --serve --port <n>` then
  `curl /health` + `/nodes`. Note results.
