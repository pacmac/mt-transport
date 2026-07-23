#!/usr/bin/env node
// mtmesh — structured CLI over the mesh domain module. Firmware-style verbs.
// ONE verb table drives dispatch AND usage (generated — no help drift). --json
// for machine output. The CLI knows only domain verbs; all mesh mechanics live
// in the module. Skeleton: dispatch + usage work; verb handlers call the (empty)
// Mesh API, which throws NotImplemented — surfaced cleanly.
'use strict';
const { Mesh, errors } = require('..');

// ---- verb table: {verb, args, help, run(ctx)} ; sub-verbs via space in `verb` ----
const VERBS = [
  { verb: 'nodes',       args: '',                    help: 'list known nodes',
    run: (m) => m.nodes() },
  { verb: 'status',      args: '<target> [mem|alarm]', help: 'device status',
    run: (m, a) => m.status(a[0], a[1] || '') },
  { verb: 'ping',        args: '<target>',            help: 'ping a node',
    run: (m, a) => m.ping(a[0]) },
  { verb: 'image list',  args: '<target>',            help: 'list available images',
    run: (m, a) => m.listImages(a[0]) },
  { verb: 'image get',   args: '<target> <pid> [--out FILE]', help: 'fetch an image',
    run: (m, a, o) => m.getImage(a[0], a[1], { out: o.out }) },
  { verb: 'config get',  args: '<target>',            help: 'read device config',
    run: (m, a) => m.getConfig(a[0]) },
  { verb: 'config set',  args: '<target> <key> <value>', help: 'set device config (validated)',
    run: (m, a) => m.setConfig(a[0], { [a[1]]: a[2] }) },
  { verb: 'listen',      args: '',                    help: 'daemon: model + image/alert listeners',
    run: (m) => m.startImageListener() },
];

function usage() {
  const lines = VERBS.map(v => `  mtmesh ${v.verb} ${v.args}`.padEnd(46) + v.help);
  return [
    'mtmesh [--gw URL] [--channel N] [--config FILE] [--json] <verb> [args]',
    '', 'verbs:', ...lines, '',
  ].join('\n');
}

// ---- arg parse: global flags, then longest-matching verb, then positionals ----
function parse(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  // match the longest verb (e.g. "image get" before "image").
  const joined = rest.join(' ');
  const match = VERBS.filter(v => joined === v.verb || joined.startsWith(v.verb + ' '))
                     .sort((x, y) => y.verb.length - x.verb.length)[0];
  const args = match ? rest.slice(match.verb.split(' ').length) : rest;
  return { flags, match, args };
}

async function main() {
  const { flags, match, args } = parse(process.argv.slice(2));
  if (flags.help || !match) { console.log(usage()); process.exit(match ? 0 : 1); }

  const m = new Mesh({ gw: flags.gw, channel: flags.channel != null ? Number(flags.channel) : undefined,
                       configPath: flags.config, logLevel: flags.log });
  try {
    await m.connect();
    const out = await match.run(m, args, flags);
    console.log(flags.json ? JSON.stringify(out) : format(out));
    await m.close();
  } catch (e) {
    const msg = e instanceof errors.MeshError ? `${e.name}: ${e.message}` : String(e && e.message || e);
    if (flags.json) console.log(JSON.stringify({ error: msg, code: e && e.code }));
    else console.error(msg);
    process.exit(2);
  }
}

function format(out) {
  if (out == null) return '';
  if (Buffer.isBuffer(out)) return `<${out.length} bytes>`;
  if (typeof out === 'object') return JSON.stringify(out, null, 2);
  return String(out);
}

main();
