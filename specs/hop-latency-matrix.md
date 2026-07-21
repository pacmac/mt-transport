---
task: hop-latency-matrix
status: IMPLEMENTED + enabler verified on air (fw 260721-10). `hop <n>` sets/reports the
        override (`hop 2` -> {"type":"hop","n":2}; `hop 0` restores). Harness validated end
        to end (1 rep, hop 3: set -> all 6 types timed via the Client event stream -> restore
        hop 0). The FULL matrix run (all hops × reps, the actual table) is pending — it's a
        long on-air run, handed to the operator: `node tools/hop-matrix.js 0,1,2,3 5 [--chunk]`.
updated: 2026-07-21
scope:
  - mt-transport/src/MeshtasticTransport.h
  - mt-transport/src/MeshtasticTransport.cpp
  - pac-garage-alarm/src/main.cpp
  - mt-transport/tools/hop-matrix.js
  - mt-transport/tools/hop-ab.js     # focused chunk-only A/B (varies the real chunk.hop knob)
source_hash:
  mt-transport/src/MeshtasticTransport.h: ddfedbbd63334a2f3197d37c9f78551d5b019fccc4244f4774de7266766ec96d
  mt-transport/src/MeshtasticTransport.cpp: 02c582a9829ed66d60ccd0e10f92f1d59638c155cadd4e39027364db559ad2cd
  pac-garage-alarm/src/main.cpp: e920b4d3f53fe1d938f1f35f71ef726b2ce1a1c830216f22c82dc245c9f348d0
---

# Hop-latency matrix: runtime hop override + sweep harness

## Why
We want round-trip latency + loss for every data type at every hop, to pick per-class
hop defaults from data. Today only chunk hop is runtime-tunable (`g_chunkHopLimit`);
replies/telemetry/alarm/nodeinfo are literal/default 3. Rather than wire four per-class
knobs before we know the answer, add ONE transport-level override to sweep hop across all
traffic on a single build; the per-class policy comes later, informed by the table.

## 1. Transport override (`MeshtasticTransport`)
- Header: `void setHopOverride(uint8_t h) { _hopOverride = h > 7 ? 7 : h; }`,
  `uint8_t hopOverride() const`, private `uint8_t _hopOverride = 0;`.
- `send()` (`.cpp`, before `packFlags`): `if (_hopOverride) hopLimit = _hopOverride;`
  — forces EVERY frame's hop when set. One point covers all send sites.
- **RAM-only, not persisted** — a reboot clears it. A forced hop must never outlive a test.

## 2. App command `hop [n]` (`pac-garage-alarm`)
`@<t> hop` reports; `@<t> hop <0-7>` sets. `0` = off (per-call defaults). Reply:
`{"type":"hop","n":<current>,"note":"0=default hops"}`. New verb in `handleCommand`
(no prefix clash with existing verbs).

## 3. Harness (`tools/hop-matrix.js`)
For each hop in the list, `hop <n>`, then exercise each command-triggerable type and time
`command -> reply`:
- `ping` (small TEXT), `status` (large TEXT), `config` / `debug` / `sch 0` (port-260), `env`
- one `chunk push` (`push pub` pid 1 -> `Client.push` transfer time)

Interleave across hops; N reps; per (type × hop) report **min / median / max + loss**,
matched on `from_num`. Flag samples where a heartbeat bundle was mid-flight. **Restore
`hop 0` on exit** (and it clears on reboot anyway).

## Verification
- Static: `send()` applies `_hopOverride`; `hop` command present.
- Functional: `@t hop 1` -> `{"type":"hop","n":1,...}`; a subsequent reply's frame shows
  hop_start=1 (observable via the gateway's rx hop fields); `hop 0` restores.
- The harness produces the table; a first short run (reps=2) validates mechanics before the
  long full run.

## Risks
- While an override <3 is active, ALARM reach is reduced. Bench-only, restored, RAM-only,
  documented. If we later keep the override as a permanent diagnostic, alarm should be
  exempted — out of scope here.
- Library API grows by one setter (additive, safe). Bench flash; field unit untouched.
