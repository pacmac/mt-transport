---
task: pir-image-pipeline
status: proposed 2026-07-21 — design agreed with Peter, NO CODE YET
priority: HIGH — this is how images actually get taken; the manual path is the test rig
source_hash: ~
scope:
  - projects/timercam-chunk/src/main.cpp          # ESP32 queue + split commands
  - projects/pac-garage-alarm/src/CamQueue.h      # NEW — nRF client for the extended I2C set
  - projects/pac-garage-alarm/src/main.cpp        # PIR -> snap, drain loop, counters, status flag
---

# Spec: pir-image-pipeline — the camera pipeline as it will actually be used

## 1. The correction this spec exists for

Everything built so far assumes a human asks for an image. **That is the test rig, not the
product.** Peter:

> *"snap can be initiated manually, but it would normally be triggered by a PIR detection.
> And realistically once the device has sent the motion detection packet, it would then
> automatically upload the image."*

So the real flow is: **PIR fires → detection packet goes out → image uploads by itself.**
Nobody is present. That invalidates two things already built:

- **`cam grab` does capture AND bulk-read in one operation**, so the camera stays awake for
  the whole nRF transfer, and a second trigger during an upload has nowhere to go.
- **`publish()` supersedes**, so a trigger arriving mid-upload **destroys the transfer in
  flight**. On a busy evening that is the failure that matters: high activity is exactly
  when the pictures are wanted, and every one would be lost while each looked fine
  individually.

## 2. Measured, not assumed — this sizes everything

From `detection_events` in node-dash's own database (passive history, no transmission):

| Node | Detections | Period | Rate |
|---|---|---|---|
| 2558179343 (FIELD) | 6 | 18–19 Jul | **~3/day** |
| 2364420971 (bench) | 43 | 18–20 Jul | 39 in one day — bench testing |

**~3 qualified detections/day in the field, with bursts to ~40.** Power at that rate,
using the measured 4.2 s cycle at ~150 mA:

| | per event | at 3/day |
|---|---|---|
| snap (wake, capture, sleep) | 0.071 mAh | 78 mAh/yr |
| transfer (wake, bulk-read, sleep) | 0.146 mAh | 160 mAh/yr |
| **both** | 0.22 mAh | **~237 mAh/yr** |

Comfortably affordable from the nRF's battery. An earlier estimate of 50/day (3,200 mAh/yr)
was invented; the real rate is ~17× lower.

**Caveats, because two days is a thin sample:**
- Enough to rule out "50/day", not enough to characterise seasons, weather, or a hedge in
  wind. Let `detection_events` accumulate for a fortnight before fixing a power budget.
- It counts packets that ARRIVED. At ~17% uplink loss the true rate is likely ~20% higher
  (3.5–4/day). An undercount, so the conclusion holds.
- **Bursts are real** (39 in a day on the bench). The average justifies the power; the
  burst justifies the queue.

## 3. Split `snap` from `transfer`

```
PIR fires   -> cam snap    wake, capture into the ESP32 queue, sleep     ~1.7 s
nRF is free -> cam xfer    wake, bulk-read ONE image into nRF RAM, sleep ~3.5 s
```

Three consequences, all good:

- **Per-trigger camera time drops ~60%** (1.7 s vs 4.2 s) — the 2.5 s bulk read no longer
  happens per trigger.
- **The bulk read happens once per upload, not once per trigger** — nothing is paid for
  images that are never sent.
- **A trigger during an upload becomes a non-event.** The camera snaps, queues, sleeps; the
  nRF is not involved and its in-flight transfer is untouched. This kills the supersession
  hazard at the root rather than mitigating it.

## 4. THE TWO-HOP HANDSHAKE — the part worth getting right

**The ESP32 drops an image only after the MESH transfer completes** — not when the nRF has
it in RAM.

That makes the **ESP32 the durable store** and the **nRF's RAM copy a working buffer**.

It solves a gap that already cost us: last night a `pm2` restart on the receiver destroyed
an in-flight transfer — 20 chunks and ~70 s of airtime, unrecoverable, because
`PushReceiver` holds chunks in memory. With the ESP32 still holding the original, an nRF
reboot costs one `cam xfer` (3.5 s, no radio) instead of the image.

It is the **same handshake at both hops, for the same reason**:

| Hop | Holder | Releases when |
|---|---|---|
| ESP32 → nRF | ESP32 queue | mesh transfer confirmed |
| nRF → gateway | nRF `g_push` | receiver sends `COMPLETE` |

In both cases **the party that cannot verify delivery refuses to discard until the party
that can says so.** That principle has already earned its keep twice: it is why `COMPLETE`
releases the device buffer, and why a short I2C read fails rather than pads.

