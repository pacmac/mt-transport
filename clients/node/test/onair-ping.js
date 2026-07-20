#!/usr/bin/env node
'use strict';
// onair-ping.js — ON-AIR verification harness for the private mesh command path.
//
// Requires the LIVE rig (mesh-gw + node-dash + OMNI) — see specs/device-comms.md.
// It sends N commands to a unit through the gateway and correlates each reply by
// reply_id == the command's packet_id (the id the gateway returns from POST). It
// reports:
//   - messages LOST (sent, never answered) — the no-message-loss check
//   - per-command LATENCY (send -> reply seen), min / avg / max
//   - with --sweep, the FASTEST send interval that still loses nothing
//
// This is the regression tool for the nonblocking-radio work (specs/nonblocking-
// radio.md): run it after any radio-path change. No external deps (Node >= 18
// global fetch). Exit code 0 = no loss, 1 = loss or error.
//
// Usage:
//   node clients/node/test/onair-ping.js [options]
//     --host <h>       gateway host           (default localhost:8000)
//     --gw <id>        gateway node id        (default !2687afb1, OMNI)
//     --channel <n>    private channel        (default 2; 0/PRIMARY refused)
//     --target <sfx>   unit suffix|shortname  (default 336b, the bench unit)
//     --verb <v>       command verb           (default ping)
//     --count <n>      commands per run       (default 5)
//     --interval <ms>  spacing between sends  (default 2000)
//     --timeout <ms>   observation window     (default 60000; raise for slow tails)
//     --sweep          sweep intervals to find the fastest lossless one
//     --help           this help
//
// NOTE: each command reply is sent twice by the firmware (reply + spaced resend),
// so a burst enqueues ~2 frames per command — at very short intervals the device's
// TX queue is the throughput limit, which is exactly what --sweep exposes.

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sweep' || a === '--help') { o[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const HOST = args.host || 'localhost:8000';
const GW = args.gw || '!2687afb1';
const CHANNEL = args.channel != null ? Number(args.channel) : 2;
const TARGET = args.target || '336b';
const VERB = args.verb || 'ping';
// Observation window. Replies can lag TENS OF SECONDS to minutes under a burst
// (queue + half-duplex + CAD backoff), so this is generous by default. A command
// with no reply by here is reported honestly as "no reply within Ns" — NOT
// "lost"; raise --timeout to watch a slow tail land. Replies stream live as they
// arrive, so you see progress regardless.
const TIMEOUT = args.timeout != null ? Number(args.timeout) : 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  console.log(src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

async function getMessages() {
  const r = await fetch(`http://${HOST}/messages`);
  if (!r.ok) throw new Error(`GET /messages -> ${r.status}`);
  return r.json();
}

// Send one command; return the packet id the gateway assigned (replies echo it as
// reply_id). This is the correlation key — never a text/content match.
async function sendCmd() {
  const r = await fetch(`http://${HOST}/${GW}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `@${TARGET} ${VERB}`, channel: CHANNEL }),
  });
  if (!r.ok) throw new Error(`POST /${GW}/messages -> ${r.status}`);
  const j = await r.json();
  if (j.id == null) throw new Error(`no packet id in gateway response: ${JSON.stringify(j)}`);
  return j.id >>> 0;
}

const maxId = (msgs) => msgs.reduce((m, x) => Math.max(m, x.id || 0), 0);

// One run: send `count` commands `interval` ms apart, then wait up to TIMEOUT after
// the last send for outstanding replies. Correlates by reply_id. Returns records.
async function runBurst(count, interval) {
  const baseline = maxId(await getMessages()); // ignore pre-existing replies
  const pending = new Map();                    // packetId -> record
  let stop = false;
  let arrival = 0;                              // order replies are observed in

  const poller = (async () => {
    while (!stop) {
      let msgs;
      try { msgs = await getMessages(); } catch { await sleep(150); continue; }
      const now = Date.now();
      for (const m of msgs) {
        if ((m.id || 0) <= baseline) continue;
        const rec = pending.get((m.reply_id) >>> 0);
        if (rec && rec.recvAt == null) {
          rec.recvAt = now;
          rec.latency = now - rec.sentAt;
          rec.text = m.text;
          rec.arrival = ++arrival;   // 1-based order this reply was seen
          // Stream live: a slow tail reply prints the instant it lands, so a long
          // latency is visible as it happens, not silently pending.
          if (!args.sweep)
            console.log(`    <- reply to #${rec.seq} after ${(rec.latency / 1000).toFixed(1)}s  (arrival ${rec.arrival})`);
        }
      }
      await sleep(120);
    }
  })();

  for (let seq = 1; seq <= count; seq++) {
    const sentAt = Date.now();
    let id;
    try { id = await sendCmd(); }
    catch (e) { console.error(`  send #${seq} failed: ${e.message}`); if (seq < count) await sleep(interval); continue; }
    pending.set(id, { seq, packetId: id, sentAt, recvAt: null, latency: null, text: null });
    if (seq < count) await sleep(interval);
  }

  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if ([...pending.values()].every((r) => r.recvAt != null)) break;
    await sleep(150);
  }
  const windowEnd = Date.now();
  stop = true;
  await poller;

  // Final sweep AFTER the window: a reply that lands late is NOT lost — it failed
  // the latency budget, which is a different (and honest) result than a dropped
  // message. Only a command with no reply at all, even here, is truly lost. Late
  // arrivals use the feed's ts (second resolution) since we stopped polling.
  try {
    const msgs = await getMessages();
    for (const m of msgs) {
      if ((m.id || 0) <= baseline) continue;
      const rec = pending.get((m.reply_id) >>> 0);
      if (rec && rec.recvAt == null) {
        rec.late = true;
        rec.recvAt = (m.ts || 0) * 1000 || windowEnd;
        rec.latency = rec.recvAt - rec.sentAt;
        rec.text = m.text;
        rec.arrival = ++arrival;
      }
    }
  } catch { /* leave as no-reply */ }

  for (const r of pending.values())
    r.inWindow = r.recvAt != null && !r.late;
  return [...pending.values()].sort((a, b) => a.seq - b.seq);
}

