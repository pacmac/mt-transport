// offline_host.js — end-to-end test of the host over REAL HTTP on an ephemeral port.
// No mesh, no radio: two fake modules stand in, one of which deliberately fails to
// start, because "a module failing must not take the host down" is a promise the
// health endpoint makes to an operator and it has to be true.
'use strict';
const assert = require('assert');
const http = require('http');
const { Host } = require('../index');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function get(port, path, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    }).on('error', (e) => resolve({ status: 0, body: String(e) }));
  });
}
function post(port, path, obj) {
  return new Promise((resolve) => {
    const data = JSON.stringify(obj);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end(data);
  });
}

(async () => {
  let emitted = null;
  const good = {
    name: 'demo',
    async start(ctx) {
      emitted = ctx.bus.emit;
      ok(ctx.config.hello === 'world', 'module receives ITS OWN config slice, injected');
      return {
        routes: [
          ['GET', '/items', async () => [{ id: 1 }, { id: 2 }]],
          ['GET', '/items/:id', async ({ params }) => ({ id: params.id })],
          ['POST', '/items', async ({ body }) => ({ created: body.name })],
          ['GET', '/blob', async () => ({ raw: Buffer.from([1, 2, 3]), contentType: 'application/octet-stream' })],
          ['GET', '/boom', async () => { throw new Error('handler exploded'); }],
        ],
        async stop() { good.stopped = true; },
      };
    },
  };
  const broken = { name: 'broken', async start() { throw new Error('no disk'); } };

  const host = new Host({
    log: quiet,
    config: { http: { port: 0, host: '127.0.0.1' }, modules: { demo: { hello: 'world' } } },
  });
  host.register(good).register(broken);
  await host.start();
  const port = host._server.address().port;

  // ---- health -------------------------------------------------------------
  {
    const r = await get(port, '/v1/health');
    const h = JSON.parse(r.body);
    ok(r.status === 200, 'health served');
    ok(h.status === 'degraded', 'ONE MODULE DOWN => degraded, host still serving');
    ok(h.ok === false, 'ok=false when not everything is ready');
    const byName = Object.fromEntries(h.modules.map((m) => [m.name, m]));
    ok(byName.demo.status === 'ready', 'healthy module reported ready');
    ok(byName.broken.status === 'failed' && /no disk/.test(byName.broken.error), 'failure reported WITH its reason');
  }

  // ---- routing ------------------------------------------------------------
  {
    ok(JSON.parse((await get(port, '/v1/demo/items')).body).length === 2, 'GET list');
    ok(JSON.parse((await get(port, '/v1/demo/items/42')).body).id === '42', 'path params');
    ok(JSON.parse((await post(port, '/v1/demo/items', { name: 'x' })).body).created === 'x', 'POST body parsed');
    ok((await get(port, '/v1/demo/nope')).status === 404, 'unknown route in a known module = 404');
    ok((await get(port, '/v1/nosuch/x')).status === 404, 'unknown module = 404');
    const t = await get(port, '/v1/demo/items/42/deep');
    ok(t.status === 404, 'extra path segment does not falsely match');
  }

  // ---- a failed module is 503, not 404 (it EXISTS, it is unavailable) -------
  {
    const r = await get(port, '/v1/broken/anything');
    ok(r.status === 503, 'failed module returns 503');
    ok(/no disk/.test(r.body), '503 carries the reason');
  }

  // ---- binary leaves over HTTP, never the event stream ----------------------
  {
    const r = await get(port, '/v1/demo/blob');
    ok(r.headers['content-type'] === 'application/octet-stream', 'binary content-type');
    ok(r.headers['content-length'] === '3', 'binary length correct');
  }

  // ---- a throwing handler is a 500, and the host stays up -------------------
  {
    ok((await get(port, '/v1/demo/boom')).status === 500, 'handler exception -> 500');
    ok((await get(port, '/v1/health')).status === 200, 'HOST SURVIVES a throwing handler');
  }

  // ---- SSE: namespaced events, live delivery -------------------------------
  {
    const frames = await new Promise((resolve) => {
      let buf = '';                       // hoisted: the timeout below also reads it
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); req.destroy(); resolve(buf); };
      const req = http.get({ host: '127.0.0.1', port, path: '/v1/events' }, (res) => {
        res.on('data', (c) => { buf += c; if (buf.includes('demo.thing')) finish(); });
      });
      req.on('error', finish);
      setTimeout(() => emitted('thing', { v: 7 }), 40);
      const t = setTimeout(finish, 2000);
    });
    ok(/event: demo\.thing/.test(frames), 'module events are NAMESPACED with the module name');
    ok(/"v":7/.test(frames), 'payload delivered');
    ok(/^id: \d+/m.test(frames), 'every event carries an id (required for resume)');
  }

  // ---- shutdown -----------------------------------------------------------
  await host.stop();
  ok(good.stopped === true, 'module stop() called on shutdown');
  ok((await get(port, '/v1/health')).status === 0, 'listener closed after stop');

  console.log(`offline_host OK: ${checks} checks passed`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
