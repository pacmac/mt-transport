---
task: mesh-cmd-idempotent-retry
status: IMPLEMENTED + VERIFIED 2026-07-23. cli-live +4 (hop/echo retries; reboot/wedge one-shot) + suite green. LIVE: `cmd hop` now lands on BOTH b80f and 336b without manual re-runs (retry resilience on the marginal link); reboot/wedge one-shot verified offline.
source_hash:
  clients/mesh/index.js: 6955c4cc1d477cf66226758bd3eb1461cb9f58436f8cd060a54882cf455e58aa
  clients/mesh/bin/mtmesh.js: 3b39320d9a8689303dd2babc9a58fafe1a4974b91ab9c9f64a4e9ee66bc27fec
  clients/mesh/test/cli-live.js: b670fa0e4106815d7c75b4614f885467fb2b69149dc341feaa8aad7b08dda5c5
scope:
  - specs/mesh-cmd-idempotent-retry.md
  - clients/mesh/index.js            # DANGER set + _cmdReliab(verb)
  - clients/mesh/bin/mtmesh.js       # cmd run uses _cmdReliab instead of {}
  - clients/mesh/test/cli-live.js    # _cmdReliab: idempotent verb -> retries; reboot/wedge -> 0
# NOT changing:
#   NO_REPLY / noReply auto-detect — unchanged; --no-reply still overrides.
#   domain methods (ping/status/config/images) — already on _idem().
---

# Spec: cmd passthrough retries idempotent verbs

## Change
index.js — a DANGER set (non-idempotent, never auto-retry) + a helper the `cmd` path uses:
```diff
 const NO_REPLY = new Set(['debug', 'sch', 'cam grab', 'chunk pull', 'push pull']);
+// Non-idempotent verbs: repeating them causes real side effects (double reboot, extra
+// watchdog reset), so the passthrough must NOT auto-retry these — everything else is
+// safe to resend. Reachable only via the raw `cmd` escape hatch.
+const DANGER = new Set(['reboot', 'wedge']);
```
```diff
+  // Reliability profile for a RAW passthrough command: idempotent-retry unless the verb
+  // is a known side-effecting one. Keeps `cmd hop`/`echo`/`status` resilient on a marginal
+  // link while `cmd reboot`/`cmd wedge` stay one-shot.
+  _cmdReliab(verb) { return DANGER.has(verb) ? {} : this._idem(); }
```

bin/mtmesh.js — `cmd` run uses it:
```diff
   { verb: 'cmd', target: true, args: '<verb> [args...]', help: 'send ANY device command raw (escape hatch)',
     run: (m, t, a, flags) => {
       if (!a.length) throw new errors.MeshError('cmd: needs a device verb', 'EUSAGE');
-      return m.command(t, a[0], a.slice(1), flags['no-reply'] ? { noReply: true } : {});
+      const opts = m._cmdReliab(a[0]);
+      if (flags['no-reply']) opts.noReply = true;
+      return m.command(t, a[0], a.slice(1), opts);
     } },
```

## Verify (Observe)
1. **Offline** (cli-live): `m._cmdReliab('hop').retries > 0`; `m._cmdReliab('reboot')` has no
   retries (undefined); full suite green.
2. **LIVE b80f + 336b:** `cmd hop` now survives a single-attempt miss (resends within budget)
   on both units; `cmd reboot` (do NOT actually run on a live unit) — verified by the offline
   assertion that reboot gets 0 retries.
