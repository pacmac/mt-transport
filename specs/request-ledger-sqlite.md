---
task: request-ledger-sqlite
status: IMPLEMENTED 2026-07-25. VERIFIED LIVE: the real queue MIGRATED EXACTLY — 41 rows from
  15 + 26 file entries, states remapped, nothing lost, legacy files left in place. A text and a
  command both enter the ledger; a text terminates at `sent` (never `done`); `mesh.request-queued`
  and `mesh.request-trying` observed on the SSE stream. Suite 17 files green (butler 32, db 37,
  cache 32 on the new backend). TWO DEFECTS FOUND AND FIXED DURING VERIFICATION — see Findings.
source_hash:
  clients/mesh/lib/db.js:          1f2d8284f4f11932
  clients/mesh/lib/cache.js:       ca03fa00bcae530b
  clients/mesh/lib/store.js:       5c7b0acb75486565
  clients/mesh/lib/butler.js:      a68156e786bb0f73
  clients/mesh/index.js:           795134b6986186f7
  clients/mesh/host-module.js:     c96f1e5285ff5734
  clients/mesh/package.json:       9aa93fbca7602997
  clients/host/API.md:             6272ef2bf6ae1730
  clients/mesh/test/db.js:         6c6cd9dd9600cad7
  clients/mesh/test/cache.js:      116db9f1874057c6
  clients/mesh/test/butler.js:     28227b8f5d968d17
  clients/mesh/test/mode.js:       b6808a282bb54be9
scope:
  - specs/request-ledger-sqlite.md
  - clients/mesh/package.json          # better-sqlite3 pinned 12.11.1 (ALREADY EDITED, see Provenance)
  - clients/mesh/lib/db.js             # NEW: the database — open, schema, migrations
  - clients/mesh/lib/cache.js          # swap the file backend for the DB, interface UNCHANGED
  - clients/mesh/lib/store.js          # queue + registry read/write via the DB
  - clients/mesh/lib/butler.js         # states, tries, error codes; text entries
  - clients/mesh/index.js              # sendText + dev-mode command() enter the ledger
  - clients/mesh/host-module.js        # command lifecycle onto SSE; ledger routes
  - clients/mesh/test/db.js            # NEW
  - clients/mesh/test/cache.js         # must pass UNCHANGED against the new backend
  - clients/mesh/test/butler.js        # state/tries renames
  - clients/mesh/test/mode.js          # ADDED MID-IMPLEMENTATION: it asserts dispatch's OLD
                                       #   contract ("dev -> direct command, bypasses the queue"),
                                       #   which is precisely what this change removes. Declared
                                       #   rather than edited quietly.
  - clients/host/API.md                # consumer-visible contract (PARTLY EDITED, see Provenance)
# NOT changing: chunk/image transfer or `sch` schema pulls — Peter: "chunks are completely
#   different, should not be a part of this". They are a bulk DATA PLANE, not messages, and
#   ledgering hundreds of frames would drown the thing this exists to make readable.
#   Also unchanged: the /v1/mesh/queue route NAME (already mechanics-free), the mesh-gw
#   interface, and the recorder CSV (Peter's evidence trail stays a flat file).
---

# Spec: request-ledger-sqlite — an outbox you can actually read

## Provenance — work already done outside a task (declared, not hidden)

Two edits were made before this task existed. Both are listed in scope above and are
reviewed as part of it:

1. **`clients/mesh/package.json`** gained `better-sqlite3@12.11.1`, plus a lockfile and a
   local `node_modules`. This began as a feasibility check and went further than a check
   should. Side effect: `ws`/`yaml` now resolve locally (8.21.1 / 2.9.0) instead of from
   `/usr/share/nodejs`. Suite 16/16 and the live service both pass.
2. **`clients/host/API.md`** — the "watch events for the receipt" line was corrected (it
   was false), and the immediate-attempt behaviour documented. Done before this task was
   opened; that was drift and is recorded here rather than quietly absorbed.

## The problem

