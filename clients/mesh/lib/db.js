// The database — one SQLite file holding the request ledger and the cache.
//
// WHY A DATABASE (files were fine until they weren't): the ledger is queried, not just
// read back. Filter by unit and state, order across ALL units ("everything I sent,
// newest first"), paginate, retain. The file version rewrote a unit's ENTIRE queue array
// on every state change, and with queued->trying->done per message that cost grows with
// history. See specs/request-ledger-sqlite.md.
//
// DEPENDENCY FACTS — verified 2026-07-25, do not re-derive:
//   - `node:sqlite` needs Node >= 22.5; this box is 20.19.2, so it is not available.
//   - better-sqlite3 is PINNED TO 12.x. Do NOT take 13.x: v13 ships N-API prebuilts and
//     prefers them, and that prebuilt SEGFAULTS on Node 20.19.2. v12 has no prebuilds and
//     always builds from source.
//   - Rebuilding needs build/ AND prebuilds/ deleted first, or make merely re-TOUCHes its
//     stamps and no-ops. Use node-gyp@10 — node-gyp 13 cannot run on Node 20.19.2.
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// Applied in order; each runs exactly once, tracked in `meta`. Append, never edit — an
// edited migration has already run on a live database and will not run again.
const MIGRATIONS = [
  // 1 — initial: the request ledger + the generic cache.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id         TEXT PRIMARY KEY,
        unit       TEXT NOT NULL,
        kind       TEXT NOT NULL,          -- 'command' | 'text'
        verb       TEXT,                   -- command only
        args       TEXT,                   -- JSON array, command only
        body       TEXT,                   -- text only
        -- Delivery target for a text, captured at submit time so a RETRY goes exactly
        -- where the original was aimed. These are ours (storage), never on the wire.
        to_num     INTEGER,
        channel    INTEGER,
        state      TEXT NOT NULL,
        tries      INTEGER NOT NULL DEFAULT 0,
        max_tries  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        tried_at   INTEGER,
        settled_at INTEGER,
        ttl_ms     INTEGER,
        result     TEXT,                   -- JSON receipt
        error_code TEXT,
        error_msg  TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_unit_created ON requests(unit, created_at DESC);
      CREATE INDEX IF NOT EXISTS requests_state        ON requests(state);
      CREATE INDEX IF NOT EXISTS requests_created      ON requests(created_at DESC);

      CREATE TABLE IF NOT EXISTS cache (
        ns       TEXT NOT NULL,
        k        TEXT NOT NULL,
        v        TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        ttl_ms   INTEGER,
        PRIMARY KEY (ns, k)
      );
    `);
  },
];

// Open (creating if needed) and bring the schema up to date. Returns the better-sqlite3
// handle; callers own their own statements.
function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Required lazily so that merely loading the module does not pull in a native binary —
  // it keeps `require('@pac/mesh')` working in environments where the addon is unbuilt,
  // and makes the failure land here with a useful message rather than at import time.
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (e) {
    throw new Error(
      `better-sqlite3 failed to load (${e && e.message}). It is a NATIVE module: after a ` +
      'clean checkout it must be compiled — delete build/ and prebuilds/ then run ' +
      '`npx node-gyp@10 rebuild --release` in the package. Do not upgrade to 13.x on Node 20.',
    );
  }

  const db = new Database(file);
  // WAL: the service writes while a dashboard reads. NORMAL trades a fsync per commit for
  // throughput and is the standard pairing with WAL — a crash can lose the last commit,
  // never the database.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
  const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

  const row = getMeta.get('schema_version');
  const at = row ? Number(row.v) : 0;
  if (at < MIGRATIONS.length) {
    // One transaction per run: a half-applied schema is worse than none.
    db.transaction(() => {
      for (let i = at; i < MIGRATIONS.length; i++) MIGRATIONS[i](db);
      setMeta.run('schema_version', String(MIGRATIONS.length));
    })();
  }

  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

module.exports = { openDb, SCHEMA_VERSION };
