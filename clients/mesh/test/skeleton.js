// Wiring test: the module require()s and exports the API. As phases land, methods
// move from the `pending` set (still throw NotImplemented) to `implemented`
// (wired — asserted present, not invoked, since they need connect()/network).
'use strict';
const assert = require('assert');
const mesh = require('..');

assert(mesh.Mesh && mesh.connect && mesh.errors && mesh.VERSION, 'exports present');
const m = new mesh.Mesh();

// Wired in mesh-cli-live (phase 3). Assert present; do NOT invoke (I/O / network).
const implemented = ['connect', 'close', 'nodes', 'node', 'command', 'ping', 'status'];
for (const name of implemented) assert(typeof m[name] === 'function', `${name} exists`);

// Still skeleton — must throw NotImplemented (sync throw or rejected promise).
const pending = ['listImages', 'getImage', 'startImageListener',
  'getSchema', 'getConfig', 'setConfig', 'startAlertListener'];

let ok = 0;
async function check() {
  for (const name of pending) {
    assert(typeof m[name] === 'function', `${name} exists`);
    let err;
    try { const r = m[name]('x', 'y'); if (r && typeof r.then === 'function') await r; }
    catch (e) { err = e; }
    assert(err instanceof mesh.errors.NotImplemented, `${name} throws NotImplemented`);
    ok++;
  }
}
check().then(() => {
  console.log(`skeleton OK: ${implemented.length} implemented/wired, ${ok}/${pending.length} still NotImplemented`);
}).catch((e) => { console.error('skeleton FAILED:', e && e.stack || e); process.exit(1); });