Peter: *"I want to see all messages but I want to see whether a message I sent was queued
and what it's state is. so basically all messages should go into the queue, but the first
try is immediate. and messages need a state and a tries field."*

**The queue today is not a record of what you sent — it is a record of what could not be
sent immediately.** Two of the three ways to send a message never appear:

| path | in the ledger today? |
|---|---|
| `POST /command` to a **dev** unit | ❌ direct + synchronous, never recorded |
| `POST /text` (free-form message) | ❌ never recorded |
| `POST /queue` / live-routed command | ✅ |

So "did my message go?" is unanswerable for most of what a person actually sends.

## The model: a mailbox, with the mechanics hidden

Peter: *"it should behave like a mailbox / smtp server, but to the consumer they see
nothing of the mechanics of that and dont even need to know it's done via messaging."*

So this is a **request ledger, not a message log**. A consumer submits an intent and
tracks its state. That it travels as a text frame on a private channel to a radio that is
asleep is entirely ours.

**Nothing radio-shaped crosses the wire**: no wake windows, channels, ports, `reply_id`,
airtime or hop counts. `tries` stays — an SMTP relay reports delivery attempts too; that
is persistence, not mechanics.

### States — outcome-shaped

| state | what the consumer understands |
|---|---|
| `queued` | accepted, not tried yet (now brief — milliseconds) |
| `trying` | attempt in flight |
| `done` | completed and **confirmed** — we hold a result |
| `sent` | dispatched, **no confirmation is possible for this kind of request** |
| `failed` | gave up after `tries` |
| `expired` | too old to be worth doing |
| `cancelled` | cancelled by the consumer |

**`sent` vs `done` is load-bearing.** A command gets a device reply, so `done` means
something. A plain text message carries no receipt of any kind, so the most that can ever
truthfully be said is "the gateway accepted it". Rendering those identically would show
chat as confirmed when it is not. This is the SMTP `250 accepted` versus actual delivery
distinction, and it is a property of the REQUEST KIND, not of any particular recipient.

Mapping from today: `pending`→`queued`, `sent`→`trying`, `acked`→`done`. The old `sent`
name is REUSED with a new meaning, so the migration must rewrite it, not pass it through.

### Errors become codes

`lastError: "timeout: reply not received"` is prose that automation would have to regex,
and it half-leaks mechanics. It becomes `{code, message}` — e.g. `no_reply`,
`unreachable`, `refused`, `expired` — so a UI can say "the unit didn't answer" and a
script can branch on the code.

### Fields

`tries` / `maxTries` (renamed from `attempts`/`maxAttempts` — one consumer, early, cheap
now and never again). Plus `kind` (`command` | `text`), state, timestamps, result/error.

## Why SQLite, now

Files were right for a cache and are wrong for a ledger:

- `store.saveQueue()` **rewrites the whole unit array on every state change**. With
  `queued→trying→done` per message that cost grows with history.
- The ledger needs querying: filter by unit and state, order across ALL units
  ("everything I sent, newest first"), paginate, retain. That is a query engine, and a
  hand-rolled one over JSON would be a bad one.
- Concurrent readers (a polling dashboard) against a writer.

Peter: *"we are now really calling for sqlite, flat files are just not up to this"* and
*"we will not use node-dash's"* — hence our own dependency, our own DB file, in our tree.

### Dependency facts — verified, do not re-derive

- `node:sqlite` needs Node ≥ 22.5; this box is **20.19.2**. Blocked.
- **`better-sqlite3@12.11.1`, compiled from source in OUR tree, works**: SQLite 3.53.2,
  WAL, transactions, queries all verified 2026-07-25.
- **Pin 12.x. Do NOT take 13.x**: v13 ships N-API prebuilts and prefers them, and that
  prebuilt **segfaults** on Node 20.19.2. v12 has no prebuilds and always builds from
  source. This was the whole failure, and it was NOT a pnpm fault.
- Rebuilding needs `build/` **and** `prebuilds/` deleted first, or `make` merely re-TOUCHes
  stamps and no-ops. Use **`node-gyp@10`**: node-gyp 13 cannot run on Node 20.19.2
  (`webidl.util.markAsUncloneable` missing from its bundled undici).
