// offline_sse.js — contract test for the SSE hub. No sockets: a fake response object
// records what would go on the wire.
//
// Resume is the ENTIRE reason SSE was chosen over WS, so it has to be proven, not
// assumed. In particular: a client that reconnects must either get exactly what it
// missed, or be TOLD it cannot (a `gap`). Silently resuming with a hole is the failure
// mode this project keeps fighting — a gap in a record that looks like "nothing
// happened".
'use strict';
const assert = require('assert');
const { SseHub } = require('../lib/sse');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };

// Minimal http.ServerResponse stand-in.
function fakeRes() {
  const r = {
    chunks: [], headers: null, code: 0, writableLength: 0, ended: false, destroyed: false,
    writeHead(code, h) { r.code = code; r.headers = h; return r; },
    write(s) { r.chunks.push(s); return true; },
    end() { r.ended = true; },
    destroy() { r.destroyed = true; },
    on() { /* handlers unused here */ },
  };
  return r;
}
const req = (lastEventId) => ({ headers: lastEventId == null ? {} : { 'last-event-id': String(lastEventId) } });
// Parse frames into {id, event, data}
const parse = (res) => res.chunks.join('').split('\n\n').filter((b) => b.trim() && !b.startsWith(':'))
  .map((b) => {
    const o = {};
    for (const line of b.split('\n')) {
      const i = line.indexOf(': ');
      if (i > 0) o[line.slice(0, i)] = line.slice(i + 2);
    }
    return o;
  });

// ---- 1. ids are monotonic from 1, frames well-formed ------------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const res = fakeRes();
  hub.attach(req(), res);
  ok(res.code === 200 && res.headers['Content-Type'] === 'text/event-stream', 'SSE headers set');
  ok(res.headers['X-Accel-Buffering'] === 'no', 'proxy buffering disabled — else the stream stalls');

  const id1 = hub.publish('mesh.node', { id: '!abc' });
  const id2 = hub.publish('mesh.reply', { from: 1 });
  ok(id1 === 1 && id2 === 2, 'ids monotonic from 1');
  const f = parse(res);
  ok(f.length === 2, 'both frames delivered');
  ok(f[0].id === '1' && f[0].event === 'mesh.node', 'id + namespaced event name on the wire');
  ok(JSON.parse(f[0].data).id === '!abc', 'data is JSON');
  hub.close();
}

// ---- 2. RESUME: reconnect with Last-Event-ID gets exactly the missed events ---
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const a = fakeRes(); hub.attach(req(), a);
  hub.publish('mesh.node', { n: 1 });
  hub.publish('mesh.node', { n: 2 });
  hub.publish('mesh.node', { n: 3 });

  // A NEW client resumes from id 1 — must receive 2 and 3, and nothing else.
  const b = fakeRes(); hub.attach(req(1), b);
  const f = parse(b);
  ok(f.length === 2, 'replayed exactly the missed events');
  ok(f[0].id === '2' && f[1].id === '3', 'replay is the correct RANGE, in order');
  ok(JSON.parse(f[1].data).n === 3, 'replayed payloads intact');
  hub.close();
}

// ---- 3. resuming when already current replays NOTHING ------------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  hub.publish('mesh.node', { n: 1 });
  const res = fakeRes(); hub.attach(req(1), res);
  ok(parse(res).length === 0, 'up-to-date client gets no replay');
  hub.close();
}

// ---- 4. GAP: buffer rolled past the client -> say so, do not resume silently --
{
  const hub = new SseHub({ bufferSize: 3, keepaliveMs: 0 });
  for (let i = 0; i < 10; i++) hub.publish('mesh.node', { n: i });   // ids 1..10, buffer holds 8,9,10
  ok(hub.oldestId === 8 && hub.lastId === 10, 'buffer rolled as expected');

  const res = fakeRes(); hub.attach(req(2), res);        // asks for 3.. — long gone
  const f = parse(res);
  ok(f.length === 1 && f[0].event === 'gap', 'CLIENT IS TOLD IT MISSED EVENTS, not silently resumed');
  const g = JSON.parse(f[0].data);
  ok(g.from === 2 && g.oldest === 8 && g.latest === 10, 'gap reports the range it cannot serve');
  hub.close();
}

// ---- 5. boundary: exactly at the oldest edge still replays, no false gap ------
{
  const hub = new SseHub({ bufferSize: 3, keepaliveMs: 0 });
  for (let i = 0; i < 5; i++) hub.publish('e', { n: i });  // ids 1..5, buffer 3,4,5
  const res = fakeRes(); hub.attach(req(3), res);          // wants 4,5 — both buffered
  const f = parse(res);
  ok(f.length === 2 && f[0].id === '4' && f[1].id === '5', 'replay works at the buffer edge');

  const res2 = fakeRes(); hub.attach(req(2), res2);        // wants 3.. — oldest is 3, so serveable
  const f2 = parse(res2);
  ok(f2.length === 3 && f2[0].id === '3', 'one before the edge is still exactly serveable');
  hub.close();
}

// ---- 6. no Last-Event-ID = live only, no history dump ------------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  hub.publish('e', { n: 1 });
  const res = fakeRes(); hub.attach(req(), res);
  ok(parse(res).length === 0, 'a fresh client gets no backlog');
  hub.publish('e', { n: 2 });
  ok(parse(res).length === 1, 'and then receives live events');
  hub.close();
}

// ---- 7. fan-out to many clients ---------------------------------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const rs = [fakeRes(), fakeRes(), fakeRes()];
  rs.forEach((r) => hub.attach(req(), r));
  ok(hub.clientCount === 3, 'three attached');
  hub.publish('e', { n: 1 });
  ok(rs.every((r) => parse(r).length === 1), 'every client got it');
  hub.close();
  ok(hub.clientCount === 0 && rs.every((r) => r.ended), 'close() ends every client');
}

// ---- 8. slow consumer is DROPPED, never allowed to back up the service -------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const slow = fakeRes();
  const good = fakeRes();
  hub.attach(req(), slow);
  hub.attach(req(), good);
  slow.writableLength = (1 << 20) + 1;         // pretend its socket is backed up
  hub.publish('e', { n: 1 });
  ok(slow.destroyed === true, 'SLOW CLIENT DROPPED');
  ok(hub.clientCount === 1, 'only the healthy client remains');
  hub.publish('e', { n: 2 });
  ok(parse(good).length === 2, 'healthy client unaffected by the slow one');
  hub.close();
}

// ---- 9. unserialisable payload must not kill the stream ----------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const res = fakeRes(); hub.attach(req(), res);
  const cyclic = {}; cyclic.self = cyclic;
  hub.publish('e', cyclic);
  hub.publish('e', { fine: true });
  const f = parse(res);
  ok(f.length === 2, 'stream survives an unserialisable payload');
  ok(JSON.parse(f[0].data).error === 'unserialisable', 'and reports it honestly');
  hub.close();
}

// ---- 10. data is always ONE line (frame integrity) ---------------------------
{
  const hub = new SseHub({ keepaliveMs: 0 });
  const res = fakeRes(); hub.attach(req(), res);
  hub.publish('e', { text: 'line one\nline two\r\nthree' });
  const body = res.chunks.join('');
  const dataLine = body.split('\n').find((l) => l.startsWith('data: '));
  ok(dataLine && dataLine.endsWith('}'), 'newlines in payload cannot break the frame');
  ok(parse(res).length === 1, 'still exactly one event');
  hub.close();
}

console.log(`offline_sse OK: ${checks} checks passed`);
