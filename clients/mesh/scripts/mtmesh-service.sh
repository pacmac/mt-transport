#!/usr/bin/env bash
# Manage the mtmesh PM2 app — the @pac/mesh domain listener (model + image catcher + /events).
# Under PM2 (not systemd) for one-pane management with node-dash. Boot-persistence is via
# pm2-root (already configured); `pm2 save` after start/stop so a reboot restores state.
#   mtmesh-service.sh [install|uninstall|status]   (default: install)
# See specs/mtmesh-pm2.md.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # clients/mesh
case "${1:-install}" in
  install)
    pm2 start "$DIR/ecosystem.config.cjs" && pm2 save
    pm2 describe mtmesh | grep -E "status|script path|exec cwd" || true ;;
  uninstall)
    pm2 delete mtmesh || true; pm2 save ;;
  status)
    pm2 describe mtmesh ;;
  *) echo "usage: mtmesh-service.sh [install|uninstall|status]"; exit 2 ;;
esac