- node-dash independently landed on the same place — pnpm, 12.11.1, compiled from source,
  no prebuilds. Separate tree, separate DB file. Nothing shared.

### Schema (one DB, `<store>/mesh.db`)

```sql
PRAGMA journal_mode=WAL;      -- a dashboard reads while the service writes
PRAGMA synchronous=NORMAL;

CREATE TABLE requests (
  id         TEXT PRIMARY KEY,
  unit       TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- 'command' | 'text'
  verb       TEXT,                   -- command only
  args       TEXT,                   -- JSON array, command only
  body       TEXT,                   -- text only
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
CREATE INDEX requests_unit_created ON requests(unit, created_at DESC);
CREATE INDEX requests_state        ON requests(state);
CREATE INDEX requests_created      ON requests(created_at DESC);

CREATE TABLE cache (
  ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
  saved_at INTEGER NOT NULL, ttl_ms INTEGER,
  PRIMARY KEY (ns, k)
);
```

`lib/cache.js` keeps its exact interface (`put/get/value/all/del/clear`) and
**`test/cache.js` must pass unchanged** — that file is the contract, and it already
asserts the rule that must survive: **expiry never deletes**, it flags `stale` and returns
the value.

### Migration

On first open, import existing `queue.json` files and the file-backed cache, mapping old
states to new, then leave the files in place (do not delete) until a later cleanup. A
queued command that survived a restart must survive this too — losing one would be losing
an instruction someone gave.

### Retention

Cap ~500 terminal requests per unit, oldest pruned. **Never prune anything not in a
terminal state.**

## Observe

1. **Static** — no `queue.json` writes remain; `better-sqlite3` pinned to 12.x; states
   and `tries` present.
2. **Functional** — send one of each (dev command, live command, text) and show all three
   in `GET /v1/mesh/queue` with sane states; a text reaching `sent` and never `done`;
   restart the service and show the ledger intact; `test/cache.js` green **unmodified**.
3. **Regression** — a real queued command still round-trips to BNCH; the recorder CSV is
   untouched; suite green.

## Risks

- **Migration is the dangerous moment** — a queued command is an instruction someone gave.
  Import must be verified before the files stop being written.
- **`tries` rename and the state names are a WIRE BREAK for node-dash.** Must be announced
  on xsession *before* they build against the current shape, not after.
- The compiled binary does not survive a clean checkout; a fresh install needs
  `node-gyp@10`. Document it, or CI breaks with a segfault that looks like nothing.

## Findings during verification (both fixed, both would have bitten in production)

1. **Text was keyed by the caller's raw string, not the resolved node id.** A text sent to
   `336b` filed under unit `"336b"` while every command for the same device filed under
   `"!8cee336b"` — one device, two rows in the outbox, history split in half. Caught by
   reading the live ledger after the first real send, not by a test. Fixed: `sendText`
   resolves through `_unitKey` exactly as commands do. (The one pre-fix row is left as
   historical data.)

2. **A request interrupted by a restart was orphaned forever.** An entry in `trying` when
   the process stops has an attempt that died with it, and nothing was left to settle the
   row — it would sit in the outbox reading "in progress" permanently. Fixed: `_load()`
   returns `trying` to `queued` and logs the recovery. The try it already used stays
   counted, so it costs a retry, not a lost instruction. Covered by test/butler.js #13;
   NOT yet observed live (the interrupted command happened to time out and requeue itself
   before the restart, so the recovery path was not exercised on the real service).

## Not done / follow-on

- `pruneRequests()` exists and is tested but **nothing calls it yet** — retention is
  available, not yet enforced. Wire it to a periodic sweep or to service start.
- The stray `better-sqlite3@13.0.1` compiled during the feasibility check is still in the
  pnpm store, unused. Harmless, worth pruning.
- The compiled binary does not survive a clean checkout; a fresh install needs
  `node-gyp@10`. This is a real CI/first-install hazard: the failure mode is a SEGFAULT,
  which looks like nothing at all.
