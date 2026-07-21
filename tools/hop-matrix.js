#!/usr/bin/env node
'use strict';
// hop-matrix.js — round-trip latency + loss for every data type at every hop.
//
// Needs firmware with the `hop` command (task hop-latency-matrix): `hop <n>` forces
// EVERY outbound frame's hop_limit to n (RAM-only). The harness sweeps n and, at each,
// exercises each command-triggerable data type, timing command -> reply. It listens on
// the Client's decoded event stream ('reply' for TEXT, 'payload' for port-260) — NOT
// /messages polling, which drops 260 and "t"-keyed frames.
//
// Interleaved across hops (drift hits every hop equally), N reps. Restores `hop 0` on exit
// (also clears on reboot). Reports min/median/max + loss per (type × hop).
//
// Usage: node tools/hop-matrix.js [hops] [reps] [--chunk]
//   hops default "0,1,2,3", reps default 3, --chunk adds a 32-chunk push per cell (slow).

const { Client } = require('/usr/share/pac/dev/pio/projects/mt-transport/clients/node');
const fs = require('fs');

const TARGET  = process.env.TARGET  || '336b';
const GATEWAY = process.env.GATEWAY || '!2687afb1';
const HOST    = process.env.HOST    || 'localhost:8000';
const HOPS = (process.argv[2] || '0,1,2,3').split(',').map(s => parseInt(s, 10));
const REPS = parseInt(process.argv[3] || '3', 10);
const DO_CHUNK = process.argv.includes('--chunk');
const REPLY_DEADLINE = 60000, CHUNK_DEADLINE = 180000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The command-triggerable data types. ev: which Client event carries the reply;
// obj arg differs ('reply' -> args[0], 'payload' -> args[1]).
const TYPES = [
  { name: 'ping',   text: t => `@${t} ping`,   ev: 'reply',   ok: o => o && o.type === 'pong'   },
  { name: 'env',    text: t => `@${t} env`,    ev: 'reply',   ok: o => o && o.type === 'env'    },
  { name: 'status', text: t => `@${t} status`, ev: 'reply',   ok: o => o && o.type === 'status' },
  { name: 'config', text: t => `@${t} config`, ev: 'reply',   ok: o => o && o.type === 'config' },
  { name: 'debug',  text: t => `@${t} debug`,  ev: 'payload', ok: o => o && o.type === 'debug'  },
  { name: 'sch',    text: t => `@${t} sch 0`,  ev: 'payload', ok: o => o && o.t    === 'sch'    },
];

function awaitMatch(c, ev, ok, timeoutMs) {
  return new Promise(res => {
    let done = false;
    const h = (...args) => {
      const obj = ev === 'payload' ? args[1] : args[0];
      if (!done && ok(obj)) { done = true; c.events.off(ev, h); res(obj); }
    };
    c.events.on(ev, h);
    setTimeout(() => { if (!done) { done = true; c.events.off(ev, h); res(null); } }, timeoutMs);
  });
}

async function setHop(c, n) {
  for (let a = 0; a < 3; a++) {
    const p = awaitMatch(c, 'reply', o => o && o.type === 'hop' && o.n === n, 8000);
    await c._sendText(`@${TARGET} hop ${n}`);
    if (await p) return true;
  }
  return false;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

(async () => {
  const c = new Client({ host: HOST, gatewayId: GATEWAY, channel: 2 });
  await c.connect();
  console.log(`hop-matrix: target=${TARGET} hops=[${HOPS}] reps=${REPS} chunk=${DO_CHUNK}\n`);
  const rec = {};                       // rec[type][hop] = [ms|null,...]
  const names = [...TYPES.map(t => t.name), ...(DO_CHUNK ? ['chunk'] : [])];
  const CSV = process.env.RESULTS || __dirname + '/hop-matrix-results.csv';
  fs.writeFileSync(CSV, 'iso,rep,hop,type,ms,ok\n');   // fresh log per run
  const push = (rep, type, hop, ms) => {
    (rec[type] ??= {}); (rec[type][hop] ??= []).push(ms);
    fs.appendFileSync(CSV, `${new Date().toISOString()},${rep},${hop},${type},${ms ?? ''},${ms != null}\n`);
  };

  // Cumulative table — printed after every hop block so partial results are usable
  // the moment they exist (and re-derivable anytime from the CSV).
  const printTable = (label) => {
    console.log(`\n== ${label} ==`);
    console.log('         ' + HOPS.map(h => `hop${h}`.padStart(11)).join(''));
    for (const nm of names) {
      let line = nm.padEnd(9);
      for (const hop of HOPS) {
        const xs = (rec[nm]?.[hop]) || [];
        const good = xs.filter(v => v != null).map(v => v / 1000);
        const loss = xs.length - good.length;
        line += (good.length ? `${median(good).toFixed(1)}s ${loss}/${xs.length}L`
                             : `-- ${loss}/${xs.length}L`).padStart(11);
      }
      console.log(line);
    }
  };

  for (let rep = 0; rep < REPS; rep++) {
    for (const hop of HOPS) {           // interleaved
      if (!(await setHop(c, hop))) console.log(`  [hop ${hop} set UNCONFIRMED]`);
      for (const ty of TYPES) {
        const t0 = Date.now();
        const p = awaitMatch(c, ty.ev, ty.ok, REPLY_DEADLINE);
        await c._sendText(ty.text(TARGET));
        const obj = await p;
        push(rep, ty.name, hop, obj ? Date.now() - t0 : null);
        process.stdout.write(`  r${rep} hop${hop} ${ty.name}:${obj ? ((Date.now()-t0)/1000).toFixed(1)+'s' : 'LOSS'}`);
        await sleep(3000);   // let the rebroadcast tail / device queue drain between samples
      }
      if (DO_CHUNK) {
        try { await c.command(TARGET, 'pushPub'); } catch {}
        await sleep(1500);
        const t0 = Date.now(); let ok = false;
        try { const b = await c.push(TARGET, 1, { deadlineMs: CHUNK_DEADLINE }); ok = !!b; } catch {}
        push(rep, 'chunk', hop, ok ? Date.now() - t0 : null);
        process.stdout.write(`  chunk:${ok ? ((Date.now()-t0)/1000).toFixed(1)+'s' : 'LOSS'}`);
      }
      process.stdout.write('\n');
      printTable(`running after rep ${rep}, hop ${hop} (log: ${CSV})`);
    }
  }

  const restored = await setHop(c, 0);
  console.log(`\nrestored hop -> 0 (defaults): ${restored ? 'confirmed' : 'UNCONFIRMED — CHECK UNIT'}`);
  printTable('FINAL');
  console.log('\n(cell = median round-trip · losses/attempts)  full log: ' + CSV);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
