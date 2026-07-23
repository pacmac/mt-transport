---
task: mesh-transport
status: IMPLEMENTED + VERIFIED 2026-07-23 (phase 2). Offline suite green; live WS deferred (gw busy with field pull).
source_hash: clients/mesh/lib/gw.js 1e1d232cea444cbe925f3b7aed3561302279c340776da7a7c7ae3cbeedf991ee; clients/mesh/lib/protocol.js c5d436e18f339fee8d8435099074eb51c6a13170d15acb1c66fc88edb4c68ca2; clients/mesh/lib/timing.js 89b60e95af7579931757570c40532f342999f91c2ae175710885f7bef0972267; clients/mesh/test/transport.js dad97f6ae07665bc75fbbe50caf9d95f3e28e53d9a85417b0e567900659bce7a
project: mt-transport
scope:
  - specs/mesh-transport.md
  - clients/mesh/lib/gw.js         # fill bodies (transport)
  - clients/mesh/lib/protocol.js   # fill bodies (codec)
  - clients/mesh/lib/timing.js     # fill bodies (serialiser)
  - clients/mesh/test/transport.js # NEW — offline codec/timing roundtrip test
---

# mesh-module phase 2 — transport layer

Fill the three transport modules with working bodies. Nothing else: `index.js`
stays a skeleton, and model/images/config/notify keep throwing NotImplemented
until their phases. Behaviour is **ported from the proven `clients/node/lib`**
(events, chunk-push, commands, payloads, queue) — not reinvented. The module must
still `require()` clean, and the codec+timing must be unit-testable offline.

## Grounded facts (from investigation 2026-07-23)
- **RECEIVE is WebSocket, not SSE.** `mesh-gw/docs/API_SSE.md`: "There is no SSE
  transport." `WS ws://<host>/events`, needs `maxPayload:0` (multi-MB snapshot
  trips ws's 1 MB default → 1009 close). First two frames: `hello` then
  `device_snapshot`. `private_app` events carry `{portnum, payload_b64}`; `text`
  events carry `{data.text, from_num, channel, packet_id, data.reply_id}`.
- **SEND** (`mesh-gw/docs/API_REST.md`): `POST /{node_id}/messages` body
  `{text, to?, channel(0–7, default 0), reply_id?, pkt_id?}` → `{id, to}`.
  `text` max 228 bytes. Broadcast when `to` omitted/null (0xFFFFFFFF).
- **crc32** = `zlib.crc32(buf) >>> 0` (IEEE 802.3 reflected; Node ≥ 20.12).
  Do NOT substitute another variant — several exist and disagree silently.
- **Push wire** (`clients/node/lib/chunk-push.js`, mirrors `MtChunkPush.h`):
  big-endian; `MESH_PAYLOAD_MAX=231`; header lens 5/4; `MANIFEST_REPEAT_EVERY=8`;
  `PROTO_VERSION=1`. Frames below.

## 1. protocol.js — pure codec (no I/O)
Port `chunk-push.js` verbatim for the frame codec, add the command grammar,
`parse260`, `parseReply`. Big-endian throughout.

### constants
```
MESH_PAYLOAD_MAX = 231
PUSH_CHUNK_HEADER_LEN = 5 ; CHUNK_DATA_MAX = 226
REPAIR_HEADER_LEN = 4 ; REPAIR_IDS_MAX = 113
MANIFEST_REPEAT_EVERY = 8 ; PROTO_VERSION = 1
MSG = {START:0x10, MANIFEST:0x11, CHUNK:0x12, PROGRESS_Q:0x13,
       PROGRESS:0x14, REPAIR:0x15, COMPLETE:0x16}
PT  = {SCHEMA:1, IMAGE:2, LOG:3, JSON:4}
UP  = {IDLE:0, PENDING:1, SENDING:2, AWAITACK:3}
```

### command grammar (from commands.js)
- `buildCommand(target, verb, args=[])` → `"@<t> <verb>[ <args…>]"`.
  - `t = String(target).replace(/^@/,'')`; reject if `t !== '*'` and `/\s/.test(t)`
    (`throw new MeshError('invalid target …','EBADTARGET')` — device tokenises on
    the first space, a spaced target breaks addressing).
  - `args` array joined by spaces; empty → no trailing space.
- `parseReply(text)` → parsed object or `null`. Not a string, or not starting
  with `{` → `null`; `JSON.parse` in try/catch, failure → `null`. (Replies carry
  no request id — correlation is positional; see timing.js.)

