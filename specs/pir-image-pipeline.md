---
task: pir-image-pipeline
status: proposed 2026-07-21 — design agreed with Peter, NO CODE YET
priority: HIGH — this is how images actually get taken; the manual path is the test rig
source_hash: ~
scope:
  - projects/timercam-chunk/src/main.cpp          # ESP32 queue + split commands
  - projects/pac-garage-alarm/src/CamQueue.h      # NEW — nRF client (UART transport, I2C fallback)
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

## 7. TRANSPORT: move the camera link to UART (chosen) — I2C kept as fallback

**Decision (Peter, 2026-07-21): the camera moves off the shared I2C bus onto `Serial1`.**

### Why this beats power-switching

Power-switching bolts a MOSFET on to work around a bus we should not be sharing. A private
UART means the camera was never on that bus — and it is faster and lower-power as a side
effect. Two of the three hardware problems simply cease to exist:

- **No false wakes.** The line is private, so `EXT0` on RX (start bit pulls it low) means
  exactly one thing: "the nRF is talking to me." BME680/SHTC3 polling is invisible to it.
- **No load switch** (a GPIO cannot source 150 mA) and **no unpowered-slave bus clamping**
  — the failure that would have broken the sensors and been blamed on something else.

### What it costs: almost nothing

```c
// Serial1 is the hardware UART on pins 15/16 (UARTE0), independent of VBUS.
#define DBG(...) do { Serial.printf(...); Serial1.printf(...); } while (0)
```
- `Serial` (USB CDC) — bench debug, dead in the field (no VBUS).
- `Serial1` — works on battery, **but only if something is physically attached to listen.
  Nothing is attached at the garage.**

So `Serial1` output in the field goes to nobody, while the enabled UARTE costs power —
which `main.cpp:45-47` already warns about ("an enabled UARTE is NOT free... 30 uA
target"). Bench debugging is unaffected because `Serial` over USB still carries everything.

### Speed and power

Current bulk read: 2.5 s for 2255 B ~= 900 B/s, throttled by 28-byte I2C pieces with settle
delays. UART at 115200 = 11.5 KB/s -> ~0.2 s; at 460800, ~0.05 s.

| | I2C (today) | UART |
|---|---|---|
| camera cycle | 4.2 s | **~1.9 s** |
| at 3/day | 237 mAh/yr | **~87 mAh/yr** |

### Build-flag switch, so I2C stays a working fallback

`Serial1` cannot be both a debug port and the camera link, so the choice is a compile-time
flag rather than a deletion — the I2C path keeps its UART debugging and stays buildable:

```c
#ifdef CAM_UART          // Serial1 is the camera link, not a debug port
#  define DBG(...)  do { Serial.printf(__VA_ARGS__); } while (0)
#else
#  define DBG(...)  do { Serial.printf(__VA_ARGS__); Serial1.printf(__VA_ARGS__); } while (0)
#endif
```

### Work this actually adds, stated honestly

- **Framing.** I2C gives addressing and per-byte ACK for free; UART gives neither. Needs
  length-prefixed frames with a CRC. Modest — everything is CRC'd already — but it is real
  protocol work, not a transport swap.
- **Wake still uses `ext0` on RX**, because UART wake is a LIGHT-sleep source on the classic
  ESP32, not a deep-sleep one. Same mechanism as today; the difference is that the line is
  private, which is the whole point. The first byte after wake will be lost during boot, so
  the nRF still sends a wake preamble, waits, then sends the command.
- **REWIRING.** Grove currently goes to the RAK's I2C pins; it must go to 15/16 instead,
  TX<->RX crossed. G4/G13 on the camera are fine as UART pins.

### I2C fallback, retained deliberately

The I2C path is not deleted. It works today and is the only thing proven on air, so it
stays behind the flag until UART has passed the same layered verification (section 10).

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
