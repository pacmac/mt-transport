// PM2 app definition for the mtmesh listener — the @pac/mesh domain listener (model +
// autonomous image catcher + read-only HTTP+WS on 127.0.0.1:8787). Managed under PM2 (not
// systemd) so it's one-pane with node-dash. Boot-persistence via pm2-root + `pm2 save`.
// Mirrors mt-radar/node-dash/ecosystem.config.cjs. See specs/mtmesh-pm2.md.
module.exports = {
  apps: [
    {
      name: "mtmesh",
      script: "bin/mtmesh.js",
      args: "listen --serve",
      cwd: "/usr/share/pac/dev/pio/projects/mt-transport/clients/mesh", // config.yaml + ./payloads resolve here
      interpreter: "node",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 10,
      // NO watch: a mesh listener must not restart mid image-transfer on a source edit.
    },
  ],
};
