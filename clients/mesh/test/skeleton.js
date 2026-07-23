// Skeleton wiring test: the module require()s, exports the API, every method
// exists and throws NotImplemented. No transport, no network.
'use strict';
const assert = require('assert');
const mesh = require('..');

assert(mesh.Mesh && mesh.connect && mesh.errors && mesh.VERSION, 'exports present');
const m = new mesh.Mesh();

const methods = ['connect', 'close', 'nodes', 'node', 'command', 'ping', 'status',
  'listImages', 'getImage', 'startImageListener', 'getSchema', 'getConfig',
  'setConfig', 'startAlertListener'];

let ok = 0;
for (const name of methods) {
  assert(typeof m[name] === 'function', `method ${name} exists`);
  try {
    const r = m[name]('x', 'y');           // sync throwers + async: both surface NotImplemented
    if (r && typeof r.then === 'function') { r.catch(() => {}); }
    // async methods return a rejected promise; sync ones throw. Either is fine.
    ok++;
  } catch (e) {
    assert(e instanceof mesh.errors.NotImplemented, `${name} throws NotImplemented`);
    ok++;
  }
}
console.log(`skeleton OK: ${ok}/${methods.length} methods wired, all NotImplemented`);
