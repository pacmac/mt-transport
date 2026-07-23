// mesh-gw transport. The ONLY code that knows mesh-gw exists. Grounded against
// live OpenAPI 2026-07-23: SEND = POST /{gwId}/messages {text,channel};
// RECEIVE = event stream /events (SSE) -> private_app (260/261) + text;
// reads = GET /nodes /status /{gwId}/info. mesh-gw is LIVE — never modify it.
// (Bodies implemented in mesh-transport phase.)
'use strict';
const { ni } = require('./errors');

class Gateway {
  constructor(cfg) { this.cfg = cfg; }        // cfg from settings (gw host/port/paths)
  async connect() { return ni('gw.connect'); }        // open the event stream
  async close() { return ni('gw.close'); }
  async sendText(gwId, text, channel) { return ni('gw.sendText'); } // POST messages
  onEvent(handler) { return ni('gw.onEvent'); }       // private_app + text events
  async nodes() { return ni('gw.nodes'); }
  async status() { return ni('gw.status'); }
  async info(gwId) { return ni('gw.info'); }
}

module.exports = { Gateway };
