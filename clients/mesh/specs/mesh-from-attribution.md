---
task: mesh-from-attribution
status: IMPLEMENTED + VERIFIED 2026-07-24. gw-from 4 + full suite green. LIVE: b80f pushed pid 45886 -> daemon auto-adopted `from !987ab80f` (was !2687afb1), control reached b80f (it answered; old attempt had 30 unanswered), repair converged (chunks 2,3), image ok 37/37 -> saved *_pid45886.jpg (valid 320x240 JPEG). Autonomous PIR-image download works end-to-end.
source_hash:
  clients/mesh/lib/gw.js: dc6f873441f54041cad5e00791c697efc46ff8ec22b66968ceed6919538d4868
  clients/mesh/test/gw-from.js: 3e62807d1328cd99c3487acf95172887884bca7bfed9b595eb7708d27f099538
scope:
  - mt-transport/specs/mesh-from-attribution.md
  - clients/mesh/lib/gw.js       # _from(e): prefer from_num -> '!'+hex; use for private_app + text
  - clients/mesh/test/gw-from.js # NEW — offline: relayed frame attributes to sender, not node_id
# NOT changing: _heard already uses packet.from (correct); model/images/reply consume `from` as-is.
---

# Spec: mesh-from-attribution — `from` is the sender, not the relay

## Root cause (live-proven)
mesh-gw's top-level `node_id` is the RELAYING/BLE-local node (the OMNI gateway `!2687afb1`) on any
multi-hop packet; the real origin is `from_num`. gw.js `_normalize` used `node_id || from_num`, so
EVERY relayed frame was attributed to the gateway. Consequence: a PIR-triggered autonomous image
push (pid 45886 from b80f) was auto-adopted `from !2687afb1`, its partial parked in
`payloads/!2687afb1/`, and it never completed — the daemon's control frames (START/PROGRESS_Q/
REPAIR) went to the GATEWAY, not b80f, so lost chunks were never re-requested. `_heard` already
keys on `packet.from`; this brings the typed events into line.

## Diff — lib/gw.js
Add a helper and use it in both `private_app` and `text`:
```js
// The ORIGINAL sender's node-id ('!'+hex). mesh-gw's node_id is the relaying gateway on a
// multi-hop packet, so from_num (the packet's real origin) is authoritative — matches _heard,
// _unitKey and the roster. Verified live: an image push was mis-adopted under the gateway.
_from(e) {
  if (e.from_num != null) return '!' + (e.from_num >>> 0).toString(16);
  return e.node_id || null;
}
```
Replace `from: e.node_id || (e.from_num != null ? String(e.from_num) : null)` (private_app + text)
with `from: this._from(e)`.

## What it fixes (all consumers of `from`)
- **images.onFrame(payload, from)** — auto-adopt keys by the SENDER; START/REPAIR go to the real
  device → the autonomous push download completes to a `.jpg` (the bug above).
- **model.apply({from})** — nodes keyed by sender, not collapsed onto the gateway.
- **'reply' event `from`** — reports the real sender (correlation already uses reply_id, unaffected).

## Observe
1. Offline (test/gw-from.js): a `private_app`/`text` event with `node_id:'!gw', from_num:0x987ab80f`
   normalizes to `from:'!987ab80f'`; a gateway-origin frame (from_num==gateway) is unchanged;
   from_num absent → falls back to node_id. Full suite green.
2. LIVE: `mtmesh b80f cmd cam grab` → b80f captures + auto-pushes → daemon auto-adopts **from
   !987ab80f** (not the gateway) and the transfer COMPLETES to a saved `.jpg` under `payloads/!987ab80f/`.
3. Regression: a normal `status`/`agc` reply still resolves; existing suite green.
