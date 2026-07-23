---
task: mesh-gw-port-override
status: IMPLEMENTED + VERIFIED LIVE 2026-07-23. settings 12 green; env-only MTMESH_GW=:8001 now reaches the device (was timing out).
source_hash: clients/mesh/lib/settings.js 035c67852645c9f328b1ce335bfde466261dd5ec62b3dc9e1a0ba0a5ffc046a3; clients/mesh/test/settings.js a52a1f2bbc12851902f69b6c2bc1ddfd875e5d561087b3d73b66d39b28ddb959
project: mt-transport
scope:
  - specs/mesh-gw-port-override.md
  - clients/mesh/lib/settings.js   # applyGw: host:port override sets port AND sendPort
  - clients/mesh/test/settings.js  # assert both ports move
---

# settings: a host:port override must move BOTH gw.port and gw.sendPort

## Bug (found live 2026-07-23)
`settings.load` applies `--gw` / `MTMESH_GW` via `deepMerge(cfg.gw, splitHost(v))`,
and `splitHost` returns only `{host, port}`. So `gw.sendPort` keeps its file/DEFAULT
value. With `MTMESH_GW=localhost:8001` over the shipped config (sendPort 8000):
events → :8001 (raw mesh-gw), but sends → :8000 (node-dash proxy). The ch-2 command
never reached the device; every reply timed out. (With an explicit `--config`
setting both `port` and `sendPort` to 8001 it worked — and the bench replied.)

## Fix — settings.js
Replace the two `deepMerge(cfg.gw, splitHost(x))` calls (env `MTMESH_GW` and
`opts.gw`) with a helper:
```
function applyGw(cfg, val) {
  const { host, port } = splitHost(val);
  cfg.gw.host = host;
  if (port !== undefined) { cfg.gw.port = port; cfg.gw.sendPort = port; }
}
```
- A `host:port` override points the WHOLE gateway (send + events) at that port —
  the common case (one mesh-gw process serves both).
- A `host`-only override leaves both ports untouched.
- Split ports remain expressible via explicit `gw.port`/`gw.sendPort` in
  config.yaml (only overridden when a `--gw`/env value actually carries a port).

Order unchanged: file < env(MTMESH_GW) < opts.gw.

## Verify
- **Offline** (test/settings.js): `load({gw:'1.2.3.4:9001'})` → `gw.host==='1.2.3.4'
  && gw.port===9001 && gw.sendPort===9001`; `load({gw:'onlyhost'})` → host set,
  ports unchanged from file/DEFAULTS; env `MTMESH_GW=h:7000` → both ports 7000.
  Existing assertions still pass.
- **LIVE**: `MTMESH_GW=localhost:8001 MTMESH_GATEWAY_ID=!2687afb1 MTMESH_CHANNEL=2
  mtmesh ping 336b` now reaches the device (was timing out purely from the port
  split). Marginal link → allow a retry.
