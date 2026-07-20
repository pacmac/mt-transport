---
task: chunk-push
status: steps 1-6 implemented 2026-07-20 — END-TO-END TRANSFER WORKS OFFLINE.
        72 engine + 42 codec + 40 JS codec + 19 e2e assertions pass. The e2e harness
        drives the REAL C++ engine against the REAL JS receiver across a seeded lossy
        link: CRC-verified completion at 10/20/30/50% loss, 5/5 seeds each.
        Steps 7 (on-air) and 8 (retention value + status flag) NOT done.
        NOTHING HAS BEEN FLASHED AND NOTHING HAS TRANSMITTED.
priority: HIGH — supersedes chunk-flow-control as the deployment gate
updated: 2026-07-20
source_hash:
  mylibs/mt-chunk-push/src/MtChunkPush.h: 091d295c0610161da6bc70937c8d38a3c67654e35aed902a50c666f4b419d16b
  mylibs/mt-chunk-push/src/MtChunkPush.cpp: b4db38c00fe5db06d63480213263ed86d8666de9bb4e9e37dde054d19279109a
  mylibs/mt-chunk-push/src/MtChunkPushCrc.h: bda2792bf970dbe10a8f4f31d1664984663dee555cdc35a4c482b5081f2c9f01
  mylibs/mt-chunk-push/test/test_push_engine.cpp: 035dd9df4c5b268c545682e38adc119c1294c3b010b859be64b28e5a8a77e234
  mylibs/mt-chunk-push/test/test_push_codec.cpp: ff51cf40ae76e9728c97dc5d8c49c7904d5c6b368c4a3dcd23ce500092d880df
  mylibs/mt-chunk-push/test/push_device_sim.cpp: 66129786b1044289fae8655041346343c3d2af17f349682e0a5c86a23df43522
  mylibs/mt-chunk-push/library.json: 3819bec033b3811aac0c7c2d2b7bbdcd437b01d68046f40bf6e600766a33636e
  projects/mt-transport/clients/node/lib/chunk-push.js: 89b0fe76a9a5392d826de4d417c2dfcdc36d42b3f6d5866e3016c96dd6102aca
  projects/mt-transport/clients/node/lib/push-receiver.js: 1c0f6f4a826137e9b65de8dcde7d0e6d0137ebaff04188a0a366ebeabf3e5dc7
  projects/mt-transport/clients/node/test/offline-push.js: 7c94cdf6c34e4dec15e57e5cf47742abfa3d000b463bcf70ee2ef24f6e29888c
  projects/mt-transport/clients/node/test/e2e-push.js: 5a8beb2d696ce28f5e21359c5ff0f1b54bcb30e978d0cfd4ad87e4a5b7425ffc
scope:
  - mylibs/mt-chunk-push/src/MtChunkPush.h        # NEW
  - mylibs/mt-chunk-push/src/MtChunkPush.cpp      # NEW
  - mylibs/mt-chunk-push/library.json             # NEW
  - mylibs/mt-chunk-push/src/MtChunkPushCrc.h     # NEW — scope EXTENDED during step 2:
                                                  # the engine needs a CRC and mt-chunk's
                                                  # is in a sibling lib we must NOT couple
                                                  # the deployed protocol to (see file)
  - mylibs/mt-chunk-push/test/test_push_engine.cpp # NEW — scope EXTENDED during step 2
  - mylibs/mt-chunk-push/test/test_push_codec.cpp # NEW — scope EXTENDED during step 1,
                                                  # see §5 note: byte-compat between the
                                                  # C++ and JS codecs is the entire point
                                                  # of a "wire" step and cannot be
                                                  # asserted from the JS side alone
  - projects/mt-transport/clients/node/lib/chunk-push.js   # NEW
  - projects/mt-transport/clients/node/test/offline-push.js # NEW
  - projects/mt-transport/clients/node/lib/push-receiver.js # NEW — step 4/5
  - projects/mt-transport/clients/node/test/e2e-push.js     # NEW — step 6
  - mylibs/mt-chunk-push/test/push_device_sim.cpp # NEW — stdio shell around the REAL
                                                  # engine so the e2e harness drives
                                                  # production code, not a JS mock
  - projects/pac-garage-alarm/src/main.cpp        # wire the push engine + FW_VERSION bump
---

# Spec: chunk-push — the device streams, the receiver listens

## 1. Why — the pull path is the thing that fails

Step 7 of `chunk-flow-control` root-caused the 16/32 stall. UART ground truth, every
pull the device received across a full failing run:

