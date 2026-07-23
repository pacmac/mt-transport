---
task: mesh-nodes-shape
status: IMPLEMENTED + VERIFIED LIVE 2026-07-23. mtmesh nodes returns the real roster (OMNI/U33B/DEV1/TA2m); offline suites green.
source_hash: clients/mesh/index.js 7702cf3882875dc9de0bfc063b4c21c30ba9d7e428992bd07cdb850e009d1949; clients/mesh/test/cli-live.js 68abb9f243c785a03030ac134f3e0fbda9ddc8352470b11122b343f26e1b47c0
project: mt-transport
scope:
  - specs/mesh-nodes-shape.md
  - clients/mesh/index.js          # _summaries only
  - clients/mesh/test/cli-live.js  # add real-shape assertions
---

# mesh-cli-live follow-up — firm _summaries to the verified live nodes shape

`mesh-cli-live` shipped `_summaries` against an UNVERIFIED guess ("array or
{nodes:[...]}"). Live smoke (2026-07-23) proved the real shape is different, so
`mtmesh nodes` returned `[]`. This firms it.

## Verified live shape — GET /{gwId}/nodes (localhost:8001/!2687afb1/nodes)
```
{ "total": 4, "count": 4, "filter": ..., "nodes": {
    "2364420971": { "num": 2364420971, "hops": 1, "last_heard": 1782…,
                    "user": { "long_name": "Alarm Unit 336b 2-260723-23",
                              "short_name": "U33B", ... },
                    "device_metrics": {...}, "environment_metrics": {...} },
    ... } }
```
- `nodes` is a **dict keyed by num-as-string**, NOT an array.
- `node_id` is **absent**; `num` is the numeric node id (`2364420971` = `0x8CEE336B`
  → `!8cee336b`).
- Name lives in `user.long_name` / `user.short_name`.

## Fix — Mesh._summaries(j)
Accept dict OR array (defensive for other gateways/versions):
```
_summaries(j) {
  const nodes = j && j.nodes !== undefined ? j.nodes : j;
  let list;
  if (Array.isArray(nodes)) list = nodes;
  else if (nodes && typeof nodes === 'object') list = Object.values(nodes);
  else list = [];
  return list.map((e) => {
    const u = e.user || {};
    const num = e.num != null ? e.num : e.from_num;
    return {
      id: e.node_id || e.id || (num != null ? '!' + (num >>> 0).toString(16) : null),
      num,
      name: u.long_name || u.short_name || e.long_name || e.short_name || null,
      lastHeard: e.last_heard != null ? e.last_heard : null,
      hops: e.hops != null ? e.hops : null,
      raw: e,
    };
  });
}
```
`node(id)` (unchanged) then matches on `id` (`!hex`) or `num`.

## Tests — test/cli-live.js (add)
Replace/extend the `_summaries` block with the REAL captured shape:
- dict container: `{nodes:{"2364420971":{num:2364420971,hops:1,last_heard:100,user:{long_name:"Alarm Unit 336b",short_name:"U33B"}}}}`
  → `[{id:'!8cee336b', num:2364420971, name:'Alarm Unit 336b', hops:1, lastHeard:100}]`.
- still accepts a plain array and `{nodes:[...]}` (back-compat).
- `null` / `{}` → `[]`.
- id derived from num when node_id/user absent.

## NOT in scope
- Positional reply mis-correlation (a relay-rebroadcast duplicate matched the next
  command during the live sweep). Inherent to id-less positional correlation;
  mitigation (reply-shape match / correlation token) is a separate backlog item.
- `info()` snapshot null on raw mesh-gw (:8001 sends no device_snapshot).

## Verify (Observe)
- **Offline**: `test/cli-live.js` green with the new real-shape assertions;
  `settings`/`transport`/`log`/`skeleton` still green; `require('..')` clean.
- **LIVE**: `mtmesh nodes --json` (against :8001/!2687afb1) returns the roster with
  `!8cee336b`/U33B etc. — no longer `[]`. `mtmesh node !8cee336b` finds it.
