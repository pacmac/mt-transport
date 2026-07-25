// pac-host — THE service. One process, one port, one API.
//
// Consumers CONNECT to this; they never require() our code. That is deliberate and it
// is about OWNERSHIP: an imported copy of @pac/mesh would open its own mesh-gw
// connection and run its own butler — two queues delivering to the same units,
// duplicate sends, mis-correlated receipts, two image stores. This process is the
// SINGLE OWNER of the mesh-gw connection, the butler queue, the image store and the
// node model. Consumers own presentation.
//
// The host owns: config, logging, the HTTP listener, the SSE hub, and lifecycle.
// It owns NO domain logic — everything real lives in a module.
'use strict';
const http = require('http');
const { SseHub } = require('./lib/sse');

const API = '/v1';

class Host {
  // opts: { config, log, sse }
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.log = opts.log || console;
    this.sse = opts.sse || new SseHub({
      log: this.log,
      bufferSize: (this.config.events && this.config.events.bufferSize),
    });
    this._modules = [];   // { name, mod, started, routes, stop, error }
    this._server = null;
    this._stopped = false;
  }

  // Register a module: { name, start(ctx) -> { routes?, stop?() } }.
  // Registration is cheap and synchronous; nothing runs until start().
  register(mod) {
    if (!mod || !mod.name || typeof mod.start !== 'function')
      throw new Error('module must be { name, start(ctx) }');
    this._modules.push({ name: mod.name, mod, started: false, routes: [], stop: null, error: null });
    return this;
  }

  async start() {
    for (const entry of this._modules) await this._startModule(entry);
    await this._listen();
    const ready = this._modules.filter((m) => m.started).length;
    this.log.info('host up on %s — %d/%d modules ready', this.address(), ready, this._modules.length);
    return this;
  }

  // A module that fails to start must NOT take the host down: the others keep
  // serving and /v1/health reports the failure. A dead recorder should never cost
  // us the ability to command a unit, and vice versa.
  async _startModule(entry) {
    const ctx = {
      config: (this.config.modules && this.config.modules[entry.name]) || {},
      log: childLog(this.log, entry.name),
      // How a module publishes to the one live stream. Names are namespaced here,
      // so a module cannot accidentally collide with another's events.
      bus: {
        emit: (type, data) => this.sse.publish(`${entry.name}.${type}`, data),
      },
    };
    try {
      const handle = (await entry.mod.start(ctx)) || {};
      entry.routes = normaliseRoutes(handle.routes);
      entry.stop = typeof handle.stop === 'function' ? handle.stop : null;
      entry.started = true;
    } catch (e) {
      entry.error = (e && e.message) || String(e);
      this.log.warn('module %s failed to start: %s', entry.name, entry.error);
    }
  }

  _listen() {
    const h = this.config.http || {};
    // localhost by default: this service drives real radio hardware.
    const host = h.host || '127.0.0.1';
    const port = h.port != null ? h.port : 8787;
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => this._route(req, res));
      this._server.once('error', reject);
      this._server.listen(port, host, () => resolve());
    });
  }

  address() {
    const a = this._server && this._server.address();
    return a ? `http://${a.address}:${a.port}` : '(not listening)';
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this.sse.close();
    if (this._server) await new Promise((r) => this._server.close(r));
    // Stop in reverse registration order; one failure must not block the rest.
    for (const entry of [...this._modules].reverse()) {
      if (!entry.stop) continue;
      try { await entry.stop(); }
      catch (e) { this.log.warn('module %s stop failed: %s', entry.name, e && e.message); }
    }
    this.log.info('host stopped');
  }

  health() {
    const modules = this._modules.map((m) => ({
      name: m.name,
      status: m.started ? 'ready' : 'failed',
      error: m.error || undefined,
    }));
    const ready = modules.every((m) => m.status === 'ready');
    return {
      ok: ready,
      status: ready ? 'ready' : (modules.some((m) => m.status === 'ready') ? 'degraded' : 'down'),
      modules,
      events: { lastId: this.sse.lastId, oldestId: this.sse.oldestId, clients: this.sse.clientCount },
      uptimeMs: Math.round(process.uptime() * 1000),
    };
  }

  // ---- routing --------------------------------------------------------------
  async _route(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { error: 'bad url' }); }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === `${API}/health` && req.method === 'GET') return send(res, 200, this.health());
      if (path === `${API}/events` && req.method === 'GET') { this.sse.attach(req, res); return; }

      // Module routes are mounted at /v1/<module><path>.
      for (const entry of this._modules) {
        const base = `${API}/${entry.name}`;
        if (path !== base && !path.startsWith(base + '/')) continue;
        if (!entry.started) return send(res, 503, { error: `module ${entry.name} unavailable`, detail: entry.error });
        const rest = path.slice(base.length) || '/';
        for (const r of entry.routes) {
          const params = matchPath(r.path, rest);
          if (!params || r.method !== req.method) continue;
          const body = hasBody(req) ? await readJson(req) : undefined;
          if (body === null) return send(res, 400, { error: 'invalid JSON body' });
          const out = await r.handler({ params, query: url.searchParams, body, req });
          return respond(res, out);
        }
        return send(res, 404, { error: 'no such route', module: entry.name, path: rest });
      }
      return send(res, 404, { error: 'not found', path });
    } catch (e) {
      this.log.warn('route %s failed: %s', path, (e && e.message) || e);
      return send(res, 500, { error: (e && e.message) || 'internal error' });
    }
  }
}

// ---- helpers ----------------------------------------------------------------

// Accepts [ [method, path, handler] ] or [ {method, path, handler} ].
function normaliseRoutes(routes) {
  if (!Array.isArray(routes)) return [];
  return routes.map((r) => {
    const o = Array.isArray(r) ? { method: r[0], path: r[1], handler: r[2] } : r;
    if (!o || !o.method || !o.path || typeof o.handler !== 'function')
      throw new Error('route must be {method, path, handler}');
    return { method: String(o.method).toUpperCase(), path: o.path, handler: o.handler };
  });
}

// Tiny matcher: '/images/:pid' vs '/images/42' -> { pid: '42' }. Null when no match.
function matchPath(pattern, actual) {
  const a = pattern.split('/').filter(Boolean);
  const b = actual.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) { params[a[i].slice(1)] = decodeURIComponent(b[i]); continue; }
    if (a[i] !== b[i]) return null;
  }
  return params;
}

const hasBody = (req) => req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// A handler returns plain data (JSON), or { status?, body?, raw?, contentType? }.
// `raw` is how binary leaves the service — images are fetched over HTTP, never
// pushed through the event stream.
function respond(res, out) {
  if (out && typeof out === 'object' && (out.raw !== undefined || out.status !== undefined || out.body !== undefined)) {
    const status = out.status || 200;
    if (out.raw !== undefined) {
      const buf = Buffer.isBuffer(out.raw) ? out.raw : Buffer.from(out.raw);
      res.writeHead(status, { 'Content-Type': out.contentType || 'application/octet-stream', 'Content-Length': buf.length });
      return res.end(buf);
    }
    return send(res, status, out.body === undefined ? null : out.body);
  }
  return send(res, 200, out === undefined ? null : out);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function childLog(log, name) {
  const tag = `[${name}]`;
  const at = (lvl) => (typeof log[lvl] === 'function'
    ? (...a) => log[lvl](`${tag} ${a[0]}`, ...a.slice(1))
    : () => {});
  return { info: at('info'), warn: at('warn'), debug: at('debug'), error: at('error') };
}

module.exports = { Host, SseHub, API };
