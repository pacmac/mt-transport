---
task: csma-tx
status: active
source_hash: cfd2d4ce51aca1e4cf4631172743180e0d9098b18ec833a535ded6f5ed71979a  # MeshtasticTransport.cpp
updated: 2026-07-17
---

# Spec: csma-tx — listen-before-talk on every transmit

## Goal

Stop transmitting blind. Deployment #1 proved the cost: one-shot replies sent
into the post-command rebroadcast window nearly always died. Real Meshtastic
does CSMA; as of 0.3.0, so does mt-transport.

## Files

| file | change |
|---|---|
| `specs/csma-tx.md` | this file |
| `src/MeshtasticTransport.h` | `csmaDeferrals()` accessor; private `waitForClearChannel()`; counters |
| `src/MeshtasticTransport.cpp` | CAD + backoff before TX in `send()` and `resend()` |
| `library.json` | 0.3.0 |
| `CHANGELOG.md` | [0.3.0] |

**NOT changing:** firmware (`pac-garage-alarm`) — no API change; it inherits
the behaviour by rebuild. SpikeSend stays frozen (still 0.1.0-era TX-blind
behaviour when built against 0.3.0 — acceptable for a minimal example).

## Design

`waitForClearChannel()` before the `transmit()` in send() and resend():

- Up to 8 attempts: `scanChannel()` (SX126x CAD, blocking, ~few symbol
  times). `RADIOLIB_CHANNEL_FREE` → proceed. `LORA_DETECTED` /
  `PREAMBLE_DETECTED` → `delay(30 + rand % (60 << min(attempt,3)))` ms
  (escalating window), count a deferral, retry.
- After 8 busy attempts (~1.5–2 s worst case): transmit anyway — FAIL-OPEN.
  An alarm that politely never speaks is worse than a collision.
- CAD leaves the radio in standby: `_rxActive = false` on entry.
- Counters: total deferrals (`csmaDeferrals()`), for app-level logging.

## Verification

1. Static: grep scanChannel/waitForClearChannel/csmaDeferrals.
2. Functional on air: dev unit rebuilt on 0.3.0 — heartbeats + @dev1 ping →
   pong decoded at the Omni event stream (TX still works through CAD path).
3. CSMA-specific: deferral counter reported over serial after a burst of
   mesh traffic; if bench never yields a busy CAD in the window, record
   DEFERRED (cannot force contention deterministically without a jammer) —
   the fail-open path guarantees TX proceeds regardless.

## Out of scope

Contention-window tuning from channel-utilisation stats (Meshtastic-style),
PKI, persistence.
