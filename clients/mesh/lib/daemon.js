// The daemon: makes the module RUN. `mtmesh listen` (or lib `mesh.listen()`) holds
// the model + WS stream open, runs the AUTONOMOUS image listener continuously
// (this is where mesh-images' "no human intervention" becomes always-on), and
// streams DOMAIN events. Optionally serves a read-only domain HTTP+WS surface for
// non-Node consumers (daemon.serve, default off) — the phase-8 cutover enabler.
//
// Nothing mesh leaks: the feed and the HTTP surface carry only nodes / replies /
// images. The daemon does NOT own the Mesh lifecycle — the caller closes it after
// stop(). All mesh mechanics stay below in the Mesh/gw/protocol layers.
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

// Events the Mesh surfaces. 'error' MUST be here: an unhandled 'error' on an
// EventEmitter throws and would kill the daemon.
const EVENTS = ['node', 'reply', 'image-available', 'image', 'detection', 'alert', 'error'];

class Daemon {
  // deps: { mesh (connected EventEmitter), cfg, log, out, json }
  constructor(deps = {}) {
    this.mesh = deps.mesh;
    this.cfg = deps.cfg || {};
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.out = deps.out || process.stdout;
    this.json = !!deps.json;
    this._subs = [];
    this._imgStop = null;
    this._server = null;
    this._wss = null;
    this._clients = new Set();
    this._startedAt = Date.now();
    this._stopped = false;
  }

  async start() {
    // Subscribe to every domain event; a throwing handler must never kill the feed.
    for (const type of EVENTS) {
      const handler = type === 'reply'
        ? (reply, from) => this._safe({ type, from, reply })
        : type === 'error'
        // keep the payload under .error: an Error's .message is non-enumerable and
        // would be lost by a spread. Subscribing at all is what stops an unhandled
        // 'error' from throwing and killing the daemon.
        ? (err) => this._safe({ type, error: err })
        : (payload) => this._safe(payload && typeof payload === 'object' ? { type, ...payload } : { type, value: payload });
      this.mesh.on(type, handler);
      this._subs.push(() => this.mesh.removeListener(type, handler));
    }

    // Autonomous image catch ON — the always-on part.
    this._imgStop = this.mesh.startImageListener();

    const d = (this.cfg.daemon) || {};
    if (d.serve) await this._startServer(); // resolves once the socket is bound (address() valid)

    this.log.info('daemon up — image listener ON%s', d.serve ? ` — serving http://${d.host}:${this._port()}` : '');
    return this;
  }

  _safe(record) {
    try { this._dispatch(record); }
    catch (e) { this.log.warn('feed dispatch failed: %s', e && e.message); }
  }

  _dispatch(record) {
    record.t = Date.now();
    const line = this.json ? JSON.stringify(record) : this._fmt(record);
    this.out.write(line + '\n');
    // Fan out to live WS clients (a dead client must not break the loop).
    if (this._clients.size) {
      const wire = JSON.stringify(record);
      for (const ws of this._clients) {
        try { ws.send(wire); } catch (e) { this.log.debug('ws send failed: %s', e && e.message); }
      }
    }
  }

  // One compact human line per event — never dumps `raw`.
  _fmt(r) {
    const tail = (o) => { try { const s = JSON.stringify(o); return s.length > 120 ? s.slice(0, 117) + '...' : s; } catch { return ''; } };
    switch (r.type) {
      case 'node':            return `node ${r.id}`;
      case 'reply':           return `reply from ${r.from} ${tail(r.reply)}`;
      case 'image-available': return `image-available ${r.node} pid ${r.pid}`;
      case 'image':           return `image ${r.node} pid ${r.pid} (${r.bytes} bytes) -> ${r.path}`;
      case 'error':           return `error ${r.error && (r.error.message || r.error) || ''}`;
      default:                return `${r.type} ${tail(r)}`;
    }
  }