### port 260 (from payloads.js) — tolerant
- `parse260(buf)` → object. utf8-decode fail → `null`; `JSON.parse` fail →
  `{type:'unparseable', raw:txt}` (device uses fixed-buffer snprintf, truncation
  is real and must not throw into the loop); success → the object.

### push frame codec (from chunk-push.js) — byte-identical
Encoders (client-emitted marked ★; device-side included for offline roundtrip
tests + C++ parity):
- ★ `encodeStart(pid)` → `[0x10][pid:2]` (3 B)
- ★ `encodeProgressQ(pid)` → `[0x13][pid:2]` (3 B)
- ★ `encodeRepair(pid, ids[])` → `[0x15][pid:2][n:1][id:2]*n`; reject
  `!ids || n===0 || n>REPAIR_IDS_MAX` → `null` (silent-truncation would hang)
- ★ `encodeComplete(pid, crc)` → `[0x16][pid:2][crc:4]` (7 B)
- `encodeManifest(pid,ptype,bytes,count,crc)` → `[0x11]…` (14 B)
- `encodeChunk(pid,seq,data)` → `[0x12][pid:2][seq:2][data]`; `>CHUNK_DATA_MAX`→`null`
- `encodeProgress(pid,cursor,done)` → `[0x14][pid:2][cursor:2][done?1:0]` (6 B)
- `decodeFrame(buf)` → typed object or `null`. Ports the chunk-push switch exactly
  (length-guards per type; never returns a partially-populated frame; unknown or
  short → `null`). NOTE a byte in the **pull** range 0x01–0x06 decodes to `null`
  here — pull is out of scope (see §4).
- `crc32(buf)` → `zlib.crc32(buf) >>> 0`.

`module.exports` = all constants + the encode/decode fns + `crc32` + the three
grammar/260 fns.

## 2. gw.js — mesh-gw transport (the ONLY code that knows mesh-gw exists)
`class Gateway { constructor(cfg) }` — `cfg` is resolved `settings` (uses
`cfg.gw.host`, `cfg.gw.port`, `cfg.gw.sendPort`, `cfg.gw.eventsPath`,
`cfg.gw.reconnectMs?`). No hard-coded hosts/ports/paths.

