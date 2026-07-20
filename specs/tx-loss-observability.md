---
task: adopt-meshtastic-csma (step 9)
status: implemented 2026-07-20 (260720-4, flashed + DEBUG frame verified on air)
priority: HIGH — instruments before measurements; blocks steps 1/4 and all reliability work
source_hash:
  projects/mt-transport/src/MeshtasticTransport.h: 4964f9432caca5f3677e0f016920de8beaf327a471f0cc2fd54518784d35a918
  projects/mt-transport/src/MeshtasticTransport.cpp: cc42da8fad546de057b3cddefcec6ff9a397f223a23de465f85cdfeb4627d72f
  projects/pac-garage-alarm/src/main.cpp: 91d76bc1a90cde8dbc53d3cd83844c22e50996856da76d0242d975fbda97c974
scope:
  - projects/mt-transport/src/MeshtasticTransport.h
  - projects/mt-transport/src/MeshtasticTransport.cpp
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: tx-loss-observability — make "sent" verifiable

## Why (measured 2026-07-20)

`mesh.send()` returns **true at ENQUEUE**. The firmware logs `REPLY: ... OK` from
that return value. If the frame is later discarded inside the TX state machine, the
application has already been told success and **never learns**. That log line was
used all day as proof "the device transmitted" — it only ever proved *queuing*, and
several wrong conclusions were built on it.

Two discard sites, both silent to the caller:

| site | condition |
|---|---|
| `MeshtasticTransport.cpp:181-186` | `startTransmit()` returns an error → frame dropped |
| `MeshtasticTransport.cpp:226-231` | TX-done not seen within 5000 ms → `finishTransmit()`, frame dropped |

**The counter that exists cannot show this.** `_txFailStreak` is a **streak**, zeroed
on every success (`.cpp:315`). The observed failure mode is *intermittent*
(`status` 4/6, `ping` 6/6), so each drop is erased by the next success. `"txfs"` is
already broadcast in the DEBUG frame every heartbeat and still reads 0.

`rxDroppedByTx()` exists (`.h:162`) — added by step 3 explicitly to "turn an
invisible loss into a number" — but **no firmware code reads it**.

## Design

Add a **cumulative** counter; do not alter the streak.

- `_txDropped` — total frames discarded by the TX state machine, ever. Never reset.
- Incremented at **both** discard sites, alongside the existing `_txFailStreak++`.
- Surface `_txDropped` and the existing `rxDroppedByTx()` in the DEBUG frame, which
  is already the diagnostics carrier and already sent every heartbeat.

## Exact changes

### 1. `src/MeshtasticTransport.h` — accessor + member

```diff
     uint32_t txFailStreak() const { return _txFailStreak; }
+
+    // CUMULATIVE frames discarded by the TX state machine (startTransmit error, or
+    // TX-done never arrived). NEVER reset — unlike txFailStreak(), which is a
+    // streak zeroed by the next success and therefore blind to intermittent loss.
+    // send() returns true at ENQUEUE, so without this a discarded frame is
+    // invisible to the caller: this is the only number that says "queued but never
+    // went out".
+    uint32_t txDropped() const { return _txDropped; }
```
```diff
     uint32_t _txFailStreak = 0;
+    uint32_t _txDropped = 0;
```

### 2. `src/MeshtasticTransport.cpp` — count at both discard sites

```diff
     if (_radio->startTransmit(it.frame, it.len) != RADIOLIB_ERR_NONE) {
         _txFailStreak++;
+        _txDropped++;   // queued, never went out — invisible to the caller otherwise
         _txCount--; _txHead = (_txHead + 1) % TXQ_N; // drop the unsendable frame
```
```diff
         if ((int32_t)(now - _txStateMs) > 5000) {
             _radio->finishTransmit();
             _txFailStreak++;
+            _txDropped++;   // TX-done never arrived; frame abandoned
             _txCount--; _txHead = (_txHead + 1) % TXQ_N;
```

### 3. `pac-garage-alarm/src/main.cpp` — surface both in the DEBUG frame

```diff
-             "\"mot\":%lu,\"pir\":%d,\"csma\":%lu,\"txfs\":%lu,"
+             "\"mot\":%lu,\"pir\":%d,\"csma\":%lu,\"txfs\":%lu,"
+             "\"txdr\":%lu,\"rxdt\":%lu,"
              "\"bt\":%lu,\"dog\":%lu,\"pts\":[",
```
with the two matching arguments `mesh.txDropped()`, `mesh.rxDroppedByTx()` inserted
in order after `mesh.txFailStreak()`.

Budget: the frame is already capped at `DEBUG_MAX = 237` with `pts[]` truncated
oldest-first to stay valid JSON. The two new fields (~24 B) simply shorten the
`pts[]` tail — the existing truncation handles it, no new failure mode.

## Explicitly NOT changing

- **`txFailStreak()` semantics.** `main.cpp:573-578` `wdtFeed()` starves the
  watchdog after `TX_FAIL_LIMIT` *consecutive* failures so the WDT resets a wedged
  radio. Making it cumulative would reset the node after 6 lifetime failures.
- **`forceTxFailStreak()`** — backs the `@wedge` test (`main.cpp:1484`).
- **The `status` reply** — already near its 208 B budget; DEBUG is the diagnostics
  carrier and is broadcast every heartbeat anyway.
- **`library.json` / `CHANGELOG.md`** — version bump belongs with the parent task.

## Verify

1. **Static** — `txDropped` present at both discard sites and in the DEBUG format.
2. **Functional** — flash bench, read a DEBUG frame off port 260, show `txdr`/`rxdt`
   present and parsing. Then re-run the status/ping A/B and read `txdr` before/after:
   if it climbs by the number of missing replies, the loss is pre-air and ours.
3. **Regression** — `wdtFeed()` still sees streak semantics (`@wedge` still forces a
   reset path); build clean for `pac-garage-alarm`.
