---
task: radio-wedge-recovery
status: active
source_hash:  # steps 1-3 implemented; steps 4-5 outstanding
  src/MeshtasticTransport.cpp: 8ad08d9fafc0253c6262a323a03b7b86fb50bec250fd1d897ee669f282123a35
  src/MeshtasticTransport.h: 86a43bc2cfbfca4dd846d1423fed6bf9b1400e05843994169f3994c021d8d7cf
  ../pac-garage-alarm/src/main.cpp: 2fbd567ebac65cb6981fdfbc486c4b16a939fcfa42b1e247e1cbdb07bbd08a76
# Baseline moved: this spec was written against MeshtasticTransport.cpp @ 0.4.0
# (fdbc359c…). Commit 7b1048a (airtime-accounting-fixes step 1) then added the
# transmitFrame() choke point, making the file 3018154f… before step 1 of THIS
# task began. That is the intended order — see the priority note below.
updated: 2026-07-18
priority: >
  CORRECTED 2026-07-18. Was "ahead of airtime-accounting-fixes", but this
  task's own Design section says transmitFrame() "land[s] naturally in the
  airtime-accounting-fixes step 1 helper — do that helper first; the two tasks
  share it." The stated priority contradicted the design. Resolution: 529
  step 1 lands first (done, 7b1048a), then all of 530, then 529 steps 2-7.
---

# Spec: radio-wedge-recovery — a mute node must reset itself

## Incident

DEV1, deployed remote. `@sleepfor 15` was sent at 15:26:46 and acknowledged
(`{"type":"sleepfor","secs":15}`, gateway message log). The node was last heard
at 15:54:11 (`{"type":"pong","upt":5173,"rssi":-121,"snr":-13.2}`), then never
again, and required a physical power cycle. Green LED observed lit. This is the
failure mode that makes an unattended node unrecoverable, and GARG is an hour's
drive with no OTA — it must not ship there.

> **Corrected 2026-07-18:** an earlier draft of this spec said `@sleepfor 900`.
> The gateway log shows the only sleepfor DEV1 ever acknowledged was **15 s**.
> The wrap-safety analysis below is unaffected (it holds for any value in the
> 5–3600 s clamp), but do not reason from a 15-minute sleep that never happened.
> Note the implication: the node survived **at least 27 minutes** of normal
> post-sleep running before going mute — the failure is not at the wake edge.

## What the incident rules out

Established by reading source, not inference:

- **Sleep duration / overflow.** `@sleepfor` clamps 5–3600 s
  (`main.cpp:789`); `doSleep(900000)` and its `(int32_t)(end - millis())`
  guard are wrap-safe.
- **`heartbeatMs - SLEEP_WINDOW_MS` underflow** (`main.cpp:1067`). All three
  writers clamp to ≥30 000 ms (`:708` `@interval`, `:855` `applySet`, `:170`
  `loadSettings`) against `SLEEP_WINDOW_MS = 8000`. Cannot underflow.
- **Radio unable to wake.** `SX126x::sleep()` is warm-start with config
  retained (`SX126x_commands.cpp:47`), and `startReceive()` → `stageMode()` →
  `standby()` issues the NOP that pulls NSS low to exit sleep (`:74-80`).
- **A plain CPU wedge.** WDT is 30 s with `CONFIG.SLEEP` set so it counts
  through `__WFE`, and is unstoppable once started (`main.cpp:232-238`). Any
  hang that stops feeding it resets the node inside 30 s and it would have
  returned.

**Therefore the node was feeding the watchdog throughout.** The MCU was alive
and looping; the radio was mute or deaf underneath it. Root cause of the radio
failure is still unknown — this task does not claim to fix it.

### RETRACTED 2026-07-18: the lit LED was the operator, not a stuck PIR

Peter reports he was **continually triggering the sensor** while standing at
the unit during the site visit, and observed the same steady green on the HOME
unit while doing so. `:1124` drives the LED from the raw PIR line, so a lit LED
during a site visit is the expected, mundane result of a person being in front
of the sensor.

**Consequence: the "stuck PIR" leading candidate below loses its only
evidence.** The alarm-storm mechanism remains real as a latent bug (a
permanently-asserted line genuinely would fire every window), but there is now
**no observation supporting that it occurred**. The falsifiable prediction
(alarms every ~15 s with `trig`/`tot` flat) was never checkable — motion
alarms go out on `DETECTION_SENSOR_APP` and the gateway log retains only
replies.

