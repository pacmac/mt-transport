---
task: mtmesh-pm2
status: IMPLEMENTED + VERIFIED 2026-07-24. systemd unit removed; pm2 start ecosystem + pm2 save; mtmesh ONLINE, /health {ok:true,serving:true}, pm2 restart survives; node-dash + mesh-gw untouched; CLI answers; services.sh lists mtmesh under PM2. (Bonus: pm2 list also surfaced a previously-invisible timelapse-pull process.)
source_hash:
  clients/mesh/ecosystem.config.cjs: bb84a562b5b91132dd614638c66e7e593ca537bb582c3aef7bcbd9bae86c1654
  clients/mesh/scripts/mtmesh-service.sh: cc28c9e801a44784932fcf0e301f65037edffdf02ec2f940954317b1c062bc05
scope:
  - mt-transport/specs/mtmesh-pm2.md
  - clients/mesh/ecosystem.config.cjs        # NEW — PM2 app def (matches node-dash's ecosystem)
  - clients/mesh/scripts/mtmesh-service.sh    # REPURPOSE systemd installer -> thin PM2 helper (or remove)
# Runtime (not files): remove /etc/systemd/system/mtmesh.service; pm2 start + pm2 save.
# NOT changing: the daemon; config.yaml. mesh-gw stays systemd (mt-radar + bluetooth ordering);
#   trial-logger's fate is Peter's (not migrated here).
---

# Spec: mtmesh-pm2 — the listener under PM2, not systemd

## Why
Supersedes mtmesh-systemd-service (d711001). PM2 gives one-pane visibility/management alongside
node-dash (which is already PM2). Boot-persistence is already set up (pm2-root startup enabled +
/root/.pm2/dump.pm2), so `pm2 save` makes it survive reboot — no systemd unit needed.

## clients/mesh/ecosystem.config.cjs (NEW — mirrors node-dash's ecosystem.config.cjs)
```js
module.exports = {
  apps: [
    {
      name: "mtmesh",
      script: "bin/mtmesh.js",
      args: "listen --serve",                 // read-only HTTP+WS on 127.0.0.1:8787
      cwd: "/usr/share/pac/dev/pio/projects/mt-transport/clients/mesh", // config.yaml + ./payloads
      interpreter: "node",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 10,
      // NO watch: a mesh listener must not restart mid image-transfer on a file edit.
    },
  ],
};
```

## clients/mesh/scripts/mtmesh-service.sh — repurpose systemd installer -> PM2 helper
```sh
#!/usr/bin/env bash
# Manage the mtmesh PM2 app. Boot-persistence via pm2-root (already configured); `pm2 save`
# after start/stop so a reboot restores state.  mtmesh-service.sh [install|uninstall|status]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-install}" in
  install)   pm2 start "$DIR/ecosystem.config.cjs" && pm2 save; pm2 describe mtmesh | grep -E "status|script|exec cwd" ;;
  uninstall) pm2 delete mtmesh || true; pm2 save ;;
  status)    pm2 describe mtmesh ;;
  *) echo "usage: mtmesh-service.sh [install|uninstall|status]"; exit 2 ;;
esac
```

## Migrate (runtime)
1. Remove systemd: `systemctl disable --now mtmesh.service; rm /etc/systemd/system/mtmesh.service; systemctl daemon-reload`.
2. `pm2 start clients/mesh/ecosystem.config.cjs && pm2 save`.

## Observe
1. Static: ecosystem.config.cjs present; the systemd unit file gone (`ls /etc/systemd/system/mtmesh.service` -> absent).
2. Functional: `pm2 describe mtmesh` -> online; `curl -s localhost:8787/health` -> {ok:true,serving:true};
   `pm2 restart mtmesh` -> online again; `scripts/services.sh` lists mtmesh under PM2 (not systemd).
3. Regression: node-dash still online; mesh-gw still active (systemd, untouched); a `mtmesh` CLI cmd still answers.
