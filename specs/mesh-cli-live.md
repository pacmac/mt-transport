---
task: mesh-cli-live
status: IMPLEMENTED + VERIFIED 2026-07-23. Offline suites green (settings 10, cli-live 14); live smoke DEFERRED (gw busy, /{gwId}/nodes shape unverified).
source_hash: clients/mesh/index.js 6d43476c7870592f414006bcd06c0bc1dde4567102f7ff4c6cd4d0088d873071; clients/mesh/lib/settings.js 56a2df1f2ccf03ffd033803b0cef66b5f36cc3ce40b47103d5191dbe9d5a30ce; clients/mesh/lib/model.js 42119038e1f431458acccfb80370e188f76cb638820d564232410e45c1723d67; clients/mesh/config.yaml 871658d9176e143a3b5be0c4e498fb6f67ab5abf4c4019af630dc32c346bebe7; clients/mesh/bin/mtmesh.js ffc1fdc0e15b6f98f6a96176168d4f46cde96b46ee906b1b0a481cf80600eb21; clients/mesh/test/skeleton.js fb33dbd8fb03096deae6ae364641dbc4a14eb65dc0d378f5ab5bf364d783d568; clients/mesh/test/settings.js d4bd686b7b6a251889f60c82a6b43e509a65ab7c4a64d715a2f909536471428c; clients/mesh/test/cli-live.js e353bfbddd491e6507ccfc21a3c2506b953a6d625a96537bd1d9237c0f3bf7fb
project: mt-transport
scope:
  - specs/mesh-cli-live.md
  - clients/mesh/index.js          # Mesh.connect/close, command/ping/status, nodes/node, event wiring
  - clients/mesh/lib/settings.js   # implement load()/find()
  - clients/mesh/lib/model.js      # basic node model (apply/nodes/node)
  - clients/mesh/config.yaml       # gw.gatewayId (config, not code)
  - clients/mesh/bin/mtmesh.js     # --log passthrough (dispatch already exists)
  - clients/mesh/test/settings.js  # NEW — config resolution/merge
  - clients/mesh/test/cli-live.js  # NEW — model + command path via mock gateway
  - clients/mesh/test/skeleton.js  # UPDATE — split implemented vs still-NotImplemented
---

# mesh-module phase 3 — first live vertical (the usable tool)

Turn the wired-but-empty core into a working CLI for ping/status/nodes. This is
the dogfood milestone: it retires our ad-hoc curl. Everything sits on the already
proven+logged transport (gw/protocol/timing) and settings loader.

## settings.js — load()/find() (config resolution)
Merge order: **DEFAULTS < config.yaml < env(MTMESH_*) < opts(flags)**. Nothing
hard-coded beyond DEFAULTS.
- `find(opts)` → path|null. Order: `opts.configPath` → `process.env.MTMESH_CONFIG`
  → `./config.yaml` (cwd) → the shipped `clients/mesh/config.yaml` (module dir).
  First existing wins.
- `load(opts={})` → merged cfg object.
  1. deep-copy DEFAULTS (JSON round-trip — cfg is plain data).
  2. if `find()` resolves, parse YAML (`require('yaml')`) and deep-merge over it.
  3. env overrides (small, documented set):
     `MTMESH_GW`→gw.host (accepts `host` or `host:port`, split on last `:`),
     `MTMESH_GATEWAY_ID`→gw.gatewayId, `MTMESH_CHANNEL`→channel (Number),
     `MTMESH_LOG`→logLevel.
  4. opts overrides (from CLI flags): `opts.gw`→gw.host(/:port),
     `opts.gatewayId`→gw.gatewayId, `opts.channel`(Number)→channel,
     `opts.logLevel`→logLevel. Undefined opts are ignored (never clobber with undefined).
- deep-merge = plain-object recursive; arrays/scalars replace.
- DEFAULTS gains `gw.gatewayId: null` (identity is config, not code).

## config.yaml — the gateway identity
Add under `gw:` a `gatewayId` **placeholder** (commented real value), plus a note.
The module ships localhost defaults; the operator sets host + gatewayId (or uses a
gitignored `config.local.yaml`). Do NOT commit a guessed live endpoint.
```yaml
gw:
  host: localhost
  port: 8000
  sendPort: 8000
  eventsPath: /events
  gatewayId: null      # REQUIRED for send — the BLE gateway node, e.g. "!2687afb1" (OMNI, channel 2)
```

## index.js — Mesh wiring
- `constructor(opts)` unchanged (stores opts).
- `async connect()`:
  - `this.cfg = settings.load(this.opts)`.
  - `require('./lib/log').log.setLevel(this.cfg.logLevel)`.
  - `this.gwId = this.cfg.gw.gatewayId`; if falsy → `throw MeshError('gw.gatewayId not configured — set it in config.yaml','ECONFIG')`.
  - `this.channel = this.cfg.channel` (settings already forbids 0 for broadcast at send time).
  - `this.gw = new Gateway(this.cfg)`; `this.timing = new Timing(this.cfg.timing)`;
    `this.model = new Model()`.
  - `this.gw.onEvent((ev) => this._onEvent(ev))`.
  - `await this.gw.connect()`.
