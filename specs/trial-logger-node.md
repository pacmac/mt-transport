---
task: trial-logger-node
status: IMPLEMENTED + VERIFIED 2026-07-24. Python systemd retired; Node under PM2 (online). LIVE (node-written rows in pac-garage-alarm/data/mesh-20260724.csv, exact python column layout): device_metrics vbat_v=4.217/batt=100/uptime=26489 AND environment_metrics temp=26.91/rh=38.5. NODEINFO long_name path identical+verified (lands next nodeinfo). services.sh: systemd=mesh-gw only, PM2=mtmesh+node-dash+trial-logger. mesh-gw/node-dash/mtmesh all up.
source_hash:
  clients/trial-logger/trial-logger.js: 6526b9df6ffdbbd3457ce3a440fb7fcf5ddc337f7f935a52bf166b3e952182ac
  clients/trial-logger/meshtastic.proto: 6c4784c9c0344a6fcb24000292d679f5a1d64241fd74f17324d9e33d7f5a9cfa
  clients/trial-logger/ecosystem.config.cjs: af964fe85bc80c4c4e14c17bd94e6b330724cccbbeae5236d98a90f5f0181f70
  clients/trial-logger/package.json: 3fbfda6daeeeea7d6442c0ba3773d985305e246f549bc393f3b3e36c4f04d1a1
scope:
  - mt-transport/specs/trial-logger-node.md
  - clients/trial-logger/package.json          # NEW — deps: ws, protobufjs
  - clients/trial-logger/meshtastic.proto      # NEW — minimal proto (verified field numbers)
  - clients/trial-logger/trial-logger.js       # NEW — the port
  - clients/trial-logger/ecosystem.config.cjs  # NEW — PM2 app (TRIAL_LOG_DIR -> pac-garage-alarm/data)
  - clients/trial-logger/.gitignore            # NEW — node_modules/, data/
# Runtime: remove trial-logger.service (systemd); pm2 start + save. NOT changing the Python file
#   (left in place, superseded) or pac-garage-alarm/data (Node writes there for a seamless cutover).
---

# Spec: trial-logger-node — the whole-mesh recorder in Node + PM2

## Why
Everything under one supervisor (PM2). Faithful 1:1 port of trial_logger.py — SAME 19 CSV columns,
same per-packet-per-receiver rows, same liveness alerts — kept whole-mesh raw (NOT merged into
mtmesh). mesh-gw /events hands out `decoded = {portnum, payload}` only (verified live), so the port
decodes the raw payload itself, exactly like the Python.

## Protobuf (protobufjs + minimal meshtastic.proto — field numbers verified vs the real proto)
```proto
syntax = "proto3";
message DeviceMetrics      { optional uint32 battery_level = 1; optional float voltage = 2; optional uint32 uptime_seconds = 5; }
message EnvironmentMetrics  { optional float temperature = 1; optional float relative_humidity = 2; }
message Telemetry           { fixed32 time = 1; oneof variant { DeviceMetrics device_metrics = 2; EnvironmentMetrics environment_metrics = 3; } }
message User                { string id = 1; string long_name = 2; }
```
(Unlisted variants/fields on the wire are skipped as unknown — matches the Python handling only
device_metrics/environment_metrics/long_name; TEXT + DETECTION payloads are raw UTF-8, no protobuf.)

## trial-logger.js — 1:1 with the Python
- WS connect `ws://localhost:8001/events` (env MESH_GW_EVENTS), reconnect on close/error after 5s.
- On each `{type:'packet'}`: build a row from the ALREADY-JSON envelope (from/to/id hex, channel,
  portnum, rx_rssi, rx_snr, hop_limit, hop_start, relay_node), decode the payload for TELEMETRY
  (vbat_v/batt_pct/uptime_s or temp_c/rh_pct), NODEINFO (long_name), TEXT/DETECTION (text). Append
  to `mesh-YYYYMMDD.csv` (header on first write). Update per-node liveness.
- Liveness: same as Python — track last-seen + last-20 gaps per from_id; SILENT alert when
  now-last > max(300, 5*median(gaps)) with >=3 gaps; BACK alert on return; append to alerts.log.
- Idle: WS has no recv-timeout hook, so run `checkSilences()` on a 30s interval (matches the
  Python's post-recv/timeout cadence).
- Rounding: vbat 3dp, temp 2dp, rh 1dp (match Python).

## ecosystem.config.cjs (PM2, matches node-dash + mtmesh)
```js
module.exports = { apps: [{
  name: "trial-logger", script: "trial-logger.js",
  cwd: "/usr/share/pac/dev/pio/projects/mt-transport/clients/trial-logger",
  interpreter: "node", autorestart: true, restart_delay: 5000, max_restarts: 10,
  env: { TRIAL_LOG_DIR: "/usr/share/pac/dev/pio/projects/pac-garage-alarm/data" }, // seamless cutover
}]};
```

## Migrate (runtime)
1. `pnpm install` in clients/trial-logger (ws + protobufjs).
2. Remove systemd: `systemctl disable --now trial-logger.service; rm /etc/systemd/system/trial-logger.service; systemctl daemon-reload`.
3. `pm2 start ecosystem.config.cjs && pm2 save`.

## Observe
1. Static: files present; systemd unit gone.
2. Functional: `pm2 describe trial-logger` -> online; a fresh row appears in today's
   `pac-garage-alarm/data/mesh-YYYYMMDD.csv` with a **decoded** telemetry (temp_c/vbat_v) and a
   NODEINFO long_name — byte-shape identical to the Python's columns. Compare a Node-written row
   to a Python-written one from earlier today.
3. Regression: node-dash + mtmesh + mesh-gw all still up; `scripts/services.sh` lists trial-logger
   under PM2 (systemd now only mesh-gw).