Current working hypothesis instead: the **radio entered an unstable state**
while the MCU kept looping and feeding the watchdog. Note that `SPI` (the
SX1262) is bound to **`NRF_SPIM3`** (Adafruit core `SPI.cpp:272`, `_SPI_DEV`),
the instance carrying the documented VBUS/HFCLK dependency of Adafruit
issue #773 — on a node that runs from battery with no VBUS. Not demonstrated,
but a more specific lead than a stuck sensor. This does not change the design
below: the safety net is deliberately independent of root cause.

### The green LED is not a hang indicator

`main.cpp:1124` drives `LED_GREEN` directly from the raw PIR line
(`digitalRead(PIN_PIR) == PIR_ACTIVE`), every loop pass, in both sleep and
awake mode. A permanently-lit LED therefore means **the PIR line was stuck at
the active level**, not that execution froze mid-wake-phase. An earlier reading
of this spec had it the wrong way round.

Two follow-on facts:

- `pirIsr()` is `{ pirTriggers++; }` — no SPI, no I2C, no Serial. It cannot
  corrupt an in-flight radio transaction. The "ISR wedged the SX1262"
  mechanism is ruled out.
- The ISR is RISING-edge, so a line stuck at the active level generates no
  further edges: `pirTriggers` freezes, `doSleep`'s early-exit
  (`pirTriggers != pirAt`) never fires, and the PIR is silently dead while the
  node sleeps normally. Stuck PIR and mute radio are **two separate faults**
  unless a common cause (supply droop / brownout) took both — which would also
  explain why only a power cycle recovered it, since a POR is what clears an
  SX1262 fault state that warm-start standby cannot.

Neither rail is firmware-cycled: `PIN_PWR_EN` (37, radio) and `PIN_3V3S_EN`
(34, 3V3_S → SHTC3 + PIR) are set OUTPUT/HIGH once at `:936-939` and never
touched again. Any power-transition instability at the PIR was external, not
sleep-path sequencing.

### Leading candidate: stuck PIR → alarm storm → supply sag

Polarity, settled: the AM312 is **active-LOW** (`PIR_ACTIVE = LOW`, `:397`,
measured on air at 5ee92c1 via the `pir` debug field). `RISING` works because
it fires on pulse *release* — one edge per presence event. So LED lit = line
stuck LOW = **stuck asserted**.

The duration detector's response to a permanently-asserted line (`:1123-1150`),
verified by reading it:

- `pirActive` true on every 250 ms sample ⇒ 60 hits per 15 s window
- `g_motionMs = 15000 >= detectT (10000)` ⇒ `sendAlarmWithRetry()` **every
  window, indefinitely** — one send plus a queued resend 3 s later
- ⇒ 2 transmits / 15 s ≈ 7% sustained TX duty at SF11/BW250

**The brownout link is RETRACTED.** It assumed a Li-SOCl2 cell (high internal
impedance, passivation) — taken from a stale mcpp project description, since
corrected. DEV1 runs a **3200 mAh LiPo at ~90%**: low internal impedance, no
meaningful sag under a ~120 mA TX pulse, ~25 mA average draw during the storm
(days, not hours, to matter), and the cell was not flat on recovery. Nothing
about this battery supports a supply-sag explanation.

**So the alarm storm is a real bug but is NOT a demonstrated cause of the mute
radio.** It stands on its own merits: ~7% sustained duty, mesh spam, needless
drain. The radio failure remains unexplained.

Falsifiable prediction, still worth checking in existing telemetry — it
confirms or kills the stuck-PIR half independently of the radio question:

> motion alarms every ~15 s while `trig`/`tot` stay **flat** and `pir` reads
> **1** continuously

Alarms without edges is impossible in normal operation. If the frames before
the silence show it, the root fix is upstream of this whole task: the duration
detector must not treat a permanently-asserted line as perpetual motion (a
stuck-line sanity bound — assert-without-edges for N windows is a fault, not
motion). Raise that as its own task; do not fold it in here.

## Goal

Make that class of failure self-recovering and self-reporting, independent of
root cause. A node that has stopped transmitting must reset itself; the next
boot must say why it reset.