- `_onEvent(ev)`:
  - `ev.kind==='text'`: `const reply = protocol.parseReply(ev.text)`; if reply →
    `this.timing.onReply(reply)` AND `this.emit('reply', reply, ev.from)`. (A
    non-JSON text is not ours — ignore.)
  - `ev.kind==='app' && ev.portnum===260`: `const obj = protocol.parse260(ev.payload)`;
    `this.model.apply({ from: ev.from, obj })`; `this.emit('node', this.model.node(ev.from))`.
  - else: ignore (status/error already logged in gw).
- `async close()` → `await this.gw.close()`.
- commands (all return the correlated reply object):
  - `command(node, verb, args=[])`:
    ```
    const text = protocol.buildCommand(node, verb, Array.isArray(args) ? args : (args===''||args==null?[]:[args]));
    return this.timing.enqueue(
      () => this.gw.sendText(this.gwId, text, { channel: this.channel }),
      { match: (r) => r && typeof r === 'object', dedupKey: `${node}|${verb}|${text}` });
    ```
    (Broadcast on the private channel; the device filters by `@target`. `to` is
    omitted — a directed PKC DM is a later concern; ch2 broadcast is the deployed path.)
  - `ping(node)` → `this.command(node, 'ping')`.
  - `status(node, domain)` → `this.command(node, 'status', domain ? [domain] : [])`.
- reads (async, gateway REST):
  - `async nodes()` → `const j = await this.gw.nodes(this.gwId); return this._summaries(j)`.
  - `async node(id)` → `(await this.nodes()).find((n) => n.id === id || n.num === id) || null`.
  - `_summaries(j)`: mesh-gw `/{gwId}/nodes` shape is **unverified live** (gw busy).
    Normalize DEFENSIVELY: accept an array or `{nodes:[...]}`; per entry emit
    `{ id: e.node_id||e.id||('!'+ (e.num>>>0).toString(16)), num: e.num??e.from_num,
       name: e.long_name||e.user?.long_name||e.short_name||null, raw: e }`.
    Firm the mapping once verified against the live gateway.

## model.js — basic live model
```
constructor() { this._nodes = new Map(); }
apply({from, obj}) {                      // from = node id string; obj = parsed 260
  if (!from) return;
  const prev = this._nodes.get(from) || { id: from };
  this._nodes.set(from, { ...prev, id: from, last: obj, ts: Date.now() });
}
nodes() { return [...this._nodes.values()]; }
node(id) { return this._nodes.get(id) || null; }
```
(`Date.now()` is fine here — this is the Node runtime, not a Workflow script. The
full no-I/O typed model is phase 6; this is enough to hold live 260 telemetry for
the daemon and tests.)

## bin/mtmesh.js — CLI passthrough
Already dispatches nodes/status/ping and awaits the async API. Add `--log`:
pass `logLevel: flags.log` into `new Mesh({...})`. Nothing else changes; usage is
still generated from the verb table.

## NOT in this phase
- images/config/notify bodies (their own phases); `listImages`/`getImage`/
  `getSchema`/`getConfig`/`setConfig`/`startImageListener`/`startAlertListener`
  stay NotImplemented.
- daemon serving (`listen` still just calls startImageListener → NotImplemented).
- Directed PKC DMs; full typed no-I/O model (phase 6).

## Verify (Observe)
- **test/settings.js** (offline): DEFAULTS present; a temp config.yaml overrides;
  env overrides file; opts override env; `host:port` split; undefined opts don't
  clobber; find() precedence (opts>env>cwd).
- **test/cli-live.js** (offline, MOCK gateway — no radio): inject a fake Gateway
  that records `sendText(gwId,text,opts)` and exposes an `emit(ev)` to feed the
  wired handler.
  - `ping('336b')` sends `@336b ping` on the configured channel; driving a text
    event `{"ok":1}` resolves the call with that object.
  - `status('336b','mem')` sends `@336b status mem`.
  - a 260 app event updates `model.node(from).last`; `model.nodes()` lists it.
  - dedup: two identical in-flight pings return the same promise (timing).
  - connect throws ECONFIG when gatewayId is null.
- **Regression**: `test/skeleton.js` updated — implemented methods
  (connect/close/nodes/node/command/ping/status) asserted to be functions that do
  NOT throw NotImplemented; the still-pending 7 asserted to throw NotImplemented.
  `test/transport.js` 31 + `test/log.js` 11 still green. `require('..')` clean;
  `mtmesh` no-verb prints usage.
- **Live smoke**: `DEFERRED` — gateway busy with the field pull and `/{gwId}/nodes`
  shape unverified. When free: set gw.host+gatewayId, `mtmesh ping <target>` returns
  a JSON reply; `mtmesh nodes --json` lists the roster; firm `_summaries`.
