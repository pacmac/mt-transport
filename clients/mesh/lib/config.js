// Config DOMAIN (device settings) — NOT the app config.yaml loader (that is
// settings.js). Owns the device's OWN schema (via the `sch` command, port 260)
// and validates set() against it BEFORE any airtime, so a consumer never sends a
// value the device rejects. mesh-gw's /schema is stock Meshtastic — not this.
// (Bodies: mesh-config phase.)
'use strict';
const { ni } = require('./errors');

class Config {
  constructor(deps) { this.deps = deps; }           // { gw, protocol, timing }
  async schema(node) { return ni('config.schema'); }     // device field table
  async get(node) { return ni('config.get'); }           // current values
  async set(node, patch) { return ni('config.set'); }    // schema-validated, then send
}

module.exports = { Config };
