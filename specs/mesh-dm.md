---
task: mesh-dm
status: IMPLEMENTED + VERIFIED 2026-07-23. Offline: resolve 8 + dm 12 + full regression green (images 17/daemon 17/receiver-gate 10/transport 31/log/settings/cli-live). LIVE b80f: `status b80f` sent `{to:2558179343, channel:0}` (directed PKC DM) and returned a full decoded status (reply-in-kind correlated) — a channel-0 directed send that the device decrypts + answers is the causal proof it arrived as a valid PKC DM. `--channel` removed from CLI. `@<target>` kept (omitAddress:false) for un-flashed-firmware compat; firmware bare-verb + dropping `@` is the later slice (needs a flash). Fallback (miss→ch2 broadcast) offline-verified.
source_hash: clients/mesh/lib/protocol.js 52affc8e764dcf5cbd2b946c1d5144ffdee1d16bb3a6d4a122d165eeb0ab00f6; clients/mesh/lib/resolve.js 63f710159c5bb9d2d6b86a4bd6b71885b696ee6ae376c252aee46082b1ba59fe; clients/mesh/index.js 7dc69cda253350a7dc63848d7e53efaf986e11f5bfd3848c1507c3d42cc9e0fc; clients/mesh/lib/images.js 917c6db3fd2b1664400e942d60618fce61b252d3143532124e13612b49c21f4a; clients/mesh/lib/settings.js d49d28f8adc85816f54df2fbb0a6908614479fd661ad553cccb7e7786ba7984d; clients/mesh/config.yaml 2da916138e079193e6f81f0741ca600c45a8914665d0955587da6628566905af; clients/mesh/bin/mtmesh.js 4187197d51ad26446860ed77ca7be8e3c9d67577e90150f5ca9e54f824475fee; clients/mesh/test/resolve.js e187379f129b1112c86e9bfe84b94c0e5e45a77a1be5cffbf4eb37611f2fc6ce; clients/mesh/test/dm.js 430677962498e63abc1d47b4c204003d22213206783ece34af79dd3169a931ec; clients/mesh/test/images.js ea9fac483bfdbf788453e070f8cb5dd3202f04bed689265a5e76672cf51f34b9
project: mt-transport
scope:
  - specs/mesh-dm.md
  - clients/mesh/lib/protocol.js    # resolveAtToken() (the @-grammar token, from images' _target) — exported, used by buildCommand
  - clients/mesh/lib/resolve.js     # NEW — target→num roster resolver (cached); resolveTarget() -> { num, atToken }
  - clients/mesh/index.js           # command() resolves + DM-default send + private fallback; construct resolver; roster cache
  - clients/mesh/lib/images.js      # _target()/_sendControl route through the shared DM send (to:num), not hand-built broadcast
  - clients/mesh/lib/settings.js    # DEFAULTS.dm { default:true, fallbackChannel:2, omitAddress:false } ; env overrides
  - clients/mesh/config.yaml        # document the dm block; channel:2 reframed as the PRIVATE FALLBACK channel
  - clients/mesh/bin/mtmesh.js      # drop `--channel` from usage + parse (channel is config, never a user arg)
  - clients/mesh/test/resolve.js    # NEW — resolver cases: num / !mac / 8-hex / 4-hex suffix / short name / * ; roster hit+miss
  - clients/mesh/test/dm.js         # NEW — DM-default send sets to:num ch0; miss→broadcast fallback ch2; @ kept (flag off); images control DM
  - clients/mesh/test/images.js     # AMENDED — makeImages injects send(); device sim parses bare `push …` (control no longer carries @token)
# NOT changing:
#   lib/gw.js — sendText already supports {to, channel} + refuses ch0 broadcast; the DM contract is already there. No edit.
#   lib/timing.js — one-in-flight-per-target correlation is unchanged; DM replies arrive as kind:text (reply-in-kind).
#   FIRMWARE (pac-garage-alarm) — bare-verb-DM acceptance + dropping `@` is a SEPARATE later slice (needs a b80f flash).
---

# mesh-dm (slice 2) — DM-default send, private fallback, target→num resolver

## Goal (Peter)
"We are switching to DM fully; private should be a fallback." Every command today goes
out as a **channel-2 broadcast** `@target …` — every node on ch2 hears it. Switch the
default to a **directed PKC DM** to the resolved node num; use the private channel only
as a fallback (num unknown / DM path unavailable). `@<target>` stays in the text for now
(un-flashed firmware still requires it — main.cpp:1831); it is removed later once the
fleet is flashed. It is redundant under DM — the mesh layer already routes to the one node.

## Verified facts
- **Transport already supports DM**: `gw.sendText(gwId, text, {to, channel})` (gw.js:130)
  — `to:num` ⇒ directed; a PKC DM legitimately rides channel 0; broadcast on ch0 is
  refused (gw.js:126-140). So DM = `{ to:num, channel:0 }`; fallback = `{ channel:2 }` (no to).
- **num source**: `gw.nodes()` → `_summaries()` yields `{ id:'!<hex>', num, name }` (index.js:98).
  The model (model.js) is keyed by id string and holds no num — NOT a num source. Use the
  gateway roster, cached.
- **Reply correlation unchanged**: the device replies IN KIND — a command DM'd to it comes
  back as a DM to us (firmware "REPLY IN KIND", main.cpp:2620-2628). mesh-gw emits it as
  `kind:'text'`; `_onEvent`→`parseReply`→`timing.onReply` already handles it (index.js:71-74).
