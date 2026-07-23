#!/usr/bin/env node
// mtmesh — structured CLI over the mesh domain module. Firmware-style verbs.
// ONE verb table drives dispatch AND usage (generated — no help drift). --json
// for machine output. The CLI knows only domain verbs; all mesh mechanics live
// in the module. Skeleton: dispatch + usage work; verb handlers call the (empty)
// Mesh API, which throws NotImplemented — surfaced cleanly.
'use strict';
const { Mesh, errors } = require('..');

// ---- verb table: {verb, target, args, help, run(m,target,args,flags)} ----------
// Grammar is target-first: `mtmesh <target> <verb> [args]`. `target: true` verbs
// receive the resolved target as the FIRST run() arg; `nodes`/`listen` are targetless.
const VERBS = [
  { verb: 'nodes',       target: false, args: '',              help: 'list known nodes',
    run: (m) => m.nodes() },
  { verb: 'status',      target: true,  args: '[mem|alarm]',   help: 'device status',
    run: (m, t, a) => m.status(t, a[0] || '') },
  { verb: 'ping',        target: true,  args: '',              help: 'ping a node',
    run: (m, t) => m.ping(t) },
  { verb: 'image list',  target: true,  args: '',              help: 'list available images',
    run: (m, t) => m.listImages(t) },
  { verb: 'image get',   target: true,  args: '<pid> [--out FILE]', help: 'fetch an image',
    run: (m, t, a, o) => m.getImage(t, a[0], { out: o.out }) },
  { verb: 'config get',  target: true,  args: '',              help: 'read device config',
    run: (m, t) => m.getConfig(t) },
  { verb: 'config set',  target: true,  args: '<key> <value>', help: 'set device config (validated)',
    run: (m, t, a) => m.setConfig(t, { [a[0]]: a[1] }) },
  { verb: 'cmd',         target: true,  args: '<verb> [args...]', help: 'send ANY device command raw (escape hatch)',
    run: (m, t, a, flags) => {
      if (!a.length) throw new errors.MeshError('cmd: needs a device verb', 'EUSAGE');
      const opts = m._cmdReliab(a[0]);        // idempotent-retry, except reboot/wedge
      if (flags['no-reply']) opts.noReply = true;
      return m.command(t, a[0], a.slice(1), opts);
    } },
  { verb: 'listen',      target: false, args: '[--serve] [--port N]', help: 'run as a daemon: hold model + autonomous image listener + event feed',
    daemon: true },
];

function usage() {
  const lines = VERBS.map(v => {
    const form = v.target ? `<target> ${v.verb} ${v.args}` : `${v.verb} ${v.args}`;
    return `  mtmesh ${form}`.padEnd(48) + v.help;
  });
  return [
    'mtmesh [--gw URL] [--config FILE] [--json] <target> <verb> [args]',
    '', 'verbs:', ...lines, '',
  ].join('\n');
}

// ---- arg parse: global flags, then TARGET-FIRST verb dispatch ------------------
// `mtmesh <target> <verb> [args]`. A targetless verb (nodes/listen) at the head wins;
// otherwise the first positional IS the target and the verb follows it.
function parse(argv) {
  const flags = {}; const rest = [];
  const BOOL = new Set(['json', 'serve', 'help', 'no-reply']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && BOOL.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  const longest = (cands, tokens) => {
    const j = tokens.join(' ');
    return cands.filter(v => j === v.verb || j.startsWith(v.verb + ' '))
                .sort((x, y) => y.verb.length - x.verb.length)[0];
  };
  // 1) targetless verb at the head (nodes / listen)
  let match = longest(VERBS.filter(v => !v.target), rest);
  if (match) return { flags, match, target: null, args: rest.slice(match.verb.split(' ').length) };
  // 2) first positional is the target; the verb follows it
  const target = rest[0];
  const after = rest.slice(1);
  match = longest(VERBS.filter(v => v.target), after);
  const args = match ? after.slice(match.verb.split(' ').length) : after;
  return { flags, match, target, args };
}

async function main() {
  const { flags, match, target, args } = parse(process.argv.slice(2));
  if (flags.help || !match) { console.log(usage()); process.exit(match ? 0 : 1); }

  const m = new Mesh({ gw: flags.gw, configPath: flags.config, logLevel: flags.log,
                       serve: flags.serve, servePort: flags.port != null ? Number(flags.port) : undefined });
  try {
    await m.connect();
    if (match.daemon) return await runDaemon(m, flags);
    const out = await match.run(m, target, args, flags);
    console.log(flags.json ? JSON.stringify(out) : format(out));
    await m.close();
  } catch (e) {
    const msg = e instanceof errors.MeshError ? `${e.name}: ${e.message}` : String(e && e.message || e);
    if (flags.json) console.log(JSON.stringify({ error: msg, code: e && e.code }));
    else console.error(msg);
    process.exit(2);
  }
}

// Daemon path: hold the process open on the daemon's WS/server + image listener;
// exit cleanly on the first SIGINT/SIGTERM. The event feed goes to stdout; this
// startup notice + shutdown go to stderr so a --json feed stays pure.
async function runDaemon(m, flags) {
  const d = await m.listen({ json: flags.json });
  const serving = m.cfg.daemon.serve ? ` — serving http://${m.cfg.daemon.host}:${d.address().port} (GET /health /nodes, WS /events)` : '';
  console.error(`mtmesh listening${serving} — image listener ON — Ctrl-C to stop`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    console.error('\nmtmesh stopping…');
    try { d.stop(); await m.close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function format(out) {
  if (out == null) return '';
  if (Buffer.isBuffer(out)) return `<${out.length} bytes>`;
  if (typeof out === 'object') return JSON.stringify(out, null, 2);
  return String(out);
}

main();
