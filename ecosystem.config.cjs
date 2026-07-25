// PM2: ONE service.
//
// Replaces the previously ad-hoc `mtmesh listen --serve` and `trial-logger` apps with
// a single host that loads both as modules and publishes one versioned API
// (clients/host/API.md). Consumers connect to it; nothing imports our code, because
// this process is the single owner of the mesh-gw connection, the butler queue and
// the image store — a second copy would mean two butlers commanding the same units.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// Config (paths, gateway, units) lives in clients/host/host.config.json, NOT here.
module.exports = {
  apps: [
    {
      name: 'pac-host',
      script: 'clients/host/bin/pac-host.js',
      cwd: '/usr/share/pac/dev/pio/projects/mt-transport',
      args: '--config clients/host/host.config.json',
      // Every path in host.config.json is absolute, so cwd does not decide where the
      // butler queue, image store or CSVs land. That was the whole cwd hazard.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      // The recorder appends to a daily CSV and the butler holds queued commands for
      // sleeping units; a kill needs time to close the socket and flush.
      kill_timeout: 8000,
      merge_logs: true,
      time: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