This is defence in depth, not a diagnosis. It converts "never heard from
again" into "gone for ~35 s, then reports DOG on boot".

## Findings this addresses

### W1 — the watchdog proves liveness, not function

`wdtFeed()` is called unconditionally at `main.cpp:1078` (loop), `:1010`
(doSleep) and `:1050` (RX window). It attests that the loop is spinning. It
attests nothing about whether a packet has left the antenna. "Alive but mute"
is exactly the state it cannot detect, and exactly the state that occurred.

### W2 — the wake error is discarded

`main.cpp:1016` calls `radio.standby()` for its side effect and drops the
return value. If the wake fails, nothing notices; every later `send()` fails
silently and returns false forever.

### W3 — mt-transport offers `sleep()` with no `wake()`

The library takes the radio down and provides no supported way to bring it
back or to ask whether it came back. The firmware improvises by reaching past
the abstraction to `radio.standby()` directly — which is how W2 happened. The
missing API caused the dropped error.

### W4 — `send()` collapses two unrelated failures into one `false`

`send()` returns false for an encode/size error and for a radio-level
transmit error alike. A caller cannot tell "your payload was bad" (a
deterministic app bug, resetting would loop) from "the radio is dead"
(reset is the correct response). The library knows the difference and
discards it.

## Design

### mt-transport (0.5.0 — additive API)

- `bool sleep()` — was `void`. Returns `_radio->sleep() == RADIOLIB_ERR_NONE`.
  Changing `void` → `bool` is source-compatible for callers that ignore it.
- `bool wake()` — `_radio->standby()`, set `_rxActive = false`, return whether
  the radio acknowledged. Closes W3; gives the firmware something to check.
- `uint32_t txFailStreak()` — consecutive **radio-level** transmit failures,
  cleared on the first success. Counts only `transmit() != RADIOLIB_ERR_NONE`;
  encode and size rejections never touch it (W4). Placing the counter in the
  library rather than the app is the point: the library is where the two
  failure kinds are still distinguishable.

All three land naturally in the `transmitFrame()` helper from
`airtime-accounting-fixes` step 1 — the same choke point that decides whether
to credit airtime decides whether to clear the streak. **Do that helper first;
the two tasks share it.**

### pac-garage-alarm

- `main.cpp:1016` — `radio.standby()` → `if (!mesh.wake()) { /* leave streak
  to trip the WDT gate */ }`. No bare radio calls behind the library's back.
- `wdtFeed()` becomes conditional: feed only while
  `mesh.txFailStreak() < TX_FAIL_LIMIT`. Past the limit, stop feeding and let
  the 30 s WDT reset the node.
  - Chosen over a wall-clock "no TX in N minutes" deadline because a streak is
    immune to config: `heartbeatMs` ranges to 24 h and `@sleepfor` to 1 h, so
    any wall-clock deadline would either reset the node mid-legitimate-sleep or
    be too slack to help. No sends attempted during sleep ⇒ no failures counted
    ⇒ deliberate deafness can never trip it.
  - `TX_FAIL_LIMIT = 6` — six consecutive failed transmits. CSMA fails open, so
    a busy channel still reaches `transmit()`; a streak means hardware, not
    contention.
