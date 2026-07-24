// Offline test for the daemon — no radio. A fake Mesh (EventEmitter) stands in;
// covers lifecycle/wiring, error-safety, feed format, and the opt-in HTTP+WS
// domain surface via an ephemeral port (real sockets, no gateway).
'use strict';
const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { Daemon } = require('../lib/daemon');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

// A fake Mesh: EventEmitter + the surface the daemon touches.
function makeMesh() {
  const m = new EventEmitter();
  m._imgOn = 0; m._imgStopCalls = 0;
  m.startImageListener = () => { m._imgOn++; return () => { m._imgStopCalls++; }; };
  m.model = { nodes: () => [{ id: '!a' }] };
  m.nodes = async () => [{ id: '!8cee336b', num: 1, name: '336b' }];
  m.node = async (id) => (id === '!8cee336b' ? { id, name: '336b' } : null);
  m.unitInfo = async (id) => ({ id, mode: 'dev', lastHeardMs: null, slp: null, awake: true });
  return m;
}
function capture() { const lines = []; return { lines, out: { write: (s) => { lines.push(s); return true; } } }; }
const quietLog = { info() {}, warn() {}, debug() {} };

// ---- 1. lifecycle + wiring + error-safety -----------------------------------
async function testLifecycle() {
  const mesh = makeMesh();
  const cap = capture();
  const d = new Daemon({ mesh, cfg: { daemon: { serve: false } }, log: quietLog, out: cap.out });
  await d.start();
  ok(mesh._imgOn === 1, 'start(): image listener started');

  mesh.emit('node', { id: '!8cee336b' });
  ok(cap.lines.some((l) => l.includes('node') && l.includes('!8cee336b')), 'feed: node event written');

  mesh.emit('reply', { ok: 1 }, '!8cee336b');
  ok(cap.lines.some((l) => l.includes('reply') && l.includes('!8cee336b')), 'feed: reply (2-arg) written');

  // 'error' must NOT throw (an unhandled EventEmitter 'error' would crash the daemon).
  let threw = false;
  try { mesh.emit('error', { message: 'boom' }); } catch { threw = true; }
  ok(!threw && cap.lines.some((l) => l.includes('error') && l.includes('boom')), 'error event handled, not thrown');

  const before = cap.lines.length;
  d.stop();
  ok(mesh._imgStopCalls === 1, 'stop(): image listener stopped');
  mesh.emit('node', { id: '!after' });
  ok(cap.lines.length === before, 'stop(): unsubscribed — no feed after stop');
  d.stop(); // idempotent
  ok(true, 'stop(): idempotent');
}

// ---- 2. json vs human format ------------------------------------------------
async function testFormat() {
  const mesh = makeMesh();
  const cap = capture();
  const d = new Daemon({ mesh, cfg: { daemon: { serve: false } }, log: quietLog, out: cap.out, json: true });
  await d.start();
  mesh.emit('image', { node: '!8cee336b', pid: 41910, path: '/x.jpg', bytes: 12345 });
  const rec = JSON.parse(cap.lines[cap.lines.length - 1]);
  ok(rec.type === 'image' && rec.pid === 41910 && typeof rec.t === 'number', 'json feed: parseable record with type + t');
  d.stop();
}

// ---- 3. serve round-trip: HTTP /health /nodes + WS /events ------------------
function get(port, path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ code: r.statusCode, json: JSON.parse(b) }));
    }).on('error', rej);
  });
}
async function testServe() {
  const mesh = makeMesh();
  const d = new Daemon({ mesh, cfg: { daemon: { serve: true, host: '127.0.0.1', port: 0 } }, log: quietLog, out: capture().out });
  await d.start();
  await waitFor(() => d.address() && d.address().port, 2000);
  const port = d.address().port;
  ok(port > 0, 'serve: bound an ephemeral port');

  const health = await get(port, '/health');
  ok(health.code === 200 && health.json.ok === true && health.json.serving === true, 'GET /health -> ok');

  const nodes = await get(port, '/nodes');
  ok(nodes.code === 200 && Array.isArray(nodes.json) && nodes.json[0].id === '!8cee336b', 'GET /nodes -> roster');

  const one = await get(port, '/nodes/' + encodeURIComponent('!8cee336b'));
  ok(one.code === 200 && one.json.name === '336b', 'GET /nodes/:id -> node');
  const missing = await get(port, '/nodes/!nope');
  ok(missing.code === 404, 'GET /nodes/:unknown -> 404');
  const bad = await get(port, '/whatever');
  ok(bad.code === 404, 'GET /unknown -> 404');

  // WS feed: connect, then a domain event must arrive on the socket.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
  const got = [];
  ws.on('message', (m) => got.push(JSON.parse(m)));
  await waitFor(() => ws.readyState === WebSocket.OPEN, 2000);
  ok(got.some((r) => r.type === 'hello'), 'WS: greeted with hello');
  mesh.emit('node', { id: '!feed' });
  await waitFor(() => got.some((r) => r.type === 'node' && r.id === '!feed'), 2000);
  ok(got.some((r) => r.type === 'node' && r.id === '!feed'), 'WS: domain event broadcast to client');

  ws.close();
  await sleep(30);
  d.stop();
  // Server is closed: a fresh request must fail.
  let refused = false;
  try { await get(port, '/health'); } catch { refused = true; }
  ok(refused, 'stop(): server closed — connection refused');
}

Promise.resolve()
  .then(testLifecycle).then(testFormat).then(testServe)
  .then(() => console.log(`daemon OK: ${pass} assertions passed`))
  .catch((e) => { console.error('daemon FAILED:', e && e.stack || e); process.exit(1); });