function summarize(recs) {
  const got = recs.filter((r) => r.recvAt != null);
  // noReply = no reply seen AT ALL, even in the final feed sweep. This is NOT
  // "lost" — a slow reply may still land after the window; raise --timeout.
  const noReply = recs.filter((r) => r.recvAt == null);
  const late = got.filter((r) => r.late); // arrived, but after the live poll window
  const lats = got.map((r) => r.latency).sort((a, b) => a - b);
  const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
  // Arrival order (by observed sequence) vs send order — reordering is a queue
  // signal, not a fault by itself, but worth surfacing.
  const arrivalOrder = got.filter((r) => r.arrival).sort((a, b) => a.arrival - b.arrival).map((r) => r.seq);
  const sendOrder = got.map((r) => r.seq).sort((a, b) => a - b);
  const reordered = JSON.stringify(arrivalOrder) !== JSON.stringify(sendOrder);
  return { sent: recs.length, received: got.length, noReply, late,
           min: lats[0] ?? null, avg, max: lats[lats.length - 1] ?? null,
           arrivalOrder, reordered };
}

(async () => {
  if (args.help) { usage(); return; }
  if (CHANNEL === 0) throw new Error('channel 0 (PRIMARY) refused — use the private channel');
  console.log(`onair-ping: @${TARGET} ${VERB}  via ${GW} ch${CHANNEL}  @ ${HOST}\n`);

  if (args.sweep) {
    const count = args.count != null ? Number(args.count) : 5;
    const intervals = [3000, 2000, 1500, 1000, 750, 500, 300, 200, 100];
    console.log(`sweep: ${count} commands at each interval, ${TIMEOUT}ms reply window\n`);
    let fastestClean = null;
    for (const iv of intervals) {
      const s = summarize(await runBurst(count, iv));
      const clean = s.noReply.length === 0 && s.late.length === 0;
      const tag = s.noReply.length ? 'MISS' : (s.late.length ? 'LATE' : 'OK  ');
      console.log(`  interval ${String(iv).padStart(4)}ms  ${tag}  ${s.received}/${s.sent} in-window  ` +
                  `lat min/avg/max = ${s.min}/${s.avg}/${s.max} ms  ` +
                  `arrival[${s.arrivalOrder.join(',')}]${s.reordered ? ' REORDERED' : ''}` +
                  (s.noReply.length ? `  no-reply ${s.noReply.length}` : '') +
                  (s.late.length ? `  late ${s.late.length}` : ''));
      if (clean) fastestClean = iv;
      await sleep(2000); // let the mesh settle between runs
    }
    console.log(`\nFastest interval with all replies in-window (0 miss, 0 late): ` +
                `${fastestClean != null ? fastestClean + ' ms' : 'NONE at intervals tested (raise --timeout?)'}`);
    process.exit(fastestClean != null ? 0 : 1);
  }

  const count = args.count != null ? Number(args.count) : 5;
  const interval = args.interval != null ? Number(args.interval) : 2000;
  console.log(`sending ${count} commands ${interval}ms apart, ${TIMEOUT}ms reply window\n`);
  const recs = await runBurst(count, interval);
  const t0 = Math.min(...recs.map((r) => r.sentAt));
  const rel = (t) => (t == null ? '   —' : '+' + String(Math.round((t - t0))).padStart(5) + 'ms');
  const uptOf = (r) => { const m = r.text && /"upt":(\d+)/.exec(r.text); return m ? m[1] : '?'; };
  const secs = (TIMEOUT / 1000).toFixed(0);
  console.log('\n  seq  pkt         sent@      reply@       latency  arr#  dev.upt  status');
  for (const r of recs) {
    const status = r.recvAt == null ? `no reply within ${secs}s` : (r.late ? 'late (>window)' : 'ok');
    console.log(`  #${r.seq}   0x${r.packetId.toString(16).padStart(8, '0')}  ${rel(r.sentAt)}  ${rel(r.recvAt)}  ` +
                `${(r.latency != null ? (r.latency / 1000).toFixed(1) + 's' : '—').padStart(8)}  ` +
                `${(r.arrival || '—').toString().padStart(3)}   ${uptOf(r).padStart(6)}   ${status}`);
  }
  const s = summarize(recs);
  // Inter-arrival gaps in observed order — shows whether replies stream out evenly
  // or bunch up behind the queue.
  const arrivals = recs.filter((r) => r.recvAt != null).sort((a, b) => a.recvAt - b.recvAt);
  const gaps = arrivals.slice(1).map((r, i) => ((r.recvAt - arrivals[i].recvAt) / 1000).toFixed(1) + 's');
  console.log(`\nsend order:    [${recs.map((r) => r.seq).join(',')}]`);
  console.log(`arrival order: [${s.arrivalOrder.join(',')}]${s.reordered ? '   <-- REORDERED vs send' : ''}`);
  if (gaps.length) console.log(`inter-arrival gaps: [${gaps.join(', ')}]`);
  console.log(`\n${s.received}/${s.sent} answered within ${secs}s (${s.late.length} of them late); ` +
              `${s.noReply.length} with no reply yet` +
              (s.received ? `\nlatency min/avg/max = ${(s.min / 1000).toFixed(1)}/${(s.avg / 1000).toFixed(1)}/${(s.max / 1000).toFixed(1)} s` : ''));
  if (s.noReply.length)
    console.log('no-reply-yet packet ids (may still land — raise --timeout, or check the feed): ' +
                s.noReply.map((r) => '0x' + r.packetId.toString(16)).join(', '));
  const clean = s.noReply.length === 0 && s.late.length === 0;
  console.log(clean ? `PASS: all ${s.sent} answered in-window.`
                    : `RESULT: ${s.noReply.length} no reply within ${secs}s, ${s.late.length} late — a latency result, verify slow ones in the feed.`);
  process.exit(clean ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
