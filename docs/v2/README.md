# mt-transport v2 — scope & rationale

**Status:** contract at **v2.1** (2026-07-22). Phase 0 frozen; Phase 1 landed both ends. **Direction: PKI DMs (Phase 1b)** — the broadcast comfort lane is an interim state, not the design. These docs are the
source of truth; the wire contract lives in [`APIV2.md`](./APIV2.md). node-dash symlinks this
directory. xsession is now for **ambiguities/clarifications only** — not for carrying the
contract.

---

## The problem v2 fixes

v1 accreted three unrelated response mechanisms, all **broadcast, fire-and-forget**:

| lane (v1) | port | framing |
|---|---|---|
| text replies (ping/status/…) | 1 (TEXT) | plain text |
| JSON telemetry/config/schema | 260 (`PAC_ALARM_APP`) | `snprintf` JSON, one frame |
| binary images | 261 (`PAC_CHUNK_APP`) | chunk protocol |

Two structural faults fall out of that:

1. **Silent, unrecoverable loss.** A broadcast cannot be ACKed, so the measured **~17-20 %
   uplink loss** is invisible and never retried. Nothing detects a dropped reply; nothing
   resends it. This is the root cause behind "status sometimes just doesn't come back."
2. **The 237-byte frame cap.** JSON responses must fit one Meshtastic frame. Everything built
   to cope with that — the `sch` 6-page pagination, the `jsonBuild` optional-shedding — is a
   workaround for a cap that v2 removes.

## The v2 model — two lanes

### 1. Comfort lane (human-facing)
`ping` and `status` stay **plain text, broadcast**. (`env` is *not* comfort — its reading is
structured data, so it rides the machine lane.)

