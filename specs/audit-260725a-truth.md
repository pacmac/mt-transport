---
task: audit-260725a-truth
status: IMPLEMENTED 2026-07-25. VERIFIED LIVE on the running pac-host:
  `fw` now parses BOTH units ('2-260725-20' and '2-260725-21'; the deployed one was null);
  `/schema/336b` went from stale=None to **stale=True with unitFw='2-260725-20'** — the check
  shipped that morning was inert on the deployed unit and now works; labels corrected; the
  in-flight ping survived the restart reading `trying` with tries and nextTryAt. Suite 19 files
  green (butler 49->60, devices 31->40). ADDENDUM 22:57: two further defects found live after the
  first commit (extra delivery attempt; settled rows aged by createdAt) fixed in the same pass.
source_hash:
  clients/mesh/index.js              3830d6273c20af51
  clients/mesh/lib/butler.js         b4fdfa41911f9166   # updated by the 22:57 addendum
  clients/mesh/lib/store.js          b161b0c92241f355
  clients/mesh/lib/db.js             c3bb7766132d0feb
  clients/mesh/lib/settings.js       c1323ebac351ad23
  clients/mesh/config.yaml           1621b29c5fc9b0ec
  clients/host/host.config.json      8b8e703836d34fa0
  clients/host/API.md                d533658f2c7a55f5   # updated by the 22:57 addendum
  clients/mesh/test/devices.js       18851b505bfa9de2
  clients/mesh/test/butler.js        916e6ec430908aa0   # updated by the 22:57 addendum
scope:
  - specs/audit-260725a-truth.md
  - clients/mesh/index.js            # fw regex; awake from measurement; prune call
  - clients/mesh/lib/butler.js       # sticky `trying`; nextTryAt; cancel/expiry guards
  - clients/mesh/lib/store.js        # persist nextTryAt (pruneRequests needed NO change —
                                     #   it already only touches terminal states)
  - clients/mesh/lib/db.js           # ADDED IN IMPLEMENTATION: migration 3, next_try_at column
  - clients/mesh/lib/settings.js     # store.keepPerUnit — declared, never hardcoded
  - clients/mesh/config.yaml         # labels; keepPerUnit
  - clients/host/host.config.json    # labels; keepPerUnit (the LIVE service reads this)
  - clients/host/API.md              # `awake`, `fw`, and the state machine are contract
  - clients/mesh/test/devices.js     # asserts awake===false from config mode today — WILL FAIL
  - clients/mesh/test/butler.js      # sticky trying + cancel/expiry of a retrying row
  # ADDED 22:57 — two more defects found live AFTER the first commit (8f52be0), folded in
  # rather than deferred, because a deferred finding is a forgotten one:
  #   5. a restart granted an EXTRA delivery attempt (observed tries=6/5) -> butler.js
  #   6. settled requests are aged by createdAt, so "1h ago / done" for a command that
  #      finished 3 minutes ago -> API.md (our half) + a chat item (their half)
# test/db.js was NOT changed: its pruneRequests coverage already asserts live rows survive,
#   and that behaviour is untouched.
# NOT changing:
#   - GET /v1/mesh/align — I told Peter it wasn't reading its config. WRONG: index.js:91
#     wires cfg.align.radios in; the nulls are an idle state machine. Nothing to fix.
#   - unitMode() itself — it is the COMMAND ROUTING decision (direct vs queue) and the
#     config override is correct there. The bug is only that `awake` piggybacks on it.
#   - the firmware's long-name format — the regex adapts to the device, not vice versa.
---

# Spec: audit-260725a-truth — the API must not state what it has not measured

## Why this exists

Peter, 2026-07-25 22:20: *"how many other bugs are you expecting me to uncover for you,
seems that I work for you not the other way around"* — then *"you can fix them all while
I sleep."*

He was right. All evening he found the defects and I confirmed them. These four came from
auditing the live API instead. Three are real bugs; **one I shipped today**.

They share one root: **a field asserts something the service never measured.**

## 1. `fw` parses only the BROKEN name — and silently disables today's staleness check

`index.js:236`:
```js
const fwMatch = typeof name === 'string' ? name.match(/^[0-9a-f]{4}\s+(\S+)$/i) : null;
```

The `[0-9a-f]{4}` prefix is the **fallback** long name a unit carries when its role name
has *not* been applied. So the regex matches only misconfigured units:

```
"b80f 2-260725-21"    -> 2-260725-21   (works ONLY because that unit's name is broken)
"Garage 2-260725-20"  -> NULL          (the DEPLOYED unit)
"Bench 2-260725-9"    -> NULL
"GARG 2-260725-20"    -> NULL
```

Measured consequence:
```
/schema/b80f  unitFw='2-260725-21'  stale=True
/schema/336b  unitFw=None           stale=None
```

