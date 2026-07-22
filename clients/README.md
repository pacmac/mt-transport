# clients/ — consumer libraries for the PAC private protocol

We own both ends of the mesh (firmware + client), so **a consumer should never re-implement the
protocol**. It imports a library from here and uses it unmodified — knowing nothing about ports,
channel hashes, chunk indices, ACKs, or retries.

## Single source of truth
**[`../docs/v2/APIV2.md`](../docs/v2/APIV2.md) is the SSOT.** Every library in this folder MUST
comply with it. Where a library and APIV2 disagree, **APIV2 wins and the library is wrong**.
A consumer may also read APIV2 directly for context, but should depend on the library, not the
raw contract.

## Layout — one directory per language
```
clients/
  node/     # EXISTS — mt-transport@1.x. The reference implementation: Client, chunk codec,
            #          push receiver, message queue, events. node-dash consumes this.
  python/   # PLACEHOLDER — scope documented in python/README.md; NOT built (no consumer yet).
```

## Rules every library here follows
1. **Import-and-use.** Expose high-level verbs (`status()`, `config()`, `schema()`,
   `onImage()`, `command()`), returning parsed objects. The consumer never constructs or parses
   a frame.
2. **Identity is injected, never baked in.** The library carries the *protocol* — ports, ptypes,
   framing, the channel-hash *algorithm*. The consumer supplies **channel name/PSK and gateway
   id** via configuration. Secrets never live in library code (see the project's
   no-hardcoded-identity rule).
3. **Conformance-tested against firmware fixtures.** The firmware defines the wire; each library
   proves byte-for-byte equivalence against recorded fixtures. `node/test/cross-cpp.js` (JS vs
   the C++ `mt-chunk` fixtures) is the model — every language joins the same fixture suite.
4. **Protocol version is explicit.** A library reports the protocol version it implements so a
   consumer can detect a device/library mismatch instead of silently mis-decoding. (v2 replaces
   today's hand-matched `pushProtoVersion` in `node/package.json`.)

## Not decided yet
- **Distribution/packaging** (npm/pip published packages vs path-load/symlink). Out of scope for
  now; libraries are consumed in-repo.
