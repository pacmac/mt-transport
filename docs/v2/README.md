# mt-transport v2 — scope & rationale

**Status:** design agreed, contract drafted. **No firmware changed yet.** These docs are the
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
`ping`, `status` (and possibly `env`) stay **plain text**, but are sent as **direct messages**
(`to = rx.from`, `want_ack`). One round-trip, human-readable in a phone/chat client, and now
**acked + retried** on loss.

### 2. Machine lane (everything else)
`config`, `schema`, `debug`, `calc`, and images are **chunked, always** — even a 40-byte
`config` — on **one private port**. Rationale:

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
`want_ack` + retransmit; one private port (260 retired as a response port); JSON responses
published as chunk `ptype`s; `jsonBuild` size-shedding and `sch` pagination removed; `@xxxx`
name addressing replaced by DM-to-nodeNum.

## What v2 does NOT touch
- **Channel-0 private-vs-primary config.** Independent decision at the channel/hash layer.
  `send()` stamps the channel hash identically on every packet regardless of port, addressing,
  or framing — so v2 and the channel layout never intersect in code. Decide it separately;
  batch into one field visit only if both happen to proceed together.
- **Standard Meshtastic ports.** `TELEMETRY`, `NODEINFO`, `POSITION` keep their native
  portnums for phone / Meshtastic-native interop.
- **Deployed `mylibs/mt-chunk`** on the un-reflashable field unit — v2 dev is bench-only.

## Open decisions (yours — not assumed in these docs)
1. **Port number:** keep `261`, or mint a fresh v2 port and retire both 260 and 261?
2. **Comfort set:** `ping` + `status` only, or include `env`?
3. **ptype granularity:** one generic `JSON` ptype for all machine responses, or a distinct
   ptype per response class (`config`/`debug`/`calc`)?
4. **Small responses:** pull (client asks) or push (device streams) as the default?

`APIV2.md` marks each of these **TBD** where it depends on the answer.

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

## Deployment
Breaking, coordinated cutover: a device/node-dash protocol mismatch = total comms loss, so
both sides flip together. Bench `!8cee336b` during dev; field unit `!987ab80f` untouched.