  // ---- opt-in read-only domain HTTP + WS surface ----------------------------
  _startServer() {
    const d = this.cfg.daemon || {};
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => this._route(req, res));
      this._wss = new WebSocketServer({ server: this._server, path: '/events' });
      this._wss.on('connection', (ws) => {
        this._clients.add(ws);
        try { ws.send(JSON.stringify({ type: 'hello', t: Date.now() })); } catch { /* client gone already */ }
        ws.on('close', () => this._clients.delete(ws));
        ws.on('error', () => this._clients.delete(ws));
      });
      this._server.once('error', reject);
      this._server.listen(d.port != null ? d.port : 8787, d.host || '127.0.0.1', () => resolve());
    });
  }

  _send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  _body(req) {
    return new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // Command butler — POST enqueue / GET ledger / DELETE cancel (the only write endpoints).
      if (p === '/queue' && req.method === 'POST') {
        const b = await this._body(req);
        if (!b || !b.unit || !b.verb) return this._send(res, 400, { error: 'need {unit, verb, args?, ttlMs?, maxAttempts?}' });
        const entry = await this.mesh.queueCommand(b.unit, b.verb, b.args || [], { ttlMs: b.ttlMs, maxAttempts: b.maxAttempts });
        return this._send(res, 200, entry);
      }
      // Operator command with live/dev routing — dev: direct (returns the reply); live: queued
      // via the butler (returns a queued ack). The daemon is the authority (state + butler).
      if (p === '/command' && req.method === 'POST') {
        const b = await this._body(req);
        if (!b || !b.unit || !b.verb) return this._send(res, 400, { error: 'need {unit, verb, args?, force?}' });
        try {
          return this._send(res, 200, await this.mesh.dispatch(b.unit, b.verb, b.args || [], { force: !!b.force, noReply: b.noReply }));
        } catch (e) {
          return this._send(res, e && e.code === 'ELIVE' ? 409 : 502, { error: (e && e.message) || String(e), code: e && e.code });
        }
      }
      // live/dev mode: GET /mode/:unit -> info; POST /mode {unit,mode} -> set/clear the override
      // (persists to config AND applies to the running butler immediately).
      const mm = p.match(/^\/mode\/(.+)$/);
      if (mm && req.method === 'GET') return this._send(res, 200, await this.mesh.unitInfo(decodeURIComponent(mm[1])));
      if (p === '/mode' && req.method === 'POST') {
        const b = await this._body(req);
        if (!b || !b.unit || !['dev', 'live', 'auto'].includes(b.mode)) return this._send(res, 400, { error: 'need {unit, mode: dev|live|auto}' });
        return this._send(res, 200, await this.mesh.setUnitMode(b.unit, b.mode));
      }
      if (p === '/queue' && req.method === 'GET') return this._send(res, 200, await this.mesh.queueList());
      const qm = p.match(/^\/queue\/(.+)$/);
      if (qm && req.method === 'GET') return this._send(res, 200, await this.mesh.queueList(decodeURIComponent(qm[1])));
      if (qm && req.method === 'DELETE') {
        const c = this.mesh.queueCancel(decodeURIComponent(qm[1]));
        return c ? this._send(res, 200, c) : this._send(res, 404, { error: 'not pending / unknown id' });
      }

      if (req.method !== 'GET') return this._send(res, 405, { error: 'method not allowed' });
      if (p === '/health') {
        return this._send(res, 200, {
          ok: true, uptimeMs: Date.now() - this._startedAt,
          nodes: this.mesh.model ? this.mesh.model.nodes().length : null,
          clients: this._clients.size, serving: true,
        });
      }
      if (p === '/nodes') return this._send(res, 200, await this.mesh.nodes());
      const m = p.match(/^\/nodes\/(.+)$/);
      if (m) {
        const target = decodeURIComponent(m[1]);
        const node = await this.mesh.node(target);
        if (!node) return this._send(res, 404, { error: 'unknown node' });
        const info = await this.mesh.unitInfo(target);   // mode + lastHeardMs + slp + awake
        return this._send(res, 200, { ...node, ...info });
      }
      return this._send(res, 404, { error: 'not found' });
    } catch (e) {
      return this._send(res, 502, { error: (e && e.message) || String(e) });
    }
  }

  _port() { return this._server ? this._server.address().port : (this.cfg.daemon && this.cfg.daemon.port); }
  address() { return this._server ? this._server.address() : null; }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    for (const off of this._subs) { try { off(); } catch { /* already gone */ } }
    this._subs = [];
    if (this._imgStop) { try { this._imgStop(); } catch { /* best effort */ } this._imgStop = null; }
    for (const ws of this._clients) { try { ws.close(); } catch { /* gone */ } }
    this._clients.clear();
    if (this._wss) { try { this._wss.close(); } catch { /* gone */ } this._wss = null; }
    if (this._server) { try { this._server.close(); } catch { /* gone */ } this._server = null; }
    this.log.info('daemon stopped');
  }
}

module.exports = { Daemon };
