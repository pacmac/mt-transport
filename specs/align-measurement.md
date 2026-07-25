---
task: align-measurement-api
status: IMPLEMENTED 2026-07-25. Ported from node-dash's real align-api.js. Suite 18 files
  green (align 47 new assertions, incl. signalQuality matching node-dash EXACTLY at six
  rssi/snr points and at both clamp ends). LIVE: session opens, pings transmit at the right
  spacing, the burst deadline resolves, and the model is pushed on `mesh.align`.
  NOT YET OBSERVED ON AIR: a completed READING. Both test targets failed to answer — BNCH is
  asleep (8 s window vs a 30 s burst) and GARG is marginal (-121..-128). So the averaging,
  quality and per-radio path are unit-tested only. See Findings.
source_hash:
  clients/mesh/lib/align.js:  c2d2d1ca0034932c
scope:
  - specs/align-measurement.md
  - clients/mesh/lib/gw.js           # carry `addr` (the REPORTING radio) through normalize
  - clients/mesh/lib/align.js        # NEW: session, burst, averaging, the view-model
  - clients/mesh/index.js            # wire Align in; expose alignPing/alignStop/alignState
  - clients/mesh/host-module.js      # /align routes + the `align` SSE event
  - clients/mesh/config.yaml         # align.radios (labels -> node ids)
  - clients/host/host.config.json    # same, for the live service
  - clients/mesh/test/align.js       # NEW
  - clients/host/API.md              # the contract node-dash rebuilds against
# NOT changing: the rotator (we do not drive it here — see Decisions), node-dash's PASV
#   interlock (theirs, raised on xsession), the ledger (align pings are instrument traffic,
#   not messages — see Decisions), or how commands/text are sent.
---

# Spec: align-measurement — the Yagi alignment backend, ported to our service

## Why this is ours now, and why it is urgent

node-dash **deleted** their align backend under the ownership change; their alignment UI
cannot return until ours exists, and nobody can align the Yagi meanwhile. It is the only
outstanding item with a blocked consumer.

We are porting from the **real retained source**, not from prose:
`/usr/share/pac/dev/projects/mt-radar/node-dash/reference/alarm-integration/src/align-api.js`
(369 lines) + `public/app-align.js` (494). node-dash: *"Port behavior from the real code,
not reconstructed prose."*

## The contract we owe them

Their BROWSER_CONTRACT survives the move: **the backend owns the entire view-model and
the browser computes nothing.** They asked for the old field names **exactly**, so their
UI restores with no adapter. So we serve computed values, not raw dB.

`signalQuality(rssi, snr)` — their exact implementation, given verbatim on xsession
(`src/utils.js:24`). It must be copied, not re-derived: if we invent our own, the align
page disagrees with the rest of their UI for the same node.

```js
// SNR weighted 60%, RSSI 40% — SNR is the better LoRa link indicator.
const snrScore  = hasSnr  ? clamp01((snr  + 20) / 30) : null;
const rssiScore = hasRssi ? clamp01((rssi + 120) / 70) : null;
both -> round((snrScore * 0.6 + rssiScore * 0.4) * 100)
```

Bands, confirmed by them: **Excellent ≥76 · Good ≥51 · Fair ≥26 · else Poor**, with
colour classes `success/success/warning/error` and `base-content/30` for null.

## The measurement — facts from the source, do not re-derive

- **Stimulus** is `@<4-hex-suffix> ping`; the unit answers `pong` carrying **its own**
  rssi/snr. That payload reading is the PRIMARY signal — it is measured **at the antenna
  being turned**, and is the most stable (sd 0.16 dB). Address by node-id suffix, never
  the short name (short names encode LOCATION and get toggled on a swap).
- **Per-radio envelope** (`rx_rssi`/`rx_snr`, one event per RECEIVING radio) is
  SECONDARY: our antennas hearing the device. It yields `yagi_q`/`omni_q`. A missing
  radio must show as a gap, never a zero.
- **Burst, not a timer.** One press = N pings spaced `BURST_SPACING_MS` (1200 ms, just
  over the collect window so each is a genuinely separate attempt), averaged into ONE
  reading. N is 1–5, default 4 — sqrt(N) noise reduction against ~0.7 dB single-ping
  jitter.
- **One burst-level deadline**, `(of-1) * 1200 + replyWindowSec * 1000`. Resolve with
  whatever landed; do NOT wait out unanswered pings, or a burst where some replies never
  come sits "gathering" for the full per-ping timeout while the average is already good
  enough.
- **Two copies of one pong** (one per receiving radio) are gathered over
  `ALIGN_COLLECT_MS` (1200 ms) then finalised into one sample.
- Measured reply latency: mean 16.1 s, max 18.6 s, ~75% land. Hence a default
  `replyWindowSec` of 30, clamped 5–120, operator-set and **persisted**.

## Decisions I am taking (Peter away — recorded so they can be reversed)

1. **We do NOT drive the rotator.** Neither did the original: it forced the dashboard to
   PASV so the Yagi would not swing mid-measurement, and the operator turned the antenna.
   Driving it is a separate concern with its own hazards, and MVP value is the
   measurement. When it is added it must talk to the hardware **directly**
   (`ws://192.168.10.186:81`), never proxy node-dash:8000 — that dependency was
   deliberately removed in 4a85768.
