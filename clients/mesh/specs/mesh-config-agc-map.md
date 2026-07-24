---
task: mesh-config-agc-map
status: IMPLEMENTED + VERIFIED 2026-07-24. config 28 (+6). LIVE b80f: config set agc.on 0 -> device agc verb, cmd agc shows on=0 sec=60 preserved, restored. Full suite green.
source_hash:
  clients/mesh/lib/config.js: 7a9ac7cb0a684e1f0667c50e9a245c83584558563392a46c2769a8151e256dc5
  clients/mesh/test/config.js: 3a552a674f9b240b7de8a5003fe1d31404f42fca031566bcaa74deaec0fae727
scope:
  - clients/mesh/lib/config.js         # COMMAND_MAP + FALLBACK_FIELDS entries for agc.on/agc.sec
  - clients/mesh/test/config.js        # a mock `agc` device + set() assertions (both fields)
# NOT changing: firmware (the `agc` verb already exists), config get (agc.* stay in the device schema).
---

# Spec: mesh-config-agc-map — `config set agc.*` via the existing `agc` text verb

## Why
`agc.on`/`agc.sec` are in the device CONFIG_FIELDS (schema) but have no client transport mapping,
so `config set agc.on 0` throws ENOMAP / can't fall back when the schema pull is flaky. The device
`agc [<on> [<sec>]]` verb replies `{type:"agc",on,sec,agcr}` and sets BOTH — same shape as
`chunk cfg` sets hop+gap. Mirror the chunk.* mapping.

## Diffs

### lib/config.js — COMMAND_MAP (after the chunk.* entries, ~26)
```js
'agc.on':  { needsCurrent: true, readVerb: 'agc', readArgs: [], writeVerb: 'agc',
             write: (cur, v) => [String(v), String(cur.sec)],
             confirm: (r, v) => !!(r && Number(r.on) === v) },
'agc.sec': { needsCurrent: true, readVerb: 'agc', readArgs: [], writeVerb: 'agc',
             write: (cur, v) => [String(cur.on), String(v)],
             confirm: (r, v) => !!(r && Number(r.sec) === v) },
```
(bare `agc` reports {on,sec}; each write carries the unchanged sibling, exactly like chunk hop/gap.)

### lib/config.js — FALLBACK_FIELDS (so it works when the `sch` pull is lossy — the common case)
```js
'agc.on':  { id: 'agc.on',  ty: 'b', label: 'AGC reset',   writable: true },
'agc.sec': { id: 'agc.sec', ty: 'n', label: 'AGC reset s', writable: true, min: 5, max: 3600, bounded: true },
```

### test/config.js
Add an `agc` arm to the mock device (state {on,sec}; bare = report, `agc <on> <sec>` = set + reply
`{type:'agc',on,sec}`), and assertions: `set('b80f',{'agc.on':0})` -> device sees on=0, confirmed;
`set('b80f',{'agc.sec':30})` -> sec=30, confirmed; out-of-range `agc.sec:4` -> ERANGE (no airtime);
bool coercion `agc.on:'0'` accepted. Cover BOTH the schema and fallback paths.

## Observe
1. Static: grep COMMAND_MAP + FALLBACK_FIELDS show agc.on/agc.sec.
2. Functional: `node test/config.js` green (was 22, +N). LIVE: `mtmesh b80f config set agc.on 0`
   then `cmd agc` shows on=0; restore.
3. Regression: chunk.gap set still confirmed (shared verb pattern untouched).
