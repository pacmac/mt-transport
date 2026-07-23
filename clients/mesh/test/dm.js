// Offline tests for DM-default send + private fallback (mesh-dm). No radio: a bare
// Mesh instance with stubbed gw/timing/roster; drive command()/_sendRaw and assert
// the send opts (to/channel) and the addressing text.
'use strict';
const assert = require('assert');
const { Mesh } = require('..');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

// A Mesh with only the fields command()/_sendRaw touch — no connect(), no radio.
function harness(dm) {
  const m = new Mesh();
  const sent = [];
  m.cfg = { dm };
  m.channel = 2;
  m.gwId = '!gw';
  m._roster = [{ id: '!987ab80f', num: 2558179343, name: 'HOME' }];
  m.nodes = async () => m._roster;                          // roster refresh = no-op
  m.gw = { sendText: async (gwId, text, opts) => { sent.push({ text, opts }); return { id: 1, ok: true }; } };
  m.timing = { enqueue: (thunk) => thunk() };               // run inline, no queue
  return { m, sent };
}

(async () => {
  // 1. DM default: resolvable target -> to:num on channel 0, @ kept (omitAddress off)
  {
    const { m, sent } = harness({ default: true, fallbackChannel: 2, omitAddress: false });
    await m.command('b80f', 'ping');
    ok(sent.length === 1, 'one send');
    ok(sent[0].opts.to === 2558179343 && sent[0].opts.channel === 0, 'DM: to:num, channel 0');
    ok(sent[0].text === '@b80f ping', 'DM: @token kept while omitAddress off');
  }
  // 2. omitAddress -> bare verb text, still a DM
  {
    const { m, sent } = harness({ default: true, fallbackChannel: 2, omitAddress: true });
    await m.command('b80f', 'status', ['mem']);
    ok(sent[0].text === 'status mem', 'omit: no @ prefix in text');
    ok(sent[0].opts.to === 2558179343 && sent[0].opts.channel === 0, 'omit: still DM to:num ch0');
  }
  // 3. unresolvable target -> private ch2 broadcast fallback (no `to`)
  {
    const { m, sent } = harness({ default: true, fallbackChannel: 2, omitAddress: false });
    await m.command('dead', 'ping');
    ok(sent[0].opts.to === undefined && sent[0].opts.channel === 2, 'miss: broadcast on fallback ch2, no to');
    ok(sent[0].text === '@dead ping', 'miss: @token retained in fallback');
  }
  // 4. dm.default false -> always broadcast, even for a resolvable target
  {
    const { m, sent } = harness({ default: false, fallbackChannel: 2, omitAddress: false });
    await m.command('b80f', 'ping');
    ok(sent[0].opts.to === undefined && sent[0].opts.channel === 2, 'dm off: broadcast fallback');
  }
  // 5. '*' -> broadcast (never a DM)
  {
    const { m, sent } = harness({ default: true, fallbackChannel: 2, omitAddress: false });
    await m.command('*', 'ping');
    ok(sent[0].opts.to === undefined && sent[0].opts.channel === 2, '*: broadcast, no to');
    ok(sent[0].text === '@* ping', '*: @* retained');
  }
  // 6. control path (_sendRaw, used by images) also DMs the device
  {
    const { m, sent } = harness({ default: true, fallbackChannel: 2, omitAddress: false });
    await m._sendRaw('b80f', 'push q 5');
    ok(sent[0].opts.to === 2558179343 && sent[0].opts.channel === 0, 'control: DM to device num');
    ok(sent[0].text === '@b80f push q 5', 'control: addressing prefixed by send path');
  }

  console.log(`dm OK: ${pass} assertions passed`);
})().catch((e) => { console.error('dm FAILED:', e && e.stack || e); process.exit(1); });