Affordable precisely because storage is abundant: PSRAM measured at **4 MiB**
(`psram=4194304` — note the firmware comment claiming 8 MB is wrong), ~3 MiB usable, so
~430 images at 7 KB. Even a week of failed uploads fits.

## 5. Queue and command set

ESP32 holds a ring of images in PSRAM, each with an id, length and CRC. The id **is** the
mesh pid, derived from the image CRC (`camPidFromCrc`) so it is content-unique with no
persistent counter — see `MtChunk.h` on why a restarting counter is dangerous.

I2C command set grows by four:

| Command | Meaning |
|---|---|
| `CMD_CAPTURE` | snap into the queue, return the new id (does NOT transfer) |
| `CMD_COUNT` | how many images are queued |
| `CMD_SELECT <id>` | make one current for reading |
| `CMD_SEEK/READ` | existing, now scoped to the selection |
| `CMD_DROP <id>` | release — **only after the mesh transfer completes** |

**Remove capture-on-wake.** Today:
```c
// Woken by the RAK => it wants a picture.
if (cause == ESP_SLEEP_WAKEUP_EXT0) g_wantCapture = true;
```
That was sound on a private bus. On a **shared** bus it is false — `EXT0` means "someone
talked to some device", and the BME680/SHTC3 are polled every 30 min, so every sensor read
costs a boot, a `cameraInit()` and a full capture, after which the camera **never sleeps
again**. Measured: sleeps at 7.15 s, wakes at 7.18 s with `wake=2` (EXT0), captures again
at 8.38 s.

## 6. Auto-upload trigger — `up`/`upst` in the PERIODIC status frame

Without it nothing starts unless a human presses something, which defeats the entire
pipeline. The device advertises "I hold pid N"; the receiver notices and drives the
transfer.

This also settles START ownership cleanly: **the device advertises, the receiver
initiates.** The device never streams into a void, and the receiver is by definition
present and listening when it starts.

Note the same "do not substitute" rule produces **opposite** behaviour in the two modes,
and that is not a contradiction:
- **Manual Start with an explicit pid** → refuse a mismatch. A human asked for something
  specific; quietly serving something else is the substitution bug.
- **Automatic upload** → there is no stated intent to override. Take what the device
  advertises.

## 7. Power switching (hardware, needs Peter)

Only SDA and SCL are exposed on Grove, and **both toggle on any I2C traffic**, so no wake
pin can distinguish a real request. Cutting power removes the question entirely: an
unpowered camera cannot be woken by sensor traffic, and the 10 µA sleep drain goes to zero.

Two hardware constraints:
1. **An nRF52 GPIO cannot power the camera** — ~14 mA drive vs 100–200 mA draw. It must
   drive a **load switch** (P-MOSFET or switch IC), sized for inrush.
2. **An unpowered I2C slave can clamp the shared bus.** With VCC at 0 V and SDA/SCL still
   pulled up, current flows through the ESD/body diodes into the dead rail and can hold the
   lines down — **breaking the BME680 and SHTC3**. That would turn a camera power fix into
   a sensor outage and be blamed on something else. Options: separate I2C bus for the
   camera, series resistors/isolator, or switch SDA/SCL with power.

## 8. Counters (so a burst is visible)

`captured / transferred / uploaded / dropped / skipped`, in the status frame. A busy night
must show up as a number rather than as silence — the same reason `badStarts` diagnosed a
refused START in ninety seconds instead of being blamed on the radio.

## 9. Explicitly NOT in scope

- **`mylibs/mt-chunk/**`** — untouched. It is the deployed protocol on hardware that
  cannot be reflashed. The nRF-side client for the new commands is a NEW local file
  (`CamQueue.h`), not an edit to `M5CameraSource`.
- **Sophisticated upload policy.** At 3/day you send them all. "Which image wins" only
  becomes interesting during a burst, and the counters will show whether that ever happens.
- **Receiver-side persistence** (`PushReceiver` losing chunks on restart) — still a real
  gap, but the two-hop handshake reduces its cost from "image lost" to "re-fetch 3.5 s".

## 10. Verify — layered, bottom-up

1. **I2C alone** — new commands answer with the camera on the bench, no radio.
2. **Queue alone** — capture 3, count == 3, select/read each, drop one, count == 2.
3. **Capture-on-wake removed** — poll the BME680 and confirm the camera does NOT capture
   and DOES go back to sleep. This is the power defect; it must be shown, not assumed.
4. **Single image end-to-end** — PIR (or simulated) → snap → drain → push → CRC-verified.
5. **Burst** — fire several triggers DURING an upload; the in-flight transfer must complete
   and the new images must be queued, not lost.
6. **nRF reboot mid-transfer** — must resume by re-fetching from the ESP32, not lose the
   image. This is what §4 exists for.
