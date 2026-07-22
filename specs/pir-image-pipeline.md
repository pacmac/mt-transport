---
task: pir-image-pipeline
status: IN PROGRESS 2026-07-21. Queue (ESP32) built + proven via serial console.
        §7 UART transport BUILT on both sides and LAYER-1 VERIFIED on air: the raw
        0x55->0xAA ping returns AA (camu ping), so the wire + RX/TX orientation
        (camera RX=13/TX=4) are correct. Framed COUNT/CAP and the full snap->xfer
        pipeline NOT yet verified. Hardware: debug adapter removed, camera on RAK
        Serial1 (15/16) — see device-comms.md 2026-07-21.
priority: HIGH — this is how images actually get taken; the manual path is the test rig
source_hash: ~
scope:
  - projects/timercam-chunk/src/main.cpp          # ESP32 queue + split commands
  - projects/pac-garage-alarm/src/CamQueue.h      # NEW — nRF client (UART transport, I2C fallback)
  - projects/pac-garage-alarm/src/main.cpp        # PIR -> snap, drain loop, counters, status flag
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

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

## 4a. CORRECTION — deep sleep destroys the queue; sleep must be tiered

**Found in Phase 3, not Phase 1 — my error.** §3/§4 assume the ESP32 holds images across
sleep. It cannot, as written: the queue lives in **PSRAM** (`CAMERA_FB_IN_PSRAM`) and the
camera sleeps via **`esp_deep_sleep_start()`**, which powers PSRAM down. Only the 8 KB+8 KB
RTC domain survives — far too small for a 2–15 KB image. So `snap → deep sleep → xfer`
loses the image at the sleep, and "the ESP32 is the durable store" (§4) is false for a
store that evaporates on sleep.

