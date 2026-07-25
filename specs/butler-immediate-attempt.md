---
task: butler-immediate-attempt
status: IMPLEMENTED 2026-07-25. VERIFIED ON AIR against BNCH: immediate attempt fires 12 ms
  after enqueue with no onHeard (was: waited for the next beat, up to 15 min). BNCH happened
  to be asleep, so the run also proved the fallback — the attempt failed, the entry returned
  to pending, and the wake-window path delivered it at 11:35. Butler tests 15 -> 29
  assertions; offline suite 16/16.
source_hash:
  clients/mesh/lib/butler.js:   72286308af450baa
  clients/mesh/test/butler.js:  861845df2cf943d1
scope:
  - specs/butler-immediate-attempt.md
  - clients/mesh/lib/butler.js        # enqueue() kicks one immediate attempt
  - clients/mesh/test/butler.js       # cover the new path
# NOT changing: the ONE-COMMAND-PER-WINDOW rule, TTL/expiry, the retry ladder, cancel(),
#   the persisted ledger shape, mesh.dispatch()'s live/dev routing, or the HTTP contract
#   (POST /queue still returns an id immediately and never blocks on the radio).
---

# Spec: butler-immediate-attempt — try now, don't wait for the beat

## The problem

`enqueue()` (`butler.js:38`) only pushes to the queue and persists. **Every** delivery
happens in `onHeard()` (`:77`), which fires when the unit transmits. So a queued command
cannot leave the gateway until the unit's next beat — **up to 15 minutes**, even when the
unit is awake and would answer instantly.

Observed today: a `ping` queued for BNCH at 11:26 UTC was still `pending`, `attempts: 0`,
with nothing wrong. And GARG — which is currently **never sleeping** — still waits for its
15-minute telemetry beat before any command reaches it. The wake-window design is correct
for a sleeper; it is pure added latency for a unit that is already listening.

Peter, 2026-07-25: *"I think we need to change the logic of the queue, it should always
try once immediately."*

## Why "always", rather than "only when we think it is awake"

The obvious optimisation is to try immediately only when `unitMode()` says `dev` (awake)
and skip it for a `live` (sleeping) unit, saving the wasted frame.

**Reject that**, because our awake/asleep knowledge is known-unreliable — that is the
open `model-sleep-truth` task: `slp` goes stale and `awake` is a heuristic from
last-heard silence. Gating on a value we know to be wrong would make delivery latency
depend on a lie. "Always try once" needs no state at all, which is precisely what makes
it robust.

The cost of being wrong is one frame (~1.6 s airtime at SF11) that a sleeping unit does
not hear. Command volume is ~36 in two days. That is a good trade.

## Design

### One immediate attempt, fire-and-forget

`enqueue()` ends by kicking a delivery attempt **without awaiting it**:

```js
setImmediate(() => this._deliverNext(unit, 'immediate').catch(() => {}));
return entry;
```

**Fire-and-forget is load-bearing, not stylistic.** `deliver()` waits on a radio reply
(~20 s `replyTimeoutMs`). If `enqueue()` awaited it, `POST /v1/mesh/queue` would block for
20 s against a sleeping unit — breaking the documented contract that a queued command
"returns an id immediately" (API.md 6.1) and turning an asynchronous API synchronous.
The caller gets its id at once; the attempt happens behind it.

### It is the SAME delivery path, not a second one

`onHeard()`'s body becomes `_deliverNext(unit, reason)`, and `onHeard()` becomes a thin
caller passing `reason: 'window'`. The immediate attempt therefore inherits, for free:

- the **`inflight` guard** — an immediate attempt cannot overlap a window delivery to the
  same unit, so the one-command-per-window rule still holds;
- TTL sweep, attempt counting, `acked`/`failed` transitions, persistence, events.

The only difference is the log line and the `reason`. Two delivery paths would be two
places to get the locking wrong; there is one.

### Attempt accounting: the immediate try COUNTS

`attempts` increments, exactly as a window delivery does. It is a real send using real
airtime, and the ledger has to stay truthful — an attempt that happened must be visible.

Consequence, stated plainly: against a sleeping unit a command now burns attempt 1 of 5
immediately and has 4 window attempts left instead of 5. That is acceptable — `maxAttempts`
is a retry budget, not a wake-window count, and 4 windows is still 4 chances. **No change
to the default.**

### What does NOT change

- **One command per window.** If three commands are queued in a burst, the first goes
  immediately and the rest wait for windows, exactly as today. Draining the whole queue
  against an awake unit is a *different* change — see Open below.
- Nothing about `dispatch()`'s live/dev routing. A `dev` unit still goes direct and
  synchronous; only the queued (butler) path gains the immediate attempt.

## Changes

1. `clients/mesh/lib/butler.js`
   - rename the body of `onHeard(unit)` → `_deliverNext(unit, reason = 'window')`;
     `onHeard(unit)` becomes `return this._deliverNext(unit, 'window')`.
   - log line distinguishes the two: `"window open for %s"` vs `"trying %s immediately"`.
   - `enqueue()` gains the `setImmediate` kick before `return entry`.
2. `clients/mesh/test/butler.js` — new assertions:
   - enqueue triggers exactly ONE delivery attempt with no `onHeard` at all;
   - `enqueue()` **returns before** the deliver promise settles (the non-blocking rule);
   - a failing immediate attempt leaves the entry `pending` and it still delivers on the
     next `onHeard`;
   - a burst of 3 enqueues to one unit produces ONE in-flight delivery, not three;
   - the immediate attempt increments `attempts`.

## Observe

1. **Static** — `_deliverNext` present; `enqueue` kicks it; `onHeard` delegates.
2. **Functional (bench, BNCH only)** — queue a `ping` and time it. Today it waits for the
   next beat; after this it should be answered in seconds with no beat in between. Show
   the ledger entry with `sentAt - enqueuedAt` of a few seconds, not minutes.
3. **Regression** — the offline suite passes; a command queued for a *sleeping* unit still
   ends up `pending` after its failed immediate attempt and still delivers on the next
   window (the wake-window path must be intact, since that is the whole point of the butler).

## Risks / open

- **Wasted airtime against a sleeping unit** — one frame per queued command. Quantified
  above and accepted.
- ~~**The burst case is unimproved.** Against an awake unit, commands 2..N still wait for
  a beat each.~~ **WRONG — corrected by the live run.** A queue DOES drain within one
  window, and the mechanism was already there: the unit's *reply* is itself a
  transmission, so it raises `heard` → `onHeard` → the next delivery. Measured
  2026-07-25: two pings queued for BNCH both delivered in the 11:35 window, the second
  starting **403 ms** after the first acked (`11:35:23.167` acked → `11:35:23.570`
  delivering). So no follow-on work is needed here, and `model-sleep-truth` is not a
  dependency for draining. The one-command-*at-a-time* rule (the `inflight` guard) still
  holds and is what keeps this orderly rather than concurrent.
- GARG is at 65% and falling ~1.1 %/hr; this change makes commanding it more responsive
  but does **not** address the drain, which is the never-sleeping state and needs the
  swap (or an explicit decision on `sleepmode`).
