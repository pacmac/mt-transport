#!/usr/bin/env node
'use strict';
// hop-ab.js — controlled A/B of chunk hop_limit vs push transfer time.
//
// Why a script: ad-hoc curls give inconsistent reads (channel drift, queue
// state, human timing). This fixes the payload (the embedded TEST image, pid 1,
// so size is constant) and varies ONLY the chunk hop, INTERLEAVED across reps so
// drift hits every hop equally. It restores hop 1 (the persisted default) on exit
// — chunk cfg persists to flash, so a test value must never be left on the unit.
//
// Usage:  node tools/hop-ab.js [hops] [reps] [pid]
//   hops : comma list, default "1,0,3"
//   reps : repetitions per hop, default 3
//   pid  : payload to push, default 1 (embedded TEST image = constant 32 chunks).
//          Pass a hash pid from a fresh `cam grab` for a smaller/faster payload.
//
// Measures END-TO-END push time (command -> CRC-verified complete) per hop.
// It does NOT count rebroadcast dupes (that needs raw 261 capture, which the WS
// tooling here is flaky on); time + received/count + loss are the reliable signal.

const { Client } = require('/usr/share/pac/dev/pio/projects/mt-transport/clients/node');
const http = require('http');

const TARGET  = process.env.TARGET  || '336b';
const GATEWAY = process.env.GATEWAY || '!2687afb1';
const HOST    = process.env.HOST    || 'localhost:8000';
const HOPS = (process.argv[2] || '1,0,3').split(',').map(s => parseInt(s, 10));
const REPS = parseInt(process.argv[3] || '3', 10);
const PID  = parseInt(process.argv[4] || '1', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getMessages() {
  return new Promise(res => {
    http.get(`http://${HOST}/messages`, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { const j = JSON.parse(b); res(Array.isArray(j) ? j : (j.messages || [])); } catch { res([]); } });
    }).on('error', () => res([]));
  });
}

// Send `chunk cfg <hop>` and confirm the device echoed {"type":"chunkcfg","hop":hop}.
// Retries the send (the reply can be lost on a ~17% link). Returns true if confirmed.
async function setHop(c, hop) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const since = Math.max(0, ...(await getMessages())
      .filter(m => m.from_num === 2364420971).map(m => m.id));
    await c._sendText(`@${TARGET} chunk cfg ${hop}`);
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const hit = (await getMessages()).find(m =>
        m.from_num === 2364420971 && m.id > since &&
        /"type":"chunkcfg"/.test(m.text || '') &&
        new RegExp(`"hop":${hop}\\b`).test(m.text || ''));
      if (hit) return true;
    }
  }
  return false;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

(async () => {
  const c = new Client({ host: HOST, gatewayId: GATEWAY, channel: 2 });
  await c.connect();
  console.log(`hop-ab: target=${TARGET} pid=${PID} hops=[${HOPS}] reps=${REPS}\n`);
  const rows = [];

  for (let rep = 0; rep < REPS; rep++) {
    for (const hop of HOPS) {                       // interleaved, not batched
      const cfgOk = await setHop(c, hop);
      await c.command(TARGET, 'pushPub', PID === 1 ? undefined : PID); // (re)publish payload
      await sleep(1500);
      let recv = 0, count = 0, ok = false, err = '';
      const t0 = Date.now();
      try {
        const buf = await c.push(TARGET, PID, {
          deadlineMs: 180000,
          onProgress: p => { recv = p.received; count = p.count; },
        });
        ok = !!buf && buf.length > 0;
      } catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      rows.push({ hop, rep, ms, recv, count, ok, cfgOk });
      console.log(`  rep ${rep} hop ${hop}: ${ok ? (ms / 1000).toFixed(1) + ' s' : 'FAIL(' + err + ')'}` +
                  `  ${recv}/${count}${cfgOk ? '' : '  [cfg UNCONFIRMED]'}`);
      await sleep(2000);
    }
  }

  const restored = await setHop(c, 1);              // persisted default — always restore
  console.log(`\nrestored chunk hop -> 1 : ${restored ? 'confirmed' : 'UNCONFIRMED — CHECK THE UNIT'}`);

  console.log('\nhop |  n | ok | min(s) | median(s) | max(s)');
  console.log('----+----+----+--------+-----------+-------');
  for (const hop of HOPS) {
    const good = rows.filter(r => r.hop === hop && r.ok);
    const all  = rows.filter(r => r.hop === hop);
    const t = good.map(r => r.ms / 1000);
    const f = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '  -';
    console.log(` ${String(hop).padStart(2)} | ${String(all.length).padStart(2)} | ${String(good.length).padStart(2)} | ` +
                `${f(Math.min(...t)).padStart(6)} | ${f(median(t)).padStart(9)} | ${f(Math.max(...t)).padStart(6)}`);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
