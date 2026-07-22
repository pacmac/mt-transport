---
task: v2-nodedb
status: SPEC 2026-07-22 — design agreed with Peter in discussion. GATED on the NodeInfo
        measurement below; do not implement the learning path until that is answered.
priority: unblocks PKI DMs without hardcoding another device's identity into firmware
source_hash: ~
project: pac-garage-alarm (owns flash/persistence). mt-transport keeps only its RAM peer table.
scope:
  - (pac-garage-alarm) src/mt_nodedb.h    # NEW — 16-entry ring: nodeNum, public_key, last_heard, short_name
  - (pac-garage-alarm) src/mt_nodedb.cpp  # NEW — learn/refresh/evict/persist
  - (pac-garage-alarm) src/main.cpp       # NODEINFO handler, command admission, `nodes` commands, wiring
  - (pac-garage-alarm) include/secrets.h  # peer key becomes an optional SEED, not the only source
---

# v2 — small node database on the alarm

## Why
The PKI peer key is currently a hardcoded constant in `secrets.h`. Peter: **"that is
unworkable"** — and he is right. The field unit `!987ab80f` has no OTA, so if the gateway's key
ever changed, DMs would break permanently and recovery would be a drive plus a reflash.
Hardcoding another device's identity is exactly the coupling we removed everywhere else (node
numbers from FICR, names/coords from the secrets table).

## GATE — measure this FIRST, it decides whether any of this is worth building
**Does the gateway's NodeInfo reach us on channel 2?**

Our transport drops any packet whose channel hash ≠ ours, so we can only decode NodeInfo from
nodes sharing our private PSK. Meshtastic sends NodeInfo on the primary channel by default. If
OMNI's NodeInfo only goes out on the public channel, **we can never learn its key**, and no
amount of nodedb helps — the fix would be a gateway-side config change instead.

### GATE RESULT — ANSWERED, learning IS viable (2026-07-22, from the reference source)
The periodic broadcast does default to channel 0 (`NodeInfoModule.h:24`,
`sendOurNodeInfo(dest = NODENUM_BROADCAST, wantReplies = false, channel = 0)`), which we cannot
decode. **But it is not the only trigger** — two paths send NodeInfo on the channel the traffic
arrived on, i.e. OUR channel:

- `MeshService.cpp:100-107` — *"Heard new node on ch. %d, send NodeInfo and ask for response"*
  → `nodeInfoModule->sendOurNodeInfo(mp->from, true, mp->channel)`
- `ReliableRouter.cpp:134-140` — on `PKI_UNKNOWN_PUBKEY`: *"PKI decrypt failure, send a NodeInfo"*
  → `nodeInfoModule->sendOurNodeInfo(p->from, false, p->channel, true)`

The second is a genuine self-healing loop: a peer that cannot decrypt our PKC DM answers by
re-advertising its NodeInfo on our channel, which is exactly when we need its key.

So NodeInfo very likely already reaches us on channel 2 and the firmware simply **ignores port 4**
(there is no handler today) — consistent with captures showing inbound ports 1, 5, 67, 260 and
nothing acting on NodeInfo. Implement the learning path; confirm empirically via the `nodes`
command once it exists (that is cheaper and more definitive than a blind serial vigil, since the
periodic interval is hours).

## MEASURED GAP — key re-learning has NO trigger (2026-07-22, proven on the bench)
Ran `nodes clear` on the bench, then re-queried:

```
14:18:45Z {"type":"nodes","n":2,"nd":[[646426545,"4363",0],[2558179343,"0000",4]]}
14:20:44Z {"type":"nodes","n":2,"nd":[[2558179343,"0000",54],[646426545,"0000",0]]}
```

Both nodes were re-ADMITTED (admission works) but the gateway key went `4363` -> `0000`
and **never came back**. The device could not DM again until a reboot re-seeded from
`secrets.h`.

**Why:** the only two paths that put NodeInfo on our channel are "gateway heard a NEW
node" (we are not new to it) and "PKI decrypt failure" (needs us to SEND PKC, which we
cannot without a key). Neither can fire, so a lost key is permanent. Eviction is
therefore NOT the graceful degradation this spec assumed — it is a dead end.

