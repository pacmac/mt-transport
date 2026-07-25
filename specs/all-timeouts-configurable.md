---
task: all-timeouts-configurable
status: IMPLEMENTED 2026-07-25. Every timeout, delay, interval and cap in the shipped code is
  now declared in settings.js DEFAULTS and overridable from config. VERIFIED by a new test
  (test/timeouts.js) that SCANS lib/ + index.js + host-module.js for the two banned shapes and
  fails on any hit — 34 assertions, 0 offenders. Suite 19 files green.
source_hash:
  clients/mesh/lib/settings.js       d81e9316df84efcd
  clients/mesh/lib/config.js         ed06bd8ad5ec7089
  clients/mesh/lib/images.js         202ffb5d06a21a13
  clients/mesh/lib/push-receiver.js  16c5f430553a825a
  clients/mesh/lib/gw.js             260f84cd773e8526
  clients/mesh/lib/butler.js         754ac7e00bb8e328
  clients/mesh/lib/align.js          b9100b6f4a22c5b7
  clients/mesh/lib/store.js          9892bc1c5e299243
  clients/mesh/lib/daemon.js         44da68e7784ca43c
  clients/mesh/index.js              fbdf6b485349ed7a
  clients/host/lib/sse.js            74792295284a570c
  clients/trial-logger/recorder.js   6456f34f8e3c3101
  clients/mesh/config.yaml           76320fab6394e245
  clients/host/host.config.json      92c7fa0ea368b9ca
  clients/mesh/test/timeouts.js      6c87138b2bc1dbe1
  clients/mesh/test/align.js         50ed5da10b057244
  clients/mesh/test/db.js            2bd1ce5222eb4328
  clients/mesh/test/devices.js       7811de29271b0b98
  clients/mesh/test/mode.js          88b3b232d8b92c9f
scope:
  - specs/all-timeouts-configurable.md
  - clients/mesh/lib/settings.js       # THE single source of every timing default
  - clients/mesh/lib/config.js         # schemaAnswerMs / schemaRetryMs (the bug)
  - clients/mesh/lib/images.js         # push idle/poll/deadline, grab poll/timeout, the 4000 literal
  - clients/mesh/lib/push-receiver.js  # idle/act/quiet/maxStale/maxUnanswered
  - clients/mesh/lib/gw.js             # reconnectMs
  - clients/mesh/lib/butler.js         # ttlMs / maxTries (maxPending already done)
  - clients/mesh/lib/align.js          # collect/spacing/reply-window/burst bounds
  - clients/mesh/index.js              # pass config through; silentMs fallback
  - clients/host/lib/sse.js            # KEEPALIVE_MS
  - clients/trial-logger/recorder.js   # silenceCheckMs / reconnectMs
  - clients/mesh/config.yaml           # declared values
  - clients/host/host.config.json      # declared values (the LIVE service reads this)
  - clients/mesh/test/timeouts.js      # NEW: assert NO hardcoded timing literals remain
  # ADDED DURING IMPLEMENTATION — removing the inline fallbacks forced config to be threaded
  # into two more modules, and their tests had to construct them with it:
  - clients/mesh/lib/store.js          # store.defaultLimit / maxLimit were `= 200` inline
  - clients/mesh/lib/daemon.js         # `d.port != null ? d.port : 8787` / `d.host || '127.0.0.1'`
  - clients/mesh/test/db.js            # PayloadStore now needs `query`
  - clients/mesh/test/devices.js       # same
  - clients/mesh/test/mode.js          # mkMesh needs cfg.timing
  - clients/mesh/test/align.js         # align bounds come from config, not constants
  # NOT changed: clients/mesh/test/settings.js — the "defaults exist" assertion it was to
  #   carry lives in test/timeouts.js instead, where it sits beside the scan that enforces
  #   the rule. One file owns the rule.
# NOT changing: the VALUES themselves, except schemaAnswerMs which is the defect being
#   fixed. Everything else keeps its current number so this is a plumbing change with no
#   behavioural surprises.
---

# Spec: all-timeouts-configurable — no timing value lives only in code

## The instruction

Peter, 2026-07-25: *"I told you RIGHT AT THE BEGINNING DO NOT HARD CODE important vars
like timeouts, you again chose to ignore me and it came back and bit you."*
**"EVERY SINGLE TIMEOUT MUST BE CONFIGURABLE. NO EXCEPTION."**

And: *"maybe all of the timeouts are not the same, many will be, so we need to create
logical timeout vars AND USE THEM."*

## What it cost — this is not a style rule

A config-schema pull failed silently **all day**, and I misdiagnosed it three times: first
as the unit being asleep, then as "the entire port-260 return path is dead", then as a
firmware fault. The truth:

```js
this.schemaTimeoutMs = deps.schemaTimeoutMs || 8000;   // config.js:75
schemaTimeoutMs: this.cfg.timing.chunkAnswerMs,        // index.js — a DIFFERENT operation's value
```

The device answers `sch` at **31–46 s** (measured: request 17:42:07, pages 17:42:38/44/53).
We gave up at 8 s. Nothing anywhere declared "schema waits 8 s", so it was invisible; and
changing `chunkAnswerMs` to tune chunking would have moved the schema deadline as a side
effect.

**Borrowing another operation's timeout is the specific failure mode**, not just the bare
literal.

## The rule

1. **`settings.js` DEFAULTS is the only place a timing default may exist.** Every key is
   also written into `config.yaml` and `host.config.json` so it is visible where an
   operator looks.
2. **No inline fallbacks.** `opts.x != null ? opts.x : 8000` is hardcoding — the key is
   undiscoverable, so nobody knows it can be set.
