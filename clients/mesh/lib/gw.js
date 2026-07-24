// mesh-gw transport. The ONLY code that knows mesh-gw exists. Grounded against
// live docs 2026-07-23 (mesh-gw/docs/API_REST.md + API_SSE.md):
//   SEND    = POST /{gwId}/messages {text, channel, to?, reply_id?} -> {id,to}
//   RECEIVE = WebSocket ws://<host>/events  (NOT SSE — API_SSE.md: "There is no
//             SSE transport"), needs maxPayload:0 (multi-MB device_snapshot trips
//             ws's 1 MB default and closes 1009). private_app -> {portnum,
//             payload_b64}; text -> {data.text, from_num, channel, packet_id}.
//   READS   = GET /{gwId}/nodes , /{gwId}/status ; info() returns the WS snapshot.
// mesh-gw is LIVE — never modify it; this module adapts to it. Nothing here is
// hard-coded: every host/port/path comes from cfg (settings).
'use strict';
const WebSocket = require('ws');
const { MeshError } = require('./errors');
const log = require('./log').log.child('gw');

const BROADCAST = null; // `to` omitted => broadcast (0xFFFFFFFF) at the gateway

class Gateway {
  // cfg = resolved settings; uses cfg.gw.{host,port,sendPort,eventsPath,reconnectMs}
  constructor(cfg) {
    this.cfg = cfg;
    const gw = (cfg && cfg.gw) || {};
    this.host = gw.host;
    this.port = gw.port;
    this.sendPort = gw.sendPort != null ? gw.sendPort : gw.port;
    this.eventsPath = gw.eventsPath || '/events';
    this.reconnectMs = gw.reconnectMs != null ? gw.reconnectMs : 5000;
    this.ws = null;
    this.stopped = false;
    this.handlers = new Set();
    this.snapshot = null;       // last device_snapshot from the event stream
    this._openWaiters = [];
  }

  // Open the event stream. Resolves once the socket is open. Reconnects on close
  // (the gateway sends no keep-alive; it re-sends a fresh snapshot on reconnect).
  async connect() {
    const p = new Promise((res, rej) => this._openWaiters.push({ res, rej }));
    this._open();
    return p;
  }

  _open() {
    if (this.stopped) return;
    // maxPayload:0 is NOT optional — see header.
    const url = `ws://${this.host}:${this.port}${this.eventsPath}`;
    log.debug('connecting', url);
    const ws = new WebSocket(url, { maxPayload: 0 });
    this.ws = ws;
    ws.on('open', () => {
      log.debug('ws open', url);
      const waiters = this._openWaiters; this._openWaiters = [];
      for (const w of waiters) w.res();
    });
    ws.on('message', (raw) => {
      let e;
      try { e = JSON.parse(raw); } catch { log.trace('drop non-JSON ws frame'); return; }
      if (e.type === 'device_snapshot') {
        this.snapshot = e;
        log.debug('snapshot: %d devices', Array.isArray(e.devices) ? e.devices.length : 0);
        return;
      }
      // 'heard' fires on EVERY over-air packet (the butler's window cue), in addition to any
      // typed event — so a unit's heartbeat/wake TX is seen even though we decode none of it.
      const heard = this._heard(e);
      if (heard) for (const h of this.handlers) {
        try { h(heard); } catch (err) { log.warn('event handler threw', err); }
      }
      const norm = this._normalize(e);
      if (norm) for (const h of this.handlers) {
        // A throwing handler must not kill the stream — log and carry on.
        try { h(norm); } catch (err) { log.warn('event handler threw', err); }
      }
    });
    ws.on('close', () => {
      if (this.stopped) return;
      log.info('ws closed; reconnecting in %dms', this.reconnectMs);
      setTimeout(() => this._open(), this.reconnectMs);
    });
    // Surface errors to handlers but never throw into the process. A failed
    // initial connect rejects the connect() promise.
    ws.on('error', (err) => {
      log.error('ws error', err);
      for (const h of this.handlers) { try { h({ kind: 'error', error: err }); } catch (e2) { log.trace('error-handler threw', e2); } }
      const waiters = this._openWaiters; this._openWaiters = [];
      for (const w of waiters) w.rej(err instanceof Error ? err : new Error(String(err)));
    });
  }

