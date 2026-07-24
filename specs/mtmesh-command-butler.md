---
task: mtmesh-command-butler
status: P1 IMPLEMENTED + VERIFIED 2026-07-24. butler 15 offline + full suite green. LIVE b80f (daemon under PM2): queue -> 'heard' (keyed to packet.from, the real sender; node_id is the relaying gateway) -> deliver PKC DM -> CORRECT receipt: `status mem` acked with {type:mem,stak,heap}. Retry/TTL/persist/one-per-window covered. P2 (firmware always-answer/idle+epoch, §4-gated) + P3 (MQTT) later.
source_hash:
  clients/mesh/lib/gw.js: eac8ad4f127cb4631b67395c82b6675d3c47134fa1b8c42f800fc9400e913031
  clients/mesh/index.js: 9a15ff5ca4f956896b59c192711bdea08ce35b86505e87454b303051e2f1ce54
  clients/mesh/lib/butler.js: 91dc6e2a93094f1ec3b7e16b54a4b764fd756540e9907450f0183485f5208b27
  clients/mesh/lib/store.js: ba1af4aca22662f6847d1ae74770f18a5c89923bc66c45ad9cf8cd5ddbe4953f
  clients/mesh/lib/daemon.js: 01d6fc44a5f1330186752644b507ddeec8ff4bb1b4087ff16322e319f166753c
  clients/mesh/bin/mtmesh.js: 1eaff53f52d98ddb4866c8a92609b31547f43ae3541aa8d6443656abe434f206
  clients/mesh/test/butler.js: ad9b962607d2e0a0b3d0e5e173dbfc3c6ce078bcffffbefbf8620e8ae2bc00fc
scope:
  # ---- Phase 1 (bench-safe, all in @pac/mesh, NO firmware) — this spec's implementable part ----
  - mt-transport/specs/mtmesh-command-butler.md
  - clients/mesh/lib/gw.js         # emit a lightweight 'heard' on EVERY inbound packet (from+portnum+rssi/snr)
  - clients/mesh/index.js          # re-emit 'heard'; construct Butler; wire it to the send path
  - clients/mesh/lib/butler.js     # NEW — CommandQueue + window-fire + retries/TTL + ledger
  - clients/mesh/lib/store.js      # queue persistence (per-unit JSON sidecar, survives restart)
  - clients/mesh/lib/daemon.js     # GET/POST /queue routes; start the butler with the daemon
  - clients/mesh/bin/mtmesh.js     # `queue` verb: enqueue / list / cancel
  - clients/mesh/test/butler.js    # NEW — offline: enqueue, fire-on-heard, receipt, retry, TTL, persistence
# NOT in Phase 1: any firmware change; the always-answer/idle + epoch contract (Phase 2, §4-gated);
#   MQTT (Phase 3). node-dash is NOT touched — the butler lives in mtmesh.
---

# Spec: mtmesh-command-butler — queue + deliver into the wake window

## Why here (not node-dash)
The butler is active comms orchestration — queue, watch the mesh, deliver into the ~10 s wake
window. @pac/mesh already owns all three ingredients (send=PKC DM, event stream=Gateway, node
model), and mtmesh is already the PM2 service. node-dash stays a dashboard. (Unlike trial-logger,
a passive sink kept separate.) Relocates specs/command-butler.md from mt-radar to @pac/mesh.

## Corrected premise
command-delivery.md constraint 3 ("broadcasts only, no PKI") is DEAD — v2 PKC DMs are proven
(every `cmd` this session). Delivery is DIRECTED (to:num, ch0), simpler + private.

## The one core addition: a `heard` event (window signal)
mtmesh's gw.js maps only private_app(260/261) + text + status; it DROPS telemetry/nodeinfo — so it
cannot currently see a unit's wake TX. Add a minimal, cheap signal:
- gw.js `_normalize`: for ANY inbound packet, ALSO surface `{ kind:'heard', from, portnum, rssi, snr, at }`
  (in addition to the existing typed kinds; never decodes payloads).
