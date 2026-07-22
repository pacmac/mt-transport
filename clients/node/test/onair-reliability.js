#!/usr/bin/env node
'use strict';
// onair-reliability.js — ON-AIR verification of the v2 Phase 1 reliability layer.
// STAGED FOR THE BENCH: needs the live rig (mesh-gw + node-dash + OMNI) and the
// bench unit !8cee336b. NOT self-runnable in CI. See specs/v2-phase1.md.
//
// WHAT PHASE 1 GUARANTEES (the CONTRACT this asserts):
//   A directed reply sent with want_ack is retransmitted (verbatim, same packet id)
//   until a routing ACK arrives or the attempt budget is spent; a delivered ACK
//   STOPS retransmission. Broadcasts never carry want_ack.
//
// HOW WE PROVE IT WITHOUT TRUSTING TIMING (no-hallucinate):
//   The device exposes cumulative ack counters (ackRetransmits, ackFailTotal,
//   pendingAckId) — surfaced in the `debug` reply (Phase 1 firmware-end task adds
//   the fields). We read them as a CAUSAL SIDE EFFECT:
//     1. Read counters (baseline).
//     2. Drive directed want_ack replies through the normal command path.
//     3. Read counters again.
//   PASS when, over the run: replies are delivered AND ackFailTotal did NOT climb
//   (nothing went unrecovered). Any retransmits that occurred (ackRetransmits up)
//   are the mechanism working on real loss — reported, not failed on.
//
// FORCING A HARD DROP (the strongest proof) needs a device-side ACK-suppression
// debug hook (withhold the outbound ACK for one id) so a retransmit is guaranteed
// and observable as a same-id duplicate. That hook is a follow-up; until then this
// harness proves the counters move correctly under natural loss and never strand a
// reply (ackFailTotal flat). Documented honestly rather than faked.
//
// Usage:
//   node clients/node/test/onair-reliability.js [--host h] [--gw id]
//        [--channel n] [--target sfx] [--count n] [--interval ms] [--timeout ms]
//   Defaults mirror onair-ping.js (localhost:8000, !2687afb1, ch2, 336b).

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { o.help = true; continue; }
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const HOST = args.host || 'localhost:8000';
const GW = args.gw || '!2687afb1';
const CHANNEL = args.channel != null ? Number(args.channel) : 2;
const TARGET = args.target || '336b';
const COUNT = args.count != null ? Number(args.count) : 10;
const INTERVAL = args.interval != null ? Number(args.interval) : 2500;
const TIMEOUT = args.timeout != null ? Number(args.timeout) : 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getMessages() {
  const r = await fetch(`http://${HOST}/messages`);
  if (!r.ok) throw new Error(`GET /messages -> ${r.status}`);
  return r.json();
}
async function sendCmd(verb) {
  const r = await fetch(`http://${HOST}/${GW}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `@${TARGET} ${verb}`, channel: CHANNEL }),
  });
  if (!r.ok) throw new Error(`POST -> ${r.status}`);
  const j = await r.json();
  if (j.id == null) throw new Error(`no packet id: ${JSON.stringify(j)}`);
  return j.id >>> 0;
}

// Read the device ack counters (ackr/ackf) out of the debug frame.
//
// NOTE ON CORRELATION: `debug` does NOT produce a text reply — broadcastDebug()
// sends the debug JSON on PAC_ALARM_APP (260) as a BROADCAST with no request_id,
// so there is no reply_id to correlate on. We therefore match by CONTENT
// (type=="debug" carrying ackr/ackf) among messages newer than the baseline, and
// take the newest. If the gateway does not surface port-260 payloads in
// /messages, read them from node-dash's 260 feed instead (lib/index.js parse260)
// — do not "fix" this by matching a text reply that the firmware never sends.
async function readAckCounters() {
  const baseline = (await getMessages()).reduce((m, x) => Math.max(m, x.id || 0), 0);
  await sendCmd('debug');
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const msgs = await getMessages();
    let best = null;
    for (const m of msgs) {
      if ((m.id || 0) <= baseline) continue;
      try {
        const j = JSON.parse(m.text);
        if (j.type === 'debug' && (j.ackr != null || j.ackf != null))
          if (!best || (m.id || 0) > best.id) best = { id: m.id || 0, j };
      } catch { /* not the debug json */ }
    }
    if (best)
      return { ackRetransmits: best.j.ackr >>> 0, ackFailTotal: best.j.ackf >>> 0, raw: best.j };
    await sleep(200);
  }
  return null;
}

(async () => {
  if (args.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (CHANNEL === 0) throw new Error('channel 0 (PRIMARY) refused — use the private channel');
  console.log(`onair-reliability: @${TARGET} via ${GW} ch${CHANNEL} @ ${HOST}\n`);

  const before = await readAckCounters();
  if (!before) {
    console.error('FAIL: could not read ack counters from the debug frame. Is the Phase 1 '
      + 'firmware-end (ackr/ackf in broadcastDebug) flashed on the bench unit, and does the '
      + 'gateway surface port-260 payloads? Aborting — not faking a pass.');
    process.exit(2);
  }
  console.log(`baseline: ackRetransmits=${before.ackRetransmits} ackFailTotal=${before.ackFailTotal}`);

  // Drive directed want_ack replies through the normal command path (status is a
  // comfort reply -> DM+want_ack in v2). Correlate delivery by reply_id.
  const baseline = (await getMessages()).reduce((m, x) => Math.max(m, x.id || 0), 0);
  const pending = new Map();
  for (let seq = 1; seq <= COUNT; seq++) {
    try { pending.set(await sendCmd('status'), { seq, got: false }); }
    catch (e) { console.error(`  send #${seq}: ${e.message}`); }
    if (seq < COUNT) await sleep(INTERVAL);
  }
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const msgs = await getMessages();
    for (const m of msgs) {
      if ((m.id || 0) <= baseline) continue;
      const rec = pending.get((m.reply_id) >>> 0);
      if (rec) rec.got = true;
    }
    if ([...pending.values()].every((r) => r.got)) break;
    await sleep(200);
  }
  const delivered = [...pending.values()].filter((r) => r.got).length;

  const after = await readAckCounters();
  if (!after) { console.error('FAIL: could not re-read ack counters.'); process.exit(2); }
  const retransmits = after.ackRetransmits - before.ackRetransmits;
  const fails = after.ackFailTotal - before.ackFailTotal;

  console.log(`\ndelivered ${delivered}/${COUNT} status replies`);
  console.log(`ackRetransmits +${retransmits}  (mechanism engaged on real loss — informational)`);
  console.log(`ackFailTotal   +${fails}  (reliable sends left UNRECOVERED — must be 0)`);

  // CONTRACT: every reliable reply was eventually confirmed. Retransmits are fine
  // (that is the layer doing its job); an unrecovered fail is the failure.
  const pass = fails === 0 && delivered === COUNT;
  console.log(pass
    ? `\nPASS: all ${COUNT} confirmed, 0 unrecovered (${retransmits} retransmit(s) absorbed loss).`
    : `\nRESULT: ${COUNT - delivered} undelivered, ${fails} unrecovered — investigate the link/budget.`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
