// Alert router — event → one or more NOTIFIER TRANSPORTS (pluggable). Transports
// implement send(alert); registered here, selected + routed by config.notify.
// Adding email/whatsapp/etc touches ONLY its own transport file. (Router body +
// console transport: this skeleton; other transports: later phases.)
'use strict';
const { ni } = require('./errors');

// Transport registry: name -> factory(cfg) -> { async send(alert) }.
const TRANSPORTS = {
  console:  require('./transports/console'),
  email:    require('./transports/email'),
  webhook:  require('./transports/webhook'),
  whatsapp: require('./transports/whatsapp'),
};

class Notifier {
  constructor(cfg) { this.cfg = cfg; this._active = new Map(); } // cfg = settings.notify
  // Build enabled transports from config. Skeleton.
  init() { return ni('notify.init'); }
  // Route one alert to its configured transports. Skeleton.
  async route(alert) { return ni('notify.route'); }   // alert = { kind, node, ... }
}

module.exports = { Notifier, TRANSPORTS };
