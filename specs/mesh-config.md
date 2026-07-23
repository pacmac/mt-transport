---
task: mesh-config
status: SPEC — slice 3 of the addressing/config rework; BLOCKED on mesh-dm (target resolver→num, DM-default send, channel-from-config all land there). This slice fills the config.js/index.js stubs so a caller passes (device, field, value), validated, never a raw device command. Rides on whatever addressing mesh-dm provides.
source_hash: ~
project: mt-transport
scope:
  - specs/mesh-config.md
  - clients/mesh/lib/config.js      # fill schema()/get()/set() bodies (were ni() stubs)
  - clients/mesh/index.js           # getSchema/getConfig/setConfig delegate to Config; construct Config; route t:'sch' 260-frames in _onEvent
  - clients/mesh/test/config.js     # NEW — offline tests (device simulator: sch pages, config/chunk cfg replies, set+readback, validation)
# NOT changing (moved to the mesh-dm slice):
#   lib/protocol.js resolveTarget + lib/images.js _target (target→num resolver) — mesh-dm.
#   bin/mtmesh.js --channel removal + channel-from-config — mesh-dm. (bin already dispatches config get/set; no config edit.)
#   index.js node(id)/nodes() — MODEL lookup, separate path; unchanged.
---

# mesh-config (phase 5) — device-schema-backed config get/set

## Goal (Peter)
The CLI must isolate the caller from raw device commands: `mtmesh config set b80f
chunk.gap 1000` → device + field + value, **validated before any airtime**, never a
hand-typed `chunk cfg 0 1000`. Today `lib/config.js` is three `ni()` stubs. Fill them.

## Device contract (verified in pac-garage-alarm/src/main.cpp, fw 2-260723-24)
- **Schema** — `sch [page]` → app frame on **port 260** (PAC_ALARM_APP), `reply[0]=0`
  (NO text reply). Paginated: `{"t":"sch","v":1,"p":P,"n":N,"f":[header, rows...]}`,
  header `["id","ty","lb","df","w","mn","mx"]`, 3 fields/page, 18 fields ⇒ **6 pages**.
  Row is ragged by type: `t`(text) `[id,"t",lb,"",w,mn,mx]`; `b`(bool) `[id,"b",lb,df,w]`;
  `n`(numeric) bounded `[id,"n",lb,df,w,mn,mx]` / unbounded `[id,"n",lb,df,w]`.
  Emitted from the SAME `CONFIG_FIELDS` table that validates every set — cannot drift.
  `chunk.gap`: ty `n`, df 3000, w 1, **mn 0 mx 60000**.
- **Read current values** — `config` cmd → TEXT reply `{"type":"config","ver":1,"beat",
  "txp","slp","det":{n,win},"alm":{on,ovr,und,hum,ren}}` (a SUBSET). `chunk cfg` (no
  gap arg) → TEXT reply `{"type":"chunkcfg","hop","gap"}`. No single all-values read;
  fields mute/push.auto/tele.*/name/lname have no live read command.
- **Write** — device's clean uniform set (`PRIVATE_APP {type:set,path,val}` on 260,
  server-validated) is **unreachable**: mesh-gw send is `POST /messages {text}` only.
  So writes go via text commands. For chunk fields: `chunk cfg <hop> <gap>` (sets BOTH;
  persisted to flash, settings v5). Only chunk.* is command-mapped this phase.

## Transport facts (verified in clients/mesh)
- `command(node,verb,args)` (index.js:119) correlates a **text** reply via timing.
  `config` and `chunk cfg` reply as text DMs ⇒ fetched through `command()`. ✓
- `sch` pages arrive as `kind:'app', portnum:260` and are currently routed to
  `model.apply` (index.js:76-80). `schema()` needs its own collection path.

> Addressing (target→num resolver, DM-default send, channel-from-config) is the
> **mesh-dm** slice — this slice consumes it. Once mesh-dm lands, `command()` already
> accepts short name / suffix / num / !mac, so `config get <target>` inherits it for free.

## Design — lib/config.js (deps: { command, sendText, buildCommand, timing, log })
Replace the three `ni()` stubs. `command`/`sendText`/`buildCommand`/`timing` are
injected from the Mesh instance (see index.js wiring) so config.js owns no transport.

```js
// field -> text-command mapping. The device's uniform {type:set} channel is
// unreachable (mesh-gw is text-only), so each writable field maps to a command.
// EXTENSIBLE: add an entry per field. chunk.* is what the gap-sweep needs now.
const COMMAND_MAP = {
  'chunk.gap': { readVerb: 'chunk', readArgs: ['cfg'], curKey: 'gap',
                 write: (cur, v) => ['cfg', String(cur.hop), String(v)] },
  'chunk.hop': { readVerb: 'chunk', readArgs: ['cfg'], curKey: 'hop',
                 write: (cur, v) => ['cfg', String(v), String(cur.gap)] },
};
```

### schema(node, { refresh = false })  — cached, authoritative field table
1. If cached (`this._schema.get(node)`) and !refresh → return it.
2. Sequentially page: for p = 0,1,…: build `sch <p>` via `buildCommand`, enqueue via
   `timing.enqueue(sendText, { noReply: true })` (resolves on send — the reply is a
   260-frame, not text), then `await this._awaitPage(node, p, timeoutMs)` (resolved by
   `onSchemaFrame`). From page 0 read `n`; stop once all `n` pages collected.