`stale` exists to stop a dashboard rendering a config form for the wrong firmware. It is
**inert on the deployed unit** — the one that cannot be reflashed. I verified it this
evening against the single unit whose name happens to match, which is why I missed it.

**Fix:** match `<anything> <version>` and identify the *version*, not the prefix. A version
is `<major>-<YYMMDD>-<build>`, which is unambiguous:

```js
// The firmware appends the build to the long name: "<prefix> <version>", where prefix is
// the role name (Garage/Bench) or, when the role name has NOT been applied, the 4-hex id
// fallback. Anchor on the VERSION SHAPE, never the prefix — anchoring on the prefix meant
// we only ever parsed misconfigured units (audit-260725a-truth).
const fwMatch = typeof name === 'string' ? name.match(/(?:^|\s)(\d+-\d{6}-\d+)\s*$/) : null;
```

## 2. `awake` reports a config file, not the device

`index.js:248` and `:427`:
```js
awake: this.unitMode(id) === 'dev',
```

`unitMode()` returns `cfg.units[id].mode` when an override exists — and **both our units
have one**. So GARG says `awake:false` because somebody typed `"mode":"live"`, and would
say the same sitting awake on the desk. `slp` is `null` on both units, so nothing real
backs it either. `butler.js:121-122` already distrusts this ("the known-unreliable ones").

**Fix — derive from the only thing we actually observe.** `model.heard()` is fed from every
inbound frame (`index.js:152`), so recency is a measurement:

```js
// AWAKE IS A MEASUREMENT, NOT A SETTING. Heard within mode.silentMs => awake. Never heard
// => null (UNKNOWN, not false). It must NEVER be derived from unitMode(), which is the
// operator's routing override and says nothing about the device (audit-260725a-truth).
_awake(id) {
  const n = this.model.node(id);
  if (!n || !n.lastHeardMs) return null;
  return Date.now() - n.lastHeardMs <= this.cfg.mode.silentMs;
}
```

Three-valued on purpose: `true` / `false` / `null` = we have never heard this unit.
`slp` stays a **separate** field — it is the device's sleep *setting*, not its current
state, and conflating them is what produced this bug.

## 3. Device labels inverted

`!8cee336b` is at the garage labelled `"Bench alarm"`; `!987ab80f` is on the bench
labelled `"Garage alarm"`. Short names and modes were toggled at the swap; labels were
not. Swap them in both config files.

Note this WILL rot again at the next swap. Flagging, not solving: a label that encodes
location has to be toggled by hand, exactly like the short name.

## 4. The ledger: `pruneRequests()` is dead, and `queued` hides an active retry

**Dead prune.** `store.js:266` defines it; the only caller is `test/db.js:119`. 150 rows
for one unit and unbounded.
**Fix:** call it on connect, with `store.keepPerUnit` **declared in settings** (no bare
constant). It already refuses to prune live rows.

**`queued` is ambiguous — this is the one Peter hit.** On `/control` he saw
`ping / 29m ago / queued` while the record held `tries: 3/5` and an attempt 9 minutes
earlier. Cause, `butler.js:205`:

```js
next.state = 'queued';   // back in the queue — retry on the next window
```

So `queued` means *both* "never attempted" and "3 of 5 attempts made". node-dash renders
`state`, which is the obvious reading of our contract. Nobody rendered it wrong.

**Fix: make `trying` STICKY.** Once the first attempt is made the row stays `trying` until
it settles. `queued` then means exactly "not yet attempted". `trying` is already in our
documented state enum, so **node-dash needs no change** — their existing display starts
telling the truth on its own.

Also add **`nextTryAt`**: with retries gated on the unit's wake window, only we know
whether the next attempt is in 30 seconds or 15 minutes.

**Sticky `trying` touches five sites, and two are safety-critical:**

| line | now | after |
|---|---|---|
| `48` `_load` | `trying` → `queued` | leave `trying`; still resumable, count for the log |
| `145` `cancel` | only `queued` | `queued` **or** `trying`, **but not while `inflight`** |
| `154` `_sweep` | expires only `queued` | **must** include `trying`, else a retrying row never expires |
| `175` `_deliverNext` | picks `queued` | picks `queued` or `trying` (the `inflight` set is the real lock) |
| `205` retry | → `queued` | stays `trying`, sets `nextTryAt: null` (window-gated, unknown) |

Sites 145 and 154 are the dangerous ones: leaving them as-is would make a retrying command
**uncancellable and unexpirable**. Both get an `inflight` guard so nothing is cancelled or
expired mid-attempt.

**Alternative considered and rejected:** leave the state machine alone and expose
`attempts{}` alongside. Lower risk, but it leaves `state` dishonest and needs node-dash to
change code to fix *our* defect. The state field should mean what it says.

## Observe

1. **Static** — the old regex is gone; no `awake:` derived from `unitMode`; `pruneRequests`
   has a non-test caller; `state = 'queued'` no longer appears in the retry path.
