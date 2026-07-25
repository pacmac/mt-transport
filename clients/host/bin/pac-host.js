#!/usr/bin/env node
// pac-host entry point — the single PM2 app.
//
// Deliberately thin: it resolves config, builds a logger, registers the modules and
// starts the Host. All domain behaviour lives in the modules; all transport lives in
// index.js. Modules are registered here and nowhere else, so "what does this service
// expose?" has exactly one answer.
'use strict';
const fs = require('fs');
const path = require('path');
const { Host } = require('../index');

// Config: --config <file> | PAC_HOST_CONFIG | ./host.config.json | shipped default.
// Resolution happens HERE, in the entry point — never inside a module. A module is
// handed its slice and must not read the filesystem, or it would resolve differently
// depending on the host's cwd (the exact bug @pac/mesh has today).
function loadConfig(argv) {
  const i = argv.indexOf('--config');
  const candidates = [
    i >= 0 ? argv[i + 1] : null,
    process.env.PAC_HOST_CONFIG,
    path.join(process.cwd(), 'host.config.json'),
    path.join(__dirname, '..', 'host.config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        const cfg = JSON.parse(fs.readFileSync(c, 'utf8'));
        cfg.__source = c;
        return cfg;
      }
    } catch { /* try the next candidate */ }
  }
  return { __source: '(defaults)' };
}

// PM2 captures stdout/stderr, so a plain console logger is the right sink here.
function makeLogger(level) {
  const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };
  const want = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
  const at = (name, n, stream) => (...a) =>
    (n <= want) && stream(`${new Date().toISOString()} ${name.toUpperCase()} ${fmt(a)}`);
  const fmt = (a) => {
    const [first, ...rest] = a;
    let i = 0;
    const s = String(first).replace(/%[sdj]/g, (m) => {
      const v = rest[i++];
      return m === '%j' ? JSON.stringify(v) : String(v);
    });
    return rest.slice(i).length ? `${s} ${rest.slice(i).map(String).join(' ')}` : s;
  };
  const out = (s) => process.stdout.write(s + '\n');
  const err = (s) => process.stderr.write(s + '\n');
  return {
    error: at('error', 0, err), warn: at('warn', 1, err),
    info: at('info', 2, out), debug: at('debug', 3, out),
  };
}

async function main() {
  const config = loadConfig(process.argv);
  const log = makeLogger(config.logLevel);
  log.info('config: %s', config.__source);

  const host = new Host({ config, log });

  // ---- module registry — the ONE place the service's surface is declared ----
  // (mesh + recorder are wired in the next steps of specs/single-service-host.md.)
  for (const spec of config.modules ? Object.keys(config.modules) : []) {
    const entry = config.modules[spec] || {};
    if (entry.enabled === false) { log.info('module %s disabled by config', spec); continue; }
    if (!entry.require) continue;         // config-only section, nothing to load yet
    try {
      host.register(require(entry.require));
    } catch (e) {
      // A module that cannot even be LOADED must not stop the service starting —
      // same rule as one that fails to start.
      log.warn('module %s could not be loaded (%s): %s', spec, entry.require, e && e.message);
    }
  }

  await host.start();

  const shutdown = async (sig) => {
    log.info('%s — shutting down', sig);
    try { await host.stop(); } catch (e) { log.warn('stop failed: %s', e && e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`host failed to start: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
