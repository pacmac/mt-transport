# RX and the command channel

## Why RX is in scope

A remote device that can only talk is a dead end: no config, no OTA trigger, no
interrogation. mt-transport must **send and receive**.

## The code cost is trivial

AES-CTR is symmetric. The fork's own decrypt is a one-liner
(`CryptoEngine.cpp:367-371`):

```cpp
void CryptoEngine::decrypt(uint32_t fromNode, uint64_t packetId, size_t numBytes, uint8_t *bytes)
{
    // For CTR, the implementation is the same
    encryptPacket(fromNode, packetId, numBytes, bytes);
}
```

So RX is:

1. Receive raw frame.
2. Parse the 16-byte plaintext header (`docs/wire-format.md` §2).
3. `header.channel == ourHash`? else drop. (Cheap pre-filter — that is exactly
   what the field is for: *"used as a hint for the decoder to limit which
   channels we consider"*, `RadioInterface.h:46`.)
4. `to == 0xFFFFFFFF || to == ourNodeNum`? else drop.
5. Decrypt payload with `nonce(header.id, header.from)` — **same routine as TX**.
6. nanopb-decode `Data{portnum, payload}`.

**~50 lines.** Decode is not the problem.

## The power cost is the whole problem

Continuous LoRa RX on an SX1262 is **~10-15 mA**. Against a Li-SOCl2 cell that
is fatal — it is the same order as staying fully awake. **You cannot be
always-listening and multi-year.** This is physics, not Meshtastic.

### Resolution: Class-A style RX windows

Borrow LoRaWAN Class A. The device is **deaf by default** and opens a bounded
listen window immediately after each transmit:

```
wake (RTC timer or PIR GPIO)
  → TX heartbeat / detection
  → RX window (~min_wake_secs, e.g. 10 s)
  → process any commands
  → sleep
```

Anyone wanting to talk to the node **queues** a command; it lands on the next
heartbeat.

### Budget

> **Duty cycle (2026-07-17): asleep by default, RTC heartbeat wake — rate
> REMOTELY CONFIGURABLE via the command channel.** MCU System ON idle, radio
> off, only the PIR rail powered; each wake = heartbeat TX → RX window →
> sleep. A PIR trip wakes it any time (alert + window). Candidate rates:
> 1–4/day ⇒ ~7–9 y; **hourly ⇒ ~3.8 y (10 s window) / ~4.8 y (5 s)** — all
> comfortably multi-year on the AA cell.
>
> `set-interval` is the one command that can strand the device: firmware
> must **clamp the accepted range** (e.g. 15 min–24 h) and **apply
> provisionally, reverting if the next wake's handshake gets no
> confirmation**. Interval + replay counter persist in a small internal
> flash settings record (no filesystem).

| Item | Cost (4 wakes/day) |
|---|---:|
| Sleep (System ON + RTC, PIR powered, ~30 µA) | **~0.72 mAh/day** |
| TX (~0.5 s @ ~120 mA, 4/day) | ~0.07 mAh/day |
| RX window (10 s @ ~12 mA, 4/day) | ~0.13 mAh/day |
| Boot (~0.2 s, bare-metal) | negligible |
| **Total** | **~0.9 mAh/day** |

> **Cell (decided 2026-07-17): EEMB ER14505 AA Li-SOCl2, 3.6 V, 2700 mAh,
> primary — no recharging.** At 1–4 wakes/day the radio is a rounding error
> and **sleep current is the entire budget**: ~0.8–0.9 mAh/day ⇒ **~7–9
> years**, back to self-discharge-limited territory even on an AA cell.
> Every µA shaved off sleep buys ~3 months of life; every extra daily wake
> costs ~2 weeks. Continuous RX (~290 mAh/day ⇒ ~9 days) remains fatal.

### Latency consequences of 1–4 wakes/day

- **Remote command latency: up to 6–24 h** (one wake interval). Acceptable
  for config/interrogation by design. On-site, a PIR trip opens a window
  within seconds — walking up to the device restores near-instant access.
- **Liveness detection is one wake interval**: the gateway must alarm on a
  missed heartbeat (gateway feature, not firmware).

### The trade-off, stated plainly

- **Worst-case command latency = one heartbeat interval** (30 min default).
  Fine for config, OTA trigger, interval changes.
  **Not** fine for "disarm now" — if that is ever needed, shorten the heartbeat
  (and pay for it) or accept it.
- Tuning knobs: heartbeat interval vs RX window length vs battery life. A PIR
  wake also opens a window, so the node is more reachable when there is activity.

## What the command channel unlocks

1. **Remote OTA trigger.** A command that sets `GPREGRET = 0xB1` and resets drops
   the node into the Adafruit bootloader for node-dash to flash
   (`BLEDfuSecure.cpp:124`). DFU lives in the bootloader, not the app — so this
   works from a custom firmware for ~5 lines. Largely solves the "5 miles away"
   problem.
2. **Config without a visit** — intervals, thresholds, arm/disarm.
3. **Interrogation** — request an immediate status/heartbeat.

## Security — design this in now, not later

**The PSK is the authentication.** Only PSK holders can produce a validly
encrypted packet, and the channel hash pre-filters. That is Meshtastic's model
and is adequate for a private channel.

**But replay is a real attack on an alarm.** An attacker who records an
encrypted `disarm` can retransmit it verbatim without ever knowing the PSK.
AES-CTR provides confidentiality, **not** authenticity or freshness.

Mitigations to design in:

- **Packet-id dedupe** — keep a small window of recently-seen `(from, id)` pairs
  and drop repeats. This is what upstream does for flood control; here it is a
  security control.
- **Monotonic command counter** — every command carries a counter > the last
  accepted one. Survives reboot only if persisted; otherwise a reset reopens the
  replay window.
- **Reject stale commands** by timestamp if the node has trusted time (it may
  not — no GPS, no NTP on nRF52; time comes from the mesh/client and is *not*
  trustworthy for security decisions).

> ⚠ **Note the collision with the TX nonce rule.** The packet id is *both* the
> CTR nonce *and* the replay-dedupe key (`docs/wire-format.md` §4). It must be
> non-repeating for crypto reasons **and** monotonic-ish for replay reasons. A
> single counter, persisted or RNG-seeded, satisfies both — but a naive reset to
> `id=1` breaks **both** at once: keystream reuse *and* a reopened replay window.

**Do not treat commands as safe just because they decrypted.** Decryption proves
someone once knew the PSK — not that this packet is fresh, nor that the sender is
who you think.

## API implication

```cpp
// TX
bool send(uint32_t portnum, const uint8_t *payload, size_t len,
          uint32_t to = 0xFFFFFFFF, uint8_t hopLimit = 3);

// RX — bounded window, returns when a packet arrives or the window closes
bool receive(uint32_t timeoutMs, RxPacket &out);

// convenience: TX then listen (the Class-A cycle)
bool sendAndListen(uint32_t portnum, const uint8_t *payload, size_t len,
                   uint32_t rxWindowMs, RxPacket &out);
```

The application still owns sleep. The library owns the radio and the wire format
— nothing else.