- `async connect()` — open `ws://${host}:${port}${eventsPath}` with
  `{maxPayload:0}` (port `ws` from events.js). Resolve on `open`. Per message:
  `JSON.parse` (drop on failure); capture `device_snapshot` into `this.snapshot`;
  route to every registered handler:
  - `type==='private_app'` → `{kind:'app', portnum, payload:Buffer.from(payload_b64||'','base64'), from:e.node_id||String(e.from_num), raw:e}`
  - `type==='text'` → `{kind:'text', text:e.data?.text, from:e.node_id||String(e.from_num), channel:e.channel, packetId:e.packet_id, replyId:e.data?.reply_id ?? null, raw:e}`
  - `type==='message_status'` → `{kind:'status', packetId:e.packet_id, status:e.status, raw:e}`
  - else → ignored (gw stays dumb; interpretation is the protocol/model layers').
  On `close`: emit close to handlers, and if not stopped, reconnect after
  `reconnectMs` (default 5000). `error` → forward, do not crash.
- `onEvent(handler)` — push to `this.handlers`; returns an off() unsubscriber.
- `async close()` — `stopped=true`; close ws.
- `async sendText(gwId, text, {channel, to=null, replyId=null}={})`
  - `Buffer.byteLength(text,'utf8') > 228` → `throw MeshError('text too long …','ETEXTLEN')`.
  - **Guard (relaxes clients/node):** a BROADCAST (`to==null`) on channel 0 →
    `throw MeshError('refusing to broadcast on channel 0 (PRIMARY)','ECHAN0')`.
    A DIRECTED message (`to` set) is allowed on any channel — a PKC DM legitimately
    rides ch0. `channel` must be given (from cfg/opts), never defaulted to 0 for
    broadcast.
  - `POST http://${host}:${sendPort}/${gwId}/messages` JSON
    `{text, channel, ...(to!=null?{to}:{}), ...(replyId!=null?{reply_id:replyId}:{})}`.
    `!r.ok` → `throw MeshError('gateway send failed: '+r.status,'EGWSEND')`.
    Return `await r.json()` (`{id,to}`). Uses global `fetch` (Node ≥ 20.12).
- `async nodes(gwId)` — `GET /${gwId}/nodes` → json. (device-namespaced, API_REST.)
- `async status(gwId)` — `GET /${gwId}/status` → json. (`/status` is the correct
  read for the OMNI gateway.)
- `info(gwId)` — return `this.snapshot` (the WS `device_snapshot`), not a REST
  call — avoids an unverified route; the snapshot is the authoritative device
  metadata. Returns `null` before connect/snapshot.

Reads (`nodes`/`status`/`info`) are thin and primarily feed phase 3 (cli-live);
included here because gw.js owns every mesh-gw call.

## 3. timing.js — outbound serialiser (the ONLY code that knows airtime exists)
Port `CommandQueue` (queue.js) to the skeleton's thunk shape. Correctness, not
throughput: replies carry no id, so one in flight + spacing is what makes a reply
attributable.

`class Timing { constructor(cfg) }` — `cfg=settings.timing`. Fields:
`q=[]`, `inFlight=null`, `lastSentAt=0`, `_pumpTimer=null`.
- `enqueue(thunk, opts={})` → Promise.
  - `thunk` = `async () => <sendResult>` (does the actual `gw.sendText`).
  - `opts`: `{match, dedupKey, priority=0, retries=0, noReply=false, timeoutMs}`.
    `timeoutMs` default `cfg.replyTimeoutMs`. `retries` default **0** (NO blind
    retry — a retried non-idempotent command doubles the effect).
  - dedup: key = `opts.dedupKey` (if given). Match against `inFlight` AND queue;
    identical pending key → return the existing promise (no key → never dedups).
  - push entry, stable-sort by `priority` desc, `_pump()`.
- `_pump()` — if `inFlight` or empty queue → return. Enforce spacing:
  `wait = max(0, spacingMs - (now - lastSentAt))`; if `wait`, arm a SINGLE
  `_pumpTimer` (the guard that stopped a 2 GB heap blow-up in queue.js) and
  return. Else shift highest-priority entry, set `inFlight`, `lastSentAt=now`,
  `await thunk()` (on throw: clear inFlight, reject, re-pump). If `noReply`:
  resolve `{sent:true}`, clear, re-pump. Else arm a `timeoutMs` timer:
  on fire, if `retries>0` decrement and requeue-front, else reject
  `MeshError('timeout','ETIMEOUT')`; clear inFlight, re-pump.
- `onReply(replyObj)` — no inFlight → `false`. If `inFlight.opts.match` and
  `!match(replyObj)` → `false`. Else clear timer, resolve with `replyObj`, clear
  inFlight, re-pump, `true`. (Positional correlation — sound only because one is
  in flight.)
- `get spacingMs()` → `cfg.sendSpacingMs`.

Timing does NOT call gw directly and holds no socket — index.js wires
`gw` ↔ `timing` in phase 3. Kept decoupled so it unit-tests with fake thunks.

## 4. Deliberately NOT in this phase
- **Pull codec** (`chunk.js`, MSG 0x01–0x06, `encodePull`/`encodeGetManifest`/
  `ChunkClient`) — deployment path is push; pull lands with mesh-images if needed.
- **index.js wiring** (`Mesh.connect` opening gw + wiring timing/onReply) — phase 3.
- **PushReceiver / getImage flow** — mesh-images.
- **settings.load** real body — still skeleton; tests pass `DEFAULTS`-shaped cfg.
- **Touching mesh-gw** — it is live.

## 5. Verify (Observe)
- **Static**: grep the three files show no remaining `ni(...)`/NotImplemented in
  the ported bodies; `require('../clients/mesh')` still loads.
- **Functional (offline, deterministic — no radio)**: `test/transport.js`
  - codec roundtrip: for START/MANIFEST/CHUNK/PROGRESS/REPAIR/COMPLETE,
    `decodeFrame(encodeX(...))` deep-equals the inputs; over-long repair/chunk →
    `null`; short/garbage buffers → `null`; a 0x02 (pull) byte → `null`.
  - `crc32` of a known vector matches (reuse a golden value from offline-push.js).
  - `buildCommand('*','ping')`→`"@* ping"`; spaced target throws;
    `parseReply('{"ok":1}')`→obj, `parseReply('hi')`→null;
    `parse260(Buffer.from('{"t":"dbg"}'))`→obj, truncated→`{type:'unparseable'}`.
  - timing: two `enqueue`d thunks run one-at-a-time ≥ spacing apart (fake timers
    or a tiny spacing cfg); `onReply` resolves the in-flight; a no-reply resolves
    on send; a timeout rejects; dedup returns the same promise; `retries:0` never
    re-sends.
- **Functional (live, best-effort / DEFERRED)**: `gw.connect()` to the configured
  host opens the WS and receives `hello`; if the gateway is busy with the field
  transfer, DEFER with reason and rely on the offline suite.
- **Regression**: `node test/skeleton.js` still prints 14/14 (untouched methods
  still throw NotImplemented); `mtmesh` with no verb still prints usage.