```
CHUNK: pull pid=1 0 x16 sendFails=0
CHUNK: pull pid=1 0 x8  sendFails=0
```

**Both carry `first=0`. The device never received a pull for `first=16`.** The client
sat at 16/32 and its follow-up requests never arrived. `sendFails=0` on both: when the
device was asked, it served perfectly. It was simply never asked again.

So `"no serve, no busy"` was literal and correct — no pull arrived, so the device had
nothing to say. Already excluded by earlier evidence: airtime accounting, hop_limit,
message size, congestion, TX-queue overflow. **The serve path is not the defect. The
request path is.**

That reframes the whole design. Under pull, a transfer needs one downlink request per
batch, and every one of them is a chance to stall the transfer permanently. Under push
there is no per-batch request to lose.

### The design principle, in one line

**Pacing belongs where the information is.** Only the device knows its TX queue depth,
CAD state, and when it last transmitted. Pull ships that decision to a remote party over
a lossy link and then needs `MSG_BUSY` to ship the answer back — and we proved `MSG_BUSY`
cannot be sent in exactly the conditions that require it. Push keeps the decision local,
so **the entire backpressure-signalling problem stops existing rather than being fixed.**

## 2. Design (Peter's, 2026-07-20)

1. Client sends **START** once: *"send pid N."*
2. Device sends the **MANIFEST first** (count, length, CRC32) so the receiver knows the
   full shape from the outset.
3. Device **streams chunks `0..count-1` at its own rate**, paced by its existing
   radio-busy/gap logic. No permission, no acks, no windows.
4. Receiver is **passive**: `store[seq] = payload`. Nothing else. It does not track gaps,
   does not time individual chunks, does not care about order.
5. When the receiver believes the stream is finished, it **reconciles**: walk
   `0..count-1`, collect missing ids, send **REPAIR** naming exactly those ids.
6. Device serves the repair list at its own pace. Repeat 5–6 until complete.
7. Receiver sends **COMPLETE**; only then may the device release the pid.

Because the sequence id carries position, out-of-order arrival, duplicates and reordering
are all non-events: a duplicate is an idempotent overwrite. **There is no in-flight logic
to get wrong.**

### Why the asymmetry is right

The Node side has effectively unlimited RAM/CPU to hold buffers and reconcile; the device
has one job in both directions — *"send these ids when the radio is free"*. The initial
stream is just the degenerate repair where the list is "all of them", so **one code path
serves both**.

## 3. The three cases that need explicit logic

Everything else falls out of the design; these do not.

### 3.1 The last chunk is lost

Reconciliation triggers on "stream finished", so if the **final** chunk is the one lost,
the trigger never fires and the receiver waits forever. The manifest saves us — `count` is
known from frame one — so the fallback is an **idle timer**: no new chunk for N seconds →
act. This also covers the device dying mid-stream.

### 3.2 Idle does not mean done — ask the device

A silence gap has two causes a timer **cannot** distinguish: the device is still sending
(pacing itself around airtime/backoff), or it finished and we lost the tail. Guessing
either way is wrong — fire early and we request chunks still in flight; wait and we hang.

So on idle the receiver asks: **PROGRESS query → device replies `{cursor, done}`**.

- **Idempotent and stateless** — reports a variable the device already holds
  (`_pushNext`). Safe to repeat, safe to lose, no session, no side effects.
- **Tiny** — a few bytes each way; retrying costs nothing on the air budget.
- **Self-healing on loss** — lose the query or its reply and we just ask again. Contrast
  with pull, where one lost request stalls the transfer (§1).

End-state logic collapses to one loop: *on idle, ask "done?" → not done, keep waiting →
done, reconcile and repair.* The lost-last-chunk case stops being special: it is just
"device says done, I am missing #31".

**Free diagnostic:** device says `sent 32`, we hold 27 → an unambiguous uplink-loss
measurement from the difference. Today we can only infer loss.

### 3.3 The device must assume NOT done until told

Asymmetric costs: if the device wrongly assumes done, the image is **lost for good**
(no OTA, no re-capture of that moment). If it wrongly assumes not-done, it holds a buffer
slightly too long. So it errs toward holding.

Two distinct states — today's design conflates them:

| State | Owner | Meaning |
|---|---|---|
| **done transmitting this pass** | device | what PROGRESS reports |
| **transfer complete** | **receiver only** | only it knows what it holds |

The device stays in *serving pid N* until the receiver's **COMPLETE**. That one round trip
is worth having, because it is the only fact the device cannot determine locally. It is
also what makes camera resume work across days.

**Required safeguard — a release condition other than the ACK**, or an unreturning
receiver pins the buffer forever on an un-reflashable field unit:

