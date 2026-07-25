---
task: text-addressing-lost
status: IMPLEMENTED 2026-07-25. VERIFIED ON AIR with Peter onsite ("got it"): a threaded
  reply arrives and shows as a reply. CRITICAL FINDING THAT REVERSED PART OF THIS SPEC —
  passing `to` switches the frame to PKC (leaves as PRIVATE_APP, not TEXT_MESSAGE_APP) and
  TA2m CANNOT DECODE IT. Peter: "nothing received", while our ledger said `sent`. The working
  path is BROADCAST on the private channel; threading via replyId is independent of
  addressing, so we get both. ta2m-chat skill updated to forbid `to`.
source_hash:
  clients/mesh/lib/butler.js:      55702b90d185efef
  clients/mesh/lib/db.js:          f0500eb97ec17e6d
  clients/mesh/lib/store.js:       70d0363c39998675
  clients/mesh/index.js:           071e13349810e3b6
  clients/mesh/host-module.js:     78ecc552d8b6d48c
  clients/mesh/test/butler.js:     138efb6abc1f2c65
scope:
  - specs/text-addressing-lost.md
  - clients/mesh/lib/butler.js    # carry toNum/channel onto the entry
  - clients/mesh/test/butler.js   # assert addressing survives enqueue -> persist -> reload
  # SCOPE EXTENDED MID-TASK (Peter: "you did not send as a reply") — threading, below:
  - clients/mesh/lib/db.js        # migration 2: reply_id column
  - clients/mesh/lib/store.js     # map replyId through
  - clients/mesh/index.js         # emit packetId on `text`; sendText accepts replyId
  - clients/mesh/host-module.js   # /text accepts replyId
  - clients/host/API.md           # document threading
# NOT changing: the delivery path, states, or the decision of WHICH addressing to use.
---

# Spec: text-addressing-lost — a directed message silently became a broadcast

## The defect

`sendText` resolves the target and passes it down:

```js
this.butler.enqueue(unitKey, null, [], { kind: 'text', body: text, toNum, channel: ch });
```

`Butler.enqueue` builds the entry from `opts` — but **never copies `toNum` or `channel`
onto it**. The DB columns exist (`to_num`, `channel`) and `store.saveQueue` maps them, so
the plumbing at both ends is right; the middle drops them. Every text row reads
`toNum=null, channel=null`.

Consequence: `_deliverText` sees no target, omits `opts.to`, and the frame goes out
**broadcast** instead of addressed. `channel` still worked only by luck — it falls back to
`this.channel`, which happens to be the right one.

## What this did NOT cause — corrected after checking the air trace

I first blamed the broadcast for a lost message. Wrong, and worth recording so it is not
"fixed" again on a false premise:

- **The channel was always correct.** Per-radio channel INDEX differs: OMNI logs the
  Private channel as 2, YAGI logs the same frame as 1. OMNI's map is
  `0 PRIMARY · 1 mqtt · 2 Private(PSK)`. Our sends were on Private throughout.
- **Broadcast is normal for channel messaging.** TA2m's own messages are
  `to=ffffffff` too. A broadcast on a PSK channel is the ordinary path, not a fault.
- **The lost message was RF loss.** The frame transmitted (15:37:38, heard by YAGI) and
  simply did not arrive. Text carries no ACK and we do not retry, so `sent` currently
  means "tried once, gave up".

So this fix restores INTENT (a directed message when one is asked for); it is not a fix
for the lost pong.

## Care needed on the addressing itself

Directed messaging to TA2m has history: **PKC DMs on channel 0 do not decode in either
direction** — measured. That is why the working path has been the private channel.

A directed message on channel 2 is a DIFFERENT thing: it is addressed but still
channel-encrypted with the Private PSK, not PKC. It should work, but it has not been
proven with this handheld. So this change makes `{to, channel}` do what it says, and the
on-air result decides whether directed-on-2 is usable. If it is not, the caller simply
omits `to` and gets the broadcast path that already works.

## Changes

`clients/mesh/lib/butler.js` — the entry gains:
```js
toNum: opts.toNum != null ? opts.toNum : null,
channel: opts.channel != null ? opts.channel : null,
```

`clients/mesh/test/butler.js` — assert a text entry retains `toNum`/`channel` through
enqueue AND through a persist/reload cycle (the store already round-trips them; nothing
proved the butler put them there in the first place, which is exactly how this slipped).

## Observe

1. **Static** — the fields are on the entry.
2. **Functional** — send with `{to: <num>, channel: 2}`; the ledger row shows the real
   `toNum`/`channel`, and the air trace shows `to=<node>` rather than `to=ffffffff`.
3. **Regression** — a text with no `to` still goes out broadcast on the private channel;
   commands are unaffected.

## Risk

Directed-on-channel-2 is unproven with TA2m. If it does not arrive, revert to omitting
`to` — the broadcast path is known good, and this is being tested while Peter is
mid-deployment and relying on the link.


## Extension: replies were not THREADED (added mid-task)

Peter, onsite: *"Ok the replies did come, but you did not send as a reply."* The messages
arrive, but appear as standalone texts on the handheld rather than threaded against what
he sent.

Meshtastic threads by `reply_id`. Every piece already existed except two links:

- `gw.sendText` ALREADY accepts `replyId` and sets `body.reply_id`.
- `gw._normalize` ALREADY captures `packetId` for an incoming text.
- **But `index.js` emits `text` WITHOUT `packetId`** — so a listener cannot know what to
  reply to.
- **And `mesh.sendText` has no `replyId` parameter** — so even knowing it, there is no way
  to pass it.

So the fix is plumbing, not new capability: surface `packetId` on the event, accept
`replyId` on the way back down, and persist it (migration 2) so a retried reply keeps its
thread instead of silently becoming a standalone message — the same class of silent drop
as the addressing bug above.