- Reset reporting: **already implemented, no change needed.** `main.cpp:932`
  reads `NRF_POWER->RESETREAS` into `g_resetReason` and write-1-clears it;
  `:954` logs it and `:622` ships it in `broadcastDebug()` next to
  `g_bootCount`. An earlier draft of this spec specced this as new work — it
  was already there.

  **Consequence: the incident may already be diagnosable from telemetry.**
  Compare `g_bootCount` in the last debug frame before DEV1 went silent with
  the first after the power cycle. Jump > 1 ⇒ the WDT *was* firing and the
  node was boot-looping. Jump == 1 ⇒ it sat wedged with the watchdog fed,
  which is the deduction in this spec. Do this before writing any code.

  > **ATTEMPTED 2026-07-18 — BLOCKED, the comparison cannot be made.**
  >
  > - **After** the power cycle: `boot=1 rst=0 pir=0 mot=0 tot=2` (17:25:30,
  >   passive capture of `!8cee336b`). `rst=0` = clean POR; `boot=1` = it has
  >   not reset once since, so it is **not** boot-looping now.
  > - **Before** the silence: **no value exists.** The gateway log holds only
  >   command replies, not the periodic port-260 debug broadcasts that carry
  >   `boot`, and nothing was captured between 15:54:11 and the site visit.
  >
  > `GPREGRET2` lives in the always-on domain: it survives WDT and soft resets
  > — which is what makes it diagnostic — but is **cleared by loss of supply**.
  > The power cycle performed to recover the node destroyed the one value that
  > would have decided between "wedged once" and "boot-looping". The evidence
  > was erased by the recovery.
  >
  > **Therefore this gate cannot be satisfied for this incident.** Proceed on
  > the source-level deduction instead (WDT with `CONFIG.SLEEP` set ⇒ a CPU
  > hang self-resets in 30 s ⇒ the node was fed throughout). Treat the
  > conclusion as sound but unconfirmed by telemetry.
  >
  > **Prerequisite for the next incident:** persist `boot`/`rst` history to
  > flash (settings already use InternalFS) so a power cycle preserves the
  > reset record, and capture `@status` *before* power-cycling any unit.
  > Without that, every future field recovery destroys its own evidence.

  Also established 2026-07-18, bearing on the stuck-PIR half:

  - The falsifiable prediction (alarms every ~15 s with `trig`/`tot` flat and
    `pir` stuck at 1) **could not be checked** — motion alarms go out on
    `DETECTION_SENSOR_APP` and the gateway log retains only replies. It is
    neither confirmed nor killed.
  - A bench replica (identical firmware **and** hardware, BME680 fitted, on
    battery) was given one `sleepfor 15` then run normally: **45 min, uptime
    strictly increasing 1063 → 3763 s, zero reboots, zero silence.** Twelve
    rapid `sleepfor 5` cycles likewise produced 0 hangs in 2 × 12 attempts.
    The incident did **not** reproduce, so the trigger is something the bench
    is not exercising — most likely the deployed unit's link margin
    (−121 to −128 dBm, SNR −13 to −18.5 dB) rather than the sleep path itself.

## Step 1 — implementation (exact diffs)

**Scope: the two library methods only.** `txFailStreak()` is step 2; the
firmware changes (`mesh.wake()` call site, WDT gate) are steps 3-4. Step 1 is
purely additive API — it changes no behaviour on its own.

### src/MeshtasticTransport.h — `:96`

```diff
     bool busy() const { return false; } // transmit() is blocking; real once RX lands
-    void sleep();                       // radio only — CPU sleep is yours
+    // Radio only — CPU sleep is yours. Both return whether the radio
+    // acknowledged; a caller that ignores the result is back to W2.
+    bool sleep();
+    bool wake();
```

`void` → `bool` is source-compatible: `pac-garage-alarm:1006` calls
`mesh.sleep();` as a statement and keeps compiling untouched.

### src/MeshtasticTransport.cpp — replace `sleep()`, add `wake()`

```diff
-void MeshtasticTransport::sleep()
-{
-    _rxActive = false;
-    if (_radio)
-        _radio->sleep();
-}
+bool MeshtasticTransport::sleep()
+{
+    _rxActive = false;      // set BEFORE the radio call: a failure must never
+    if (!_radio)            // leave the flag claiming RX is still armed
+        return false;       // "no radio" is not "slept successfully"
+    return _radio->sleep() == RADIOLIB_ERR_NONE;
+}
+
+// Counterpart to sleep(), closing W3. RadioLib's no-arg sleep() is warm start
+// with config retained (SX126x_commands.cpp:47), so standby() alone brings the
+// radio back — no begin() re-init needed.
+//
+// The library offering sleep() with no wake() is what pushed the firmware into
+// calling radio.standby() directly and dropping its int16_t status (W2). The
+// missing API caused the discarded error, so the fix is the API, not a comment.
+bool MeshtasticTransport::wake()
+{
+    _rxActive = false;
+    if (!_radio)
+        return false;
+    return _radio->standby() == RADIOLIB_ERR_NONE;
+}
```

### What step 1 does NOT buy — stated plainly

A `true` from `wake()` means the SX1262 **acknowledged the standby command**.
It does **not** prove the radio will actually transmit. If a wedged SX1262
returns `RADIOLIB_ERR_NONE` while remaining mute, `wake()` is blind to it.

