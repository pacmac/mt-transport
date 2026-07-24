---
task: mesh-reply-correlation
status: IMPLEMENTED + VERIFIED 2026-07-24. transport 38 (+7 reply_id cases) + full suite green. LIVE: butler `status mem` queued while b80f slept 25s -> delivered on wake -> receipt {type:mem,...} (the crossing sleepfor reply is now IGNORED by reply_id). Normal cmd agc still returns {type:agc}.
source_hash:
  clients/mesh/lib/timing.js: 5ddb2badc7c015476c6334bf7f622b9de89e6f12c27179cc88c901a387b343ff
  clients/mesh/index.js: 89ca340356fec95b321b2a77e74d5510994731200009a1d3469b93f5111e7388
  clients/mesh/test/transport.js: 223838552b40bbf08b4418c1d64cd4bfc4986bfb018fb0841cad5105bf14bb62
scope:
  - mt-transport/specs/mesh-reply-correlation.md
  - clients/mesh/lib/timing.js     # capture sentId from the thunk; onReply matches by reply_id
  - clients/mesh/index.js          # pass ev.replyId into timing.onReply
  - clients/mesh/test/transport.js # reply_id match: crossing reply ignored, correct matches, null -> positional
# NOT changing: firmware (already threads sendReply(msg, rx.id)); gw.js (already extracts replyId).
---

# Spec: mesh-reply-correlation — match replies by reply_id, not just position

## Why
timing.js correlates POSITIONALLY (one-in-flight + `match:(r)=>r&&typeof r==='object'`). The butler
broke that: a DELAYED reply from an earlier command (a `sleepfor` reply the device emits on WAKE)
crosses into a later in-flight command and is grabbed as its receipt. Seen 3×. The device already
threads `sendReply(msg, rx.id)` and gw.js extracts `replyId`; verified live the reply's
`reply_id === the command's sent packet_id` (1303666450). So exact correlation is available.

## Diffs

### lib/timing.js — capture the sent id + match by reply_id
`_pump()`, after the send, capture the returned packet id:
```js
    let res;
    try { res = await e.thunk(); }
    catch (err) { ... existing ... }
    e.sentId = (res && res.id != null) ? Number(res.id) : null;   // for reply_id correlation
```
`onReply` gains the reply_id and prefers exact correlation:
```js
  onReply(replyObj, replyId = null) {
    if (!this.inFlight) return false;
    const e = this.inFlight;
    // Exact when the device threaded a reply_id AND we know our sent id; else positional
    // (broadcasts / untraceable replies keep the old behaviour). A reply threaded to a
    // DIFFERENT command's id is IGNORED — that is the cross the butler kept hitting.
    if (e.sentId != null && replyId != null) {
      if (Number(replyId) !== e.sentId) return false;
    } else {
      const m = e.opts.match;
      if (m && !m(replyObj)) return false;
    }
    clearTimeout(e.timer);
    this.inFlight = null;
    e.resolve(replyObj);
    this._pump();
    return true;
  }
```

### index.js — thread the reply_id through
```js
    if (ev.kind === 'text') {
      const reply = protocol.parseReply(ev.text);
      if (reply) { this.timing.onReply(reply, ev.replyId); this.emit('reply', reply, ev.from); }
      return;
    }
```

### test/transport.js — new correlation cases
- A command with a known sentId: a reply carrying a DIFFERENT reply_id is IGNORED (onReply→false,
  command stays in-flight); a reply with the MATCHING reply_id resolves it.
- A reply with `replyId=null` (untraceable) still matches positionally (back-compat).

## Observe
1. Offline: `node test/transport.js` green incl. the new reply_id cases; full suite green.
2. LIVE: re-run the butler over a sleepfor — the queued command's receipt is now the CORRECT reply
   (e.g. `status mem` -> `{type:mem,...}`), NOT the competing `sleepfor` reply.
3. Regression: a normal `mtmesh b80f cmd agc` still returns its `{type:agc}` reply; noReply/dedup unaffected.
