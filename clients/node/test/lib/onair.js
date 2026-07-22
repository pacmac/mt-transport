'use strict';
// onair.js — reusable ON-AIR test harness.
//
// "Did I get a reply" is not a test. This harness records, for every command, WHAT
// came back and HOW, then issues a verdict. A PASS means: the right unit answered the
// right message, over the expected transport, in time, without the device restarting
// underneath the run.
//
// Two real failures drove this (see specs/onair-test-analysis.md):
//   1. A reply that landed ~40 ms after the poll window closed was reported as
//      "no reply" — a false negative that sends you hunting a phantom device fault.
//      LATE is now its own verdict, distinct from ABSENT.
//   2. A run would have reported PASS for a BROADCAST fallback when a PKC DM was
//      expected, because nothing inspected the transport. That is precisely how the
//      PSK-DM failure masqueraded as a device fault. Transport is now asserted.
//
// Rig per specs/device-comms.md — do NOT invent a new path:
//   send  : POST http://<node-dash>/<gw>/messages  {text, channel}
//   observe: GET  http://<node-dash>/messages      (correlate on reply_id)

const DEFAULTS = {
  host: 'localhost:8000',      // node-dash (proxies mesh-gw)
  gw: '!2687afb1',             // OMNI gateway
  channel: 2,                  // private channel; 0 is refused outright
  pollMs: 200,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

async function getMessages(host) {
  const r = await fetch(`http://${host}/messages`);
  if (!r.ok) throw new Error(`GET /messages -> ${r.status}`);
  const d = await r.json();
  return Array.isArray(d) ? d : (d.messages || d);
}

async function sendCmd(host, gw, text, channel) {
  const r = await fetch(`http://${host}/${gw}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel }),
  });
  if (!r.ok) throw new Error(`POST -> ${r.status}`);
  const j = await r.json();
  if (j.id == null) throw new Error(`gateway returned no packet id: ${JSON.stringify(j)}`);
  return j.id >>> 0;
}

// Pull the device-reported uptime / firmware out of a JSON reply, when present.
// upt going BACKWARDS across a run means the device rebooted — that invalidates the
// whole run, and must be shouted rather than averaged into a latency figure.
function parseDeviceState(text) {
  try {
    const j = JSON.parse(text);
    return { upt: typeof j.upt === 'number' ? j.upt : null, fw: j.fw || null, type: j.type || null };
  } catch { return { upt: null, fw: null, type: null }; }
}

/**
 * Run a command set and analyse every exchange.
 * opts: { host, gw, channel, target, verb, count, intervalMs, windowMs,
 *         targetNode (uint32, required for identity assertion),
 *         expectTransport: 'broadcast' | 'dm' | 'any' }
 */
async function runCommands(opts) {
  const o = { ...DEFAULTS, ...opts };
  if (o.channel === 0) throw new Error('channel 0 refused — never flood the public mesh');
  if (!o.targetNode) throw new Error('targetNode required: identity cannot be asserted without it');

  const before = await getMessages(o.host);
  const baselineId = before.reduce((m, x) => Math.max(m, x.id || 0), 0);

  const recs = [];
  for (let seq = 1; seq <= o.count; seq++) {
    const text = `@${o.target} ${o.verb}`;
    const sentAt = Date.now();
    let packetId = null, sendErr = null;
    try { packetId = await sendCmd(o.host, o.gw, text, o.channel); }
    catch (e) { sendErr = e.message; }
    recs.push({ seq, text, packetId, sentAt, sendErr, reply: null, verdict: null });
    if (seq < o.count) await sleep(o.intervalMs);
  }

  // Observe until every command is answered or the window closes. The window is
  // measured from the LAST send; queue drain grows with burst depth, so a caller
  // running a burst must size it accordingly.
  const deadline = Date.now() + o.windowMs;
  const byPacket = new Map(recs.filter((r) => r.packetId != null).map((r) => [r.packetId, r]));
  let arrival = 0;
  const seenMsgIds = new Set();
  const unmatched = [];   // replies correlating to nothing we sent
  const duplicates = [];  // second+ reply carrying a reply_id we already matched

  const collect = (msgs, late) => {
    for (const m of msgs) {
      const id = m.id || 0;
      if (id <= baselineId || seenMsgIds.has(id)) continue;
      const rid = (m.reply_id || 0) >>> 0;
      if (!rid) continue;
      seenMsgIds.add(id);
      const rec = byPacket.get(rid);
      if (!rec) { unmatched.push({ id, reply_id: rid, from_num: m.from_num, text: m.text }); continue; }
      const dev = parseDeviceState(m.text || '');
      const entry = {
        msgId: id, ts: m.ts, replyId: rid, from_num: m.from_num, to_num: m.to_num,
        is_dm: !!m.is_dm, channel: m.channel, hop_limit: m.hop_limit, hops: m.hops,
        snr: m.snr, rssi: m.rssi, text: m.text, ...dev,
        recvAt: late ? (m.ts ? m.ts * 1000 : Date.now()) : Date.now(),
        late,
      };
      if (rec.reply) { duplicates.push(entry); continue; } // retransmit / dupe evidence
      entry.arrival = ++arrival;
      entry.latency = entry.recvAt - rec.sentAt;
      rec.reply = entry;
    }
  };

  while (Date.now() < deadline) {
    try { collect(await getMessages(o.host), false); } catch { /* transient */ }
    if (recs.every((r) => r.reply || r.sendErr)) break;
    await sleep(o.pollMs);
  }
  // Post-window sweep: a reply that lands just after the window is LATE, not absent.
  // This is the exact boundary that produced a false "no reply" today.
  await sleep(1500);
  try { collect(await getMessages(o.host), true); } catch { /* transient */ }

  // ---- verdicts -----------------------------------------------------------
  for (const r of recs) {
    const p = r.reply;
    const checks = [];
    if (r.sendErr) { r.verdict = 'SEND_FAIL'; r.why = r.sendErr; continue; }
    if (!p) { r.verdict = 'ABSENT'; r.why = `no reply within ${o.windowMs} ms`; continue; }
    if (p.replyId !== r.packetId) checks.push(`reply_id ${hex(p.replyId)} != cmd ${hex(r.packetId)}`);
    if (p.from_num !== o.targetNode) checks.push(`answered by ${p.from_num}, expected ${o.targetNode}`);
    if (o.channel != null && p.channel != null && p.channel !== o.channel)
      checks.push(`channel ${p.channel}, expected ${o.channel}`);
    if (o.expectTransport === 'dm' && !p.is_dm) checks.push('expected DM, got BROADCAST');
    if (o.expectTransport === 'broadcast' && p.is_dm) checks.push('expected BROADCAST, got DM');
    if (checks.length) { r.verdict = 'WRONG'; r.why = checks.join('; '); }
    else if (p.late) { r.verdict = 'LATE'; r.why = `arrived after the ${o.windowMs} ms window`; }
    else r.verdict = 'OK';
  }

  // Reboot detection: device uptime must be non-decreasing across the run.
  const upts = recs.filter((r) => r.reply && r.reply.upt != null)
                   .map((r) => ({ seq: r.seq, upt: r.reply.upt }));
  let rebooted = null;
  for (let i = 1; i < upts.length; i++)
    if (upts[i].upt < upts[i - 1].upt)
      rebooted = `upt went ${upts[i - 1].upt}s (#${upts[i - 1].seq}) -> ${upts[i].upt}s (#${upts[i].seq})`;

  return { opts: o, recs, unmatched, duplicates, rebooted, upts };
}

function report(res) {
  const { recs, unmatched, duplicates, rebooted, opts } = res;
  const got = recs.filter((r) => r.reply);
  const lat = got.map((r) => r.reply.latency).sort((a, b) => a - b);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;

  console.log('\n  seq  cmd pkt      reply msg  reply_id     from        transport  ch  hops  snr/rssi     upt  latency  verdict');
  for (const r of recs) {
    const p = r.reply;
    const tr = p ? (p.is_dm ? 'DM' : 'BROADCAST') : '—';
    console.log(
      `  #${String(r.seq).padEnd(3)} ${r.packetId != null ? hex(r.packetId) : '—'.padEnd(10)}  ` +
      `${p ? String(p.msgId).padEnd(9) : '—'.padEnd(9)}  ${p ? hex(p.replyId) : '—'.padEnd(10)}  ` +
      `${p ? String(p.from_num).padEnd(10) : '—'.padEnd(10)}  ${tr.padEnd(9)}  ` +
      `${p && p.channel != null ? String(p.channel).padEnd(2) : ' —'}  ` +
      `${p && p.hops != null ? String(p.hops).padEnd(4) : '  — '}  ` +
      `${p ? `${p.snr ?? '—'}/${p.rssi ?? '—'}`.padEnd(11) : '—'.padEnd(11)}  ` +
      `${p && p.upt != null ? String(p.upt).padStart(4) : '   —'}  ` +
      `${p ? String(p.latency).padStart(6) + 'ms' : '     —  '}  ${r.verdict}` +
      (r.why ? `  (${r.why})` : ''));
  }

  const sendOrder = recs.filter((r) => r.reply).map((r) => r.seq);
  const arrOrder = got.slice().sort((a, b) => a.reply.arrival - b.reply.arrival).map((r) => r.seq);
  const reordered = JSON.stringify(sendOrder) !== JSON.stringify(arrOrder);

  console.log(`\n  latency min/avg/max : ${lat[0] ?? '—'}/${avg ?? '—'}/${lat[lat.length - 1] ?? '—'} ms`);
  console.log(`  arrival order       : [${arrOrder.join(',')}]${reordered ? '  REORDERED vs send' : ''}`);
  console.log(`  duplicate replies   : ${duplicates.length}` +
              (duplicates.length ? `  (same reply_id seen again — retransmit/dupe)` : ''));
  console.log(`  unmatched replies   : ${unmatched.length}` +
              (unmatched.length ? `  (correlate to no command we sent)` : ''));
  console.log(`  device uptime       : ${res.upts.map((u) => u.upt + 's').join(' -> ') || '—'}`);
  if (rebooted) console.log(`  *** DEVICE REBOOTED MID-RUN: ${rebooted} — run is INVALID ***`);

  const ok = recs.every((r) => r.verdict === 'OK');
  const pass = ok && !rebooted;
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'}: ${recs.filter(r => r.verdict === 'OK').length}/${recs.length} OK` +
              `, ${recs.filter(r => r.verdict === 'LATE').length} late` +
              `, ${recs.filter(r => r.verdict === 'ABSENT').length} absent` +
              `, ${recs.filter(r => r.verdict === 'WRONG').length} wrong` +
              `, expected transport = ${opts.expectTransport}`);
  return pass;
}

module.exports = { runCommands, report, DEFAULTS };
