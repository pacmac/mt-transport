---
task: onair-test-analysis
status: SPEC 2026-07-22 — the on-air harness must ANALYSE the exchange, not count replies.
priority: test infrastructure — every later phase uses this as its regression gate
source_hash: ~
project: mt-transport (clients/node test harness)
scope:
  - clients/node/test/lib/onair.js   # NEW — reusable analysis harness (records + verdicts)
  - clients/node/test/onair-ping.js  # rewritten on top of the harness
---

# On-air test analysis

"Did I get a reply" is not a test. A PASS must mean: **the right unit answered the right
message, over the expected transport, in time, without the device restarting underneath it.**

## Why (evidence, today)
1. `onair-ping.js` reported `#3 no reply within 10s`. The reply HAD arrived (msg id 10565,
   `reply_id` 0xe8fae4cf, device `upt` 109) ~40 ms after the poll window closed. A boundary
   miss was reported as a loss — a false negative that sends you chasing a phantom fault.
2. The same run would have reported PASS for a **broadcast fallback** when a PKC DM was
   expected, because it never inspected the transport. That is exactly how the PSK-DM failure
   masqueraded as a device fault for an hour.

## ACK — the missing half (added 2026-07-22)
The harness must REQUEST and MEASURE an ack. It did not, and that was the defect: every run
showed `status='no_ack_needed'` because the command was sent as a **broadcast**, so no ack was
ever asked for. Per `MESSAGES_SPEC.md:105`, "Broadcasts reach `sent` and stay there… DMs proceed
from `sent` to `acked`, `failed`, or `no_ack`." Reliability cannot be tested over a broadcast.

- **Send as a DM** — pass `to: <targetNode>` on `POST /{gw}/messages`. That is what requests the ack.
- **Record the delivery state** of the outbound command: `sent` → `acked` | `failed` | `no_ack`
  (`no_ack_needed` means we failed to ask, and is itself a FAIL when an ack is expected).
- **Measure ACK latency separately from RESPONSE latency.** They are different things:
  ack = the mesh confirming delivery of our command; response = the device's reply arriving.
  Report both per command, plus min/avg/max for each.
- **Assert per `MESSAGES_SPEC.md:99`**: `acked` means a ROUTING_APP with matching `request_id`
  and `error_reason = 0`. This is the same condition the transport implements, so the test and
  the firmware agree on what "acked" means.
- `--expect-ack acked|any` — when `acked` is required, anything else (`no_ack`, `failed`,
  `no_ack_needed`, still `sent` at timeout) is a FAIL with the actual state reported.

## What every command record must carry
| group | fields | assertion |
|---|---|---|
| correlation | cmd `packet_id`, reply msg `id`, `reply_id`, `from_num` | `reply_id == packet_id` AND `from_num == target node` |
| **ack** | outbound `status`, ack timestamp, **ack latency** | matches `--expect-ack`; timed from send |
| transport | `to_num`, `is_dm`, `channel` | matches `--expect-transport` (broadcast\|dm\|any); channel MUST be 2, never 0 |
| radio | `hop_limit`, `hops`, `snr`, `rssi` | reported (diagnostic, not pass/fail) |
| timing | sent_at, reply_at, latency | in-window / LATE / absent — LATE is its own verdict, never "no reply" |
| device | `upt`, `fw` from the reply JSON | **`upt` decreasing across the run = device rebooted → run INVALID** |
| integrity | duplicate `reply_id` count; unmatched replies | duplicates reported (want_ack retransmit evidence); a reply matching no command is flagged |

## Aggregate
delivered/total, latency min/avg/max, send-vs-arrival reordering, reboot detection, transport
consistency, duplicates. Exit 0 only if every command is CORRELATED + right unit + expected
transport + in-window, and no reboot occurred.

## Deliberately NOT changed
- `onair-reliability.js` — rewritten later against this harness when PKI lands.
- The command grammar or the gateway POST route (`device-comms.md` is the standing rig).
