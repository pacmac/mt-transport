---
task: mesh-cmd-retry
status: IMPLEMENTED + VERIFIED 2026-07-23. cli-live +3 (drop→resend→resolve; no-retry→ETIMEOUT) + full offline suite green. LIVE 336b: retry fires (status resent 3×, retriesLeft 2→1→0 logged); `ping` now succeeds (small reply survives). `status` still ETIMEOUTs — but the link is snr −17.8 dB, BELOW the ~−17.5 SF11 demod floor, so the 204-byte status reply is physically undemodulable (link-dead-for-large-frames, not a client gap — the specced honest bound). Raw command() stays retries=0 (reboot/wedge).
source_hash:
  clients/mesh/index.js: f10a3cf79906f82b7750c245e85b42817cc1f684fb91dcaefda81aee801cd0c0
  clients/mesh/lib/settings.js: 1458e8a062c5f28ab333223747fba44c396303d6cb181c38c813aaf606677f21
  clients/mesh/config.yaml: 81606ee5eb960b50f9b453c2751a4a1fc25fe705f85b956dbee0622ab6074b95
  clients/mesh/test/cli-live.js: a2e8db2d1311d58fb3d639e23848a8bfb386a65c371ca318666bf8b35501a576
scope:
  - specs/mesh-cmd-retry.md
  - clients/mesh/lib/settings.js     # retry.idempotent (2) + retry.attemptTimeoutMs (10000)
  - clients/mesh/config.yaml         # document the retry block
  - clients/mesh/index.js            # command() takes {retries,timeoutMs}; _idem() helper; ping/status + images/config deps opt in
  - clients/mesh/test/cli-live.js    # retry: first send unanswered -> timeout -> resend -> reply resolves
# NOT changing:
#   lib/timing.js — the retry engine already exists (enqueue {retries}; timeout re-enqueues & re-runs the send thunk; reply clears). We only start passing retries.
#   lib/gw.js — no want_ack field on the gateway send; whether the gateway's own MT stack want_acks directed sends is UNVERIFIED (mesh-gw source absent). Client retry is safe either way (idempotent).
#   reboot/wedge — reachable only via the raw command() escape hatch, which keeps retries=0.
---

# Spec: mesh-cmd-retry — resend idempotent commands instead of silently failing

## Why
Firmware reply-path want_ack (retransmit 3×/4s) is done, but the FORWARD path is
fire-and-forget: `gw.sendText` has no want_ack and `timing.enqueue` retries default 0.
A command lost on the −115 dBm 336b link never reaches the device, so it never replies →
`ETIMEOUT`, no resend. `timing.js` already re-enqueues on timeout (`retries--`, re-runs the
send thunk) — we just never pass `retries`. Turn it on for the idempotent domain paths.

## Diffs

### lib/settings.js — DEFAULTS.retry
```diff
-  retry:   { commands: false },
+  retry:   { commands: false, idempotent: 2, attemptTimeoutMs: 10000 },
```
`idempotent` = extra resend attempts for known-idempotent domain commands. `attemptTimeoutMs`
= per-attempt reply wait for them (the device replies in <10s or never — device-reply-window),
so 3 attempts ≈ 30s worst case rather than 1×20s-then-fail.

### config.yaml — document
```yaml
retry:
  commands: false        # raw command() escape hatch: never blind-retry (reboot/wedge live here)
  idempotent: 2          # resends for KNOWN-idempotent domain cmds (ping/status/config/image control)
  attemptTimeoutMs: 10000 # per-attempt reply wait for those (device answers <10s or never)
```

### index.js
1. `command()` accepts reliability params (destructured to avoid colliding with `_addressed`'s send `opts`):
```diff
-  async command(node, verb, args = []) {
+  async command(node, verb, args = [], { retries = 0, timeoutMs } = {}) {
     const a = Array.isArray(args) ? args : (args === '' || args == null ? [] : [args]);
     const { num, atToken } = await this._resolve(node);
     const body = `${verb}${a.length ? ' ' + a.join(' ') : ''}`;
     const { text, opts, key } = this._addressed(node, body, num, atToken);
     return this.timing.enqueue(
       () => this.gw.sendText(this.gwId, text, opts),
-      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}` });
+      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}`, retries, timeoutMs });
   }
```
2. `_idem()` helper (reads the config) + opt-in on the idempotent domain methods:
```diff
+  // Reliability profile for KNOWN-idempotent commands: resend on timeout (safe to repeat).
+  _idem() { const r = this.cfg.retry || {}; return { retries: r.idempotent != null ? r.idempotent : 0, timeoutMs: r.attemptTimeoutMs }; }
+
-  async ping(node) { return this.command(node, 'ping'); }
-  async status(node, domain) { return this.command(node, 'status', domain ? [domain] : []); }
+  async ping(node) { return this.command(node, 'ping', [], this._idem()); }
+  async status(node, domain) { return this.command(node, 'status', domain ? [domain] : [], this._idem()); }
```
3. images + config get their command dep with the idempotent profile (all their commands —
   `push stat`, `config`, `chunk cfg`, `name`/`lname` — are idempotent):
```diff
-      command: (node, verb, args) => this.command(node, verb, args),   // images
+      command: (node, verb, args) => this.command(node, verb, args, this._idem()),   // images
...
-      command: (node, verb, args) => this.command(node, verb, args),   // config
+      command: (node, verb, args) => this.command(node, verb, args, this._idem()),   // config
```
The **raw public `command()`** stays retries=0 — the escape hatch a caller uses for `reboot`/`wedge`.

### test/cli-live.js
Add: a mock gw that IGNORES the first send and answers on the second; `m.command(node,'ping',
[],{retries:1,timeoutMs:80})` → first attempt times out → resend → reply → RESOLVES (not
ETIMEOUT); assert exactly 2 sends. And with retries:0 the same single-drop → rejects ETIMEOUT.

## Verify (Observe)
1. **Offline:** the new cli-live retry test (drop-then-answer resolves; no-retry rejects); full
   suite green.
2. **Static:** `command()` passes `retries`; ping/status/images/config use `_idem()`.
3. **LIVE 336b:** `mtmesh 336b status` / `ping` — with retry, the marginal-link command that
   ETIMEOUT'd before now lands within the resend budget (show it succeeding, and the attempt
   count if logged). If still failing after 3 attempts, that's link-dead, not a client gap —
   report honestly.