3. **No module-level timing constants**, even in a new file, even when ported from
   someone else's source. `lib/align.js` was written TODAY with `ALIGN_COLLECT_MS` and
   `BURST_SPACING_MS` as bare constants, on the same day the rule was restated.
4. **Never reuse another operation's value.** If a wait is conceptually distinct it gets
   its own name, even if the number happens to match today.
5. Applies to timeouts, delays, intervals, deadlines, retry budgets, caps and spacing.

## The logical groups

Peter's point stands — these are not all the same thing. Grouped by what they physically
wait for:

```yaml
timing:
  sendSpacingMs:    3000     # gap between OUR transmissions
  replyMs:          20000    # a device TEXT reply
  frameAnswerMs:    8000     # a 260/261 FRAME answer (chunk)
  schemaAnswerMs:   60000    # schema pages — MEASURED at 31-46 s, was wrongly 8 s
  schemaRetryMs:    2500     # resend `sch <page>` this often within the above
  attemptTimeoutMs: 10000    # per-attempt reply wait (retry ladder)
  grab:
    timeoutMs:      30000    # camera grab overall
    pollMs:         2000     # grab poll
    ackMs:          4000     # was a bare setTimeout(…, 4000) in images.js
  push:
    idleMs:         35000    # proven push idle
    actMs:          4000     # spacing once the device says where it is
    quietMs:        15000    # post-stream quiet before PROGRESS_Q
    pollMs:         1000
    deadlineMs:     900000   # whole-transfer deadline
    maxStale:       8
    maxUnanswered:  30
  link:
    reconnectMs:    5000     # gw AND recorder — genuinely the same thing, shared
    keepaliveMs:    25000    # SSE comment frame
  liveness:
    silentMs:       150000   # "not heard this long => assume asleep"
    silenceCheckMs: 30000    # recorder's check period
align:
  collectMs:        1200     # gather both radios' copies of one pong
  burstSpacingMs:   1200     # between pings in a burst
  replyWindow:      { defaultSec: 30, minSec: 5, maxSec: 120 }
  burst:            { min: 1, max: 5, default: 4 }
butler:
  ttlMs:            86400000
  maxTries:         5
  maxPending:       10       # already declared
```

**Deliberately shared:** `link.reconnectMs` covers gw and recorder — reconnecting to a
local service is one concept and duplicating it invites drift.

**Deliberately separate:** `frameAnswerMs` and `schemaAnswerMs`, despite both being
"wait for a 260 frame". They are the same *mechanism* and different *physics* — a chunk
answer is immediate, a schema page is built and queued behind other TX. Conflating them
is exactly the bug.

## Changes

Each site loses its literal and reads the declared value. `index.js` passes the whole
`timing` block down rather than cherry-picking, so a new key does not need new plumbing.

**Values are unchanged except `schemaAnswerMs`** (8 s → 60 s), which is the defect. Every
other number is carried across as-is so this is provably plumbing.

## Observe

1. **Static** — `test/timeouts.js` greps the shipped source for timing literals and
   FAILS if any remain. That is the assertion that keeps this from rotting: a rule with
   no test is a rule that gets broken again in a week.
2. **Functional** — a schema pull against an awake bench unit now SUCCEEDS and populates
   the cache (`ns='schema'`), which has been empty since the cache was built.
3. **Regression** — full offline suite green; a queued command still round-trips; push
   and grab paths behave unchanged (same numbers, different source).

## Risks

- **Wide blast radius**: touches nearly every lib. Mitigated by changing no values except
  the one being fixed, and by the suite.
- `host.config.json` must gain the same keys or the live service silently keeps defaults —
  it is the file the running service actually reads, and it has caught us before.

## What was actually found and fixed

The sweep covered **17 `timing` keys**, plus `align` (8), `butler` (3) and `store` (2).
Every one of these was a literal in code or an inline fallback before:

| where | was | now |
|---|---|---|
| `config.js` | `schemaTimeoutMs \|\| 8000`, fed `chunkAnswerMs` | gone entirely — the schema is a file |
| `images.js` | `4000` grab-ack, poll/deadline literals | `timing.grabAckMs` / `grabPollMs` / `grabTimeoutMs` / `pushDeadlineMs` |
| `push-receiver.js` | idle/act/quiet/maxStale/maxUnanswered constants | `timing.push*` |
| `gw.js` | reconnect constant | `timing.reconnectMs` |
| `host/lib/sse.js` | `KEEPALIVE_MS = 25000` | `timing.keepaliveMs` |
| `recorder.js` | silence-check + reconnect constants | `timing.silenceCheckMs` / `reconnectMs` |
| `butler.js` | ttl / maxTries | `butler.ttlMs` / `maxTries` (`maxPending` already done) |
| `align.js` | collect, spacing, reply-window, burst bounds | `align.*` |
| `store.js` | `defaultLimit = 200`, `maxLimit = 1000` | `store.*`, and **throws** if undeclared |
| `daemon.js` | `port \|\| 8787`, `host \|\| '127.0.0.1'` | declared |

**The fallbacks had to go, not just be supplemented.** A `|| 8000` next to a declared key is
worse than no key at all: it silently wins whenever the config path is wrong, which is exactly
how the 8 s schema timeout survived being "configurable". So a missing value is now a loud
error (`store._q()`, `Config.schema()`), never a quiet default.

**The test is a scanner, not a checklist.** Asserting that 17 named keys exist would not have
caught the original bug — `schemaTimeoutMs` was passed a real value from a real key, just the
*wrong* one. test/timeouts.js instead greps the shipped source for `xxxMs = 1234` and
`|| 1234`, so a NEW hardcoded timeout added next month fails the suite without anyone
remembering to add it to a list. `settings.js` is the single allowed exception: it *is* the
declaration.