- **retention deadline** — generous (uploads are once/day at best), and
- **supersession** — a new pid releases the old, so a fresh capture is never blocked by a
  stale unconfirmed transfer.

Whichever fires first. The retained pid + its ack state go in the **debug frame**, so an
un-acked buffer is visible rather than silent. *Deadline value is a real trade-off
(too short loses resume, too long risks blocking storage) — proposed in step 8, not
picked silently.*

### 3.4 The device advertises that an upload is waiting (Peter, 2026-07-20)

The device carries a **status flag: "I have pid N waiting to upload"**, surfaced in the
existing status/heartbeat frame. This is not just reporting — it changes how a transfer
starts and makes the one remaining fragile message self-healing.

- **Discovery instead of polling.** Node never has to know in advance that an image
  exists, and never has to poll asking. The device says so, and Node sends START.
- **It makes a lost START recoverable.** START is the one message whose loss could
  otherwise leave a transfer un-started. But the flag stays set, so the *next* status
  frame re-advertises the pending upload and Node simply asks again. Nothing wedges —
  which is the property the pull design lacked (§1).
- **It subsumes the §3.3 visibility requirement.** The same flag reports a **retained
  un-acked pid**, so a buffer held past a failed transfer is visible rather than silent.

Proposed fields (tiny, and **change-gated** like the rest of telemetry — the flag moves
rarely, so it costs approximately nothing):

| Field | Meaning |
|---|---|
| `up` | pid awaiting/undergoing upload; `0` = none |
| `upst` | `0` idle · `1` pending (never started) · `2` sending · `3` awaiting COMPLETE |

**Keep it to these two keys.** The status frame already overflowed once today (fixed by
the bounded `jsonBegin/jsonAdd/jsonEnd` builder); adding a flag must not re-open that, so
these go in as optional fields the builder can drop under pressure.

**Consequence worth stating plainly:** with this flag, *every* message in the push
protocol becomes retry-safe. START is re-triggered by the flag, PROGRESS/REPAIR/COMPLETE
are idempotent by construction (§3.2, §3.3). **No single lost frame can strand a
transfer** — which is exactly the failure we spent today chasing.

## 3.5 Answering `mt-chunk`'s documented case AGAINST push

`MtChunk.h:10-14` and `:104-118` argue push is the wrong design. Those arguments were
written deliberately and must be answered, not quietly contradicted.

**Objection 1 — preemption.** *"The device keeps NO transfer state, and it is never
mid-transfer, so an alarm never has to preempt an in-flight burst. A push design needs a
preemptible state machine purely to solve a problem pull does not have."*

**Partly wrong today, and checkable.** The claim holds for *protocol* state but not for
the *radio*. `MtChunk.cpp` serves a pull with

```c
for (uint8_t i = 0; i < count; i++)
    if (!sendChunk((uint16_t)(first + i))) _sendFailures++;
```

— up to `PULL_BATCH_MAX` = 16 frames enqueued in one synchronous loop, into a TX ring of
`TXQ_N` = 16. So under pull the device **is** mid-burst, with an alarm queued behind up
to 16 frames. Push with a one-chunk-per-`service()` cursor is **more** preemptible, not
less: the alarm interleaves after the current single frame. The "preemptible state
machine" the header warns about is `_pushNext` + `_pushActive` — two variables, and it
buys back preemption the batch loop currently loses.

**Objection 2 — residency.** *"A push design would have to iterate the whole payload,
which needs it resident"* — the reason `IPayloadSource` exists, since the RAK4631's whole
LittleFS is 28,672 B and cannot hold an image.

**This one is simply not true of a cursor-based push.** Push reads window `seq` on demand
via `IPayloadSource::read(offset, dst, len)` — the identical call `sendChunk(idx)` already
makes. Chunk-addressing is fully preserved; the only thing that moves is *who chooses the
index*. The device still holds **one chunk, never the payload**, so the proxy property
that makes the M5 camera design work is untouched.

**Net:** objection 2 does not apply; objection 1 inverts once you look at the serve loop.
The header's reasoning will be corrected when `mt-chunk` is eventually retired — **not
now**, since it is the deployed protocol and out of scope (§6).

## 4. Wire — new lib, side by side

`mylibs/mt-chunk-push/`, **new**. `mt-chunk` is **not modified and not renamed.**

**Recommendation (decide before step 1):** do *not* rename `mt-chunk` → `mt-chunk-pull`
yet. The deployed field unit runs the pull firmware and cannot be reflashed; a rename
churns every include across projects and buries the real diff. If we still want the name,
do it later as a separate mechanical commit. Keeping both libs means push is fully
revertible — git history plus an untouched `mt-chunk`.