2. **Functional** — `GET /v1/mesh/devices` shows `fw` for BOTH units; `/schema/336b`
   returns `stale: true` with a real `unitFw`; the in-flight ping reads `trying` with
   `tries` and `nextTryAt`.
3. **Regression** — full suite green, and the live ping probe keeps running across the
   restart with its ledger row intact.

## Risks

- **Sticky `trying` is a semantic change to a live contract.** Mitigated by it being an
  already-documented state, the five sites being enumerated above, and new tests for
  cancel-while-retrying and expire-while-retrying.
- **`awake` becomes three-valued.** `null` is new for consumers. API.md must say `null`
  means unknown, not false.
- **A restart mid-experiment** re-reads the ledger from SQLite; the running ping probe
  polls the API, so it tolerates it. Verify the in-flight row survives rather than assume.

## What implementation changed about the plan

**`pruneRequests()` needed no edit at all.** The spec assumed sticky `trying` would require
teaching it a new live state. It already prunes only `['done','sent','failed','expired',
'cancelled']`, so a `trying` row was never at risk. One less change than planned.

**A schema migration was required and had not been anticipated.** `nextTryAt` has to survive a
restart, so it needs a column: `db.js` migration 3, `next_try_at`. Verified applied against the
live database (20 columns, 150 rows intact).

**Three existing butler assertions encoded the OLD state machine** and failed, exactly as the
spec predicted for `test/devices.js`. Two were mechanical. The third — "an interrupted `trying`
request returns to the queue" — was rewritten rather than patched: with sticky `trying` the
state string on load is no longer meaningful (interrupted-mid-attempt and waiting-for-window are
indistinguishable and resume identically), so the test now asserts **the invariant that actually
matters** — the request is still delivered, its used try is still counted, and `nextTryAt` is
cleared. Testing a state string there was always the weaker check.

## Found during implementation, NOT fixed (out of scope)

**A restart grants one extra delivery attempt.** A row interrupted at `tries == maxTries` is
reloaded, selected, incremented to `maxTries + 1`, attempted, and only then marked `failed`.
Observed live: ping `ms0u8qv9.0` sat at `tries: 5/5` in `trying` across the restart.
This is **pre-existing, not a regression** — the old `_load` reset such a row to `queued` and
`_deliverNext` did exactly the same thing. It terminates correctly (the next failure settles it),
so it costs one extra transmission per interrupted command, never a loop. Logged, not fixed:
the guard belongs in `_deliverNext` (skip and settle when `tries >= maxTries`) and that is a
separate change to the delivery path.

## Deferred verification

`awake` returning `true`/`false` from real traffic could not be proven within the session:
pac-host restarted, so `model.lastHeardMs` is empty and every unit correctly reads `null`
(never heard *since restart*). Both units beat on a ~15-minute heartbeat, so the flip needs one
heartbeat to observe. The unit-level behaviour IS covered by test/devices.js 2c, which asserts
`true` inside `silentMs`, `false` beyond it, and `null` when never heard — including the case
that caused the bug (`mode: 'live'` override present, heard just now, must be `true`).

## Addendum, 22:57 — two more, found live after the first commit

Peter: *"tomorrow I would have already forgotten it."* Both were captured as mcpp steps
before any code was touched, then fixed in the same pass.

### 5. A restart granted an extra delivery attempt

Observed on the live ledger at 22:51:20: `ms0u8qv9.0` settled `done` with **`tries: 6/5`**.

`_deliverNext()` selects on *state* and never checks *tries*, so a row interrupted at
`tries == maxTries` is reloaded, selected, incremented past the limit, and only settled
`failed` after that extra attempt fails.

**I had already found this during the audit and deliberately deferred it**, reasoning it
"costs one extra transmission, never a loop". That was wrong, and this run proves it: the
*only* reason that ping ever succeeded is the restart handing it an attempt it was not
entitled to. Without the restart it would have been `failed` at try 5, and GARG's pong —
the first reply in five and three-quarter hours — would have arrived with no live row to
attach to. A lost receipt, not a spare transmission.

Fixed with a guard at the head of the delivery path: a selected row already at `maxTries`
is settled `failed` instead of attempted.

### 6. Settled requests are aged by the wrong timestamp

`/control` showed the GARG ping as **"1h ago · done"** when it had settled three minutes
earlier. That age is `createdAt` (21:45:12), not `settledAt` (22:51:20).

Same shape as the `queued` defect: we return four timestamps with no guidance, so the
misleading one is the easy one to reach for. On a 15-minute wake window these are routinely
**an hour apart**, which no consumer would guess from the field names alone.

Our half is the contract — API.md now states which field to render for a settled request,
and why the two diverge. Which field node-dash's Executed list uses is their code and
their call; raised on the channel with the measured example rather than asserted.
