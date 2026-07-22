---
task: v2-transport
status: DOCS DRAFT 2026-07-22 — design agreed in discussion; the two contract docs are the
        first deliverable and must be reviewed before ANY firmware change. No code touched yet.
priority: design — supersedes the v1 port/JSON/broadcast surface
source_hash: ~   # pure-doc step: deliverables are docs/v2/*.md, no backing source yet
scope:
  - docs/v2/README.md         # NEW — scope + rationale (the "why" and "what")
  - docs/v2/APIV2.md          # NEW — wire contract (the "how"): port, frames, ptypes, flows. THE SSOT.
  - clients/README.md         # NEW — consumer-library family: SSOT is APIV2, per-language, conformance
  - clients/python/README.md  # NEW — Python lib PLACEHOLDER: scope of the (unbuilt) lib; must comply with APIV2
---

# v2-transport — one reliable, uniform protocol for the private surface

## Why this exists
v1 grew three unrelated response mechanisms — JSON on port 260, binary chunks on 261, text
replies on port 1 — all **broadcast, fire-and-forget**. Broadcasts cannot be ACKed, so the
measured ~17-20 % uplink loss is **silent and unrecoverable**, and the JSON path keeps
hitting the 237-byte single-frame cap (the `sch` pagination and `jsonBuild` shedding are both
just workarounds for that cap). v2 collapses this to two clean lanes with real delivery
guarantees.

## The two lanes
1. **Comfort lane** — `ping`, `status` (maybe `env`): stay TEXT, but sent as **DMs**
   (`to = rx.from`, `want_ack`). Human-readable, one round-trip, ack + retransmit.
2. **Machine lane** — everything else (`config`, `schema`, `debug`, `calc`, images):
   **chunked, always**, on **one private port**, even when the payload would fit one frame.
   One reliable code path; the chunk layer's per-chunk + whole-payload CRC makes truncation
   impossible, so no per-frame fitting logic is ever needed again.

## Decided changes (the scope of the eventual code work — NOT this step)
1. Transport: set `wantAck=true` (packFlags already supports the flag — never set today);
   address responses to `rx.from`, not `BROADCAST_ADDR`; drive `resend()` off the no-ACK timeout.
2. One private port: retire `PAC_ALARM_APP` (260) as a response port; all machine responses
   ride the single chunk port. `TELEMETRY`/`NODEINFO`/`POSITION` stay on native portnums.
3. Chunk the JSON responses as `ptype`s (`SCHEMA=1`, `IMAGE=2` already exist; add
   `config`/`debug`/`calc`, or one generic JSON ptype). **Chunk wire format unchanged** — this
   is an extension via `ptype`, which is exactly why image transfer does not break.
4. Route `jsonBuild` output into the chunk publish path instead of `send()`.
5. Small responses may use **push** (device streams) rather than the pull handshake.
6. Comfort path: `ping`/`status` reply as text DMs.
7. Remove `jsonBuild` size-shedding (`JReq` MUST/OPTIONAL, fit-loop, reserved-brace) and the
   `sch` pagination — obsolete once chunked. Builder collapses to always-emit. **Verify every
   `jsonBuild`/`JReq` caller before deleting** — this partly unwinds fw 260721-11.
8. Retire `@xxxx` name-prefix addressing → DM by nodeNum (kills the short-name footgun).

## Explicitly OUT OF SCOPE
- **Channel-0 private-vs-primary config.** An independent decision at the channel/hash layer.
  The v2 port/DM/chunk changes do not touch it and it does not touch them (`send()` stamps the
  channel hash identically on every packet regardless of port/addressing/framing). Batch into a
  single field touch if both proceed, but decide separately.

## Coordination model (changed this session)
- `docs/v2/` is the **durable contract**. node-dash will **symlink** to it, so both sides read
  one source of truth.
- **xsession is downgraded to ambiguities / clarifications only** — no more exchanging the
  actual contract over the channel.

## Single source of truth (decided)
- **`docs/v2/APIV2.md` is the SSOT.** Every implementation — device firmware, `clients/node`,
  the future `clients/python` — MUST comply with it; where code and APIV2 disagree, APIV2 wins
  and the code is wrong. Consumers may also read APIV2 directly for context.
- **Consumer libraries** live under `clients/<lang>/`, each a conformant, import-and-use
  implementation that hides all protocol mechanics; the **consumer injects identity**
  (channel name/PSK, gateway id) — secrets are never baked into a lib. `clients/node` exists;
  `clients/python` is a **documented placeholder only — not built** (no Python consumer yet).
- Distribution/packaging (npm/pip vs path-load) is explicitly **not decided now**.

## This step's deliverable
Only the two docs below, reviewed and agreed **before any firmware change**:
- `docs/v2/README.md` — scope + rationale.
- `docs/v2/APIV2.md` — the wire contract: single port, 16-byte header + chunk headers, the
  `ptype` registry, comfort-command list, and request/response flows.

## Deployment note
Breaking, coordinated cutover — a mismatched protocol between device and node-dash = total
comms loss, so the two sides flip together. Bench `!8cee336b` only during dev; field unit
`!987ab80f` untouched; deployed `mylibs/mt-chunk` untouched.
