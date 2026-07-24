---
task: mtmesh-mode-live-dev
status: IMPLEMENTED + VERIFIED 2026-07-24 (M1-M3). mode 11 offline + full suite (13 files) green. LIVE b80f: dev status -> direct {type:mem}; `mode live` -> live; live status -> QUEUED (note: delivers on next wake), delivered+acked with correct receipt; `cmd reboot` in live w/o --force -> ELIVE; `mode auto` -> dev. Routed via daemon /command + /mode (butler + state authority); config override persisted.
source_hash:
  clients/mesh/lib/model.js: 8f768e09e244c9b349f87c53895a165a31c64939e82d434b021f01a2d6742894
  clients/mesh/index.js: e05ae1b2efd4cd72fb94d04f36e3fa3aaaa7113c9132abdd88a046f60d169959
  clients/mesh/lib/settings.js: d815494469f256e283a0337766d526d0fd4e8c5ab1bc1e550baff44ad899846b
  clients/mesh/lib/daemon.js: 99f463eba02d3769dee25c4e685867589a586511742eb34d9af0396987437d3f
  clients/mesh/bin/mtmesh.js: 0d36d16981e6f0a5cb97cc40727c7e090109b38c83e91db37651acdead2aee24
  clients/mesh/test/mode.js: 5a67b25f1b88fe3fec043e12fee79e23e28eb3bbc6529517fdd4ef91596e494b
  clients/mesh/test/daemon.js: 85da62ca80be5ee18feeee9bb3265c8b19564da4b4fd7ca8f9a2f8a746bcb351
scope:
  # IMPLEMENTED. Also: daemon POST /command + /mode routes; bin daemonJson helper; test/daemon.js mock; test/mode.js.
  - mt-transport/specs/mtmesh-mode-live-dev.md
  - clients/mesh/index.js          # last-heard tracking; unitMode(); dispatch() routing; danger-guard
  - clients/mesh/lib/model.js      # per-unit lastHeardMs + last-known slp
  - clients/mesh/lib/daemon.js     # /nodes/:id exposes {mode,lastHeardMs,slp,awake}
  - clients/mesh/lib/settings.js   # units: { <id>: { mode } } per-unit config
  - clients/mesh/bin/mtmesh.js     # operator verbs route via dispatch; `mode` verb; --force
# NOT changing: command() stays the DIRECT primitive (internal callers + the butler's in-window
#   deliver always want direct); the butler; the firmware (slp already reported).
---

# Spec: mtmesh-mode-live-dev — two interaction models, per unit

## The two modes
- **dev** = SYNCHRONOUS. Unit awake (sleep off). `mtmesh <u> status` → send, wait, print the reply.
  Today's behaviour.
- **live** = ASYNCHRONOUS. Unit asleep ~99% (RTC wake). The SAME `mtmesh <u> status` must NOT try a
  direct command (it would time out — the unit is deaf) → it **auto-queues via the butler** and
  returns `queued — delivers on next wake`, receipt to follow. Never a timeout.

Per-unit, because the bench is dev-awake while GARG is live-asleep **at the same time**.

## How mode is decided (first match wins)
1. **Explicit override** — `config.units.<id>.mode: dev|live` (operator forces it).
2. **Sleep state** — the unit's last-known `slp` (device reports it in status/config): `slp==1` → live.
3. **Liveness** — not heard in > `mode.silentMs` (default ~2× heartbeat, e.g. 150 s) → live (assume asleep).
4. **Default** — dev (awake, recently heard).

The daemon is the source of truth: it tracks **lastHeardMs** (from the new `heard` event — fires on
every packet from a unit) and caches the **last-known `slp`** from any status/config reply it sees.
A one-shot CLI has no history, so it **asks the daemon** (`GET /nodes/:id` → `{mode,lastHeardMs,slp,awake}`).

## Routing (the point)
- `command()` stays the DIRECT primitive — internal callers (images/config) and the butler's
  in-window `deliver` always want direct, regardless of mode.
- New `Mesh.dispatch(unit, verb, args)` — the OPERATOR path:
  - dev  → `command()` (synchronous; returns the reply).
  - live → `queueCommand()` (async; returns `{queued:true, id, unit, note:'delivers on next wake', lastHeardMs}`).
- The CLI's operator verbs (`status`, `ping`, `cmd`, `config set`, `image grab`, …) go through
  `dispatch`, so the same command Just Works in both modes. `queue`/`listen`/`nodes` are unaffected.

## Safety (live is a drive away)
- In **live** mode, danger verbs (`reboot`, `wedge`, and non-idempotent `cmd`s) require `--force`;
  otherwise `dispatch` refuses with "live unit — use --force". (Pairs with the butler's
  non-idempotent no-retry guard, the other open butler refinement.)
- `dispatch` also annotates the queued entry so the ledger shows operator-initiated vs autonomous.

## CLI surface
- `mtmesh <u> mode`            → show resolved mode + why (override/slp/silent) + lastHeard.
- `mtmesh <u> mode dev|live|auto` → set/clear the per-unit override (persists to config).
- Operator verbs: unchanged syntax; dev prints the reply, live prints the queued ack.

## Phasing (when approved)
- **M1**: last-heard tracking (model + `heard`) + `unitMode()` resolver + `/nodes/:id` mode fields.
- **M2**: `dispatch()` routing + CLI operator verbs through it + the `mode` verb + config override.
- **M3**: danger-guard (`--force`) in live + ledger annotation.

## Observe (when built)
1. Offline: `unitMode()` picks live for slp=1 / silent, dev for recently-heard; dispatch routes
   dev→command, live→queueCommand (mocked). Full suite green.
2. LIVE: with b80f awake → `mtmesh b80f status` returns the reply (dev). Force b80f into sleep →
   `mtmesh b80f status` returns `queued — delivers on next wake` (live) and lands on wake.
3. Regression: internal command() paths (images/config/butler) unchanged; `queue`/`nodes`/`listen` intact.
