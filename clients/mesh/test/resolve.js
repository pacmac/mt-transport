// Offline tests for the target resolver (mesh-dm). No radio: resolve every target
// form against a stub roster and assert { num, atToken }.
'use strict';
const assert = require('assert');
const { resolveTarget } = require('../lib/resolve');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

// b80f = !987ab80f = 2558179343 ; 336b = !8cee336b = 2364420971
const roster = [
  { id: '!987ab80f', num: 2558179343, name: 'HOME' },
  { id: '!8cee336b', num: 2364420971, name: 'DEPL' },
];

// numeric node-num (no roster needed)
{
  const r = resolveTarget('2558179343', []);
  ok(r.num === 2558179343 && r.atToken === 'b80f', 'numeric num -> num + 4-hex suffix, no roster');
}
// full !mac
{
  const r = resolveTarget('!987ab80f', []);
  ok(r.num === 2558179343 && r.atToken === 'b80f', '!mac -> parsed num + suffix');
}
// bare 8-hex
{
  const r = resolveTarget('987ab80f', []);
  ok(r.num === 2558179343 && r.atToken === 'b80f', '8-hex -> parsed num + suffix');
}
// 4-hex suffix via roster
{
  const r = resolveTarget('b80f', roster);
  ok(r.num === 2558179343 && r.atToken === 'b80f', '4-hex suffix -> roster num');
}
// short name via roster
{
  const r = resolveTarget('DEPL', roster);
  ok(r.num === 2364420971 && r.atToken === 'DEPL', 'short name -> roster num');
}
// broadcast
{
  const r = resolveTarget('*', roster);
  ok(r.num === null && r.atToken === '*', '* -> broadcast (num null)');
}
// suffix miss (roster has it, but wrong suffix) -> num null, atToken preserved
{
  const r = resolveTarget('dead', roster);
  ok(r.num === null && r.atToken === 'dead', 'unknown suffix -> num null (caller falls back)');
}
// empty roster + suffix -> miss
{
  const r = resolveTarget('b80f', []);
  ok(r.num === null && r.atToken === 'b80f', 'suffix with empty roster -> num null');
}

console.log(`resolve OK: ${pass} assertions passed`);
