'use strict';
// The request ledger on SQLite: schema, persistence, cross-unit query, retention, and the
// file-era import. Offline — a real DB in a temp dir, no radio.
//
// The assertion that matters most: retention must NEVER prune a live request. A queued
// command is an instruction someone gave, and losing one loses the instruction.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../lib/db');
const { PayloadStore } = require('../lib/store');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `pac-db-${tag}-`));

const entry = (o = {}) => ({
  id: o.id || 'e1', kind: o.kind || 'command', verb: o.verb || 'ping', args: o.args || [],
  body: o.body || null, toNum: o.toNum || null, channel: o.channel || null,
  state: o.state || 'queued', tries: o.tries || 0, maxTries: o.maxTries || 5,
  createdAt: o.createdAt || Date.now(), triedAt: null, settledAt: null,
  ttlMs: o.ttlMs || 86400000, result: o.result || null, error: o.error || null,
});

// ---- schema + migrations ---------------------------------------------------
{
  const dir = tmp('schema');
  const db = openDb(path.join(dir, 'mesh.db'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  ok(tables.includes('requests'), 'requests table created');
  ok(tables.includes('cache'), 'cache table created');
  ok(tables.includes('meta'), 'meta table created');
  ok(db.pragma('journal_mode', { simple: true }) === 'wal', 'WAL enabled (a reader must not block the writer)');
  ok(Number(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v) >= 1, 'schema version recorded');

  // Re-opening must be idempotent — migrations run once, not once per boot.
  db.close();
  const db2 = openDb(path.join(dir, 'mesh.db'));
  ok(Number(db2.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v) >= 1, 're-open does not re-migrate');
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- round-trip through the store -----------------------------------------
{
  const dir = tmp('rt');
  const s = new PayloadStore({ dir });
  s.saveQueue('!aa', [entry({ id: 'a1', verb: 'status', args: ['mem'] })]);
  const back = s.loadQueue('!aa');
  ok(back.length === 1, 'saveQueue/loadQueue round-trips');
  ok(back[0].verb === 'status' && back[0].args[0] === 'mem', 'verb + args survive');
  ok(back[0].state === 'queued' && back[0].tries === 0, 'state + tries survive');
  ok(back[0].error === null, 'no error -> null, not an empty object');

  // A result and a structured error survive the trip.
  s.saveQueue('!aa', [entry({ id: 'a1', state: 'done', result: { type: 'status', vbat: 4.1 } })]);
  ok(s.loadQueue('!aa')[0].result.vbat === 4.1, 'result JSON survives');
  s.saveQueue('!aa', [entry({ id: 'a1', state: 'failed', error: { code: 'no_reply', message: 'x' } })]);
  const e = s.loadQueue('!aa')[0];
  ok(e.error.code === 'no_reply' && e.error.message === 'x', 'error {code,message} survives');

  // A text entry keeps what it needs to be RETRIED to the same place.
  s.saveQueue('!bb', [entry({ id: 'b1', kind: 'text', verb: null, body: 'hello', toNum: 123, channel: 2 })]);
  const t = s.loadQueue('!bb')[0];
  ok(t.kind === 'text' && t.body === 'hello', 'text body survives');
  ok(t.toNum === 123 && t.channel === 2, 'text delivery target survives (a retry must go to the same place)');

  ok(s.listQueuedUnits().sort().join() === '!aa,!bb', 'listQueuedUnits from the ledger');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- persistence across a restart -----------------------------------------
{
  const dir = tmp('restart');
  const s1 = new PayloadStore({ dir });
  s1.saveQueue('!cc', [entry({ id: 'c1', verb: 'reboot' })]);
  const s2 = new PayloadStore({ dir });               // simulates a service restart
  ok(s2.loadQueue('!cc').length === 1, 'ledger survives a restart');
  ok(s2.loadQueue('!cc')[0].verb === 'reboot', 'the queued instruction is intact');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- cross-unit query: the thing files could not do ------------------------
{
  const dir = tmp('query');
  const s = new PayloadStore({ dir });
  const now = Date.now();
  s.saveQueue('!aa', [
    entry({ id: 'a1', state: 'done', createdAt: now - 3000 }),
    entry({ id: 'a2', state: 'queued', createdAt: now - 1000 }),
  ]);
  s.saveQueue('!bb', [entry({ id: 'b1', kind: 'text', body: 'hi', state: 'sent', createdAt: now - 2000 })]);

  const all = s.listRequests();
  ok(all.length === 3, 'listRequests spans units');
  ok(all[0].id === 'a2' && all[2].id === 'a1', 'newest first across ALL units');
  ok(s.listRequests({ unit: '!aa' }).length === 2, 'filter by unit');
  ok(s.listRequests({ state: 'queued' }).length === 1, 'filter by state');
  ok(s.listRequests({ kind: 'text' })[0].body === 'hi', 'filter by kind');
  ok(s.listRequests({ limit: 2 }).length === 2, 'limit applies');
  ok(s.listRequests({ limit: 2, offset: 2 }).length === 1, 'offset applies (paging)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- retention: caps terminal rows, NEVER touches a live one --------------
{
  const dir = tmp('prune');
  const s = new PayloadStore({ dir });
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(entry({ id: `d${i}`, state: 'done', createdAt: now - (100 - i) * 1000 }));
  rows.push(entry({ id: 'live1', state: 'queued', createdAt: now - 99000 }));   // OLDEST, but LIVE
  rows.push(entry({ id: 'live2', state: 'trying', createdAt: now - 98000 }));
  s.saveQueue('!aa', rows);

  const removed = s.pruneRequests(3);
  ok(removed === 7, 'prune removed the excess terminal rows only');
  const left = s.loadQueue('!aa');
  ok(left.length === 5, '3 terminal kept + 2 live');
  ok(left.some((x) => x.id === 'live1'), 'a QUEUED request is never pruned, however old');
  ok(left.some((x) => x.id === 'live2'), 'a TRYING request is never pruned');
  ok(left.filter((x) => x.state === 'done').length === 3, 'kept exactly keepPerUnit terminal rows');
  ok(left.some((x) => x.id === 'd9'), 'the NEWEST terminal rows are the ones kept');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- import of the file-era queues ----------------------------------------
// A command queued before the switch is still someone's instruction.
{
  const dir = tmp('import');
  const unit = '!987ab80f';
  fs.mkdirSync(path.join(dir, unit), { recursive: true });
  fs.writeFileSync(path.join(dir, unit, 'queue.json'), JSON.stringify([
    { id: 'old1', unit, verb: 'status', args: [], status: 'pending', enqueuedAt: Date.now() - 5000,
      ttlMs: 86400000, attempts: 1, maxAttempts: 5, sentAt: null, ackedAt: null, receipt: null,
      lastError: 'timeout: reply not received' },
    { id: 'old2', unit, verb: 'ping', args: [], status: 'acked', enqueuedAt: Date.now() - 9000,
      ttlMs: 86400000, attempts: 1, maxAttempts: 5, sentAt: null, ackedAt: Date.now(),
      receipt: { type: 'pong' }, lastError: null },
  ]));

  const s = new PayloadStore({ dir });
  const got = s.loadQueue(unit);
  ok(got.length === 2, 'legacy queue.json imported — a queued instruction is not lost');
  const byId = Object.fromEntries(got.map((g) => [g.id, g]));
  ok(byId.old1.state === 'queued', 'old "pending" -> "queued"');
  ok(byId.old2.state === 'done', 'old "acked" -> "done"');
  ok(byId.old1.tries === 1, 'attempts -> tries');
  ok(byId.old2.result.type === 'pong', 'receipt -> result');
  ok(fs.existsSync(path.join(dir, unit, 'queue.json')), 'the legacy file is LEFT IN PLACE (a bad import must be recoverable)');

  // Import runs ONCE — a second open must not duplicate rows.
  const s2 = new PayloadStore({ dir });
  ok(s2.loadQueue(unit).length === 2, 'import is idempotent across restarts');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`db OK: ${pass} assertions passed`);