New message types in a **fresh 0x10 block**, so a stray frame can never be misread as a
pull-protocol frame (existing: `CHUNK 0x01, PULL 0x02, MANIFEST 0x03, ERR 0x04,
GETMANIFEST 0x05, BUSY 0x06`). Big-endian, matching the existing frames.

| Type | Dir | Payload |
|---|---|---|
| `PUSH_START` 0x10 | C→D | `pid:2` |
| `PUSH_MANIFEST` 0x11 | D→C | `pid:2, count:2, len:4, crc32:4` |
| `PUSH_CHUNK` 0x12 | D→C | `pid:2, seq:2, data[]` |
| `PUSH_PROGRESS_Q` 0x13 | C→D | `pid:2` |
| `PUSH_PROGRESS` 0x14 | D→C | `pid:2, cursor:2, flags:1` (bit0 = done) |
| `PUSH_REPAIR` 0x15 | C→D | `pid:2, n:1, ids:2×n` |
| `PUSH_COMPLETE` 0x16 | C→D | `pid:2, crc32:4` |

### Two corrections to this spec, made during implementation

**1. `CHUNK_DATA_MAX` is 226, not 224 as first written here (and as told to node-dash).**
A pushed chunk carries no `count` field: the manifest arrives first and is repeated, so
repeating the count in every chunk would be 2 bytes of pure redundancy per frame. The
header is therefore **5 bytes** (`type + pid:2 + seq:2`) against mt-chunk's 7, leaving
`231 − 5 = 226`. Inconsequential to node-dash (they decode no 261 frames) but they were
told 224, so it is corrected on the channel rather than left to be discovered.

**2. `MANIFEST_REPEAT_EVERY = 8` — a hole in the original design.** Dropping `count` from
the chunk header exposed it: the manifest becomes the **sole carrier of `count` and
`crc`**, and this protocol deliberately has no `GETMANIFEST`. So a single lost manifest
would leave the receiver holding chunks it can never complete or verify, with no way to
ask again — precisely the "one lost frame strands the transfer" failure push exists to
eliminate. Fix: the device **re-sends the manifest every 8 chunks** and once at
end-of-pass. No request path, self-healing, consistent with push. At 32 chunks that is 5
copies; against the ~17% per-frame loss measured on this link, losing all five is
~1-in-70,000, for 14 bytes each.

**Repair carries an explicit id list, not `first+count`.** Losses are scattered, not
contiguous, and the `first+count` shape is exactly what produced the ambiguous
`0 x16` / `0 x8` pulls in §1. At 2 bytes per id, one 224-byte frame names ~110 missing
chunks — far beyond need. `CHUNK_DATA_MAX` is unchanged at 224 (`PUSH_CHUNK` header is
the same 5 bytes as `MSG_CHUNK`).

Back-compat is free: peers already drop unknown types, so a pull-firmware device simply
ignores push frames.

## 4b. Client API contract (settled with node-dash 2026-07-20)

`Client.fetch(target, pid, { onProgress, deadlineMs })` — **signature unchanged**;
node-dash's route and UI sit directly on it and must not move.

- **`onProgress` must OMIT `batch`.** node-dash destructures
  `{received, count, batch, elapsedMs}` at `src/chunk-api.js:74` and forwards to the
  browser. Under push there is no batch; they will drop the field rather than render
  `batch: undefined`. Emit `{received, count, elapsedMs}`.
- `count` is known from the **manifest at frame one**, and `received` climbs
  monotonically regardless of arrival order — so the dashboard gets a real progress bar
  instead of an indeterminate spinner, and one that never jumps backwards.
- **`MSG_BUSY` has zero code dependency on node-dash** — verified their side: three
  references, all comments (`src/transport-adapter.js:25,:128`,
  `tests/test_transport_adapter.mjs:113`). Nothing branches on `0x06`. It can be
  retired without coordination.

**Flagged by node-dash, not yet assessed by us:** push streams 32+ *unsolicited* frames.
Their feeds are safe (261 never reaches the message path; the private-app cache
early-returns on non-JSON at `src/persist.js:224`), but the frames still cross their
`/events` relay to every connected browser, and the gateway rebroadcasts ~2.8 frames per
chunk (their measurement). If a push runs with the Control page open, that is a socket
burst. They will throttle their side if it proves real — **but the ~2.8× rebroadcast
figure is a fact about our airtime too, and step 7 should measure it rather than
inherit it.**

