---
task: hop-latency-matrix
kind: findings / results (not a spec)
date: 2026-07-21
firmware: pac-garage-alarm 260721-11 (bench !8cee336b via OMNI !2687afb1, channel 2)
raw: tools/hop-matrix-results.csv (120 rows)
harness: tools/hop-matrix.js  (0,1,2,3 × 5 reps, interleaved; 60 s reply deadline; 3 s inter-send gap; replies matched on from_num via the Client event stream)
---

# Hop-limit vs reply latency & loss — findings

## What was measured
Round-trip time (command → reply) and loss for six command-triggerable packets, at each
`hop_limit` 0–3, forced on ALL device frames by the RAM-only `hop <n>` override. 120 samples
(30 per hop, 5 per type×hop). The override was restored to `hop 0` on completion (confirmed).

## Results

**Median round-trip latency (seconds):**

| type   | hop0 | hop1 | hop2 | hop3 |
|--------|-----:|-----:|-----:|-----:|
| ping   |  7.3 |  6.8 |  7.4 |  9.1 |
| env    |  7.5 | 13.4 |  8.4 |  4.3 |
| status | 16.9 |  6.4 |  4.9 |  4.7 |
| config |  3.7 |  4.9 |  7.5 |  7.8 |
| debug  |  6.1 |  8.3 | 10.4 |  4.3 |
| sch    |  4.9 |  5.0 |  4.8 |  4.3 |
| **pooled** | **5.1** | **5.6** | **6.7** | **4.7** |

**Loss (lost / attempts):**

| type   | hop0 | hop1 | hop2 | hop3 |
|--------|:----:|:----:|:----:|:----:|
| ping   | 1/5  | 0/5  | 0/5  | 1/5  |
| env    | 1/5  | 0/5  | 3/5  | 2/5  |
| status | 3/5  | 3/5  | 1/5  | 2/5  |
| config | 0/5  | 0/5  | 0/5  | 3/5  |
| debug  | 1/5  | 1/5  | 1/5  | 0/5  |
| sch    | 0/5  | 1/5  | 0/5  | 1/5  |
| **pooled** | **6/30 (20%)** | **5/30 (17%)** | **5/30 (17%)** | **9/30 (30%)** |

## Findings

1. **Hop-limit does not affect reply latency.** Pooled medians are flat at ~5–7 s across all
   four hops, and the frame-to-frame spread within a single hop (≈4 s to 17 s) is far larger
   than any difference between hops. Latency is governed by **LoRa airtime (SF11/BW250, ~2 s
   per full frame) + device TX-queue depth + the lossy uplink** — not by hop count.

2. **Only hop3 is worse for loss; hop 0/1/2 are indistinguishable.** Pooled loss is 20/17/17 %
   for hop 0/1/2 and **30 % for hop3**. The higher hop3 loss is consistent with self-congestion:
   a larger hop_limit means every node rebroadcasts each frame, and the extra channel traffic
   causes more collisions. (An earlier mid-run "loss rises monotonically with hops" read was
   small-n noise and does not survive the full sample.)

3. **hop3's low median (4.7 s) is survivorship bias, not speed.** At hop3 the slow replies
   became outright *losses* (30 %) rather than slow arrivals, so the survivors look fast. hop1,
   by contrast, retained a 53 s straggler. Do not read hop3's median as "fastest".

4. **The dominant term is the ~17–20 % baseline loss**, present at every hop — that is the
   link (asymmetric uplink; OMNI hears the device weakly/erratically), not the hop setting.
   No hop choice touches it.

## Recommendation

- **Reply `hop_limit` is hardcoded to 3 (`sendText`). Drop it to 1.** No latency cost, loss no
  worse than hop0/2 and clearly better than hop3, and less channel congestion for the whole mesh.
  A modest, safe win. (Optional: expose it as a `hop.reply` field in the config-schema table so
  it is runtime-tunable; low priority given the small effect.)
- **Do NOT treat hops as a reply-latency lever.** The real levers, in order: reduce round-trips,
  shrink frames, and address the ~17–20 % uplink loss. Hop tuning changes none of those.

## Method / caveats
- n = 30 per hop (5 per type×hop). Enough to conclude on latency-flatness and on hop3-worst-loss;
  individual type×hop cells (n=5) are noisy — do not over-read a single cell (e.g. env-hop1 13.4 s,
  status-hop0 16.9 s are 1–2 slow samples).
- The override forces ALL frames, so alarm reach was reduced during the run — acceptable, bench
  only, RAM-only, restored to `hop 0`.
- Replies matched on scalar `from_num` via the Client's decoded event stream (not `/messages`
  substring matching), after two earlier false-loss artefacts (25 s deadline too short; `config`
  matched on the wrong reply channel) were found and fixed.
