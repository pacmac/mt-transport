---
task: butler-receipt-correlation
status: IMPLEMENTED + VERIFIED 2026-07-24. timing.js onReply requires an exact reply_id match once a sent id is captured; unsolicited frames (no reply_id) rejected. transport.js F/G rewritten; cli-live.js mock now threads replyId (necessary ripple, added to scope). Full suite GREEN (transport 43, cli-live 28, all files pass).
source_hash:
  clients/mesh/lib/timing.js: c93c7c5e98a9a8a46db78a3080e98a7f28c56e3b421d139091c03bae9d6344c4
  clients/mesh/test/transport.js: 087505924e2cc2d131053835ea2e95aed91b7ceb042f56d37015ab3d985ef47d
  clients/mesh/test/cli-live.js: 1d2934d1812ea75c072fbe870c6c8de1ccbfce274158c1dab00d33445f250399
scope:
  - clients/mesh/lib/timing.js        # onReply: require reply_id match when sentId was captured
  - clients/mesh/test/transport.js    # F rewritten (unsolicited frame rejected) + G (no-sentId positional)
  - clients/mesh/test/cli-live.js      # RIPPLE: mock command-reply emits now thread replyId (real device does)
# NOT changing: butler.js (records faithfully), index.js command() (the loose match is the fallback,
#   left as-is for the sentId==null case).
---

# Spec: butler-receipt-correlation — an unsolicited frame must never be a command's receipt

## Symptom (live, from `mtmesh b80f queue --list`)
- a `status mem` command → `receipt: {"type":"sleepfor","secs":35}` (and `secs:300`)
- a `clear` command → `receipt: {"type":"agc",...}`
The butler marks `acked` with a **wrong** frame, so `ackedAt`/`receipt` are untrustworthy — which
defeats the entire "enqueue → query if/when delivered" contract.

## Root cause (confirmed, with line refs)
1. `index.js:112` — every text event is offered to correlation: `this.timing.onReply(reply, ev.replyId)`.
2. `index.js:210-212` — `command()` enqueues with `match: (r) => r && typeof r === 'object'` — i.e. the
   positional matcher accepts **ANY object**.
3. `timing.js:79-94 onReply`:
   ```js
   if (e.sentId != null && replyId != null) {
     if (Number(replyId) !== e.sentId) return false;   // exact path
   } else {
     const m = e.opts.match;
     if (m && !m(replyObj)) return false;               // positional fallback
   }
   ```
   The device threads `reply_id` on real command replies (`sendReply(msg, rx.id)`), but an
   **unsolicited** frame (`sleepfor`, heartbeat, another command's reply) carries **no reply_id**.
   With `replyId == null`, the exact branch is skipped and control falls to the positional matcher,
   which — accepting any object — **consumes the unsolicited frame** and resolves the wrong receipt.
   On a slow/marginal link a `sleepfor` announcement routinely lands inside a command's reply window,
   so this fires in practice.

## Fix (timing.js onReply — ~3 lines)
When we captured our sent packet id (`e.sentId != null`), the device WILL thread `reply_id`; require
an exact match and reject anything without it. Only fall back to positional when there is no sent id
to match against (rare — a send that returned no id).
```js
onReply(replyObj, replyId = null) {
  if (!this.inFlight) return false;
  const e = this.inFlight;
  if (e.sentId != null) {
    // Device threads reply_id to our packet id. An unsolicited frame (sleepfor/heartbeat/other
    // command's reply) carries none and must NEVER be taken as our reply. Exact match required.
    if (replyId == null || Number(replyId) !== e.sentId) return false;
  } else {
    const m = e.opts.match;                 // no capturable sent id -> positional fallback
    if (m && !m(replyObj)) return false;
  }
  clearTimeout(e.timer); this.inFlight = null; e.resolve(replyObj); this._pump(); return true;
}
```
Trade-off: if a genuine command reply ever lacked a reply_id it would now time out instead of
resolving — but a timeout (honest "no reply") is strictly better than a **wrong** receipt, and the
device does thread reply_id on `sendReply` (verified live: correlation 1303666450).

## Observe (when implemented)
1. Offline (test/transport.js): in-flight command with `sentId=42`; feed `onReply(sleepforObj, null)`
   → returns false, command still pending; then `onReply(statusObj, 42)` → resolves with the STATUS.
   Add a second case: unsolicited frame with a NON-matching reply_id also rejected.
2. Full suite green (the existing reply_id tests must still pass).
3. Live (336b over the new USB console makes this cheap): enqueue `status`, force a `sleepfor`
   nearby, confirm the receipt is the status JSON, not the sleepfor.