- index.js `_onEvent`: on a heard event, `this.emit('heard', { from, portnum, rssi, snr, at })`.
The window-detector keys off `heard`: a unit transmitting = its ~10 s letterbox is open.

## Butler (lib/butler.js)
```
Butler({ deliver, store, log, cfg })   // deliver(unit, verb, args) -> reply (the existing mesh.command PKC-DM path)
  enqueue(unit, verb, args, {ttlMs, maxAttempts}) -> id      // persisted immediately
  list(unit?) / get(id) / cancel(id)                          // ledger
  onHeard(unit)   // window open: fire the OLDEST pending cmd for `unit` (one per window — airtime),
                  // await reply within the window; reply -> acked+receipt; timeout -> attempts++, next window;
                  // attempts>=max -> failed; enqueuedAt+ttl < now -> expired (swept on each heard + a timer).
```
Queue entry: `{ id, unit, verb, args, enqueuedAt, ttlMs, attempts, maxAttempts, status:pending|sent|acked|failed|expired|cancelled, lastError, receipt, sentAt, ackedAt }`.
One command per window (SF11 airtime + the 10 s budget); the rest wait for the next wake.

## Persistence (store.js)
Per-unit queue sidecar `<store>/<unit>/queue.json` (mirrors the payload-store per-node dir + JSON
pattern). `saveQueue(unit, entries)` / `loadQueue(unit)` / `listQueuedUnits()`. Survives restart —
a command for a unit that wakes in 6 h is still there. NEVER cleared except by terminal status + a
retention window (keep the ledger for the dashboard).

## Wiring (index.js + daemon.js)
- index.js: `this.butler = new Butler({ deliver:(u,v,a)=>this.command(u,v,a,this._idem()), store:this.images.store, ... })`;
  on `connect()` subscribe `this.on('heard', e => this.butler.onHeard(e.from))`.
- daemon.js: `GET /queue` (all) + `GET /queue/:unit` + `POST /queue {unit,verb,args,ttlMs?}` (enqueue) +
  `DELETE /queue/:id` (cancel). Butler runs whenever the daemon runs (its whole point).

## CLI (bin/mtmesh.js) — intake + inspect
- `mtmesh <unit> queue <verb> [args...]`  -> enqueue (POSTs to the daemon if up, else direct)
- `mtmesh <unit> queue --list`            -> the unit's ledger
- `mtmesh queue cancel <id>`              -> cancel

## Observe (Phase 1)
1. Offline (test/butler.js): enqueue persists; a synthetic `onHeard` fires the oldest pending and
   marks acked on a mocked reply; a timeout increments attempts and re-fires next heard; TTL expires;
   maxAttempts -> failed; queue survives a store reload. Full suite green.
2. LIVE bench b80f (always-awake, so it "wakes" every heartbeat): `mtmesh b80f queue status` then
   watch it deliver on the next heard packet and record the reply as the receipt; `queue --list`
   shows acked. (b80f transmits regularly, so the window opens within seconds — no sleep needed to
   prove the mechanism.)
3. Regression: existing daemon /health,/nodes + image listener + a normal `cmd` all still work;
   test suite green.

## Phase 2 (LATER, firmware-coordinated, §4-gated) — NOT in this spec
Always-answer contract: on wake the device expects a command OR an explicit "idle" (then sleeps
immediately); epoch piggybacked on the answer for time-sync (display/scheduling only, never
security). Needs firmware changes + the §4 field gate. The Class-A window mechanism is already
proven behind @sleepmode.

## Phase 3 (LATER) — MQTT edges (option B)
Butler intake also subscribes `pac/garage/cmd`; publishes reply/alarm/telemetry to the house broker.
Same butler core; a bridge module. Deferred (Peter: nice-to-have).