2. **The PASV interlock is node-dash's to honour.** Their `dashMode.set(0)` is their
   subsystem; we cannot and must not set it. If they auto-swing the Yagi during a
   session, readings are corrupted. RAISED ON XSESSION — we expose `running: true` in the
   model so they can gate on it.
3. **Align pings do NOT enter the request ledger.** They are instrument traffic — 4 per
   press — and would drown the outbox that exists to show a person what THEY sent. Same
   reasoning Peter applied to chunks: *"chunks are completely different"*. They go
   through `gw.sendText` directly.
4. **Radios are named in CONFIG, not hardcoded** (`no-hardcoded-identity`). Verified live
   from mesh-gw `/devices`: `!2687afb1` = E9:B0:3F:17:27:91 (OMNI, our gateway),
   `!fa39f7b4` = F4:12:FA:39:F7:B6 (YAGI). We map the reporting `addr` to a label via
   that endpoint at session start, so a MAC change does not need a code change.

## What has to change outside align

`lib/gw.js` drops the **reporting radio**. mesh-gw emits one event per receiving BLE
device carrying `addr` (the recorder already relies on this: *"the same packet heard by
two receivers is two rows"*), but `_normalize`/`_heard` do not carry it, so `yagi_q`
versus `omni_q` is currently impossible to compute. Add `addr` to the normalized shape —
additive, nothing else reads it.

## Wire surface

| route | |
|---|---|
| `POST /v1/mesh/align/ping` | `{target, n?}` — opens/retargets the session, fires one burst |
| `POST /v1/mesh/align/stop` | end the session |
| `GET /v1/mesh/align` | the complete view-model (polling fallback) |
| `POST /v1/mesh/align/config` | `{replyWindowSec}` — persisted |

SSE: **`mesh.align`**, carrying the identical view-model. The original used a dedicated
WebSocket because the dashboard's `/events` pushed 7.2 MB on connect; our `/v1/events` is
already lean, so it rides the shared stream. Payload shape is byte-identical to what
`app-align.js` consumes, so their change is the transport line, not the renderer.

View-model (their names, unchanged): `kind:'align'`, `running`, `target`, `tx`, `channel`,
`nBurst`, `replyWindowSec`, `burst{active,got,of}`, `warning`, `best{n}`, `current`,
`readings[]`. Each reading: `n, quality, label, cls, spread, got, of, rssi, snr, yagi_q,
omni_q, barPct, isBest, isCurrent, trendDir, trendDelta`. `current` adds `gapToBest`,
`bestN`, `bestAgo`.

`channel` is in the model because their UI displays it; it is **reported**, never accepted
as input — channel selection stays ours.

## Observe

1. **Static** — `signalQuality` matches theirs numerically at known points
   (e.g. rssi -55/snr 7 → the same integer their UI would show); bands at the 76/51/26
   boundaries.
2. **Functional** — a real burst against BNCH: `POST /align/ping`, watch `mesh.align`
   events go `burst.active` → a reading with `quality`/`label`, `got<=of`, and `yagi_q`
   **or** `omni_q` present. A second burst produces `trendDir`/`gapToBest`.
3. **Regression** — the ledger does NOT gain 4 rows per press; commands/text still work;
   offline suite green.

## Risks

- **A burst is ~4 pings + replies of airtime on a shared mesh.** Bounded by N≤5 and by
  being operator-triggered, but it is not free.
- **GARG must not be a casual target.** It is battery, marginal (-114…-128 dBm) and
  draining ~1.1 %/hr; pinging it 4× per press is a real cost. Bench first.
- **`sd 0.16 dB` and `~75% land` come from the source's own measurements**, taken on the
  old stack. Our numbers may differ; treat them as expectations, not guarantees.

## Findings from the live run

**The burst loop is correct — verified by id, not by assumption.** An n=3 burst appeared
on air as only TWO frames, which looked like a defect. Adding a per-ping log and converting
our decimal packet ids to the recorder's hex settled it:

| our log | hex | on air |
|---|---|---|
| 1542721453 | 5bf40fad | yes |
| 843501899  | 32446b0b | **NO** |
| 1932075678 | 7329229e | yes |

All three were sent, correctly spaced ~1.3 s. One frame was lost between the gateway and
our own receiving radio. That is the loss align exists to MEASURE, not a bug — but the air
trace alone could not distinguish "not sent" from "sent but not heard", which is why the
per-ping log is now permanent.

**Align needs an AWAKE target.** A burst runs ~30 s; a sleeping unit's window is ~8 s, so
BNCH can only ever answer the ping that happens to land inside it. This is not a defect —
alignment is done with someone at the antenna and the target awake — but it means BNCH on
a 15-min beat is a poor test target, and it should be documented for whoever aligns next.

**GARG answers pongs intermittently** (12:05, 12:14 today at -121..-128) but answered
neither test burst. Consistent with the marginal link, not evidence of a fault.
