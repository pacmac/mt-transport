---
task: camera-push
status: proposed 2026-07-21 — I2C link and capture PROVEN; bulk-grab not yet built
priority: HIGH — Layer B; the first real image over push
source_hash: ~
scope:
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: camera-push — snap, bulk-grab to RAM, power the camera down, then push

## 1. The architecture, and the one I got wrong first

**Peter's design:** snap → **bulk-transfer the whole image over I2C into the nRF** →
**power the ESP32 down** → push to the mesh from the nRF's local copy.

I was about to build `g_push.publishSource(g_cam)` — pushing straight from the camera,
one I2C window per chunk. That is wrong on three counts, and they are the reasons the
design exists:

- **Power.** It keeps the ESP32 — the power hog — alive for the entire multi-minute mesh
  upload, when it only needs to be awake for a few seconds of capture and bulk read.
- **Reliability.** It puts an I2C round trip (9 pieces of 28 bytes for a 226-byte window)
  in the middle of *every* chunk send, so an I2C hiccup becomes a mesh-transfer failure.
- **Resume.** A per-chunk source cannot survive the camera sleeping; a local copy can be
  re-pushed for as long as the nRF holds it.

## 2. It also makes the work SMALLER — both Phase 1 blockers vanish

Phase 1 found two blockers for the serve-per-chunk approach. Bulk-grab removes both:

| Phase 1 blocker | Under bulk-grab |
|---|---|
| `g_cam` is `mtchunk::IPayloadSource`, `g_push` needs `mtchunkpush::IPayloadSource` — an adapter is mandatory | **No adapter.** `publish(pid, type, buf, len)` takes a plain buffer. No source object is involved. |
| `M5CameraSource::read()` clamps `len` to mt-chunk's `CHUNK_DATA_MAX` (224); push asks 226, gets a short read, and the engine **correctly refuses to pad** → every full chunk fails, `sf` climbs | **Irrelevant.** The clamp only binds when the protocol drives reads per chunk. A bulk read loops at any piece size. |

`mylibs/mt-chunk/**` therefore stays **untouched** — it is the deployed protocol on an
un-reflashable field unit, and coupling it to this would have been the wrong risk.

## 3. Evidence this is built on (measured today, not assumed)

- **I2C link proven by A/B**, which is the only reason it is trustworthy:
  ```
  unplugged : {"st":251,"len":4294967295,"crc":"FFFFFFFF","ok":true}   <- bus floating
  plugged   : {"st":2,  "len":0,         "crc":"00000000","ok":true}   <- ST_NOFRAME
  ```
- **Capture works:** `{"pid":12651,"len":2267,"n":11,"crc":"93B8A2D3"}`, fetched off the
  device and verified from disk — `FFD8..FFD9`, JPEG 320x240 baseline, CRC matches. The
  image is a flat grey field (lens facing a blank surface), which is why 2267 bytes.

## 4. DEFECT FOUND, and it must be fixed here

**An absent camera reports success.** With nothing connected, `cam info` returned
`ok:true` with `st=251`, `len=0xFFFFFFFF`, `crc=0xFFFFFFFF` — all-ones is what a floating
bus reads — and **`cam diag` counters stayed at zero**, so the failure was not even
counted.

Only because 251 is outside the enum (`ST_IDLE=0, ST_READY=1, ST_NOFRAME=2, ST_ERROR=3`)
was it visible at all. A garbage value landing in 0..3 would have looked genuine.

**Consequence if unfixed:** `capture()` "succeeds", we publish a payload of length
4294967295, and the push engine computes a chunk count from garbage. The diagnosis then
happens over the air at 2 s per frame.

**Fix (in main.cpp, at the point of use — NOT in mt-chunk):** treat a reply as valid only
if `st <= ST_ERROR` **and** `len` is within the buffer bound. Otherwise report an explicit
error rather than `ok:true`.

## 5. Local copy: RAM, not flash — decided, with what it does not cover

`static uint8_t g_camBuf[CAM_BUF_MAX]` in nRF RAM.

- LittleFS is **28 KB total and near-full** (settings + bootlog), so an image does not fit
  there at all. Flash persistence would need a dedicated region or a repartition.
- nRF RAM: 248 KB total, ~21.5 KB used by this firmware. A 32 KB buffer is affordable.
- The nRF is always-on and rarely reboots, so RAM covers the case that actually occurs:
  the ESP32 sleeping, the radio being busy, a transfer taking days of retries.

**What RAM does NOT cover:** an nRF reboot loses the image. Accepted for now, recorded
rather than hidden. Flash persistence is a separate decision needing a partition change.

## 6. Change (`main.cpp` only)

1. `static uint8_t g_camBuf[CAM_BUF_MAX];` + `g_camLen`, `g_camCrc`.
2. New verb **`cam grab [pid]`**:
   - `wake()` → `capture()` → `refresh()`
   - **validate** status and length (§4) — bail with an explicit error if implausible
   - bulk-read `len` bytes into `g_camBuf` in a loop
   - **verify CRC of the RAM copy against the camera's reported CRC** — a bulk read that
     silently short-reads must fail here, not after a three-minute mesh transfer
   - `g_cam.sleep()` — **the camera is off from this point**
   - `g_push.publish(pid, PT_IMAGE, g_camBuf, g_camLen)`
   - reply with pid, len, crc, chunk count, and that the camera is asleep
3. Keep `cam snap` unchanged (it publishes to the pull server) so nothing that works today
   is taken away.
4. `FW_VERSION` bump.

## 7. Verify

1. **Static** — `cam grab` present; `g_push.publish` called with the RAM buffer.
2. **L0** — `cam grab` with the camera UNPLUGGED must report an explicit error, not
   `ok:true`. This is the §4 defect and it is the check that matters most.
3. **L1** — `cam grab` plugged: RAM CRC == camera CRC, camera asleep afterwards.
4. **L2** — `Client.push()` fetches the real image, CRC-verified from disk, and it decodes
   as a JPEG. Note the payload size now VARIES per capture, so chunk count and tail length
   vary — the first time that has been true.
5. **Regression** — `cam snap` + pull still work; the test image still pushes.