**Fix (not yet implemented):** when we need to DM a node and hold no key, send OUR
NodeInfo to it with `want_response = true`. `NodeInfoModule::handleReceivedProtobuf`
(line 22-40) replies to that with its own NodeInfo, on the channel the request arrived
on — i.e. ours.

**HARD CONSTRAINT on that fix:** replies to `want_response` are **suppressed per sender
for 12 HOURS** (`NodeInfoReplySuppressSeconds = USERPREFS_NODEINFO_REPLY_SUPPRESS_SECS`,
NodeInfoModule.cpp:20,34-40). So we get at most ONE NodeInfo per peer per 12 h. That
means:
- We must rate-limit our own requests (one attempt, then back off — spamming is useless
  and only costs airtime).
- Recovery from a lost key can take up to 12 h, so **losing a key is expensive**.
- The `secrets.h` SEED therefore stays important as the cold-start path, and eviction of
  a keyed node should be avoided rather than merely tolerated.

## Design (agreed)
- **16-entry ring**, LRU by `last_heard`. A new node evicts the oldest.
  Record ≈45 B: `nodeNum(4) + public_key(32) + last_heard(4) + short_name(5)`. ~720 B RAM total.
  No long_name / hw_model / role / position / telemetry — we do not route and do not display.
- **Admission = anything we can decode.** The channel-hash filter already excludes the ~350
  strangers on the public mesh, so no allowlist is needed. Commands bump `last_heard`, so active
  peers naturally stay and passive ones age out — no separate "pin" mechanism.
- **Never evict the node currently being replied to** (`rx.from` of the command in hand).
  Removes the pathological case of dropping the entry we are about to use.
- **Key acquisition is NodeInfo-only.** A command does not carry the sender's key — it is never
  on the LoRa wire (`MeshPacket.public_key` is filled *from* the nodedb on decode, not from the
  air). So the ring decides who we keep; NodeInfo supplies the keys.
- **A changed key OVERWRITES, and is logged.** Meshtastic refuses (`NodeDB::updateUser` drops a
  mismatching NodeInfo wholesale) — which is exactly what has TA2m stuck, and would be
  unrecoverable on the unreflashable field unit. **Rationale: our trust boundary is the channel
  PSK, not the keypair.** A node must already hold the PSK to be decoded at all, at which point
  it can read and inject our traffic regardless — so refusing the update buys no protection
  against the only attacker who could mount it, while guaranteeing a dead end.
- **No key → broadcast fallback**, self-healing. The fallback is PERMANENT, not a Phase-3
  casualty: it covers cold boot, eviction, and any node whose NodeInfo has not yet arrived.
- **secrets.h key becomes an optional SEED**, not the sole source. It removes the cold-start gap;
  learning overrides it. The "unworkable" part was the inability to UPDATE, not the seed itself.
- **Persistence batched**, not write-per-mutation (flash wear). Follows the existing settings
  record: versioned + CRC'd, written on settled change.
- **Lives in the firmware** (it owns flash). It pushes keys into the transport via the existing
  `addPkiPeer()`; mt-transport keeps owning no storage.

## Command surface — the no-reflash escape hatch
This is the real answer to "unworkable": recovery without a drive.
- `nodes` — list held entries (num, short name, key fingerprint, age, count/16)
- `nodes forget <num>` — drop one entry
- `nodes clear` — drop all
Replies are JSON via `jsonBuild` (never raw snprintf), on the existing `@<target> <verb>` grammar.

## Not vendored
Meshtastic's `NodeDB` is not portable here — it is wired to `config`, `channels`, the filesystem
and its own protobufs, and carries routing/telemetry we do not need. We follow its SEMANTICS
where they matter (NodeInfo parsing, the key-change question — which we deliberately answer the
other way) rather than vendoring the code. This is a considered exception to
"prefer official MT implementations", not an oversight.

## Tests
- **Offline:** ring behaviour — insert, refresh-on-bump, LRU eviction order, never-evict-current,
  key overwrite, persistence round-trip incl. CRC rejection of a corrupt record.
- **On-air (bench `!8cee336b`), via the committed harness only:**
  `node clients/node/test/onair-ping.js --target 336b --count 1 --dm --expect-ack acked`
  must flip FAIL -> PASS once a key is learned. Plus `nodes` showing the gateway with a key.
- No improvised probes: node-dash sends and receives DMs and handles the PKI (see
  `specs/device-comms.md`).
