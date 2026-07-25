'use strict';
// lib/cache.js — the generic persistent cache. Offline: real files in a temp dir, no radio.
//
// The assertion that matters most here is the TTL one: an EXPIRED entry must still be
// RETURNED (flagged stale), never deleted. Losing the only copy of a schema while the
// unit sleeps is the exact bug the persistent cache exists to prevent, and a future
// SQLite backend (task cache-sqlite-backend) must keep passing this file unchanged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cache } = require('../lib/cache');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-cache-'));
const c = new Cache(dir);

// ---- put / get round-trip -------------------------------------------------
c.put('schema', '!987ab80f', { ver: 3, fields: [{ id: 'alm.ovr' }] });
const got = c.get('schema', '!987ab80f');
ok(got && got.value.ver === 3, 'put/get: value round-trips');
ok(Array.isArray(got.value.fields), 'put/get: nested structure survives');
ok(got.stale === false, 'no ttl -> never stale');
ok(got.ttlMs === null, 'no ttl -> ttlMs null');
ok(typeof got.savedAt === 'number' && got.ageMs >= 0, 'savedAt/ageMs present');

ok(c.get('schema', 'nope') === null, 'missing key -> null, not a throw');
ok(c.get('nosuchns', 'k') === null, 'missing namespace -> null, not a throw');
ok(c.value('schema', '!987ab80f').ver === 3, 'value() returns the bare value');
ok(c.value('schema', 'nope') === null, 'value() of a miss is null');

// ---- namespaces are isolated ----------------------------------------------
c.put('registry', 'devices', ['!8cee336b', '!987ab80f']);
ok(c.value('registry', 'devices').length === 2, 'array value round-trips');
ok(c.get('schema', 'devices') === null, 'same key in another ns does not collide');

// ---- TTL: expiry marks stale, and NEVER deletes ---------------------------
c.put('vol', 'k', 'v', { ttlMs: 1 });
const before = c.get('vol', 'k');
ok(before.ttlMs === 1, 'ttlMs is recorded');
const waitUntil = Date.now() + 5;
while (Date.now() < waitUntil) { /* spin briefly; sleeping would need async */ }
const after = c.get('vol', 'k');
ok(after !== null, 'EXPIRED ENTRY IS STILL RETURNED — expiry must not delete');
ok(after.stale === true, 'expired entry is flagged stale');
ok(after.value === 'v', 'expired entry still carries its value');
ok(c.value('vol', 'k') === 'v', 'value() returns a stale value too (caller decides)');

// A zero/negative/absent ttl means "no expiry", not "expire immediately" — a caller
// passing ttlMs: 0 must not silently make its entry permanently stale.
c.put('vol', 'zero', 'v', { ttlMs: 0 });
ok(c.get('vol', 'zero').stale === false, 'ttlMs 0 -> no expiry, not instant staleness');

// ---- all() -----------------------------------------------------------------
c.put('schema', '!8cee336b', { ver: 3, fields: [] });
const all = c.all('schema');
ok(all.length === 2, 'all() lists every entry in the namespace');
ok(all[0].savedAt >= all[1].savedAt, 'all() is newest-first');
ok(all.every((e) => e.key && 'value' in e), 'all() entries carry key + value');
ok(c.all('nosuchns').length === 0, 'all() of a missing ns is [], not a throw');

// ---- durability: a SECOND instance sees what the first wrote ---------------
// This is the whole point — surviving a restart, not just a hot cache.
const c2 = new Cache(dir);
ok(c2.value('registry', 'devices').length === 2, 'a fresh instance reads from disk');
ok(c2.value('schema', '!987ab80f').ver === 3, 'schema survives a new instance');

// ---- corrupt entry is ignored, never fatal --------------------------------
// The ONLY backend-specific block in this file: corruption is injected the way the
// storage can actually be corrupted. Under the old file backend that was a bad .json
// file; under SQLite it is a row whose value is not parseable JSON. The PROPERTY being
// asserted is identical — a corrupt entry must read as a miss and must not break a
// listing of its neighbours.
const c3 = new Cache(dir);
c3.db.prepare('INSERT INTO cache (ns, k, v, saved_at, ttl_ms) VALUES (?,?,?,?,NULL)')
  .run('schema', 'broken', '{not json', Date.now());
ok(c3.get('schema', 'broken').value === null, 'corrupt entry yields a null value, not a throw');
ok(c3.all('schema').filter((e) => e.value && e.value.ver).length === 2,
   'corrupt entry does not break the listing — the good ones are still there');

// ---- key sanitising: a key cannot escape the cache dir --------------------
c.put('schema', '../../escape', { ver: 1, fields: [] });
ok(!fs.existsSync(path.join(dir, '..', '..', 'escape.json')), 'a traversing key does not escape the cache dir');
ok(c.value('schema', '../../escape').ver === 1, 'a sanitised key still round-trips');

// ---- del / clear ------------------------------------------------------------
ok(c.del('vol', 'k') === true, 'del() reports removal');
ok(c.get('vol', 'k') === null, 'deleted entry is gone');
ok(c.del('vol', 'k') === false, 'del() of a miss is false, not a throw');
c.clear('schema');
ok(c.all('schema').length === 0, 'clear() empties the namespace');
ok(c.value('registry', 'devices').length === 2, 'clear() does not touch another namespace');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`cache OK: ${pass} assertions passed`);