3. Parse each ragged row into `{ id, ty, label, def, writable, min, max, bounded }`.
   Cache `{ ver, fields, at: /* injected clock, see note */ }` under node. Return it.
- `onSchemaFrame(from, obj)` (called by index `_onEvent` for `obj.t==='sch'`): resolve
  the matching `_pageWaiters` entry with the page's fields.
- Bounded wait: if a page never arrives within timeout → throw `MeshError(...,'ESCHEMA')`.

### get(node) — compose the available reads into a flat values map
- `cfg = await command(node,'config')`; `chunk = await command(node,'chunk',['cfg'])`.
- Flatten to schema ids: `beat, slp, txp, det.n(=det.n), det.win, alm.on/ovr/und/hum/ren,
  chunk.hop, chunk.gap`. Return `{ values, unread }` where `unread` = writable schema
  ids with no read source (mute, push.auto, tele.*, name, lname) — surfaced honestly,
  never faked. (schema() is NOT required for get; get uses only the two reads.)

### set(node, patch)  — patch = { field: value }; validated BEFORE airtime
For each `[field, raw]` in patch:
1. `await this.schema(node)`; `f = fields.find(id===field)`.
   - unknown → `MeshError('unknown field '+field,'EFIELD')`.
   - `!f.writable` → `MeshError(field+' is read-only','EREADONLY')`.
2. Coerce `raw` by `f.ty`: `n`→Number (integer), `b`→0/1, `t`→string.
   - `n` non-integer/NaN → `EVALUE`; `b` not in {0,1} → `EVALUE`.
3. Bounds (client-side, **no airtime if it fails**): `n` bounded & (v<min||v>max) →
   `MeshError(field+' out of range ['+min+','+max+']','ERANGE')`; `t` length vs min/max.
4. `map = COMMAND_MAP[field]`; if none → `MeshError(field+' valid but no transport
   mapping yet','ENOMAP')` (honest: schema-settable, we just can't send it text-only).
5. `cur = await command(node, map.readVerb, map.readArgs)` (e.g. `{hop,gap}`).
6. `await command(node, map.readVerb, map.write(cur, v))` (e.g. `chunk cfg <hop> <v>`).
7. **Read back**: `after = await command(node, map.readVerb, map.readArgs)`; assert
   `after[map.curKey] === v` else `MeshError('set not confirmed','ECONFIRM')`.
Return `{ set: { [field]: v }, confirmed: true }`.

> Clock note: config.js takes no wall-clock itself; `at`/timeouts use values passed in
> from timing/deps (the module already centralizes clocks in timing.js). No `Date.now()`
> is added to config.js beyond what timing already owns.

## index.js wiring
- In `connect()` (or constructor, matching how images/model are built): construct
  `this.config = new Config({ command: (n,v,a)=>this.command(n,v,a),
   sendText: (t)=>this.gw.sendText(this.gwId, t, { channel: this.channel }),
   buildCommand: protocol.buildCommand, timing: this.timing, log })`.
- `_onEvent` PORT_ALARM branch (index.js:76): after `parse260`, if `obj && obj.t==='sch'`
  → `this.config.onSchemaFrame(ev.from, obj)` and `return` (do NOT feed schema pages to
  `model.apply`). All other 260 frames unchanged.
- Delegate the three stubs:
  `getSchema(node){ return this.config.schema(node); }`
  `getConfig(node){ return this.config.get(node); }`
  `setConfig(node, patch){ return this.config.set(node, patch); }`

## NOT in scope
- Broader `set()` field coverage (name/lname/det/alm/beat/…): each needs its own text
  command mapping. Deferred; the COMMAND_MAP makes adding them a one-line change.
- Making mesh-gw able to send app-data on 260 (the uniform `{type:set}` path). Separate
  project (mesh-gw), much larger.

## Verify (Observe)
1. **Offline** (test/config.js, device simulator, no radio): sim answers `sch <p>` with
   the 6 real pages as 260-frames, `config`/`chunk cfg` with the real reply shapes, and
   `chunk cfg <hop> <gap>` by mutating its state. Assert: schema() assembles 18 fields &
   caches (second call ⇒ 0 new sends); get() returns merged values + honest `unread`;
   set('chunk.gap',1000) validates, sends `chunk cfg <hop> 1000`, read-back confirms;
   set out-of-range (70000) throws ERANGE **with zero sends**; set unknown field throws
   EFIELD; set read-only (txp) throws EREADONLY.
2. **Regression**: full `pnpm test` (images/daemon/receiver-gate/transport/log/settings/
   cli-live) green; `require('..')` clean; `mtmesh --help` unchanged.
3. **LIVE b80f**: `mtmesh config get b80f` (real values incl chunk.gap); `mtmesh config
   set b80f chunk.gap <cur>` (no-op set + confirm round-trip). Snapshot the current gap
   FIRST; the sweep step restores it.

## Gap-sweep (task step 5, gated on the above passing — uses ONLY the new clean path)
On BENCH b80f only. `g = (config get).chunk.gap` snapshot. For gap in [3000,1500,1000,500]:
`config set b80f chunk.gap <gap>`, run one instrumented pid-1 fetch, record streaming
time + chunks-lost/repair-rounds. Then **`config set b80f chunk.gap <g>` to RESTORE**
(persisted-config-outlives-tests; the hop-0 incident). Report the streaming-time vs loss
curve; recommend a floor. Do NOT touch deployed 336b. Do NOT contend with the 41910
campaign (bench b80f is a different unit — no contention, but confirm b80f is idle).
