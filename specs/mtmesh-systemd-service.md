---
task: mtmesh-systemd-service
status: IMPLEMENTED + VERIFIED 2026-07-24. mtmesh-service.sh install -> mtmesh.service active + enabled; journalctl shows startup; /health {ok:true,serving:true} via the service; restart-survives; mesh-gw unaffected; CLI coexists (cmd agc still answers); listed by scripts/services.sh.
source_hash:
  clients/mesh/scripts/mtmesh-service.sh: 85ef7755dad68b75cffa1061ac490a47bf2c45d160150cc5c748f5bc08817502
scope:
  - mt-transport/specs/mtmesh-systemd-service.md
  - clients/mesh/scripts/mtmesh-service.sh   # NEW — install|uninstall|status; renders + enables the unit
# NOT changing: the daemon itself (mtmesh listen already works); config.yaml (gateway already configured).
---

# Spec: mtmesh-systemd-service — the mesh listener as a first-class service

## Why
`mtmesh listen` (always-on model + autonomous image catcher + domain `/events`) runs only when
launched by hand. It should be a service like its sibling `mesh-gw` (systemd), independent of
node-dash's PM2. An install SCRIPT (not a static unit) renders absolute paths so it's portable
and re-runnable.

## The unit (rendered by the script into /etc/systemd/system/mtmesh.service)
```
[Unit]
Description=mtmesh — @pac/mesh domain listener (model + image catcher + /events)
After=network.target mesh-gw.service
Wants=mesh-gw.service

[Service]
Type=simple
User=root
WorkingDirectory=<MODULE_DIR>            # clients/mesh — config.yaml + ./payloads resolve here
ExecStartPre=/bin/sleep 3               # let mesh-gw's WS come up first
ExecStart=<NODE> bin/mtmesh.js listen --serve   # read-only HTTP+WS on 127.0.0.1:8787
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mtmesh
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

## clients/mesh/scripts/mtmesh-service.sh (NEW)
```sh
#!/usr/bin/env bash
# Install/manage the mtmesh systemd service. Idempotent: re-run to update the unit.
#   mtmesh-service.sh [install|uninstall|status]   (default: install)
set -euo pipefail
MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # clients/mesh
NODE="$(command -v node)"
UNIT=/etc/systemd/system/mtmesh.service
cmd="${1:-install}"

case "$cmd" in
  install)
    [ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=mtmesh — @pac/mesh domain listener (model + image catcher + /events)
After=network.target mesh-gw.service
Wants=mesh-gw.service

[Service]
Type=simple
User=root
WorkingDirectory=$MODULE_DIR
ExecStartPre=/bin/sleep 3
ExecStart=$NODE bin/mtmesh.js listen --serve
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mtmesh
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNITEOF
    systemctl daemon-reload
    systemctl enable --now mtmesh.service
    systemctl --no-pager --lines=0 status mtmesh.service || true
    echo "installed: $UNIT  (WorkingDirectory=$MODULE_DIR, node=$NODE)"
    ;;
  uninstall)
    systemctl disable --now mtmesh.service || true
    rm -f "$UNIT"; systemctl daemon-reload
    echo "removed: $UNIT" ;;
  status)
    systemctl --no-pager status mtmesh.service ;;
  *) echo "usage: mtmesh-service.sh [install|uninstall|status]"; exit 2 ;;
esac
```

## Observe
1. Static: `ls clients/mesh/scripts/mtmesh-service.sh` (executable); grep the rendered unit for
   WorkingDirectory + ExecStart.
2. Functional: run `install`; `systemctl is-active mtmesh` -> `active`; `journalctl -u mtmesh`
   shows the "mtmesh listening … image listener ON" startup line; `curl -s localhost:8787/health`
   returns JSON. It appears in `scripts/services.sh` output.
3. Regression: restart-survival — `systemctl restart mtmesh` -> active again; mesh-gw untouched
   (still active); a `mtmesh` CLI command still works (shares config, no port clash on 8787).