- **Two addressing paths today**: `command()`→`buildCommand` (index.js:119) and images
  `_sendControl` hand-builds `@${t} push …` (images.js:78-88) via a duplicate `_target`
  (images.js:40). Both move onto the shared DM send.

## Design

### lib/resolve.js (NEW) — target → { num, atToken }
`resolveTarget(target, roster)`:
- `atToken` = the `@`-grammar token (short name / 4-hex suffix / `*`), via
  `protocol.resolveAtToken` (images' proven `_target` logic, moved to protocol.js & shared).
- `num`:
  - `*` → `null` (all-units; no DM, broadcast).
  - decimal digits, length > 4 → `Number(token)`.
  - `!`+8hex or 8hex → `parseInt(hex, 16)`.
  - 4-hex suffix or short name → roster lookup: the node whose `id` ends in the suffix,
    or whose `name`/short matches → its `num`. Not found → `null`.
- Returns `{ num, atToken }`. `num===null` ⇒ caller uses the broadcast fallback.

### index.js — roster cache + DM-default send
- Roster cache: `this._roster` from `gw.nodes()`, populated on connect and refreshed on a
  resolver miss (one refetch, then give up → fallback). Small helper `_resolve(target)`.
- `command(node, verb, args)`:
  ```
  const { num, atToken } = await this._resolve(node);
  const addr = this.cfg.dm.omitAddress && num != null ? '' : `@${atToken} `;  // @ kept while flag off
  const text = `${addr}${verb}${args.length ? ' ' + args.join(' ') : ''}`.trim();
  const opts = (this.cfg.dm.default && num != null)
      ? { to: num, channel: 0 }                      // directed PKC DM
      : { channel: this.cfg.dm.fallbackChannel };    // private broadcast fallback (ch2)
  return this.timing.enqueue(() => this.gw.sendText(this.gwId, text, opts),
                             { match:…, dedupKey:`${num ?? atToken}|${verb}|${text}` });
  ```
  (buildCommand's role — building `@token verb args` — is now inline here so the send opts
  and the text are chosen together. protocol.buildCommand stays for any external caller /
  the fallback string; resolveAtToken is the shared piece.)
- Construct the resolver with a `roster()` accessor over the cache.

### lib/images.js — control frames onto DM
- `_target(node)` → delegate to `protocol.resolveAtToken` (kill the dup).
- `_sendControl(target, buf)` → build the same text, but send via the shared DM path
  (`to:num` when resolvable, else fallback) instead of the bare `gw.sendText(...,{channel})`.
  Simplest: give images a `send(node, text)` injected from index that does resolve+DM+fallback,
  so images owns no addressing. Chunk RECEPTION (port 261, device→us broadcast) is unchanged.

### settings.js / config.yaml — the dm block
```
dm:
  default: true          # directed PKC DM (to:num) is the default send
  fallbackChannel: 2      # private channel used when num is unknown / * / DM unavailable
  omitAddress: false      # TEMP: keep the @<target> text prefix until the fleet is flashed;
                          # flip true (then remove) once every unit accepts bare-verb DMs
```
Env: `MTMESH_DM=0` disables (all broadcast), `MTMESH_DM_OMIT=1` drops `@`. `channel:2` is
reframed in comments as the private FALLBACK channel (still the fallback broadcast target).

### bin/mtmesh.js — drop --channel
Usage line: remove `[--channel N]`. main(): stop passing `channel: flags.channel…` to Mesh().
Channel/DM come from config/env only — never a user arg.

## Risks / live-verify (Observe must confirm, not assume)
- **PKC actually applied**: confirm mesh-gw encrypts a `{to:num, channel:0}` POST as a PKC
  DM (not plaintext on PRIMARY). VERIFY on air before trusting — decode a received frame /
  check the gateway. If a gateway ever sends `{to:num, channel:0}` unencrypted that would
  leak on PRIMARY; treat unverified as blocking for the ch0 path.
- **Reply-in-kind reaches us**: b80f DM'd → its reply DM comes back on the WS and correlates.
- **Never-DM-third-party**: the resolver only DMs the user-named target; live tests use ONLY
  b80f (bench). No sweep of the roster, no DM to ta21/others.
- **no-retry preserved**: want_ack/retransmit stays OFF (that's a later control-path slice).

## Verify (Observe)
1. **Offline** (test/resolve.js, test/dm.js, no radio, fake gw capturing send opts):
   resolve num/!mac/8hex/suffix/short/* against a stub roster (hit + miss); a resolvable
   target ⇒ `sendText` called with `{to:num, channel:0}` and text still `@<token> verb`
   (omitAddress false); a miss / `*` ⇒ `{channel:2}` broadcast; omitAddress true ⇒ text has
   no `@`; images control frame ⇒ DM to the device num.
2. **Regression**: full `pnpm test` green (images/daemon/receiver-gate/transport/log/settings/
   cli-live); `mtmesh --help` no longer lists `--channel`.
3. **LIVE b80f**: `mtmesh status b80f` and `mtmesh ping b80f` over the DM path — confirm the
   send went as `{to:2558179343, channel:0}` (log line) and the reply correlated. Then force
   a miss (a bogus target) → confirm it falls back to the ch2 broadcast and still resolves
   when the target is valid. b80f ONLY; do not contend with the 41910 campaign on 336b.
