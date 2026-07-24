#!/usr/bin/env bash
# Install/manage the mtmesh systemd service — the @pac/mesh domain listener (model +
# autonomous image catcher + read-only /events). Sibling of mesh-gw.service; independent of
# node-dash's PM2. Idempotent: re-run install to update the unit. See specs/mtmesh-systemd-service.md
#   mtmesh-service.sh [install|uninstall|status]   (default: install)
set -euo pipefail
MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # clients/mesh
NODE="$(command -v node || true)"
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
