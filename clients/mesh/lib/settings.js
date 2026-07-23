// config.yaml loader. NOTHING is hard-coded in the module: every path and timing
// comes from here. Merge order: DEFAULTS < config.yaml < env < CLI flags.
// (Loader body implemented in a later phase; this is the skeleton contract.)
'use strict';
const { ni } = require('./errors');

// The ONLY place defaults live. A missing config.yaml still yields a usable set.
const DEFAULTS = Object.freeze({
  gw:      { host: 'localhost', port: 8000, sendPort: 8000, eventsPath: '/events' },
  channel: 2, // never 0
  paths:   { store: './payloads', log: './mtmesh.log' },
  timing:  { sendSpacingMs: 3000, replyTimeoutMs: 20000, wsMaxPayload: 0,
             chunkAnswerMs: 8000, idleMs: 240000, pushDeadlineMs: 900000 },
  retry:   { commands: false },
  listen:  { autoFetchImages: true, alerts: ['motion', 'fault'] },
  notify:  { transports: { console: { enabled: true } }, routes: {} },
});

// Resolve config from file/env/flags. Skeleton: not implemented.
// @param {object} [opts] { configPath, env, flags }
// @returns {object} merged config
function load(opts) { return ni('settings.load'); }

// Locate config.yaml (--config / env MTMESH_CONFIG / cwd). Skeleton.
function find(opts) { return ni('settings.find'); }

module.exports = { DEFAULTS, load, find };
