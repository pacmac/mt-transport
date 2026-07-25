---
task: butler-collapse-duplicates
status: IMPLEMENTED 2026-07-25. VERIFIED LIVE: 20 identical POSTs to the running service
  produced ONE entry and returned the SAME id every time (ms0ibxbz.0); zero duplicates in the
  ledger. Offline: butler 32 -> 45 assertions, including a literal replay of the 55-command
  incident. maxPending declared in BOTH config files, not left as a hidden default.
source_hash:
  clients/mesh/lib/butler.js:      b25ed6057b51a8ee
  clients/mesh/test/butler.js:     2e4a6030a179829c
  clients/mesh/config.yaml:        d2a0bec5e1b3a474
  clients/host/host.config.json:   1fd463f1e87615ac
scope:
  - specs/butler-collapse-duplicates.md
  - clients/mesh/lib/butler.js       # collapse identical pending commands; cap pending per unit
  - clients/mesh/test/butler.js      # cover both guards, incl. a replay of the real flood
  - clients/host/API.md              # the collapse is consumer-visible (same id returned twice)
  - clients/mesh/config.yaml         # butler.maxPending declared, not an invisible default
  - clients/host/host.config.json    # same, for the live service
# NOT changing: the ledger schema, states, retention, or delivery. This only governs what
#   is ACCEPTED into the queue. Text is deliberately exempt — see below.
---

# Spec: butler-collapse-duplicates — a caller cannot flood the queue

## What actually happened

Nothing was broken. The service faithfully queued **55 identical `txp` commands** because
it was asked to, 55 times, by me. The wait-loop I wrote used a **POST as its poll
condition**:

```bash
until curl --max-time 20 -X POST /v1/mesh/command -d '{"unit":"336b","verb":"txp"}' \
      | grep -q '"dbm"'; do sleep 5; done
```

`POST /command` is a WRITE. For a unit that cannot answer it creates a ledger entry, and
the exit condition (`"dbm"` in the response) only appears when the device replies. The
unit was asleep — it had latched the garage role on a battery boot — so it never replied,
the loop never exited, and each iteration enqueued another command.

The timing proves the mechanism: 55 entries over 2321 s with inter-arrival gaps of
**25.01, 25.01, 25.02 s** — exactly `--max-time 20` + `sleep 5`.

**The rule broken: a poll must be a READ.** The correct condition was
`GET /v1/mesh/queue/<id>` against the one entry already created.

Peter: *"well we need to hard prevent this?"* — so the guard goes in the service, because
a bug I can repeat is a design gap, not just my mistake.

## Design — two guards, different jobs

### 1. Collapse identical pending commands (the common case)

On enqueue, if a **non-terminal** (`queued` or `trying`) entry exists for the same
`(unit, kind, verb, args)`, **return that entry** instead of creating a new one.

This is the same principle already proven in the FIRMWARE tx queue (`mt-txqueue`
replace-by-key), where a newer telemetry frame supersedes a stale queued one rather than
stacking. Here it is stronger still: the pending command has not been delivered yet, so a
second identical one cannot achieve anything the first will not.

It would have turned 55 entries into 1.

**Text is EXEMPT.** Two identical messages are two genuine sends — a person typing "ok"
twice means it twice. Collapsing chat would silently swallow a message, which is far worse
than a duplicate command. So the collapse applies to `kind: 'command'` only.

**`force: true` bypasses it**, for a deliberate repeat (e.g. re-sending a command you
believe was lost). The escape hatch matters: without it, a legitimate repeat becomes
impossible rather than merely inconvenient.

### 2. Cap pending per unit (the backstop)

Collapse only catches *identical* commands. A loop varying an argument would still stack.
So: a hard ceiling of **`maxPending` (default 10)** non-terminal entries per unit. Beyond
it, enqueue **throws** rather than silently dropping — a caller that has queued 10
undelivered commands at one radio has lost control, and should be told, not humoured.

**Why 10 and not something roomier.** Peter: *"when would we ever send 50 commands to a
device?"* — we would not. The largest legitimate backlog observed is **1**; a deliberate
setup sequence on a sleeping unit might be 3–5 (`interval`, `sleepmode`, `name`). A cap of
50 would have admitted 50 of the 55 strays before objecting, which is barely a guard at
all. With collapse already reducing an identical flood to one entry, the cap only has to
catch a *varied* flood — rarer still — so it can afford to be tight.

The cap protects the DEVICE as much as the database: every queued command is airtime on a
shared mesh aimed at a battery-powered radio.

### What the caller sees

The collapsed entry is returned with `collapsed: true` so a consumer can tell "your
command is already in the queue" from "a new one was created". The `id` is the FIRST
entry's id — so polling that id still works, which is exactly what a correct wait-loop
would have been doing.

## Changes

`clients/mesh/lib/butler.js`
- `enqueue()`: before creating an entry, scan `_entries(unit)` for a non-terminal match on
  `(kind==='command', verb, args)` unless `opts.force`; return it (marked `collapsed`) if
  found.
- `enqueue()`: count non-terminal entries for the unit; throw `EQUEUEFULL` past
  `maxPending`.
- constructor: `maxPending` from `cfg.butler.maxPending`, default 10.

**Declared in config, not buried as a default** (Peter: *"should be a variable"*). A limit
that only exists in code is a limit nobody knows they can change, and it would have to be
found by reading source at the moment someone is already fighting a flood.

`clients/mesh/test/butler.js` — new assertions:
- 55 identical enqueues produce ONE entry (a literal replay of the incident);
- the returned id is stable across those calls and `collapsed` is set on repeats;
- a DIFFERENT verb, or different args, is NOT collapsed;
- a collapse does NOT happen once the first entry is terminal (a later repeat is a genuine
  new command);
- **text is never collapsed** — two identical messages give two entries;
- `force: true` bypasses collapse;
- the cap throws, and only counts non-terminal entries.

## Observe

1. **Static** — the collapse and cap are both in `enqueue`.
2. **Functional** — replay the flood against the live service: POST the same command 20
   times in a loop; `GET /v1/mesh/queue` shows **one** pending entry, and every response
   carries the same id.
3. **Regression** — a normal queued command still round-trips; two distinct commands still
   both queue; the offline suite passes.

## Risks

- **A collapsed command may be wanted twice.** Mitigated by `force`, and by the collapse
  only applying while the first is still undelivered.
- **The cap could reject a legitimate burst** on a unit that is offline for a long time.
  10 already exceeds anything observed; if it is ever hit in real use that is information
  worth having, not a limit to raise reflexively — see below.

## If the cap is ever hit

Peter: *"10 is already a lot."* Treat reaching it as a **bug signal, not a capacity
problem**. Nothing in normal operation queues ten undelivered commands at one radio, so
the first response to an `EQUEUEFULL` is to find the caller looping — not to raise the
number. Raising it should require a concrete, named use case.