  // Register an event handler. Returns an unsubscriber.
  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  // gw stays dumb: it maps mesh-gw envelopes to a small normalized shape and
  // leaves interpretation (protocol/model) to the layers above.
  _normalize(e) {
    if (e.type === 'private_app') {
      return {
        kind: 'app',
        portnum: e.portnum,
        payload: Buffer.from(e.payload_b64 || '', 'base64'),
        from: e.node_id || (e.from_num != null ? String(e.from_num) : null),
        raw: e,
      };
    }
    if (e.type === 'text') {
      return {
        kind: 'text',
        text: e.data && e.data.text,
        from: e.node_id || (e.from_num != null ? String(e.from_num) : null),
        channel: e.channel,
        packetId: e.packet_id,
        replyId: (e.data && e.data.reply_id) != null ? e.data.reply_id : null,
        raw: e,
      };
    }
    if (e.type === 'message_status') {
      return { kind: 'status', packetId: e.packet_id, status: e.status, raw: e };
    }
    return null; // everything else is stock Meshtastic — not our concern here
  }

  // A unit transmitting means its ~10 s RX window is open (the butler's cue). mesh-gw emits one
  // 'packet' event per received packet (alongside any decoded typed event), so this is the
  // universal per-packet signal. Kept dumb: sender + link stats, no payload decode.
  _heard(e) {
    if (e.type !== 'packet') return null;
    const pkt = (e.data && e.data.packet) || {};
    // KEY off packet.from — the ORIGINAL sender. e.node_id is always the relaying/BLE-local node
    // (the gateway), so it would collapse every unit onto one key. Verified live 2026-07-24.
    if (pkt.from == null) return null;
    const dec = pkt.decoded || {};
    return {
      kind: 'heard', from: '!' + (pkt.from >>> 0).toString(16), portnum: dec.portnum || null,
      rssi: pkt.rx_rssi != null ? pkt.rx_rssi : null,
      snr: pkt.rx_snr != null ? pkt.rx_snr : null,
    };
  }

  // Send a text message via the gateway. opts: {channel, to, replyId}.
  //   - text is capped at 228 UTF-8 bytes (API_REST.md).
  //   - BROADCAST (to==null) on channel 0 is REFUSED — PRIMARY is the public mesh
  //     and a broadcast there leaks alarm traffic to every node in range. A
  //     DIRECTED message (to set) is allowed on any channel: a PKC DM legitimately
  //     rides channel 0.
  async sendText(gwId, text, opts = {}) {
    const { channel, to = BROADCAST, replyId = null } = opts;
    if (Buffer.byteLength(text, 'utf8') > 228) {
      throw new MeshError(`text too long: ${Buffer.byteLength(text, 'utf8')} > 228 bytes`, 'ETEXTLEN');
    }
    if (channel == null) {
      throw new MeshError('channel must be given explicitly (never defaulted to 0/PRIMARY)', 'ECHAN0');
    }
    if (to === BROADCAST && channel === 0) {
      throw new MeshError('refusing to broadcast on channel 0 (PRIMARY)', 'ECHAN0');
    }
    const body = { text, channel };
    if (to !== BROADCAST) body.to = to;
    if (replyId != null) body.reply_id = replyId;
    log.debug('send', { gwId, channel, to: to === BROADCAST ? 'bcast' : to, bytes: Buffer.byteLength(text, 'utf8') });
    log.trace('send text', text);
    const r = await fetch(`http://${this.host}:${this.sendPort}/${gwId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { log.warn('gateway send failed: %d', r.status); throw new MeshError(`gateway send failed: ${r.status}`, 'EGWSEND'); }
    return r.json(); // {id, to}
  }

  async nodes(gwId) {
    const r = await fetch(`http://${this.host}:${this.sendPort}/${gwId}/nodes`);
    if (!r.ok) throw new MeshError(`gateway nodes failed: ${r.status}`, 'EGWREAD');
    return r.json();
  }

  async status(gwId) {
    const r = await fetch(`http://${this.host}:${this.sendPort}/${gwId}/status`);
    if (!r.ok) throw new MeshError(`gateway status failed: ${r.status}`, 'EGWREAD');
    return r.json();
  }

  // The authoritative device metadata is the WS device_snapshot, not a REST call
  // (avoids depending on an unverified /info route). Null until connect+snapshot.
  info(_gwId) { return this.snapshot; }
}

module.exports = { Gateway, BROADCAST };
