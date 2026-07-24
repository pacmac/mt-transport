---
task: mesh-gw-not-node-dash
status: IMPLEMENTED + VERIFIED 2026-07-24. settings.js default + config.yaml -> :8001 (mesh-gw). Full suite GREEN (test/settings.js 2 assertions 8000->8001). Daemon LIVE on :8001: /health {nodes:14,serving:true}, pong round-trips correlate through mesh-gw events. No node-dash dependency; survives node-dash being abandoned.
source_hash:
  clients/mesh/lib/settings.js: cabeac802e957bc604118803f4f4b3c714e273ae7a41cda2104f2026ef9af425
  clients/mesh/test/settings.js: 7508d75a4d790fc2bf4ae2e68b52f838cc282766eee97a919df92bd0a7dee22a
scope:
  - clients/mesh/specs/mesh-gw-not-node-dash.md
  - clients/mesh/lib/settings.js   # DEFAULTS.gw port/sendPort 8000 -> 8001
  - clients/mesh/test/settings.js   # RIPPLE: 2 assertions hardcoded the old 8000 default -> 8001
  - clients/mesh/config.yaml        # (fixed live to 8001; runtime config, not hashed)
# NOT changing: gw.js (endpoint comes from cfg), any behaviour — only the endpoint number + the reason.
---

# Spec: mesh-gw-not-node-dash — direct to mesh-gw, never node-dash

## The violation
The butler was reaching the mesh via **node-dash :8000** — both the live `config.yaml` (`gw.port:8000`)
and the code **default** in `settings.js` (`DEFAULTS.gw = {port:8000, sendPort:8000}`). Per the design
(`device-comms.md:53`) mesh-gw is **:8001** (raw REST + `ws:8001/events`, owns ALL BLE); node-dash
:8000 is a *dashboard/proxy*. Depending on it is forbidden: **node-dash may consume our libs; we must
never depend on their service.** The hardcoded 8000 default is a hidden dependency — abandon node-dash
and mtmesh silently dies falling back onto a service that's gone.

Node-dash does NOT even proxy all feeds transparently — it re-labels some (mesh-gw `private_app`/
telemetry → node-dash `device_data`/`telemetry_update`) and `message_status`/`device_snapshot`
forwarding is unverified. So "mesh-gw or nothing" is also *correctness*, not just hygiene.

## Change
- `settings.js` `DEFAULTS.gw`: `port 8000 -> 8001`, `sendPort 8000 -> 8001` (+ comment: never node-dash).
- `config.yaml` `gw.port`/`sendPort`: `8000 -> 8001` (done live 2026-07-24; comment records why).

mesh-gw on :8001 serves both the send REST (`POST /{gw}/messages` → HTTP 400 on empty body = route
present) and `ws:8001/events`. trial-logger already uses `:8001` (correct); mtmesh was the outlier.

## Observe
1. Static: `grep` settings.js + config.yaml show `8001`, no `8000` in the gw block.
2. Functional (done): mtmesh restarted on :8001; direct b80f ping round-tripped in 4.5 s via mesh-gw
   (`{pong,rssi:-126,snr:-17.2}`) — send + receive both work with node-dash out of the path.
3. Regression: full mesh test suite green (settings.js default change must not trip an assertion).
4. Independence: with node-dash stopped, mtmesh still functions (mesh-gw owns the BLE); if mesh-gw is
   down, mtmesh fails — correct, never silently on node-dash.
