# clients/python — PLACEHOLDER (not built)

**Status: placeholder. No code here yet.** There is no Python consumer today, so this library is
**defined but deliberately unbuilt** (YAGNI). This file documents its intended scope so the slot
is reserved and the contract is clear if/when a Python consumer appears.

## What this will be
A Python port of `clients/node` — a conformant, import-and-use consumer library for the PAC
private Meshtastic protocol. A Python consumer would:

```python
from mt_transport import Client            # illustrative — API mirrors clients/node

client = Client(host="localhost:8000", gateway_id="!2687afb1",
                channel_name=..., channel_psk=...)   # identity INJECTED, never baked in
status = client.status()                   # high-level verb; no frames, no ports, no chunks
client.on_image(lambda img: ...)           # reassembly/retries hidden
```

## Hard requirements (inherited from clients/README.md and the SSOT)
1. **Complies with [`../../docs/v2/APIV2.md`](../../docs/v2/APIV2.md)** — the single source of
   truth. Where this library and APIV2 disagree, APIV2 wins.
2. **Import-and-use** — high-level verbs only; the consumer never touches a portnum, channel
   hash, or chunk header. API mirrors `clients/node` so the two stay recognisable.
3. **Identity injected, never baked in** — channel name/PSK and gateway id come from the
   consumer's config. No secrets in library code.
4. **Conformance-tested against the firmware fixtures** — the same recorded frames that
   `clients/node/test/cross-cpp.js` checks, decoded byte-for-byte identically here.
5. **Reports its protocol version** so a consumer can detect a device/library mismatch.

## Explicitly out of scope for now
- The implementation itself (no consumer → not built).
- Packaging/distribution (pip vs path-load) — undecided project-wide.

## When someone does build it
Start from `clients/node` as the behavioural reference, generate/reuse the firmware fixtures,
and make the conformance suite pass **before** wiring any real consumer to it.
