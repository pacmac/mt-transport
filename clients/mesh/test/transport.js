// Offline transport test — deterministic, no radio, no gateway.
// Proves the codec roundtrips, crc32 matches the canonical check value, the
// command/260 grammar behaves, and the serialiser enforces one-in-flight +
// spacing + positional replies + no-blind-retry. gw.js's network paths are
// exercised live/best-effort separately (see specs/mesh-transport.md §5).
'use strict';
const assert = require('assert');
const P = require('../lib/protocol');
const { Timing } = require('../lib/timing');

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- 1. push frame codec roundtrip -----------------------------------------
{
  const start = P.decodeFrame(P.encodeStart(0xBEEF));
  ok(start.type === P.MSG.START && start.pid === 0xBEEF, 'START roundtrip');

  const q = P.decodeFrame(P.encodeProgressQ(7));
  ok(q.type === P.MSG.PROGRESS_Q && q.pid === 7, 'PROGRESS_Q roundtrip');

  const man = P.decodeFrame(P.encodeManifest(5, P.PT.IMAGE, 1000, 32, 0x12345678));
  ok(man.pid === 5 && man.ptype === P.PT.IMAGE && man.bytes === 1000 &&
     man.count === 32 && man.crc === 0x12345678, 'MANIFEST roundtrip');

  const data = Buffer.from('hello world');
  const ch = P.decodeFrame(P.encodeChunk(5, 3, data));
  ok(ch.pid === 5 && ch.seq === 3 && ch.data.equals(data), 'CHUNK roundtrip');

  const pr = P.decodeFrame(P.encodeProgress(5, 17, true));
  ok(pr.pid === 5 && pr.cursor === 17 && pr.done === true, 'PROGRESS(done) roundtrip');
  const pr2 = P.decodeFrame(P.encodeProgress(5, 0, false));
  ok(pr2.done === false, 'PROGRESS(!done) roundtrip');

  const rep = P.decodeFrame(P.encodeRepair(5, [1, 4, 9]));
  ok(rep.pid === 5 && rep.ids.length === 3 && rep.ids[2] === 9, 'REPAIR roundtrip');

  const comp = P.decodeFrame(P.encodeComplete(5, 0xC8245EBB));
  ok(comp.pid === 5 && comp.crc === 0xC8245EBB, 'COMPLETE roundtrip');
}

// ---- 2. decoder rejects malformed / out-of-scope ---------------------------
{
  ok(P.encodeRepair(5, []) === null, 'empty repair rejected');
  ok(P.encodeRepair(5, new Array(P.REPAIR_IDS_MAX + 1).fill(1)) === null, 'over-long repair rejected');
  ok(P.encodeChunk(5, 0, Buffer.alloc(P.CHUNK_DATA_MAX + 1)) === null, 'over-long chunk rejected');
  ok(P.decodeFrame(Buffer.from([P.MSG.START])) === null, 'short START -> null');
  ok(P.decodeFrame(Buffer.alloc(0)) === null, 'empty buf -> null');
  ok(P.decodeFrame(Buffer.from([0x02, 0, 1, 0, 0, 16])) === null, 'pull byte 0x02 -> null (out of scope)');
  ok(P.decodeFrame(Buffer.from([0xFF, 1, 2, 3])) === null, 'unknown type -> null');
  // a truncated CHUNK (header only, no body) is malformed, not an empty chunk
  ok(P.decodeFrame(Buffer.from([P.MSG.CHUNK, 0, 5, 0, 3])) === null, 'bodyless CHUNK -> null');
}

// ---- 3. crc32 canonical check value ----------------------------------------
{
  // The CRC-32 (IEEE 802.3 reflected) check value of "123456789" is 0xCBF43926.
  ok(P.crc32(Buffer.from('123456789')) === 0xCBF43926, 'crc32 canonical check');
}

// ---- 4. command grammar + reply/260 parse ----------------------------------
{
  ok(P.buildCommand('*', 'ping') === '@* ping', 'buildCommand broadcast');
  ok(P.buildCommand('@336b', 'chunk', ['pull', 1, 0, 16]) === '@336b chunk pull 1 0 16', 'buildCommand args');
  let threw = false;
  try { P.buildCommand('bad name', 'ping'); } catch (e) { threw = e.code === 'EBADTARGET'; }
  ok(threw, 'spaced target rejected');

  ok(P.parseReply('{"ok":1}').ok === 1, 'parseReply object');
  ok(P.parseReply('hello') === null, 'parseReply non-json -> null');
  ok(P.parseReply('{bad') === null, 'parseReply malformed -> null');

  ok(P.parse260(Buffer.from('{"t":"dbg","up":42}')).up === 42, 'parse260 object');
  ok(P.parse260(Buffer.from('{"t":"dbg", trunca')).type === 'unparseable', 'parse260 truncated -> unparseable');
}

