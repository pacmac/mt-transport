// Offline level-gating test for lib/log.js. Captures output by injecting a fake
// stream (log._setOut) — no spawning except the one env-override subprocess.
'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { log } = require('../lib/log');

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; };

const cap = { lines: [], write(s) { this.lines.push(s); } };
log._setOut(cap);
const reset = () => { cap.lines.length = 0; };

// at 'warn': error+warn emit, info/debug/trace suppressed
log.setLevel('warn'); reset();
log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
ok(cap.lines.length === 2, `warn level -> 2 lines (got ${cap.lines.length})`);
ok(cap.lines[0].startsWith('ERROR ') && cap.lines[1].startsWith('WARN '), 'warn level -> error+warn only');

// at 'trace': all five emit
log.setLevel('trace'); reset();
log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
ok(cap.lines.length === 5, `trace level -> 5 lines (got ${cap.lines.length})`);

// 'silent': nothing
log.setLevel('silent'); reset();
log.error('e'); log.warn('w');
ok(cap.lines.length === 0, 'silent -> no lines');

// child scope prefix + nesting
log.setLevel('info'); reset();
const gw = log.child('gw');
gw.info('hi');
ok(cap.lines[0].includes('[gw] hi'), 'child scope prefix');
reset();
gw.child('sub').warn('x');
ok(cap.lines[0].includes('[gw:sub] x'), 'nested child prefix');

// setLevel resolution: returns name; unknown -> keeps current; numeric accepted
ok(log.setLevel('debug') === 'debug', 'setLevel returns resolved name');
ok(log.setLevel('bogus') === 'debug', 'unknown level -> keeps current (fallback)');
ok(log.setLevel(0) === 'error', 'numeric 0 -> error');

// isEnabled matches level
log.setLevel('info');
ok(log.isEnabled('info') === true && log.isEnabled('debug') === false, 'isEnabled matches level');

// env MTMESH_LOG honoured on a fresh require (separate process)
const out = execFileSync(
  process.execPath,
  ['-e', "process.stdout.write(require('./lib/log').log.level)"],
  { cwd: path.join(__dirname, '..'), env: { ...process.env, MTMESH_LOG: 'debug' } }
).toString().trim();
ok(out === 'debug', `env MTMESH_LOG honoured on fresh require (got ${out})`);

console.log(`log OK: ${pass} assertions passed`);
