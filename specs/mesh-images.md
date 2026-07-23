---
task: mesh-images
status: IMPLEMENTED + VERIFIED 2026-07-23. Offline images 17 (reassembly/repair/store/seed/closed-loop-get/autonomous/resume) green; LIVE image list 336b = pid 41910 crc 0x229E1A28 ready. Full live get is link-limited (marginal garage), handled by the existing campaign.
source_hash: clients/mesh/lib/push-receiver.js d9afec656a6953bda532b3a2e2c6c0595138416a539849ebcab87548755db4aa; clients/mesh/lib/store.js 271b3e5f8bfc7f860f9e81289fb191d46a82bcc4693fef72fe0087b40c6dfe46; clients/mesh/lib/images.js 604bfe13e6ecbd92e8917cf6f2ab42df42eff88dc4553bfef7a43c6485585231; clients/mesh/index.js bbda9cf1569c9e70bc7e9b3e4303287dd4e56d1b8f7961fa82ac92d8fcd97b92; clients/mesh/test/images.js a1f25301691e15dc73594ba1f56a16bec63968fb71003b3a6443f810b94e3831; clients/mesh/test/skeleton.js df8eaf593334113f72c6298d77d0f132302606d33eabaf3fc2e7929b74047156
project: mt-transport
scope:
  - specs/mesh-images.md
  - clients/mesh/lib/push-receiver.js   # NEW — port of PushReceiver
  - clients/mesh/lib/store.js           # NEW — port of PayloadStore
  - clients/mesh/lib/images.js          # fill Images (onFrame, get, list, listener)
  - clients/mesh/index.js               # 261 wiring + getImage/listImages/startImageListener
  - clients/mesh/test/images.js         # NEW — offline device-simulator + autonomous catch + resume
---

# mesh-module phase 4 — autonomous image transfer

Close the auto-upload gap: images move from the device to disk with **no human
intervention**. An always-on passive receiver catches device-initiated pushes,
drives the transfer, persists partials so a marginal link converges across
windows, CRC-verifies, saves the JPEG, and emits a domain event. `getImage` is
the active one-shot over the same machinery. Everything below the domain surface
(chunks, push frames, windows, repair, CRC, resume) is hidden.

PORT the proven code — do NOT reinvent:
- `clients/node/lib/push-receiver.js` (PushReceiver state machine) → `lib/push-receiver.js`
- `clients/node/lib/store.js` (PayloadStore) → `lib/store.js`
- `clients/node/index.js` `push()` control loop → `images.get()` / the shared drive loop
The chunk-push codec already lives in `lib/protocol.js` (MSG 0x10–0x16, crc32,
encodeStart/ProgressQ/Repair/Complete, decodeFrame). push-receiver.js requires it.

## Ports & framing (recap, verified)
- Port **261** carries binary push frames (device→us). Port **260** = JSON.
- Push control (us→device) is TEXT (mesh-gw sends no raw portnums):
  `@<t> push <pid>` START · `@<t> push q <pid>` PROGRESS_Q ·
  `@<t> push rep <pid> <id,id,…>` REPAIR · `@<t> push done <pid> <crc>` COMPLETE ·
  `@<t> push stat` STAT (has a JSON reply) · `@<t> push pub [pid]` publish.
- `decodeFrame` returns push types; a byte in 0x10–0x16 is push (0x01–0x06 pull is
  out of scope → decoded as null).

## 1. lib/push-receiver.js — port PushReceiver (unchanged logic)
Straight port of `clients/node/lib/push-receiver.js`, with `require('./protocol')`
instead of `./chunk-push` (same symbols: MSG, decodeFrame, encode*, crc32,
REPAIR_IDS_MAX). Keep every tuning constant and comment (idleMs, maxStale,
maxUnanswered, actMs, the liveness-reset reasoning). `onFrame(buf, nowMs)` stores
chunks; `tick(nowMs)` returns the next control frame to send or null; `assemble()`
CRC-verifies. `Date.now()` is fine (Node runtime).

