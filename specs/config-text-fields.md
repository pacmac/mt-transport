---
task: device-names-bnch-garg
status: IMPLEMENTED + VERIFIED 2026-07-23. config 22 assertions (+3 text) + full offline suite green. LIVE b80f: `config set name BNCH` + `lname BNCH` both confirmed (from the write reply); roster shows short `BNCH`, long `BNCH 2-260723-29`. LIVE 336b: name/lname GARG confirmed on-device (marginal link, 1-3 retries); roster still shows the old name — 336b's NodeInfo announcement hasn't crossed the −115 link yet (device state correct, propagation lag). No firmware change. Band-aid; SSOT + mesh-gw app-send is the real cure.
source_hash:
  clients/mesh/lib/config.js: 5ac25340f8b72f1192e5ba9f430ea077f10260dd6807b8197c6e241a88866d4f
  clients/mesh/test/config.js: 79a32d32e1dc71a735091b794fe9d1ea4277acc9496e73d24a881df5ad33dd22
scope:
  - specs/config-text-fields.md
  - clients/mesh/lib/config.js        # COMMAND_MAP += name/lname; FALLBACK_FIELDS += name/lname (text); set() handles ty:'t'; confirm from the WRITE reply (drops the extra read-back)
  - clients/mesh/test/config.js        # text-field set (name) + length validation + confirm-from-reply cases
# NOT changing:
#   firmware — names already runtime-settable (name/lname cmds, persisted) and long_name = g_longName + " " + FW (main.cpp:1459). No reflash.
#   index.js — getConfig/setConfig already delegate. get() still lists name/lname as `unread` (no device read cmd; the roster/`nodes` shows the live name).
---

# Spec: config-text-fields — set name/lname (text) via the CLI

## Device contract (verified pac-garage-alarm/src/main.cpp:2402-2425)
`name <x>` / `lname <x>` set g_shortName / g_longName, validate (validateName), persist
(saveSettings), announce (sendNodeInfo), and reply `{"type":"name"|"lname","name":"<new>",
"was":"<old>","ok":true}` — so the WRITE reply confirms the set (no separate read needed).
Broadcast long_name = `g_longName + " " + FW_VERSION` (main.cpp:1459), so lname=BNCH →
"BNCH 2-260723-NN". Also: the `chunk cfg <hop> <gap>` write reply already returns
`{type:chunkcfg,hop,gap}` — the new values — so chunk sets can confirm from the write reply too.

## config.js changes

### COMMAND_MAP — generalize (needsCurrent + confirm-from-write-reply)
```js
const COMMAND_MAP = {
  'chunk.gap': { needsCurrent: true, readVerb: 'chunk', readArgs: ['cfg'], writeVerb: 'chunk',
                 write: (cur, v) => ['cfg', String(cur.hop), String(v)],
                 confirm: (r, v) => !!(r && Number(r.gap) === v) },
  'chunk.hop': { needsCurrent: true, readVerb: 'chunk', readArgs: ['cfg'], writeVerb: 'chunk',
                 write: (cur, v) => ['cfg', String(v), String(cur.gap)],
                 confirm: (r, v) => !!(r && Number(r.hop) === v) },
  'name':  { writeVerb: 'name',  write: (cur, v) => [v], confirm: (r, v) => !!(r && r.ok && r.name === v) },
  'lname': { writeVerb: 'lname', write: (cur, v) => [v], confirm: (r, v) => !!(r && r.ok && r.name === v) },
};
```

### FALLBACK_FIELDS — add the text fields (so a text set doesn't need the flaky sch pull)
```js
  'name':  { id: 'name',  ty: 't', label: 'Short name', writable: true, min: 1, max: 4,  bounded: true },
  'lname': { id: 'lname', ty: 't', label: 'Long name',  writable: true, min: 1, max: 30, bounded: true },
```

### set() — handle ty:'t'; unified write + confirm-from-reply
Replace the numeric-only coerce/validate + the read/write/read-back with:
```js
      let v;
      if (f.ty === 'b') { … unchanged … }
      else if (f.ty === 'n') { … unchanged (integer + bounds) … }
      else if (f.ty === 't') {
        v = String(raw);
        if (f.bounded && (v.length < f.min || v.length > f.max))
          throw new MeshError(`${field}: length ${v.length} out of [${f.min},${f.max}]`, 'ERANGE');
      } else throw new MeshError(`${field}: unsupported type ${f.ty}`, 'EVALUE');

      const map = COMMAND_MAP[field];
      if (!map) throw new MeshError(`${field} valid but no transport mapping yet`, 'ENOMAP');
      let cur = null;
      if (map.needsCurrent) {
        cur = await this.command(node, map.readVerb, map.readArgs);
        if (!cur || typeof cur !== 'object') throw new MeshError(`${field}: could not read current value`, 'ECONFIRM');
      }
      const reply = await this.command(node, map.writeVerb, map.write(cur, v));
      if (!map.confirm(reply, v)) throw new MeshError(`${field}: set not confirmed`, 'ECONFIRM');
      out[field] = v;
```
(Confirm now comes from the WRITE reply for ALL fields — one fewer round-trip than before.)

## Result
`mtmesh b80f config set name BNCH` → `name BNCH` → reply `{name:"BNCH",ok:true}` → confirmed.
`mtmesh b80f config set lname BNCH` → broadcasts `BNCH 2-260723-NN`. Swap-toggle = re-run
`config set name` on the swapped unit (persisted, no reflash).

## Verify (Observe)
1. **Offline** (test/config.js): set('name','BNCH') → device sim replies {ok,name} → confirmed;
   over-length name (>4) → ERANGE with no send; chunk.gap set still confirms (now from the write
   reply, no read-back); existing 19 assertions stay green.
2. **Regression:** full offline suite (config/skeleton/etc.).
3. **LIVE b80f:** `config set name BNCH` + `config set lname BNCH`; `mtmesh nodes` shows short
   `BNCH`, long `BNCH 2-260723-27`. Then set 336b → GARG (marginal link — retries; DEFER if it won't take).