// ---- 5. timing serialiser --------------------------------------------------
async function timingTests() {
  // A) one-in-flight + spacing + positional onReply
  {
    const t = new Timing({ sendSpacingMs: 30, replyTimeoutMs: 1000 });
    const sent = [];
    const mk = (tag) => t.enqueue(async () => { sent.push({ tag, at: Date.now() }); }, { match: () => true });
    const p1 = mk('a'); const p2 = mk('b');
    // Auto-respond to whatever is in flight, so the second only runs after the
    // first resolves AND the spacing window elapses.
    const responder = setInterval(() => { if (t.inFlight) t.onReply({ ok: true }); }, 2);
    await Promise.all([p1, p2]);
    clearInterval(responder);
    ok(sent.length === 2 && sent[0].tag === 'a' && sent[1].tag === 'b', 'serialised in order');
    ok(sent[1].at - sent[0].at >= 28, `spacing honoured (${sent[1].at - sent[0].at}ms >= ~30)`);
  }

  // B) noReply resolves on send (no onReply needed)
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 1000 });
    const r = await t.enqueue(async () => {}, { noReply: true });
    ok(r && r.sent === true, 'noReply resolves {sent:true}');
  }

  // C) timeout rejects, and retries:0 means the thunk ran exactly once
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 20 });
    let calls = 0;
    let code = null;
    try { await t.enqueue(async () => { calls++; }, { match: () => true }); }
    catch (e) { code = e.code; }
    ok(code === 'ETIMEOUT', 'timeout rejects ETIMEOUT');
    ok(calls === 1, 'retries:0 -> thunk sent once (no blind retry)');
  }

  // D) dedup returns the same promise
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 1000 });
    const p1 = t.enqueue(async () => {}, { dedupKey: 'k', match: () => true });
    const p2 = t.enqueue(async () => {}, { dedupKey: 'k', match: () => true });
    ok(p1 === p2, 'dedup: identical key -> same promise');
    await tick(0);
    t.onReply({ ok: true });
    await p1;
  }

  // E) reply_id correlation: a crossing reply (wrong reply_id) is IGNORED; the match resolves
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 1000 });
    const p = t.enqueue(async () => ({ id: 111 }), { match: () => true });
    await tick(0);                                    // let _pump send + capture sentId
    ok(t.inFlight && t.inFlight.sentId === 111, 'reply_id: sentId captured from thunk {id}');
    ok(t.onReply({ type: 'sleepfor' }, 222) === false, 'reply_id: a DIFFERENT reply_id is ignored (the butler cross)');
    ok(t.inFlight != null, 'reply_id: command stays in-flight after a crossing reply');
    ok(t.onReply({ type: 'agc' }, 111) === true, 'reply_id: matching reply_id resolves');
    ok((await p).type === 'agc', 'reply_id: the CORRECT reply is delivered as the receipt');
  }

  // F) sentId captured -> an UNSOLICITED frame (no reply_id) must NOT be taken as our reply.
  //    Reproduces the live bug: a `status` in-flight was acked with a {type:sleepfor} receipt. The
  //    loose matcher (mirrors command()'s `r && typeof r === 'object'`) used to consume it; the fix
  //    rejects any no-reply_id frame once a sent id was captured.
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 1000 });
    const p = t.enqueue(async () => ({ id: 55 }), { match: (r) => r && typeof r === 'object' });
    await tick(0);
    ok(t.onReply({ type: 'sleepfor', secs: 35 }, null) === false, 'sentId set: unsolicited frame (no reply_id) is REJECTED, not acked');
    ok(t.inFlight != null, 'sentId set: command stays in-flight after the unsolicited frame');
    ok(t.onReply({ type: 'status' }, 55) === true, 'sentId set: the matching reply_id resolves');
    ok((await p).type === 'status', 'sentId set: the STATUS is the receipt, not the sleepfor');
  }

  // G) no captured sentId (send returned no id) -> positional match still applies (back-compat)
  {
    const t = new Timing({ sendSpacingMs: 0, replyTimeoutMs: 1000 });
    const p = t.enqueue(async () => ({}), { match: (r) => r && r.ok });   // no id -> sentId stays null
    await tick(0);
    ok(t.inFlight && t.inFlight.sentId == null, 'no id in send result -> sentId null');
    ok(t.onReply({ nope: 1 }, null) === false, 'sentId null: positional match rejects a non-match');
    ok(t.onReply({ ok: true }, null) === true, 'sentId null: positional match accepts');
    await p;
  }
}

timingTests().then(() => {
  console.log(`transport OK: ${pass} assertions passed`);
}).catch((e) => {
  console.error('transport FAILED:', e && e.stack || e);
  process.exit(1);
});
