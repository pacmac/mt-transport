'use strict';
// WebSocket subscription to mesh-gw, routing private_app by portnum.
//
// maxPayload:0 is NOT optional — the gateway opens with a multi-MB snapshot
// that trips ws's 1 MB default and closes the socket with 1009.

const WebSocket = require('ws');
const EventEmitter = require('events');

class MeshEvents extends EventEmitter {
  constructor({ host, reconnectMs = 5000 }) {
    super();
    this.host = host;
    this.reconnectMs = reconnectMs;
    this.ws = null;
    this.stopped = false;
  }

  start() {
    if (this.stopped) return;
    this.ws = new WebSocket(`ws://${this.host}/events`, { maxPayload: 0 });
    this.ws.on('open', () => this.emit('open'));
    this.ws.on('message', (raw) => {
      let e;
      try { e = JSON.parse(raw); } catch { return; }
      this.emit('event', e);
      if (e.type === 'private_app') {
        // portnum-keyed so consumers filter without re-parsing
        this.emit(`port:${e.portnum}`, Buffer.from(e.payload_b64 || '', 'base64'), e);
      } else if (e.type === 'text') {
        this.emit('text', e);
      }
    });
    const retry = () => {
      if (this.stopped) return;
      setTimeout(() => this.start(), this.reconnectMs);
    };
    this.ws.on('close', () => { this.emit('close'); retry(); });
    this.ws.on('error', (err) => { this.emit('wserror', err); });
  }

  stop() { this.stopped = true; if (this.ws) this.ws.close(); }
}

module.exports = { MeshEvents };
