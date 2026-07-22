#!/usr/bin/env node
'use strict';
// onair-ping.js — ON-AIR health / regression check for the private command path.
//
// Built on test/lib/onair.js, which ANALYSES each exchange rather than counting
// replies. A PASS here means: the targeted unit answered THAT command (reply_id
// correlated), over the expected transport, on the private channel, within the
// window, and the device did not reboot mid-run.
//
// Requires the live rig (mesh-gw + node-dash + OMNI) — specs/device-comms.md.
// Exit 0 = PASS.
//
// Usage:
//   node clients/node/test/onair-ping.js [options]
//     --host <h>          node-dash host            (default localhost:8000)
//     --gw <id>           gateway node id           (default !2687afb1, OMNI)
//     --channel <n>       private channel           (default 2; 0 refused)
//     --target <sfx>      unit suffix               (default 336b, the bench)
//     --node <num>        target node number        (default 2364420971 = !8cee336b)
//     --verb <v>          command verb              (default ping)
//     --count <n>         commands per run          (default 1 — see NOTE)
//     --interval <ms>     spacing between sends     (default 2500)
//     --timeout <ms>      window after the LAST send (default 10000)
//     --expect <t>        broadcast | dm | any      (default any)
//     --help
//
// NOTE on --count: reply latency grows with burst depth (measured 3.3s, 5.5s, ~10s
// for a 3-command burst — the device TX queue draining, not link loss). Default is 1
// so the 10 s window matches a single round trip. Raise --timeout with --count.

const { runCommands, report, DEFAULTS } = require('./lib/onair');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { o.help = true; continue; }
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

const a = parseArgs(process.argv.slice(2));
if (a.help) {
  console.log(require('fs').readFileSync(__filename, 'utf8')
    .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const opts = {
  host: a.host || DEFAULTS.host,
  gw: a.gw || DEFAULTS.gw,
  channel: a.channel != null ? Number(a.channel) : DEFAULTS.channel,
  target: a.target || '336b',
  targetNode: a.node != null ? Number(a.node) : 2364420971, // !8cee336b, the bench
  verb: a.verb || 'ping',
  count: a.count != null ? Number(a.count) : 1,
  intervalMs: a.interval != null ? Number(a.interval) : 2500,
  windowMs: a.timeout != null ? Number(a.timeout) : 10000,
  expectTransport: a.expect || 'any',
};

(async () => {
  console.log(`onair-ping: @${opts.target} ${opts.verb} x${opts.count} via ${opts.gw} ` +
              `ch${opts.channel} @ ${opts.host}  (window ${opts.windowMs}ms, expect ${opts.expectTransport})`);
  const res = await runCommands(opts);
  process.exit(report(res) ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
