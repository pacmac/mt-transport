---
task: mesh-logging
status: IMPLEMENTED + VERIFIED 2026-07-23. log gating 11 + skeleton 14/14 + transport 31 green; stdout stays clean (logs -> stderr).
source_hash: clients/mesh/lib/log.js 010ce699651ad5d47ad428a7320d346c515dda862572966664d05c08643b13c1; clients/mesh/lib/settings.js 96a449395866a72c2e54e6d57144bac73123141825add43ced3aca27ae0ae889; clients/mesh/config.yaml a6dd1def5828ff635491578446fde5083678588394d5f9cf48364d9d1f8957e9; clients/mesh/lib/gw.js 305e41139279a0fac1f4facb67efd729a488fecaaca6689600da8c6a8091a95d; clients/mesh/lib/timing.js 72af71255d9620d1f9b94eeab8c83749e9735b3c42999d897d847b911d731fb4; clients/mesh/test/log.js 349007171e6347bf68acb5dc50d410e734db2b2f2676e2d8dc4ba5ff738119e5
project: mt-transport
scope:
  - specs/mesh-logging.md
  - clients/mesh/lib/log.js        # NEW — singleton leveled logger
  - clients/mesh/lib/settings.js   # +logLevel in DEFAULTS
  - clients/mesh/config.yaml       # +logLevel
  - clients/mesh/lib/gw.js         # retrofit silent catches -> leveled logs
  - clients/mesh/lib/timing.js     # add leveled log points
  - clients/mesh/test/log.js       # NEW — level-gating test
---

# mesh-module — level-based debugging

Cross-cutting logging for `clients/mesh`. One tiny module, one shared logger, no
config threading. Retrofit the transport's silent `catch`es into leveled logs.

## lib/log.js — singleton leveled logger
```
LEVELS = { silent:-1, error:0, warn:1, info:2, debug:3, trace:4 }
```
- A single ROOT logger (module singleton). `require('./log')` everywhere returns
  the same instance — no per-construct wiring, no cfg passed around.
- Level resolution at import: `MTMESH_LOG` env (name or number) → else `'info'`.
  Unknown value → `'info'` (never throw from a logger).
- API:
  - `log.error/warn/info/debug/trace(...args)` — emit iff `LEVELS[current] >= LEVELS[method]`.
  - `log.child(scope)` → a logger whose lines are prefixed `[scope]`; delegates to
    the root level (setLevel on root affects all children). Children can be nested.
  - `log.setLevel(nameOrNum)` — runtime override (index.connect will call this from
    `cfg.logLevel` once settings.load lands). Returns the resolved level name.
  - `log.level` — current level name (getter).
  - `log.isEnabled(method)` — cheap guard for expensive message construction.
- Output: `error`/`warn` → `process.stderr`; `info`/`debug`/`trace` → `process.stderr`
  too (stdout stays reserved for CLI DATA output — `--json` etc must never be
  polluted by logs). Each line: `<LEVEL> [<scope>] <message>` (args joined like
  console.log via util.format). No timestamps in v1 (keep it grep-clean; add later
  if needed).
- The stream is injectable (`log._out`) so the test can capture without spawning.

## settings.js + config.yaml — the config var
- `settings.js` `DEFAULTS`: add `logLevel: 'info'` (top-level key).
- `config.yaml`: add
  ```yaml
  logLevel: info        # silent|error|warn|info|debug|trace ; env MTMESH_LOG overrides
  ```
- No load() change (still skeleton). When settings.load lands it will
  `log.setLevel(cfg.logLevel)` and honour a `--log` flag; out of scope here.

## gw.js retrofit (behaviour unchanged apart from logging)
`const log = require('./log').log.child('gw')`. Replace the three silent
`catch {}`/comment-only handlers with leveled calls, and add trace/debug points:
- connect open → `log.debug('ws open', url)`; message JSON.parse fail →
  `log.trace('drop non-JSON ws frame')`; a throwing handler → `log.warn('event handler threw', err)`.
- `device_snapshot` captured → `log.debug('snapshot: N devices')`.
- close/reconnect → `log.info('ws closed; reconnecting in Nms')` (skip when stopped).
- ws error → `log.error('ws error', err)` (in addition to the existing handler
  fan-out + connect reject).
- `sendText` → `log.debug('send', {gwId, channel, to, bytes})` before POST;
  non-ok → `log.warn` before the throw (the throw stays).

## timing.js log points (behaviour unchanged)
`const log = require('./log').log.child('timing')`.
- enqueue → `log.trace('enqueue', {priority, dedupKey})`; dedup hit →
  `log.debug('dedup: returning in-flight promise', key)`.
- pump send → `log.trace('send (spacing Nms waited)')`; thunk throw →
  `log.warn('send threw', err)` (before reject).
- timeout fire → `log.debug('timeout', {retriesLeft})` (before reject/requeue).
- onReply consumed → `log.trace('reply matched')`.

## NOT in scope
- index.js `--log` flag wiring + calling setLevel from cfg (settings phase).
- model/images/config/notify log points (those modules are still skeleton).
- Timestamps, log files, rotation, transports (notify.js already owns alert
  transports — logging is separate and stderr-only).

## Verify (Observe)
- **test/log.js** (offline, captures `log._out`):
  - at level `warn`: `error`+`warn` emit, `info`/`debug`/`trace` suppressed.
  - at level `trace`: all five emit.
  - `silent`: nothing emits.
  - `child('gw')` output carries `[gw]`; nested child carries both scopes.
  - `setLevel` returns resolved name; unknown → `info`; env `MTMESH_LOG=debug`
    honoured on a fresh require (child-process one-liner).
  - `isEnabled('debug')` matches the level.
- **Regression**: `node test/skeleton.js` → 14/14; `node test/transport.js` → 31;
  `require('..')` clean. gw/timing behaviour unchanged (transport suite still green
  proves the retrofit added only logging).
- **Static**: grep gw.js/timing.js show no remaining empty `catch {}` /
  comment-only silent handlers.