**Fix (Peter's call: my instinct, taken): tiered sleep.**

| Queue state | Sleep mode | Current | Why |
|---|---|---|---|
| **empty** | deep (`esp_deep_sleep_start`) | ~10 µA | nothing to lose; PSRAM may power down |
| **holding ≥1 image** | light (`esp_light_sleep_start`) | **UNMEASURED** (~0.8 mA datasheet-class, not measured on this bench) | RAM+PSRAM retained; execution resumes in place |

Light sleep retains PSRAM and returns after the call (no reboot), so the queue survives.
`ext0` on SCL and the G33 power-latch both work unchanged in light sleep.

**The tail risk this creates, and its bound.** Light sleep is cheap for the normal case —
the nRF uploads within minutes of the detection packet, so an image is held only briefly.
But if the link is down, holding in light sleep for *days* at ~0.8 mA (~19 mAh/day) would
flatten a small cell — the opposite of the power win. So: a **max-hold timeout**
(provisional 2 h, matching the nRF-side retention deadline). When it expires the ESP32
drops the held image and returns to deep sleep. Better to lose one image than the node.
If the nRF still advertises it, the next `xfer` returns "no image" — already a handled
case.

**HONEST, UNMEASURED:** the ~0.8 mA light-sleep figure is datasheet-class, not measured —
this bench has no ammeter. The max-hold value depends on it, so both are provisional until
measured on Peter's hardware. Recorded rather than asserted.

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

## 7. TRANSPORT: camera link on UART — BUILT, layer-1 verified 2026-07-21

**Decision (Peter, 2026-07-21): the camera moves off the shared I2C bus onto `Serial1`.**
**Status: implemented on both sides and the physical link is proven.**

- **Frame:** `[0x7E][len][payload][crc16-CCITT]`, both directions. UART has no
  addressing/ACK, so length + CRC do that job. A raw `0x55` outside a frame echoes
  `0xAA` — the link/pin test, independent of framing.
- **Wiring (verified):** RAK `Serial1` RX=15/TX=16 ↔ camera Grove; camera side
  `CAM_UART_RX=13 (G13)`, `CAM_UART_TX=4 (G4)`. `camu ping` → `AA` on the first try,
  so no swap was needed. If a future rebuild pings wrong, flip `CAM_UART_RX/TX`.
- **Builds:** `-DCAM_UART` on both (`timercam_uart`, `rak4631_camuart`); the default
  envs keep I2C + Serial1-debug as the fallback. `DBG` drops its Serial1 mirror under
  the flag so debug text never clocks at the camera.
- **Verbs:** `camu ping | count | cap` on the nRF drive the framed client.
- **Verified 2026-07-21:** `ping`→`AA` (raw link); `count`→framed 1-byte reply;
  `cap`→a real capture over UART, framed INFO `st=1 len=3329 crc=96D1BCEC`. So the
  wire, the framing (len+crc16), and a capture command all work end to end.
- **NOT yet verified:** framed `SEEK` (bulk read of image bytes), and the full
  snap→xfer→publish→push pipeline. That is the next step.

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

## 10a. PHASE-2 DIFFS — ESP32 queue (THIS CYCLE = step 2 only)

Scope this cycle: **`projects/timercam-chunk/src/main.cpp` only.** UART transport (§7,
needs rewiring) and the nRF drain loop are separate cycles. This one is backward-compatible
and testable over the proven I2C link.

### The constraint that shapes it

`cameraInit()` sets `c.fb_count = 1` (line 188). `g_fb` is a pointer into the driver's
one-deep frame-buffer pool, and `capture()` calls `releaseFrame()` before every grab. So a
queue **cannot** hold `camera_fb_t*` — the next capture needs that buffer back. The queue
holds **our own PSRAM copies** of the JPEG bytes; the fb is returned immediately after copy.

### Backward compatibility is mandatory

`M5CameraSource` (mt-chunk, deployed, un-reflashable) speaks `INFO/CAPTURE/SEEK/SLEEP` and
is the only proven path. It does capture → INFO → SEEK, reading the frame it just took. So:
**`CMD_CAPTURE` pushes to the queue AND selects the new entry**, and INFO/SEEK operate on
the *selected* entry. The existing flow then behaves exactly as today; the queue is
invisible to it.

### New state (replaces the single-frame globals)

```c
// A queue of image COPIES in PSRAM. Not camera_fb_t* — fb_count=1, so the driver
// reclaims its one buffer on the next capture. Bounded by ENTRY COUNT, not by a
// free-PSRAM measurement, so it cannot exhaust memory regardless of image size.
struct CamImage {
    uint16_t id;        // == mesh pid; 0 = empty slot
    uint32_t len;
    uint32_t crc;
    uint8_t *buf;       // heap_caps_malloc(MALLOC_CAP_SPIRAM), owned by this slot
};
static const uint8_t CAM_QUEUE_MAX = 8;   // ~3/day with bursts; 8*15KB = 120KB of ~3MiB
static CamImage g_q[CAM_QUEUE_MAX];
static int      g_sel = -1;   // index of the SELECTED image, or -1
static uint16_t g_nextId = 1; // fold of crc; see idFromCrc()
```

`g_fb`, `g_crc`, `g_status` as *frame* state go away; `g_status` stays only as the reply
byte, computed from `g_sel`.

### New commands (added; existing four unchanged in wire shape)

```c
enum Cmd : uint8_t {
    CMD_INFO    = 0x01,  // -> status(1) len(4) crc(4) of the SELECTED image
    CMD_CAPTURE = 0x02,  // capture, push, SELECT the new one (back-compat)
    CMD_SEEK    = 0x03,  // read from the SELECTED image (unchanged logic)
    CMD_SLEEP   = 0x04,
    CMD_COUNT   = 0x05,  // -> n(1) : how many images queued
    CMD_SELECT  = 0x06,  // id(2) -> status(1) : make that image current
    CMD_DROP    = 0x07,  // id(2) -> n(1) : free it, reply new count
};
```

`0x05-0x07` are unused today, so an old `M5CameraSource` never sends them and a new nRF
client never sends them to old firmware without first checking (that check is a later
cycle). The block stays clear of any existing value.

### `capture()` → `captureToQueue()`

```
- releaseFrame(); warm-discard; g_fb = get(); crc; g_status = READY
+ warm-discard; fb = get(); if(!fb) return err
+ id = idFromCrc(crc(fb))                      // content-derived, matches camPidFromCrc
+ slot = free slot, or EVICT OLDEST (free its buf, count a drop)
+ slot.buf = heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM)
+ if(!slot.buf) { esp_camera_fb_return(fb); return err }   // do NOT crash; report
+ memcpy(slot.buf, fb->buf, fb->len); slot.len/crc/id set
+ esp_camera_fb_return(fb)                      // fb released IMMEDIATELY
+ g_sel = slot                                  // back-compat: new image is current
```

`idFromCrc` must fold the 32-bit CRC to 16 bits the SAME way `camPidFromCrc` does on the
nRF (skip 0 and 1), so the id the camera assigns equals the mesh pid — verified by
comparing the two implementations, not assumed.

### `CMD_SEEK` — one-line change

Validate and read against `g_q[g_sel]` instead of `g_fb`. The slaveWrite / FIFO staging
(the hard-won one-read-lag fix, lines 296-303) is **untouched** — only the source pointer
and length change from `g_fb->buf/len` to `g_q[g_sel].buf/len`.

### Tiered sleep (§4a) — this cycle, because the queue is useless without it

`goToSleep()` splits by queue state:
```
+ if (queueCount() == 0) {
+     ... existing ext0 arm ...
+     esp_deep_sleep_start();              // 10 uA, PSRAM may drop; nothing to lose
+ } else {
+     ... same ext0 arm ...
+     esp_light_sleep_start();             // RAM+PSRAM retained, RETURNS here
+     // resumed by SCL activity; fall back into loop() and serve
+ }
```
Deep sleep still reboots into `setup()`; light sleep returns in place, so `loop()` must
tolerate both. The **max-hold timeout** (§4a) is checked in `loop()`: if the oldest held
image has aged past `MAX_HOLD_MS`, drop it (count it) and, if the queue empties, deep sleep.

### Remove capture-on-wake (the power defect)

```
- if (cause == ESP_SLEEP_WAKEUP_EXT0) g_wantCapture = true;
+ // Do NOT capture on wake. On a SHARED bus EXT0 means only "someone talked to
+ // some device"; the nRF sends CMD_CAPTURE explicitly when it wants a frame.
+ (void)cause;
```

### Explicitly NOT touched in this file, this cycle

- The `slaveWrite`/FIFO staging in `CMD_SEEK` — the race fix. Source pointer only.
- `crc32Buf`, `cameraInit`, `goToSleep`, `PIN_BAT_HOLD` latch — unchanged.
- Serial console — `d`/`i` gain "of the selected image" semantics for free via `g_sel`.

### Not in this cycle, named so it is not forgotten

- **nRF side** (`CamQueue.h`, `main.cpp`): the client that sends COUNT/SELECT/DROP and the
  two-hop DROP-after-mesh-COMPLETE handshake. `cam grab` stays as-is until then.
- **UART transport** (§7): needs rewiring; I2C stays the path.
- **`up`/`upst` periodic frame** (§6): the auto-upload trigger.

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
