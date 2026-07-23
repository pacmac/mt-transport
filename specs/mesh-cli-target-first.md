---
task: mesh-cli-target-first
status: IMPLEMENTED + VERIFIED 2026-07-23. `mtmesh --help` shows target-first grammar; `mtmesh b80f status` sends the DM ({to:2558179343,channel:0}, device replied); `mtmesh nodes` targetless (4 nodes); old `mtmesh status b80f` now prints usage. Full offline suite green. Help columns realigned (padEnd 46→48).
source_hash: clients/mesh/bin/mtmesh.js 6ae41680e3d170300f7f56ff821c60b1d10ee93cfa3131fc1897f3779f6e903c
project: mt-transport
scope:
  - specs/mesh-cli-target-first.md
  - clients/mesh/bin/mtmesh.js   # VERBS target flag + args, parse() peels target-first, run(m,target,args,flags), usage()
# NOT changing:
#   lib/*, index.js — the library API is unchanged; only the CLI arg ORDER changes.
#   test/cli-live.js — tests the Mesh library (m.status/m.ping), not the CLI parse(); unaffected.
---

# mesh-cli target-first grammar

## Goal (Peter)
`<target>` is needed by every device verb but sits at a different position per verb
today (`status <target>`, `image get <target> <pid>`, `config set <target> <key> <value>`).
Make it the consistent FIRST arg: `mtmesh <target> <verb> [args]`. `nodes` and `listen`
take no single device → targetless.

## Change (bin/mtmesh.js only)
### VERBS table
Add `target: true` to device verbs, `target: false` (or omit) to nodes/listen. Drop the
leading `<target> ` from each verb's `args` string. New `run` signature `(m, target, args, flags)`:
```
{ verb:'nodes',      target:false, args:'',                 run:(m)          => m.nodes() },
{ verb:'status',     target:true,  args:'[mem|alarm]',      run:(m,t,a)      => m.status(t, a[0] || '') },
{ verb:'ping',       target:true,  args:'',                 run:(m,t)        => m.ping(t) },
{ verb:'image list', target:true,  args:'',                 run:(m,t)        => m.listImages(t) },
{ verb:'image get',  target:true,  args:'<pid> [--out FILE]',run:(m,t,a,o)   => m.getImage(t, a[0], { out:o.out }) },
{ verb:'config get', target:true,  args:'',                 run:(m,t)        => m.getConfig(t) },
{ verb:'config set', target:true,  args:'<key> <value>',    run:(m,t,a)      => m.setConfig(t, { [a[0]]: a[1] }) },
{ verb:'listen',     target:false, args:'[--serve] [--port N]', daemon:true },
```

### parse()
```
// flags + rest unchanged. Then:
const joined = rest.join(' ');
// 1) a TARGETLESS verb at the head wins (nodes / listen)
let match = VERBS.filter(v => !v.target)
  .filter(v => joined === v.verb || joined.startsWith(v.verb + ' '))
  .sort((x,y) => y.verb.length - x.verb.length)[0];
if (match) return { flags, match, target: null, args: rest.slice(match.verb.split(' ').length) };
// 2) else first token is the TARGET; match a target verb against the remainder
const target = rest[0];
const after  = rest.slice(1);
const j2 = after.join(' ');
match = VERBS.filter(v => v.target)
  .filter(v => j2 === v.verb || j2.startsWith(v.verb + ' '))
  .sort((x,y) => y.verb.length - x.verb.length)[0];
const args = match ? after.slice(match.verb.split(' ').length) : after;
return { flags, match, target, args };
```

### usage()
Header: `mtmesh [--gw URL] [--config FILE] [--json] <target> <verb> [args]`. Per line:
target verbs render `mtmesh <target> <verb> <args>`; targetless render `mtmesh <verb> <args>`.

### main()
`const { flags, match, target, args } = parse(...)`; `await match.run(m, target, args, flags)`.
Unknown/absent verb or a target with no following verb → `match` undefined → usage (exit 1).

## Verify (Observe) — run the binary
1. New form: `mtmesh b80f status` builds `status` to b80f (DM send logged). `mtmesh 2558179343 ping`, `mtmesh b80f config get` likewise.
2. Targetless: `mtmesh nodes` and `mtmesh listen` still dispatch (no target).
3. Old form now rejected: `mtmesh status b80f` → usage (status parsed as target, `b80f` not a verb).
4. `mtmesh --help` shows the target-first grammar; no `--channel`.
