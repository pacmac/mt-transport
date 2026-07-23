// Timing/pacing — the ONLY code that knows airtime exists. Serialises outbound
// (one in flight; replies carry no request id so correlation is positional),
// device-driven pacing, backpressure, and the NO-BLIND-RETRY policy (most
// commands are not idempotent). All intervals come from settings.timing.
// (Bodies: mesh-transport phase.)
'use strict';
const { ni } = require('./errors');

class Timing {
  constructor(cfg) { this.cfg = cfg; }              // cfg = settings.timing
  // Enqueue an outbound send; resolves when its reply lands (positional). No retry.
  enqueue(fn, opts) { return ni('timing.enqueue'); }
  // Space between sends, from config. Skeleton.
  get spacingMs() { return ni('timing.spacingMs'); }
}

module.exports = { Timing };
