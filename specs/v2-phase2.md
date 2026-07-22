---
task: v2-phase2-chunk-everything
status: SPEC — not yet implemented. Decisions made on Peter's behalf 2026-07-22 (delegated).
priority: v2 Phase 2 — chunk the JSON responses; NON-BREAKING (runs alongside the v1 260 path)
source_hash: ~   # set when implementation begins
project: spans mt-transport/clients/node, mylibs/mt-chunk (+ mt-chunk-push), pac-garage-alarm.
         Each repo gets its own /idiot task; this spec is the shared contract reference.
scope:
  - (mylibs/mt-chunk) src/MtChunk.h            # add ptype JSON = 4 to the ptype enum
  - (mylibs/mt-chunk) test/…                   # C++ fixture generation for JSON payloads
  - clients/node/lib/chunk.js                  # PTYPE.JSON const; no frame-format change
  - clients/node/index.js                      # high-level verbs: config/schema/debug/calc/env
  - clients/node/test/offline-json-ptype.js    # NEW — decode a JSON-ptype manifest+chunks
  - (pac-garage-alarm) src/main.cpp            # publish JSON responses as JSON-ptype payloads
---

# v2 Phase 2 — chunk everything (generic JSON ptype = 4)

Phase 0 froze: **one generic JSON ptype (4)**; the JSON's own `t` field names the response;
**pull** is the default. This phase adds that ptype and the client verbs, **alongside** the
existing port-260 raw-JSON path (A/B-able; nothing removed until Phase 4).

## DECISIONS (made on Peter's behalf)
- **D2.1 ptype `JSON = 4`** (SCHEMA=1 superseded, IMAGE=2 binary, LOG=3 unchanged). One number,
  registered identically in `MtChunk.h`, `chunk.js`, and APIV2 (already stamped there in Phase 0).
- **D2.2 The consumer routes on the JSON `t` field, not on ptype.** `config`/`schema`/`debug`/
  `calc`/`env` are all ptype 4; `JSON.parse` then switch on `t`. This is why one ptype suffices.
- **D2.3 node verbs:** `client.config()`, `.schema()`, `.debug()`, `.calc()`, `.env()` each →
  `GETMANIFEST` → `MANIFEST` → `PULL` → reassemble → verify whole-payload CRC → `JSON.parse`.
  Reuse the existing `ChunkClient`/`PayloadStore` pull+repair machinery unchanged.
- **D2.4 Firmware publishes BOTH ways this phase:** the existing 260 raw-JSON send stays; the
  same JSON is ALSO offered as a pullable JSON-ptype payload. Lets node-dash A/B old vs new with
  the field unit untouched. Old path is deleted only in Phase 4.
- **D2.5 `env` becomes machine-lane here** (Phase 0 moved it off comfort). Its reading is a
  JSON-ptype payload like config; no more text env reply.

## Tests (no-hallucinate)
- **Offline (`offline-json-ptype.js`):** feed a C++-generated MANIFEST(ptype=4)+CHUNK set through
  `chunk.decodeFrame` + `ChunkClient`, assert the reassembled bytes `JSON.parse` and carry the
  expected `t`. Extends `cross-cpp.js` conformance to ptype 4.
- **On-air (bench):** `client.config()` end-to-end against `!8cee336b`; assert a valid config
  object comes back (the CONTRACT), independent of which port carried it. Bench only.
- Gate: `pio run` clean in every touched firmware/lib repo before any on-air claim.

## Out of scope
Removing the 260 path (Phase 4), port collapse / @xxxx (Phase 3). This phase only ADDS.
