// config.yaml loader. NOTHING is hard-coded in the module: every path and timing
// comes from here. Merge order: DEFAULTS < config.yaml < env(MTMESH_*) < opts(flags).
'use strict';
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// The ONLY place defaults live. A missing config.yaml still yields a usable set.
// Identity (gatewayId) is config, never code — hence null here.
const DEFAULTS = Object.freeze({
  // mesh-gw DIRECT (:8001, raw REST + ws:8001/events, owns all BLE — device-comms.md:53). NEVER
  // :8000/node-dash: mtmesh must NOT depend on their service and must survive node-dash being
  // abandoned. mesh-gw or nothing — if mesh-gw is down, failing is correct; never fall back onto them.
  gw:      { host: 'localhost', port: 8001, sendPort: 8001, eventsPath: '/events', gatewayId: null },
  channel: 2, // never 0
  logLevel: 'info', // silent|error|warn|info|debug|trace ; env MTMESH_LOG overrides. See lib/log.js.
  paths:   { store: './payloads', log: './mtmesh.log' },
  timing:  { sendSpacingMs: 3000, replyTimeoutMs: 20000, wsMaxPayload: 0,
             chunkAnswerMs: 8000, idleMs: 240000, pushDeadlineMs: 900000,
             pushQuietMs: 15000 }, // post-stream quiet wait before PROGRESS_Q; must exceed device max inter-chunk gap (~9s)
  retry:   { commands: false, idempotent: 2, attemptTimeoutMs: 10000 }, // resend known-idempotent domain cmds; per-attempt reply wait
  // Directed PKC DM (to:num, channel 0) is the DEFAULT send; the private channel is the
  // fallback (num unknown / '*' / DM disabled). omitAddress keeps the legacy @<target>
  // text prefix (un-flashed firmware still requires it) — flip true, then remove, once
  // the whole fleet accepts bare-verb DMs.
  dm:      { default: true, fallbackChannel: 2, omitAddress: false },
  // Per-unit interaction mode (live/dev): dev = direct sync command; live = auto-queue via the
  // butler (asleep unit, deliver on wake). units.<id>.mode forces it; else auto (device slp /
  // last-heard silence). silentMs = "not heard this long => assume asleep => live".
  units:   {},
  mode:    { silentMs: 150000 },
  listen:  { autoFetchImages: true, alerts: ['motion', 'fault'] },
  daemon:  { serve: false, host: '127.0.0.1', port: 8787 }, // opt-in read-only domain HTTP+WS surface
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

// Apply a host[:port] gateway override. A single --gw/MTMESH_GW points the WHOLE
// gateway (send AND events) at that port, so a parsed port sets both gw.port and
// gw.sendPort — otherwise events and sends split across ports (found live: WS on
// :8001 but POST on :8000 → every reply timed out). Host-only leaves ports as-is;
// split ports stay expressible via explicit gw.port/gw.sendPort in config.yaml.
function applyGw(cfg, val) {
  const { host, port } = splitHost(val);
  cfg.gw.host = host;
  if (port !== undefined) { cfg.gw.port = port; cfg.gw.sendPort = port; }
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
  if (env.MTMESH_GW) applyGw(cfg, env.MTMESH_GW);
  if (env.MTMESH_GATEWAY_ID) cfg.gw.gatewayId = env.MTMESH_GATEWAY_ID;
  if (env.MTMESH_CHANNEL) cfg.channel = Number(env.MTMESH_CHANNEL);
  if (env.MTMESH_LOG) cfg.logLevel = env.MTMESH_LOG;
  if (env.MTMESH_SERVE) cfg.daemon.serve = env.MTMESH_SERVE !== '0' && env.MTMESH_SERVE !== 'false';
  if (env.MTMESH_SERVE_PORT) cfg.daemon.port = Number(env.MTMESH_SERVE_PORT);
  if (env.MTMESH_DM) cfg.dm.default = env.MTMESH_DM !== '0' && env.MTMESH_DM !== 'false';
  if (env.MTMESH_DM_OMIT) cfg.dm.omitAddress = env.MTMESH_DM_OMIT !== '0' && env.MTMESH_DM_OMIT !== 'false';

  // opts overrides (CLI flags) — undefined ignored
  if (opts.gw !== undefined) applyGw(cfg, opts.gw);
  if (opts.gatewayId !== undefined) cfg.gw.gatewayId = opts.gatewayId;
  if (opts.channel !== undefined && opts.channel !== null) cfg.channel = Number(opts.channel);
  if (opts.logLevel !== undefined) cfg.logLevel = opts.logLevel;
  if (opts.serve !== undefined) cfg.daemon.serve = !!opts.serve;
  if (opts.servePort !== undefined && opts.servePort !== null) cfg.daemon.port = Number(opts.servePort);

  return cfg;
}

// Persist a per-unit mode override to config.yaml (units.<id>.mode). 'auto' clears it.
// Writes to the located file, or the shipped module default if none exists yet.
function setUnitMode(opts, id, mode) {
  const file = find(opts) || path.join(__dirname, '..', 'config.yaml');
  let doc = {};
  try { doc = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* new/empty file */ }
  doc.units = doc.units || {};
  if (mode === 'auto') {
    if (doc.units[id]) { delete doc.units[id].mode; if (!Object.keys(doc.units[id]).length) delete doc.units[id]; }
  } else {
    doc.units[id] = { ...(doc.units[id] || {}), mode };
  }
  fs.writeFileSync(file, YAML.stringify(doc));
  return { id, mode, file };
}

module.exports = { DEFAULTS, load, find, setUnitMode };