That is not a flaw in this step, it is the reason step 2 exists:
`txFailStreak()` observes actual transmit outcomes and is the real detector.
Step 1 removes the *silent* failure mode (W2/W3); step 2 catches the *lying*
one. Neither alone is sufficient — this is defence in depth, and the spec
should not pretend otherwise.

### Files in step 1

| file | change |
|---|---|
| `src/MeshtasticTransport.h` | `void sleep()` → `bool sleep()`; add `bool wake()` |
| `src/MeshtasticTransport.cpp` | reimplement `sleep()`; add `wake()` |
| `specs/radio-wedge-recovery.md` | this section; `source_hash: ~` until Phase 5 |

**NOT changing in step 1:**
- `library.json` / `CHANGELOG.md` — 0.5.0 ships when the whole task lands.
- `pac-garage-alarm` — steps 3-4. Its `mesh.sleep()` at `:1006` compiles
  unchanged; the bare `radio.standby()` at `:1016` is knowingly left in place
  until step 3 replaces it.
- `transmitFrame()` — step 2 hooks it for the streak counter.

### Step 1 verification plan

1. **Static:** `grep -n "sleep()\|wake()" src/MeshtasticTransport.h` shows both
   returning `bool`; no `_radio->sleep()` or `_radio->standby()` outside these
   two methods.
2. **Build:** `pac-garage-alarm` and `examples/SpikeSend` both compile with no
   source change, proving `void`→`bool` is source-compatible.
3. **DEFERRED — on-air proof.** The `@wedge` test that demonstrates self-reset
   is step 5 and needs steps 2-4 first. Step 1 changes no runtime behaviour, so
   there is nothing on-air to observe yet. Recorded rather than skipped.

## Step 2 — implementation (exact diffs)

**Scope: the streak counter only.** The firmware call site and the WDT gate are
steps 3-4.

### Why placement alone enforces W4 — no error-kind plumbing needed

`send()` returns false at three points **before** `transmitFrame()` is reached:
`:45-46` (null radio / oversized payload), `:59-60` (`pb_encode` failed),
`:70-71` (`ctrCrypt` failed). `resend()` likewise guards `!_radio ||
_frameLen == 0` at `:216-217` before its call.

**So `transmitFrame()` is only ever entered with a valid, encoded, encrypted
frame, and any false it returns is by construction a radio-level failure.**
That is precisely the distinction W4 says the library knows and discards.
Counting inside `transmitFrame()` therefore satisfies "radio-level only"
structurally — an encode or size rejection can never touch the streak because
it never gets there.

### src/MeshtasticTransport.h — accessor + member

Next to `csmaDeferrals()` (`:103`):

```diff
     uint32_t csmaDeferrals() const { return _csmaDeferrals; }
+
+    // Consecutive RADIO-LEVEL transmit failures; cleared by the first success.
+    // Encode/size/crypto rejections never reach the transmit path, so they can
+    // never inflate this (W4). A sustained streak means hardware, not
+    // contention: CSMA fails open, so a busy channel still reaches transmit()
+    // and a healthy radio still returns ERR_NONE and clears the count.
+    uint32_t txFailStreak() const { return _txFailStreak; }
```

With the counters (`:135`):

```diff
     uint32_t _csmaDeferrals = 0;
+    uint32_t _txFailStreak = 0;
```

### src/MeshtasticTransport.cpp — count inside the choke point

```diff
 bool MeshtasticTransport::transmitFrame()
 {
     waitForClearChannel();                              // also clears _rxActive
     _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
-    return _radio->transmit(_frame, _frameLen) == RADIOLIB_ERR_NONE;
+    if (_radio->transmit(_frame, _frameLen) != RADIOLIB_ERR_NONE) {
+        _txFailStreak++;
+        return false;
+    }
+    _txFailStreak = 0;
+    return true;
 }
```

The `_txAirMs +=` line is deliberately left where it is. Moving accounting
behind the success check is **airtime-accounting-fixes step 4**, a different
task; doing it here would blur two tasks in one diff.

### RESIDUAL RISK — the load-bearing unknown for this whole task

