// config.yaml loader. NOTHING is hard-coded in the module: every path and timing
// comes from here. Merge order: DEFAULTS < config.yaml < env(MTMESH_*) < opts(flags).
'use strict';
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// The ONLY place defaults live. A missing config.yaml still yields a usable set.
// Identity (gatewayId) is config, never code — hence null here.
const DEFAULTS = Object.freeze({
  gw:      { host: 'localhost', port: 8000, sendPort: 8000, eventsPath: '/events', gatewayId: null },
  channel: 2, // never 0
  logLevel: 'info', // silent|error|warn|info|debug|trace ; env MTMESH_LOG overrides. See lib/log.js.
  paths:   { store: './payloads', log: './mtmesh.log' },
  timing:  { sendSpacingMs: 3000, replyTimeoutMs: 20000, wsMaxPayload: 0,
             chunkAnswerMs: 8000, idleMs: 240000, pushDeadlineMs: 900000 },
  retry:   { commands: false },
  listen:  { autoFetchImages: true, alerts: ['motion', 'fault'] },
  notify:  { transports: { console: { enabled: true } }, routes: {} },
});

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Recursive merge of plain objects; arrays and scalars in `src` replace `dst`.
function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (sv === undefined) continue; // never clobber with undefined
    if (isPlainObject(sv) && isPlainObject(dst[k])) deepMerge(dst[k], sv);
    else dst[k] = isPlainObject(sv) ? deepMerge({}, sv) : sv;
  }
  return dst;
}

// Split a "host" or "host:port" string into { host, port? }.
function splitHost(s) {
  const str = String(s);
  const i = str.lastIndexOf(':');
  if (i <= 0) return { host: str };
  const port = Number(str.slice(i + 1));
  return Number.isFinite(port) ? { host: str.slice(0, i), port } : { host: str };
}

// Locate config.yaml: --config / env MTMESH_CONFIG / cwd / shipped module default.
// First existing wins; returns null if none exist.
function find(opts = {}) {
  const candidates = [
    opts.configPath,
    process.env.MTMESH_CONFIG,
    path.join(process.cwd(), 'config.yaml'),
    path.join(__dirname, '..', 'config.yaml'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not there */ }
  }
  return null;
}

// Resolve config from DEFAULTS < file < env < opts.
function load(opts = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS)); // deep copy (plain data)

  const file = find(opts);
  if (file) {
    let parsed;
    try { parsed = YAML.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`config.yaml parse error (${file}): ${e.message}`); }
    if (isPlainObject(parsed)) deepMerge(cfg, parsed);
  }

  // env overrides (small, documented set)
  const env = process.env;
  if (env.MTMESH_GW) deepMerge(cfg.gw, splitHost(env.MTMESH_GW));
  if (env.MTMESH_GATEWAY_ID) cfg.gw.gatewayId = env.MTMESH_GATEWAY_ID;
  if (env.MTMESH_CHANNEL) cfg.channel = Number(env.MTMESH_CHANNEL);
  if (env.MTMESH_LOG) cfg.logLevel = env.MTMESH_LOG;

  // opts overrides (CLI flags) — undefined ignored
  if (opts.gw !== undefined) deepMerge(cfg.gw, splitHost(opts.gw));
  if (opts.gatewayId !== undefined) cfg.gw.gatewayId = opts.gatewayId;
  if (opts.channel !== undefined && opts.channel !== null) cfg.channel = Number(opts.channel);
  if (opts.logLevel !== undefined) cfg.logLevel = opts.logLevel;

  return cfg;
}

module.exports = { DEFAULTS, load, find };