## 4c. A real bug the native harness caught (step 2)

Pacing used `_lastSendMs != 0` as the "never sent yet" sentinel. **`millis()` legitimately
IS 0 just after boot**, so the very first frames after a reboot would have skipped the
inter-send gap entirely and burst onto the air — at exactly the moment a device is most
likely to be doing something else. Replaced with an explicit `_hasSent` flag; the same
0-sentinel was removed from the retention check, where the state guard is the correct
test anyway.

Worth recording because it is the argument for the injected clock: `service(nowMs)` takes
time as a parameter rather than calling `millis()`, which is the only reason a test could
ever pass `t=0` and see this. On-air it would have looked like an intermittent burst after
reboot and cost days.

## 4d. Two more real defects the harness caught (steps 3-6)

Both were found by the end-to-end harness, and both would have presented on air as
"the transfer just stops" — the exact symptom we spent the day chasing under pull.

**1. The receiver never gave up on a dead device.** Killing the device mid-stream left
it looping PROGRESS_Q forever: the stale-round bound only trips in the repair branch,
which needs a reply that never comes. A fetch that neither completes nor errors is the
16/32 failure in a new costume. Fixed with an unanswered-query bound that produces a
clear reason string and a *usable partial* (`8/32`), because an interrupted transfer
should be resumable, not lost.

**2. Sizing that bound needed arithmetic, not a guess — the first two attempts were
wrong and the harness said so.** `maxUnanswered = 6` broke the 30% and 50% loss cases:
on a lossy link the *replies* are lost too, so a live device is indistinguishable from a
dead one. Resetting the counter on ANY inbound frame helped but was not enough, because
**in `AWAITACK` the device is legitimately silent** — silence is the expected state
exactly where we query most. At 50% loss a query round-trip succeeds with
`p = 0.5 x 0.5 = 0.25`, so `N` tries fail with `0.75^N` across ~8 stretches per transfer:
`N=12` gives ~23% cumulative false-death (measured: 2/5 seeds wrongly aborted), `N=30`
gives ~0.02%. Cost of `N=30` is ~4 minutes to notice a genuinely dead device.

**Aborting a working transfer is far worse than taking four minutes to notice a dead
one**, so the bound is deliberately loose. Recording the reasoning because the number
looks arbitrary and is not.

## 4e. Measured cost, offline (step 6)

| Link | Result | Repair rounds | Frames on air | Simulated |
|---|---|---|---|---|
| clean | 32/32 CRC ok | 0 | 37 | 65 s |
| 10% loss | 5/5 seeds | 1.8 | 44 | 111 s |
| 20% loss | 5/5 seeds | 2.2 | 49 | 127 s |
| 30% loss | 5/5 seeds | 4.6 | 56 | 219 s |
| 50% loss | 5/5 seeds | 8.8 | 88 | 616 s |

Also passing: 20% loss + 20% duplicates; 15/15/30% loss+dup+**reorder**; a force-dropped
START recovered by the receiver re-asking; 40% loss recovered via progress+repair.

**37 frames for a clean 32-chunk transfer** — 32 chunks + 5 manifests, and *zero*
round trips. That is the number to compare against pull, which needed one downlink
request per batch and stalled permanently when one was lost.

**THE LIMIT, stated because the pull harness passed and pull still failed on air:**
FakeLink loss is INDEPENDENT per frame. Real loss here is correlated and bursty
(gateway rebroadcast self-congestion, ~2.8 frames per chunk by node-dash's measurement).
This proves PROTOCOL LOGIC under loss. It is NOT evidence the on-air transfer works.
Step 7 is the only real verdict.

## 5. Test plan — layers, bottom-up, as always

- **L0 offline** (`test/offline-push.js`) — fake device + seeded lossy link driving the
  real receiver. Must include the cases §3 exists for: **last chunk lost**, **device dies
  mid-stream**, **PROGRESS reply lost**, **REPAIR lost**, plus loss/dup/reorder sweeps.
- **L1/A on-air** — bench `!8cee336b` via OMNI ch2. Bar: **10/10 consecutive CRC-verified
  transfers**.
- Field unit `!987ab80f` is **untouched** throughout.

## 6. Explicitly NOT in scope

- `mylibs/mt-chunk/**` — untouched, still the deployed protocol.
- Renaming `mt-chunk` → `mt-chunk-pull` (§4 recommendation: later, separate commit).
- The open pull-path question (client dedup vs on-air loss) — recorded on
  `chunk-flow-control` note 1203, no longer load-bearing under push.
- Layer B camera pipeline — unchanged, still blocked on TimerCam.