Steps 1-4 all assume a wedged SX1262 **reports** failure: that `standby()` or
`transmit()` returns something other than `RADIOLIB_ERR_NONE`. If a wedged part
instead answers cleanly while radiating nothing, then `wake()` returns true,
`transmit()` returns `ERR_NONE`, the streak never increments, the gate never
fires, and the node stays mute exactly as it did on 2026-07-18.

Neither step 1 nor step 2 detects that case, and step 5's `@wedge` test does
NOT close it — `@wedge` proves the *recovery path* works when a failure is
reported, not that a real wedge is reportable.

If the field failure recurs with `txFailStreak() == 0` in telemetry, that is
the answer: the fault is invisible at the RadioLib API and the next line of
defence must be external (e.g. a wall-clock "no successful TX in N heartbeats"
deadline, deliberately rejected here for good reasons that would need
revisiting, or periodic radio re-init). Record the streak in `broadcastDebug()`
so this is falsifiable in the field rather than guessed at.

### Files in step 2

| file | change |
|---|---|
| `src/MeshtasticTransport.h` | `txFailStreak()` accessor; `_txFailStreak` member |
| `src/MeshtasticTransport.cpp` | branch on transmit result inside `transmitFrame()` |
| `specs/radio-wedge-recovery.md` | this section |

**NOT changing:** `library.json`/`CHANGELOG.md` (0.5.0 ships with the task);
`pac-garage-alarm` (steps 3-4); the `_txAirMs` placement (529 step 4).

### Step 2 verification plan

1. **Static:** `_txFailStreak++` appears exactly once, inside `transmitFrame()`;
   `_txFailStreak = 0` exactly once, on the success path.
2. **Build:** both consumers compile unchanged (additive API).
3. **DEFERRED — forced-failure test.** Proving the streak increments only on
   radio errors needs a stub radio that can return `TX_TIMEOUT`; `test/` is
   empty and the library has no native env. Real proof arrives at step 5 via
   `@wedge` on hardware.

## Step 3 — implementation (exact diffs)

**Scope: the wake call site only.** The WDT gate is step 4.

### Correction to this spec's own Design section

The Design says:

> `main.cpp:1016` — `radio.standby()` → `if (!mesh.wake()) { /* leave streak
> to trip the WDT gate */ }`

**"Leave the streak to trip the gate" is true but arbitrarily slow, and the
spec should not imply otherwise.** `txFailStreak()` only increments when a
transmit is *attempted and fails*. If `wake()` fails, `doSleep()` returns and
`sleepCycle()` proceeds to `mesh.receive()` — a receive, not a transmit. The
next transmit is the following heartbeat, up to `heartbeatMs` away: **300 s on
DEV1, configurable to 24 h**. Six consecutive failures are then needed before
the gate fires. On DEV1's beat that is roughly **30 minutes** of silence before
recovery starts.

Resolution (chosen 2026-07-18): **retry `wake()` once, then continue.** A
transient standby failure recovers immediately at the cost of one SPI
round-trip; a persistent one still falls through to the streak/gate path with
the latency above, now documented rather than hidden.

Rejected: treating a single failed wake as an immediate fault (stop feeding the
WDT at once). It would reset within 30 s, but it inverts this task's own
principle — a *streak* was chosen over a single failure precisely so one bad
reading cannot reboot a healthy node.

### pac-garage-alarm/src/main.cpp — `doSleep()` `:1006` and `:1016`

```diff
 static void doSleep(uint32_t ms)
 {
-    mesh.sleep();
+    if (!mesh.sleep())
+        report("SLEEP  ", false); // radio refused to sleep; carry on and let
+                                  // the wake path below sort it out
     uint32_t end = millis() + ms;
     uint32_t pirAt = pirTriggers;
     while ((int32_t)(end - millis()) > 0) {
         wdtFeed();
         uint32_t remain = end - millis();
         delay(remain > 1000 ? 1000 : remain); // tickless System-ON sleep
         if (pirTriggers != pirAt)
             break; // PIR woke us early
     }
-    radio.standby(); // SX1262 warm-start before the next TX
+    // Wake through the library, and CHECK it. A bare radio.standby() here
+    // discarded its int16_t status, so a failed wake went unnoticed and every
+    // later send() failed silently forever — the 2026-07-18 failure mode.
+    //
+    // One retry: a transient standby error recovers immediately for one SPI
+    // round-trip. A persistent one falls through to txFailStreak()/the WDT
+    // gate (step 4) — but note that path only starts counting at the NEXT
+    // transmit, i.e. up to heartbeatMs away (300 s on DEV1), then needs
+    // TX_FAIL_LIMIT failures. Recovery is guaranteed, not prompt.
+    if (!mesh.wake()) {
+        report("WAKE   ", false);
+        if (!mesh.wake())
+            report("WAKE2  ", false); // radio is not answering; step 4 gates the WDT
+    }
 }
```