## 2. lib/store.js — port PayloadStore (unchanged)
Straight port of `clients/node/lib/store.js`: `save(buf,{pid,ptype,node})`,
`savePartial`/`loadPartial`/`clearPartial` (buffer-then-sidecar ordering; identity
= pid+crc+count+len so a reused pid can't blend two images). `prune()` still throws
(retention unspecified). Dir from `cfg.paths.store`.

## 3. lib/images.js — the domain subsystem
`constructor({ gw, protocol, timing, model, cfg, log })` → also builds
`this.store = new PayloadStore({ dir: cfg.paths.store })`, `this.active = new Map()`
(pid → { rx, node, promise-controls }), `this.listening = false`, `this.emit` (a
callback the Mesh installs to surface domain events).

### onFrame(buf, from) — the single 261 entry point
- `const f = protocol.decodeFrame(buf)`; if null return.
- If an active receiver holds `f.pid` → `rx.onFrame(buf, Date.now())` and let its
  drive loop act.
- Else if **listening** and `f` is a START/MANIFEST/CHUNK for an UNKNOWN pid →
  **auto-adopt**: spin up a receiver for `f.pid` from `from` and start driving it
  (this is the autonomous auto-upload catch). Emit `image-available {node,pid}`.
- Else drop (unsolicited, not listening).

### the drive loop (shared by get() and the listener)
A per-pid async loop, ported from `index.js push()`:
- create `PushReceiver(pid,{idleMs:cfg.timing.idleMs…})`; register in `this.active`.
- seed from `store.loadPartial(node,pid)` when identity matches (resume) — the
  marginal-link convergence.
- optional adopt: `push stat` (via command/timing) → check `proto` (mismatch →
  throw, never hang), `upst` (0 → device holds nothing → fail fast), adopt if
  `upst∈{2,3} && up===pid` (resume a device already streaming) else send START.
- loop until `deadline` (cfg.timing.pushDeadlineMs) / `signal`:
  - `await sleep(pollMs)`; `const out = rx.tick(Date.now()); if (out) sendControl(out)`.
  - write-through partial (`store.savePartial`) + `onProgress`.
  - `rx.failed` → throw; `rx.done` → `assemble()` (CRC) → `store.save()` →
    clearPartial → resolve/emit `image {node,pid,path,bytes}`.
- `sendControl(buf)`: decode which control frame and send the TEXT form via
  `gw.sendText(gwId, text, {channel})` — fire-and-forget (chunks are the reply).
  Faithful to push(): control is not queued as request/reply; the receiver's idle
  gating is the pacing.

### get(node, pid, {onProgress, signal} = {})
Runs the drive loop to completion, resolves the verified Buffer. Never returns a
partial. Throws on proto mismatch / empty device / deadline / CRC fail.

### list(node)
`push stat` (via command/timing) → `{ pid:up, state:upst, chunks:cnt, crc, proto,
fw, ready: upst!==0 && up>0 }`. (The device holds at most one published payload;
a fuller inventory waits on the advert surface, still unbuilt in firmware.)

### startListener() / stopListener()
`startListener()` sets `this.listening = true` (idempotent); returns a stop fn.
From then, onFrame auto-adopts unknown-pid pushes and drives them to disk. With
`cfg.listen.autoFetchImages` a future 260 advert (`av[]`, not yet emitted by fw)
would also trigger `get()`. `stopListener()` clears the flag and aborts active
receivers.

## 4. index.js wiring
- `PORT_CHUNK = 261`.
- `connect()`: build `this.images = new Images({ gw:this.gw, protocol, timing:this.timing,
  model:this.model, cfg:this.cfg, log })` and install `images.emit = (type,payload)=>this.emit(type,payload)`.
- `_onEvent`: add `if (ev.kind==='app' && ev.portnum===PORT_CHUNK) return this.images.onFrame(ev.payload, ev.from);`
  (the gwId to reply to is `this.gwId`; the receiver addresses the DEVICE via the
  `@<node>` text, `node` derived from the transfer's origin).
- `getImage(node,pid,opts)` → `this.images.get(node,pid,opts)`.
- `listImages(node)` → `this.images.list(node)`.
- `startImageListener()` → `this.images.startListener()`.
- Domain events: `'image-available'` (a push began / device advertises) and
  `'image'` (`{node,pid,path,bytes}` saved + verified).

## 5. CLI (already dispatches)
- `image list <target>` → prints the stat summary.
- `image get <target> <pid> [--out FILE]` → `getImage`; writes bytes to `--out`
  (or store path) and prints the path/size. (`format()` already renders `<N bytes>`.)

## 6. config
Uses existing `paths.store`, `timing.idleMs/pushDeadlineMs/chunkAnswerMs`,
`listen.autoFetchImages`. No new keys required.

## 7. NOT in scope
- PULL codec (push is the deployed path). Retention/prune. Daemon serving (phase 7
  runs startListener under `mtmesh listen`). The advert (`av[]`) auto-fetch trigger
  is wired defensively but firmware doesn't emit it yet.

## 8. Verify (Observe)
- **Offline reassembly/CRC** (test/images.js): build a manifest + N chunks with
  `protocol.encode*`; feed a PushReceiver; assert `assemble()` CRC-matches; a
  dropped chunk → `missing()` non-empty → a REPAIR round fills it → done.
- **Closed-loop device simulator** (no radio): a fake gw whose `sendText` parses
  the push control text (`push <pid>` / `push q` / `push rep` / `push done`) and
  streams the corresponding 261 frames back into `images.onFrame` — LOSSY (drop
  1-in-K) to force a repair round. Assert `get()` resolves the exact bytes,
  CRC-verified, saved to the store dir.
- **Autonomous catch**: with `startListener()`, the simulator initiates a push
  (START+manifest+chunks) for an unknown pid; assert the module catches it,
  drives to done, saves, and emits `image {node,pid,path,bytes}` — no get() call.
- **Resume**: kill the loop mid-transfer (persisted partial on disk); a fresh
  `get()` seeds from the partial and completes with only the missing chunks.
- **Regression**: skeleton now shows getImage/listImages/startImageListener
  IMPLEMENTED (move them out of the pending set); settings/transport/log/cli-live
  green; `require('..')` clean.
- **LIVE (best-effort / DEFERRED)**: against a device holding a payload
  (`push stat` ready) drive `getImage` to a CRC-verified JPEG. The garage unit
  (pid 41910) is marginal — convergence needs a window; the autonomous listener is
  exactly what removes the human from that wait. Note result; offline+sim carry
  correctness.
