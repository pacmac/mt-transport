---
task: mesh-cli-cmd-passthrough
status: IMPLEMENTED + VERIFIED 2026-07-23. cli-live +3 (noReply auto-resolves {sent:true}; "cam grab" pair) + full offline suite green; `mtmesh --help` lists `cmd`. LIVE b80f: `cmd debug` → {sent:true} (noReply); `cmd hop` → {type:hop,n:0}; `cmd status mem` → {type:mem} (multi-word). Every device command now reachable. Interim to the commands SSOT (typed help/args).
source_hash:
  clients/mesh/bin/mtmesh.js: d2b4e30b6e1eef9a9e5c50977c00174f77f39d6c8d661042d78a0200b9123aa7
  clients/mesh/index.js: 25800051af4b3658aae45d59bdbfbd757c0d93bcdfd3d18d79ecb41c223504f1
  clients/mesh/test/cli-live.js: 800f927ba198a0fd52dad532731d83d534e9f99a54e5738f9428254a442345b1
scope:
  - specs/mesh-cli-cmd-passthrough.md
  - clients/mesh/bin/mtmesh.js       # `cmd` verb (variadic) + --no-reply flag
  - clients/mesh/index.js            # command() gains noReply param + auto-detect via a NO_REPLY set
  - clients/mesh/test/cli-live.js    # noReply resolves {sent:true}; a no-reply verb auto-detects
# NOT changing:
#   lib/timing.js — noReply already resolves {sent:true} on send (line ~118). We only pass it.
#   the curated domain verbs — unchanged; `cmd` is additive, an escape hatch that exposes everything.
---

# Spec: mesh-cli-cmd-passthrough — one verb, zero holes

## Why
The CLI hardcodes 8 domain verbs and hides ~18 device commands (hop/debug/cam/reboot/
telemetry/echo/wedge/sch/push/chunk). A generic passthrough exposes ALL of them now,
without per-command work (Peter: "expose everything, no filtering"). The self-describing
SSOT (commands.json + codegen) remains the proper end-state for typed help/args; this is
the interim that removes the holes.

## Design

### bin/mtmesh.js — the `cmd` verb (variadic, target-first)
```js
{ verb: 'cmd', target: true, args: '<verb> [args...]', help: 'send any device command raw (escape hatch)',
  run: (m, t, a, flags) => {
    if (!a.length) throw new errors.MeshError('cmd: needs a device verb', 'EUSAGE');
    return m.command(t, a[0], a.slice(1), flags['no-reply'] ? { noReply: true } : {});
  } },
```
- Target-first parse already gives `a` = every token after `cmd`, so `mtmesh b80f cmd chunk cfg 0 1000`
  → `command('b80f','chunk',['cfg','0','1000'])` → `@b80f chunk cfg 0 1000`. Multi-word verbs just work.
- Add `'no-reply'` to the BOOL flag set in parse() so `--no-reply` is recognized.
- `errors` is already required at the top of bin/mtmesh.js.

### index.js — command() noReply (param + auto-detect)
```diff
+// Verbs that answer by another route (binary/260 frame), never a text reply — resolve
+// on send instead of waiting (else they always ETIMEOUT). verb, or "verb subverb".
+const NO_REPLY = new Set(['debug', 'sch', 'cam grab', 'chunk pull', 'push pull']);
...
-  async command(node, verb, args = [], { retries = 0, timeoutMs } = {}) {
+  async command(node, verb, args = [], { retries = 0, timeoutMs, noReply } = {}) {
     const a = Array.isArray(args) ? args : (args === '' || args == null ? [] : [args]);
     const { num, atToken } = await this._resolve(node);
     const body = `${verb}${a.length ? ' ' + a.join(' ') : ''}`;
     const { text, opts, key } = this._addressed(node, body, num, atToken);
+    const nr = noReply != null ? noReply : (NO_REPLY.has(verb) || (a.length && NO_REPLY.has(`${verb} ${a[0]}`)));
     return this.timing.enqueue(
       () => this.gw.sendText(this.gwId, text, opts),
-      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}`, retries, timeoutMs });
+      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}`, retries, timeoutMs, noReply: !!nr });
   }
```
- Auto-detect covers the common no-reply verbs for EVERY caller; `--no-reply` is the manual
  override for anything not listed. `cmd` passes no `retries` → 0 (unknown idempotency).
- `noReply:true` → `timing` resolves `{sent:true}` on send; the CLI prints that.

## Result — no holes
```
mtmesh b80f cmd debug          # {sent:true} (broadcasts the DEBUG frame; no text reply)
mtmesh 336b cmd hop 5          # {type:hop,n:5,...}
mtmesh b80f cmd reboot         # raw; no retry (non-idempotent)
mtmesh b80f cmd cam grab       # {sent:true}; then `image get`
mtmesh b80f cmd telemetry 1 30 # any command the firmware accepts
```

## Verify (Observe)
1. **Offline** (cli-live): `command(node,'debug')` auto-detects noReply → resolves `{sent:true}`
   (no reply emitted); `command(node,'ping',[],{noReply:false})` still waits. `mtmesh --help`
   lists `cmd`. Full suite green.
2. **Live b80f:** `mtmesh b80f cmd debug` → `{sent:true}`; `mtmesh b80f cmd hop` → `{type:hop,...}`
   (a real reply through the passthrough); `mtmesh b80f cmd status mem` matches the domain path.