`report()` already exists (`:266`) and logs to serial — which is silent on
battery until firmware-hardening step 5 adds the `Serial1` mirror. Noted, not
a blocker: the value here is that the failure is *recorded in code* rather than
discarded, and step 4 acts on it regardless of whether anyone is listening.

### Files in step 3

| file | change |
|---|---|
| `pac-garage-alarm/src/main.cpp` | checked `mesh.sleep()`; `radio.standby()` → checked `mesh.wake()` with one retry |
| `specs/radio-wedge-recovery.md` | this section |

**NOT changing:** `wdtFeed()` gating (step 4); the `@wedge` command (step 5);
anything in mt-transport (steps 1-2 landed).

### Step 3 verification plan

1. **Static:** `grep -c "radio\." src/main.cpp` == 0 — no bare RadioLib calls
   remain behind the library's back. `mesh.wake()` appears exactly twice (call
   + retry).
2. **Build:** `pac-garage-alarm` compiles against mt-transport with the new
   bool API.
3. **Functional:** `@sleepfor 15` on HOME must still sleep and wake normally —
   the happy path is unchanged, only the error path gains checking.
4. **DEFERRED — failed-wake proof.** Forcing `standby()` to fail needs the
   `@wedge` command, which is step 5.

## Step 4 — implementation (exact diffs)

**This is the step that changes field behaviour.** Everything before it was
plumbing; this one lets the device reboot itself.

### The watchdog is hammered from FOUR sites, not three

W1 above lists `:1078`, `:1010`, `:1050`. It **misses a fourth**: the feed at
the top of `sleepCycle()`. Current line numbers after step 3:

| site | context |
|---|---|
| `:1012` | `doSleep()` chunk loop |
| **`:1044`** | **top of `sleepCycle()` — MISSING from W1** |
| `:1065` | RX window |
| `:1093` | top of `loop()` |

This matters more than a typo. Had the gate been applied per call site as the
Design implies, `:1044` would have stayed unconditional — and `sleepCycle()`
runs every beat, so that single unconditional feed would keep the watchdog
hammered forever and **the entire task would be inert**.

### Therefore: gate inside wdtFeed(), not at the call sites

```diff
-static void wdtFeed() { NRF_WDT->RR[0] = WDT_RR_RR_Reload; }
+// The watchdog guard. We never trigger a reset — we stop SUPPRESSING the one
+// that was always available. Feeding unconditionally from four sites is what
+// made "alive but mute" survivable indefinitely (W1).
+//
+// Gated here rather than at each call site deliberately: there are four sites
+// and W1 itself missed one. Gating the function means every present AND future
+// caller is covered and the guard cannot be defeated by a forgotten site.
+static void wdtFeed()
+{
+    if (mesh.txFailStreak() >= TX_FAIL_LIMIT)
+        return; // radio has failed TX_FAIL_LIMIT times running: let the 30 s
+                // WDT reset us. RESETREAS=DOG on the next boot says why.
+    NRF_WDT->RR[0] = WDT_RR_RR_Reload;
+}
```

New constant beside `WDT_SECONDS`:

```diff
 static const uint32_t WDT_SECONDS            = 30;
+// Consecutive radio-level TX failures before we stop feeding the watchdog.
+// CSMA fails open, so a busy channel still reaches transmit() and a healthy
+// radio still clears the streak — a run this long means hardware, not
+// contention. No sends are attempted while asleep, so deliberate deafness
+// (@sleepfor, long @interval) can never accumulate a streak.
+static const uint32_t TX_FAIL_LIMIT          = 6;
```

Declaration order verified: `mesh` is at `:68`, `wdtFeed()` at `:230`. No
`wdtFeed()` runs before `mesh.begin()` (`wdtStart()` is at `:995`, `begin()` at
`:975`), and `_txFailStreak` is member-initialised to 0 regardless, so the gate
is open until a real failure run occurs.

