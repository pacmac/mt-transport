'use strict';
// gw.js `from` attribution: the SENDER (from_num), not the relaying gateway (node_id).
const assert = require('assert');
const { Gateway } = require('../lib/gw');
let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const g = new Gateway({ gw: { host: 'x', port: 1, sendPort: 1, eventsPath: '/e', gatewayId: '!g' } });

// Relayed frame: node_id is the gateway, from_num is the real sender (b80f = 0x987ab80f).
ok(g._normalize({ type: 'private_app', portnum: 261, payload_b64: '', node_id: '!2687afb1', from_num: 0x987ab80f }).from === '!987ab80f',
   'private_app: from is the SENDER (from_num), not the relay node_id');
ok(g._normalize({ type: 'text', node_id: '!2687afb1', from_num: 0x987ab80f, data: { text: '{"type":"agc"}' } }).from === '!987ab80f',
   'text: from is the sender, not the relay');

// Gateway-origin frame (from_num == the gateway): unchanged.
ok(g._normalize({ type: 'private_app', portnum: 260, payload_b64: '', node_id: '!2687afb1', from_num: 0x2687afb1 }).from === '!2687afb1',
   'gateway-origin frame attributes to the gateway');

// from_num absent -> fall back to node_id.
ok(g._normalize({ type: 'text', node_id: '!abcd', data: { text: 'x' } }).from === '!abcd',
   'from_num absent -> node_id fallback');

console.log(`gw-from OK: ${pass} assertions passed`);