> **Amended 2026-07-22 (APIV2 §5.1).** These were designed as `want_ack` **DMs** to get an ACK +
> retransmit. Proven on air not to work: **Meshtastic 2.8 rejects PSK-encrypted DMs** ("legacy
> DM") and we encrypt with the channel PSK, not PKI. The device transmitted the DM correctly
> (flags `0x6B`, `to` = gateway) and mesh-gw's raw event stream saw **nothing**; `onair-ping`
> scored 0/3, and 3/3 once reverted to broadcast. **Meshtastic-level `want_ack` therefore cannot
> make gateway-facing traffic reliable** — that job falls entirely to the machine lane's
> pull/re-PULL ARQ below, which is the real reliability win in v2.

### 2. Machine lane (everything else)
`env`, `config`, `schema`, `debug`, `calc`, and images are **chunked, always** — even a 40-byte
`config` — on **one private port (`261`)**. Rationale:

- **One reliable code path.** No "does it fit one frame?" branching, ever.
- **Truncation becomes impossible.** The chunk layer already carries a per-chunk CRC and a
  whole-payload CRC, so a response is either delivered whole or refetched — never half-parsed.
- **It's an extension, not a rewrite.** The chunk protocol already has a `ptype` field
  (`SCHEMA=1`, `IMAGE=2` exist). Other responses become new `ptype`s over the **unchanged**
  wire format — which is exactly why image transfer does not break.

The deliberate trade: a sub-frame reply now costs a short chunk handshake instead of one
frame. Accepted — uniformity and reliability over per-message efficiency.

## What changes, concretely
See the change list in [`../../specs/v2-transport.md`](../../specs/v2-transport.md). In brief:
`want_ack` + retransmit; one private port (`261` kept, `260` retired as a response port); JSON
responses published under a single generic `JSON` chunk `ptype`; `jsonBuild` size-shedding and
`sch` pagination removed; `@xxxx` name addressing replaced by DM-to-nodeNum **once PKI lands (Phase 1b)** — it must stay until then, as PSK DMs are rejected by the gateway.

## What v2 does NOT touch
- **Channel-0 private-vs-primary config.** Independent decision at the channel/hash layer.
  `send()` stamps the channel hash identically on every packet regardless of port, addressing,
  or framing — so v2 and the channel layout never intersect in code. Decide it separately;
  batch into one field visit only if both happen to proceed together.
- **Standard Meshtastic ports.** `TELEMETRY`, `NODEINFO`, `POSITION` keep their native
  portnums for phone / Meshtastic-native interop.
- **Deployed `mylibs/mt-chunk`** on the un-reflashable field unit — v2 dev is bench-only.

## Frozen decisions (Phase 0 — 2026-07-22)
The four contract questions are resolved; `APIV2.md` is stamped `v2.1` and carries no `TBD`.

1. **Port number → keep `261`** (`PAC_CHUNK_APP`); retire `260`. The chunk lane already lives
   on `261` with an unchanged wire format — no new portnum to register on either end.
2. **Comfort set → `ping` + `status` only.** `env` moves to the machine lane (structured data,
   not a one-glance human line). ⚠️ **Amended 2026-07-22:** the *set* stands, but they are
   carried as **broadcast text, not want_ack DMs** — Meshtastic 2.8 rejects PSK DMs (APIV2 §5.1).
3. **ptype granularity → one generic `JSON` ptype (`4`)** for every machine-lane JSON response;
   the JSON's own `t` field names the specific response. `SCHEMA` (1) is superseded; `IMAGE` (2)
   stays its own binary ptype.
4. **Small responses → pull by default** — client asks, device manifests, client pulls and
   reassembles. Push stays for images and unsolicited events, not command responses.

## Consumer libraries — we own the mesh, so consumers shouldn't have to know it

`APIV2.md` is the **single source of truth**. Everything that speaks the protocol — device
firmware, `clients/node`, the future `clients/python` — complies with it; if code and APIV2
disagree, **APIV2 wins**.

A consumer should **import a library and use it unmodified**, knowing nothing about ports,
channel hashes, chunk indices, or retries. Those live inside the lib:

```
clients/
  node/     # EXISTS — mt-transport@1.x: Client, chunk codec, queue, events (the reference impl)
  python/   # PLACEHOLDER — documented, NOT built (no Python consumer yet)
```

- **Import-and-use.** The consumer configures a connection and calls high-level verbs
  (`status()`, `config()`, `onImage()`), never constructing a frame.
- **Identity is injected, never baked in.** The lib carries the *protocol* (ports, ptypes,
  framing, the channel-hash algorithm); the consumer supplies **channel name/PSK and gateway
  id** via config. Secrets never live in a lib.
- **Conformance keeps languages honest.** Libs are tested byte-for-byte against **fixtures
  generated from the firmware** (the existing `clients/node/test/cross-cpp.js` is the model).
  The firmware defines the wire; each lib proves it matches; APIV2 documents it.
- **Distribution (npm/pip vs path-load) is not decided yet** — out of scope for now.

## Delivery plan — phased, tested, reversible

Each phase is a self-contained, tested slice built **bottom-up**. v2 runs **alongside v1**
until the deliberate breaking phases, so nothing is taken away until its replacement is proven
(the pattern push already uses beside pull). `pre-v2` (tagged across all repos) is the rollback
point behind everything.

**Governing rules for every phase:**
- One `/idiot` task + spec; no phase touches code outside its spec.
- A phase lands **both ends** — firmware *and* the nodejs lib — plus its tests. "Done" is never
  all-firmware-then-all-lib; APIV2 binds them, so they move together.
- **Layered testing:** offline codec/fixtures (no radio) → single bench device → on-air.
- Bench `!8cee336b` only. Field unit `!987ab80f` untouched until the final cutover.

| phase | delivers | breaking? |
|---|---|:--:|
| **0** ✅ | **Freeze the contract** — resolved the 4 TBDs (port, comfort set, ptype granularity, pull-vs-push) and stamped APIV2 `v2.0`. **Done 2026-07-22** (see "Frozen decisions" above). Gated everything. | — |
| **1** ✅ | **Reliability layer** — `want_ack` + retransmit, transport-owned. Landed both ends. ⚠️ DM addressing proved unusable (2.8 rejects PSK DMs, APIV2 §5.1); comfort stays broadcast until **1b**. | no |
| **2** | **Chunk-everything** — `config`/`debug`/`calc`/`schema` as chunk ptypes; lib verbs pull+reassemble. **Old 260 path stays live in parallel** — A/B-able. | no |
| **1b** | **PKI (PKC) DMs** — X25519+SHA256+AES-CCM, `channel=0` marker. Unblocks acked DMs. Gates the comfort lane and `@xxxx` retirement. `specs/v2-phase1b-pki.md`. | no |
| **3** | **Collapse to one port**; retire `@xxxx` **only after 1b** (DM by nodeNum needs PKI). First deliberately-breaking step. | **yes** |
| **4** | **Remove dead code** — `jsonBuild` shedding, `sch` pagination, old 260 sends — only after 2/3 proven, only after grepping every caller. | **yes** |
| **5** | **Conformance + coordinated cutover** — full fixture conformance, bench e2e, one-shot device+node-dash field cutover. | **yes** |

## Test strategy — cumulative, contract-based, no-hallucinate

Regression safety is **structural, not a promise.** Built on the existing
`clients/node/test/` harness (`run.js`, `cross-cpp.js`, `offline-*`, `onair-*`, `npm test`).

**Two tiers, both cumulative:**

| tier | against | determinism | runs |
|---|---|---|---|
| **Offline** | recorded fixtures + codec, no radio | 100% deterministic | every run, every phase — the regression backbone |
| **On-air** | bench `!8cee336b` | real, lossy | each phase boundary + before cutover |

**Rules that make it a real net:**
1. **Cumulative & phase-tagged (`P1…P5`).** A later phase runs the **full** prior suite; Phase 3's
   port-collapse must keep P1/P2 green or it fails.
2. **Assert the CONTRACT, not the mechanism.** A test says *"a valid `status` object is
   retrievable"*, never *"status arrives on port 260."* That is what lets the suite survive the
   breaking phases — the capability is stable even when the mechanism changes.
3. **No-hallucinate.** Assertions are on **decoded bytes / parsed objects / causal side effects**,
   never timing. Every phase closes with the test **run and its real output shown**.
4. **Idempotent.** Setup/teardown restores any state touched (persisted config, hop override), so
   it re-runs safely any number of times. On-air tests are loss-aware (retry within the ack
   window / report loss explicitly) so real radio loss is never a flaky false-fail.
5. **One command.** `npm test` = full offline suite; a tagged runner drives the on-air tier.
6. **Conformance = the lockstep guarantee.** Firmware generates fixtures; the lib must decode them
   identically (`cross-cpp.js` is the model). Firmware and lib cannot drift without a red test.

**A phase is "done" only when:** its new tests pass **AND** the full accumulated offline suite is
green **AND** the on-air suite passes on the bench — all with output shown.

## Deployment
Breaking, coordinated cutover: a device/node-dash protocol mismatch = total comms loss, so
both sides flip together. Bench `!8cee336b` during dev; field unit `!987ab80f` untouched.