### DECISION (2026-07-18): a permanently dead radio boot-loops. Accepted.

`_txFailStreak` is a transport member, so it resets to 0 on every boot. A
permanently dead radio therefore cycles: 6 failures -> reset -> boot -> 6
failures -> reset, roughly every 30 s + heartbeat, indefinitely. Over days that
drains the battery instead of sitting quietly mute.

**Accepted deliberately.** A node that keeps trying beats a silent brick, and
the loop is visible — `RESETREAS=DOG` plus a climbing boot count. The
alternative (cap the resets, then stay up mute so the unit still answers
commands and preserves battery) requires **persistent** reset counting across
power loss, which is exactly what the boot-history ring-buffer task builds.

**Revisit when boot-history lands.** Until then the honest failure mode is
preferred over a half-implemented cap.

### PREREQUISITE — this step is inert without firmware-hardening §1

If the radio is dead, the post-reset `mesh.begin()` may also fail, and today
that hits the un-watchdogged `while(true)` blink at `:978` — the node bricks
anyway and this entire step delivers nothing. **firmware-hardening step 1
(mesh.begin failure must reset, not spin) must ship in the same flash.** Landing
the code separately is fine; deploying it separately is not.

### Files in step 4

| file | change |
|---|---|
| `pac-garage-alarm/src/main.cpp` | `TX_FAIL_LIMIT` constant; gate inside `wdtFeed()` |
| `specs/radio-wedge-recovery.md` | this section |

### Step 4 verification plan

1. **Static:** `wdtFeed()` contains the gate; all four call sites unchanged and
   therefore all gated; `TX_FAIL_LIMIT` defined once.
2. **Build:** firmware compiles.
3. **Regression by construction:** no `send()` occurs during `@sleepfor` or
   between heartbeats, so the streak cannot grow while deliberately deaf.
4. **DEFERRED — the real proof is step 5.** `@wedge` forces the failure and
   demonstrates self-reset within ~35 s with `DOG` on the next boot. Until then
   this step is verified structurally, not observed.

## Files

| file | change |
|---|---|
| `specs/radio-wedge-recovery.md` | this file |
| `src/MeshtasticTransport.h` | `bool sleep()`, `bool wake()`, `txFailStreak()`, counter |
| `src/MeshtasticTransport.cpp` | implement the above in `transmitFrame()` |
| `library.json` | 0.5.0 |
| `CHANGELOG.md` | [0.5.0] |
| `README.md` | sleep/wake + failure-streak in the API paragraph |
| `../pac-garage-alarm/specs/tx-deadline-watchdog.md` | firmware-side spec |
| `../pac-garage-alarm/src/main.cpp` | W2 fix, WDT gate, RESETREAS |

Cross-repo: `pac-garage-alarm` is not a registered mcpp project (mcpp resolves
by cwd). Its half is tracked as steps 3–6 of this task; if it needs its own
task, create it from a session rooted in that repo.

**NOT changing:** wire format. The airtime counters (separate task). The
`@sleepfor` command semantics — the node is *supposed* to be deaf for the
duration; that behaviour is correct and stays.

## Verification

1. Static: no bare `radio.` calls in `main.cpp` where a `mesh.` API exists;
   `wdtFeed()` has exactly one gated call path.
2. Native: stub radio forced to fail `transmit()`; assert `txFailStreak()`
   increments only on radio errors, is untouched by an oversized payload, and
   clears on the first success.
3. **DEV1, the one that matters:** add a `@wedge` debug command that sleeps the
   radio and deliberately skips the wake. Confirm the node stops transmitting,
   self-resets within ~35 s, and the next heartbeat reports `RESETREAS=DOG`.
   This reproduces the incident on demand and proves recovery — without it we
   are only asserting the fix works.
4. Soak: `@sleepfor 3600` and a 24 h `@interval` must NOT trip the gate.
   Deliberate deafness is not failure — regression-test both explicitly.
5. GARG is NOT flashed from this task. DEV1 green first, batched with the
   airtime fixes, one trip.

## Out of scope

The root cause of the radio going mute — still unknown, and this task is
explicitly the safety net rather than the diagnosis. Re-init-on-wedge
(`begin()` again instead of resetting) — a reset is simpler and provably
restores every register. OTA.
