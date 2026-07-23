// Offline test for the live vertical — the Mesh command/event/model glue, driven
// by a MOCK gateway (no radio, no network). Proves ping/status build the right
// text, correlate the reply, feed the model, dedup, and that connect() refuses
// without a gatewayId.
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Mesh } = require('..');
const { Timing } = require('../lib/timing');
const { Model } = require('../lib/model');

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A stand-in matching the slice of the Gateway interface the Mesh uses.
function mockGw() {
  return {
    sent: [], _h: null, nodesReply: [],
    onEvent(h) { this._h = h; return () => { this._h = null; }; },
    emit(ev) { if (this._h) this._h(ev); },
    async sendText(gwId, text, opts) { this.sent.push({ gwId, text, opts }); return { id: 1 }; },
    async nodes() { return this.nodesReply; },
    async status() { return {}; }, info() { return null; },
    async connect() {}, async close() {},
  };
}

// Wire a Mesh with the mock gw, bypassing real connect()/network.
function wire(gwId = '!gw', channel = 2) {
  const m = new Mesh();
  m.cfg = { gw: { gatewayId: gwId }, channel };
  m.gwId = gwId; m.channel = channel;
  m.timing = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 500 });
  m.model = new Model();
  const g = mockGw(); m.gw = g;
  g.onEvent((ev) => m._onEvent(ev));
  return { m, g };
}

async function main() {
  // ping builds "@336b ping" on the channel; resolves on the JSON text reply
  {
    const { m, g } = wire('!gw', 2);
    const p = m.ping('336b');
    await tick(0);
    ok(g.sent.length === 1 && g.sent[0].text === '@336b ping' && g.sent[0].opts.channel === 2,
      'ping sends "@336b ping" on ch2');
    g.emit({ kind: 'text', text: '{"ok":1,"upt":5}', from: '!336b' });
    const r = await p;
    ok(r && r.ok === 1 && r.upt === 5, 'ping resolves with the JSON reply');
  }

  // status with a domain arg
  {
    const { m, g } = wire();
    const p = m.status('336b', 'mem'); await tick(0);
    ok(g.sent[0].text === '@336b status mem', 'status mem builds "@336b status mem"');
    g.emit({ kind: 'text', text: '{"heap":1000}', from: 'x' });
    ok((await p).heap === 1000, 'status resolves');
  }

  // a 260 app event updates the model
  {
    const { m, g } = wire();
    g.emit({ kind: 'app', portnum: 260, payload: Buffer.from(JSON.stringify({ t: 'dbg', bat: 88 })), from: '!abcd' });
    ok(m.model.node('!abcd').last.bat === 88, 'model captures 260 telemetry');
    ok(m.model.nodes().length === 1, 'model.nodes lists it');
  }

  // non-JSON text is not a reply — ignored without error
  {
    const { m, g } = wire();
    g.emit({ kind: 'text', text: 'hello world', from: 'x' });
    ok(true, 'non-JSON text ignored');
  }

  // dedup: two identical in-flight pings collapse to ONE frame; both callers get
  // the reply. (Promise identity can't be asserted — the async command() wrapper
  // creates a fresh promise around the deduped timing promise; the frame count is
  // the real dedup evidence.)
  {
    const { m, g } = wire();
    const p1 = m.ping('336b'); const p2 = m.ping('336b');
    await tick(0);
    ok(g.sent.length === 1, 'dedup: identical in-flight ping sent once');
    g.emit({ kind: 'text', text: '{"ok":1}', from: 'x' });
    const [r1, r2] = await Promise.all([p1, p2]);
    ok(r1.ok === 1 && r2.ok === 1, 'dedup: both callers receive the reply');
  }

  // _summaries against the VERIFIED live shape: {nodes:{<num>:{num,user,...}}}
  {
    const { m } = wire();
    const live = { total: 1, count: 1, nodes: {
      '2364420971': { num: 2364420971, hops: 1, last_heard: 100,
        user: { long_name: 'Alarm Unit 336b 2-260723-23', short_name: 'U33B' } },
    } };
    const s = m._summaries(live);
    ok(s.length === 1, 'dict container -> one summary');
    ok(s[0].id === '!8cee336b', 'id derived from num (2364420971 -> !8cee336b)');
    ok(s[0].name === 'Alarm Unit 336b 2-260723-23' && s[0].num === 2364420971, 'name from user.long_name');
    ok(s[0].hops === 1 && s[0].lastHeard === 100, 'hops + lastHeard passed through');

    // back-compat: plain array and {nodes:[...]}; short_name fallback; null -> []
    const a = m._summaries([{ node_id: '!aa', long_name: 'Alpha' }, { num: 171, user: { short_name: 'B' } }]);
    ok(a[0].id === '!aa' && a[0].name === 'Alpha', 'array + top-level long_name');
    ok(a[1].id === '!ab' && a[1].name === 'B', 'id from num + user.short_name');
    ok(m._summaries({ nodes: [{ id: '!c' }] })[0].id === '!c', 'accepts {nodes:[array]}');
    ok(m._summaries(null).length === 0 && m._summaries({}).length === 0, 'null/{} -> []');
  }

  // connect() refuses without a gatewayId (no network reached)
  {
    const tmp = path.join(os.tmpdir(), `mtmesh-noid-${process.pid}.yaml`);
    fs.writeFileSync(tmp, 'gw:\n  gatewayId: null\n');
    const m = new Mesh({ configPath: tmp });
    let code = null;
    try { await m.connect(); } catch (e) { code = e.code; }
    fs.unlinkSync(tmp);
    ok(code === 'ECONFIG', 'connect throws ECONFIG without gatewayId');
  }

  console.log(`cli-live OK: ${pass} assertions passed`);
}

main().catch((e) => { console.error('cli-live FAILED:', e && e.stack || e); process.exit(1); });
