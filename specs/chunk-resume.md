---
task: chunk-resume
status: proposed — awaiting approval, no edits made
source_hash: ~
updated: 2026-07-19
scope:
  - projects/pac-garage-alarm/src/main.cpp        # branch chunk-integration ONLY
  - projects/mt-transport/clients/node/index.js
  - projects/mt-transport/clients/node/lib/chunk.js
  - projects/mt-transport/clients/node/lib/store.js
  - projects/mt-transport/clients/node/test/run.js
---

# Spec: chunk-resume — content-derived pid + resumable fetch

## 1. Why

Peter, 2026-07-19: *"uploads may be at worst once a day, at best never unless
there is an intruder ... resume [is] invaluable due to the radio being busy or
outside influences."* Design priority is **reliability + resume, not speed** —
see memory `camera-transfer-reliability-over-speed`.

Two facts force this cycle:
- Every `cam snap` republishes a *different* image under the **same fixed pid**
  (`CAM_IMAGE_PID = 2`). `chunk.js:170` accepts a chunk on pid+count match, so a
  stale chunk from a previous capture (still echoing via the Omni) is accepted
  into the new image → CRC failure after reassembly. Measured: run 2 of the
  pacing test.
- Resume is impossible while a pid does not stably identify specific bytes. The
  same fixed-pid problem is the blocker.

Both are solved by making the pid identify the content.

## 2. Change 1 — content-derived pid (device, `pac-garage-alarm/src/main.cpp`)

On `cam snap`, after `capture()` + `refresh()`, derive the pid from the image
CRC the camera already reports (`g_cam.crc()`), instead of the constant 2:

```
uint32_t crc = g_cam.crc();
uint16_t pid = (uint16_t)(crc ^ (crc >> 16));   // fold to 16 bits
if (pid == 0 || pid == TEST_IMAGE_PID) pid ^= 0x8000; // avoid reserved 0 and 1
g_chunks.publishSource(pid, mtchunk::PT_IMAGE, g_cam);
```

- **Content-derived, per Peter's approval.** Same image → same pid (idempotent
  resume); different image → different pid (no stale-chunk pollution). No
  cross-reboot persistence needed, unlike a monotonic counter.
- **Reserved pids:** 0 (protocol default / "none") and 1 (`TEST_IMAGE_PID`, the
  embedded image) must never be produced by derivation — remap if hit.
- **16-bit fold of a 32-bit CRC** can collide between two *distinct* images
  (~1/65536). The manifest still carries the full 32-bit CRC, so an actual
  wrong reassembly is still caught; a collision at worst makes one resume start
  fresh. Acceptable given capture frequency.

`mt-chunk` needs **no change**: `publishSource(pid, …)` already takes the pid and
stores it. The `_highWater` GONE-vs-NOSUCH split assumes monotonic pids, so with
content pids it may occasionally label a never-seen pid GONE instead of NOSUCH —
**cosmetic only** (both mean "not available"), noted, not fixed here.

## 3. Change 2 — persist partial progress (client, `lib/store.js`)

Add alongside the existing final-image `save()`:

- `savePartial(node, {pid, crc, count, len, have, buf})` — writes a `.part`
  buffer plus a `.part.json` sidecar `{pid, crc, count, len, have:[…]}`.
- `loadPartial(node, pid)` — returns the sidecar+buffer or null.
- `clearPartial(node, pid)` — removes both.

Keyed by node+pid. The sidecar carries `crc`/`count`/`len` so a resume can be
*rejected* if the manifest no longer matches (e.g. a 16-bit pid collision).

## 4. Change 3 — resumable fetch (client, `index.js` + `lib/chunk.js`)

`chunk.js`: give `ChunkClient` a `seed({buf, have})` that installs a prior buffer
and received-set **after** the manifest is accepted (the manifest handler
allocates fresh; seed replaces from disk only when identity matches).

`index.js fetch()`:
1. After the manifest arrives, if `loadPartial` matches the manifest's
   `pid+crc+count+len`, `seed()` the client with it — the pull loop then
   requests only the gaps (`requestNext` already pulls only missing runs).
2. Periodically (each window with new chunks) `savePartial` so an interruption
   loses at most one window.
3. On `verified`, `save()` the final image and `clearPartial`.
4. On GONE (pid evicted — the payload-identity fix already returns this), fail
   the resume cleanly and `clearPartial`: the bytes are gone, a stale partial is
   useless.

Keep the pacing robustness from `camera-fetch-stall` (already committed).

## 5. Tests (`test/run.js`, unit-level — no radio)

- pid derivation: a CRC folding to 0 or 1 remaps off the reserved values;
  distinct CRCs give distinct pids; equal CRCs give equal pids (idempotence).
- resume: given a partial with `have={0,2}` of count 4, a seeded client requests
  only {1,3} and, fed those, verifies. (Extract the derivation into a small pure
  function so it is testable without a device.)

## 6. Hardware verification (the real proof)

DEV1 `!8cee336b` bench only; OMNI `!2687afb1`, channel 2; field unit never
touched. Camera resettable via DTR/RTS on `/dev/ttyUSB0` (open `dtr=False`).

1. **Resume:** start a fetch, kill it mid-transfer, restart it — it seeds from
   the partial, pulls only the gaps, and the final CRC matches the camera's own.
2. **No cross-capture pollution:** two `cam snap`s in a row, fetch each — both
   CRC-match, no "CRC failed after reassembly". This is what run 2 failed.
3. **Reliability:** ≥3 consecutive clean fetches (each its own capture/pid).

A CRC match is the pass criterion; "an image appeared" is not.

## 7. Not in scope

- Device payload retention beyond one image (`publishSource` still holds one).
  Captures are rare; resume within one image's lifetime is the requirement.
- `_highWater` GONE/NOSUCH labelling under non-monotonic pids (cosmetic).
- The deployed-unit CSMA root fix (`adopt-meshtastic-csma`, BUG 14) — separate.
- `main` branch of `pac-garage-alarm` stays `deploy-2026-07-19`.
