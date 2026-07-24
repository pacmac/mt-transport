// PM2 app definition for trial-logger — whole-mesh packet recorder (mesh-gw /events -> daily CSV
// + missed-heartbeat alerts). Under PM2 so it's one-pane with node-dash + mtmesh. Boot-persistence
// via pm2-root + `pm2 save`. TRIAL_LOG_DIR keeps writing to the existing pac-garage-alarm/data so
// the cutover from the Python service is seamless. See specs/trial-logger-node.md.
module.exports = {
  apps: [
    {
      name: "trial-logger",
      script: "trial-logger.js",
      cwd: "/usr/share/pac/dev/pio/projects/mt-transport/clients/trial-logger",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        TRIAL_LOG_DIR: "/usr/share/pac/dev/pio/projects/pac-garage-alarm/data",
        MESH_GW_EVENTS: "ws://localhost:8001/events",
      },
    },
  ],
};
