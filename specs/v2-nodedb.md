---
task: v2-nodedb
status: REVISION 2 IMPLEMENTED + OBSERVED 2026-07-22/23 (fw 2-260722-14) — key learned OTA
        from TA2m in 3 s of the first undecryptable DM; DMs ack'd + PKC replies delivered.
priority: unblocks PKI DMs without hardcoding another device's identity into firmware
source_hash: src/MeshtasticTransport.h 07ed28ab0f4e1a200cacd4af864ed69fe22888a47e9707f641f90bf177ec9a8a; src/MeshtasticTransport.cpp ce518eb213ac78721129e3bd3e4d37613ceaba7ce864e25e240d30d04a61453e; ../pac-garage-alarm/src/main.cpp 0741f142fb7eb83472d082ebbee39c520b622d2ebc6bd72fe280cf278e1f1965; ../pac-garage-alarm/platformio.ini f59df0ebac2ae4aa8e1065c3f6125e8a3edd1eab16fb915aa10c4a470685de2e
project: pac-garage-alarm (owns flash/persistence). mt-transport keeps only its RAM peer table.
scope:
  - (pac-garage-alarm) src/mt_nodedb.h    # 16-entry ring (BUILT)
  - (pac-garage-alarm) src/mt_nodedb.cpp  # learn/refresh/evict/persist (BUILT)
  - (pac-garage-alarm) src/main.cpp       # NODEINFO handler + rev 2: key request, DM ack, fw bump
  - (pac-garage-alarm) include/secrets.h  # peer key = optional SEED (BUILT)
  - src/MeshtasticTransport.h             # rev 2: one-shot want_response setter
  - src/MeshtasticTransport.cpp           # rev 2: Data.want_response fill in buildAndQueue
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

---

# REVISION 2 (2026-07-22 ~23:30) — active key request + DM delivery receipt

## Evidence forcing this (bench, fw 2-260722-13, 23:22–23:24)
Peter DM'd the bench from TA2m (!da5af428): `pkiRxNoKey` climbed 1→4,
`pkifrom=da5af428` — the DMs ARRIVE and are dropped for lack of the sender's key.
TA2m's NodeInfo never airs on ch2 (its primary is another channel — the index
mismatch, bugs-enhancements task 3), so passive learning can never fire for it.
The OMNI's nodedb key was the secrets.h SEED, not OTA learning; no key has ever
been learned over the air. Peter rejects seeding more peers. This is the fix the
14:22 note (id:1277) predicted after the `nodes clear` dead-end.

Bootstrap legality verified in the vendored 2.8 source: "Rejecting legacy DM"
(Router.cpp:544-546) applies ONLY to TEXT_MESSAGE_APP — a directed NODEINFO under
the channel PSK decodes fine on a stock node; upstream itself sends directed
NodeInfo on the traffic's channel (MeshService.cpp:100, ReliableRouter.cpp:134).
Also observed: OMNI ACKs our PKC DMs with PSK routing frames on the channel
(port=5 decoded via the PSK path, pkiRxOk unmoved) — so our ACKs may mirror that.

## Change A — mt-transport: expose Data.want_response (one-shot, no call-site churn)

`src/MeshtasticTransport.h`, next to `scheduleNextTxIn()`:
```c
    // One-shot: the NEXT enqueued frame carries Data.want_response = true.
    // Used by the key-request bootstrap (directed NodeInfo asking the peer to
    // answer with its User/public key). Mirrors the scheduleNextTxIn pattern.
    void wantResponseNext() { _wantRespNext = true; }
```
private: `bool _wantRespNext = false;`

`src/MeshtasticTransport.cpp` `buildAndQueue()`, with the other Data fields:
```c
    data.request_id = requestId;
    data.reply_id = replyId;
    data.want_response = _wantRespNext;   // NEW
    _wantRespNext = false;                // NEW — consumed whether or not the send succeeds
```
(Placed BEFORE the encode; cleared unconditionally so a failed send cannot leak
the flag onto an unrelated later frame.)

## Change B — main.cpp: sendNodeInfo grows dest + wantResponse (defaults keep all 4 callers unchanged)

~L1283: `static void sendNodeInfo()` →
`static void sendNodeInfo(uint32_t to = mt::BROADCAST_ADDR, bool wantResponse = false)`

~L1329 send call:
```c
    if (wantResponse)
        mesh.wantResponseNext();
    report("NODEINFO", mesh.send(meshtastic_PortNum_NODEINFO_APP, buf, os.bytes_written, to));
```

## Change C — main.cpp: maybeRequestKey() + 12 h per-node limiter (after sendNodeInfo)

```c
// Key bootstrap: ask an unknown peer for its key by sending OUR NodeInfo,
// DIRECTED, want_response=true (upstream MeshService.cpp:100 pattern). The peer
// suppresses replies to one per requester per 12 h (NodeInfoModule.cpp:20,34-44
// — the REQUEST is recorded even when the reply is throttled), so asking more
// often than that is provably useless airtime; the limiter matches the window.
static const uint32_t KEYREQ_BACKOFF_MS = 12UL * 3600UL * 1000UL;
static const uint8_t  KEYREQ_N = 4;
static struct KeyReq { uint32_t node, atMs; } g_keyReq[KEYREQ_N] = {};
static void maybeRequestKey(uint32_t node)
{
    if (!node || node == mt::BROADCAST_ADDR || node == g_nodeNum || mtdb::keyFor(node))
        return;
    const uint32_t now = millis() | 1;               // atMs 0 = empty slot
    uint8_t slot = 0;
    for (uint8_t i = 0; i < KEYREQ_N; i++) {
        if (g_keyReq[i].node == node) {
            if (now - g_keyReq[i].atMs < KEYREQ_BACKOFF_MS)
                return;                              // peer would suppress anyway
            slot = i;
            break;
        }
        if (g_keyReq[i].atMs == 0)
            slot = i;                                // free slot wins
        else if (g_keyReq[slot].atMs != 0 &&
                 (int32_t)(g_keyReq[i].atMs - g_keyReq[slot].atMs) < 0)
            slot = i;                                // else evict the oldest
    }
    g_keyReq[slot] = {node, now};
    DBG("KEYREQ: 0x%08lx\n", (unsigned long)node);
    sendNodeInfo(node, /*wantResponse=*/true);
}
```

## Change D — main.cpp: the two triggers

1. Inbound PKC we could not decrypt — in loop(), after `mesh.service()`:
```c
    // A PKC frame we couldn't decrypt names exactly the peer whose key we lack.
    static uint32_t s_noKeySeen = 0;
    if (mesh.pkiRxNoKey() != s_noKeySeen) {
        s_noKeySeen = mesh.pkiRxNoKey();
        maybeRequestKey(mesh.pkiLastFrom());
    }
```
2. Comfort reply fell back to broadcast for lack of a key — handleCommand, after
the `if (sent) ... else sendReply(...)` block:
```c
        if (comfort && !sent && rx.from != mt::BROADCAST_ADDR)
            maybeRequestKey(rx.from); // broadcast served; fetch the key for next time
```

## Change E — main.cpp: delivery receipt for ALL directed want_ack texts (~L3227)

Current: the ACK lives inside the `isCommandText()` branch, so a plain DM gets
neither ACK nor handling — the phone shows it undelivered forever. New:
```c
        } else if (rx.portnum == meshtastic_PortNum_TEXT_MESSAGE_APP) {
            // Delivery receipt for ANY directed want_ack text, command or not —
            // a plain DM must read "delivered" even though only @-commands are
            // acted on. (Stock 2.8 ACKs PKC DMs the same way: PSK routing frame
            // on the channel — observed from the OMNI 2026-07-22.)
            if (rx.wantAck && rx.to == g_nodeNum)
                report("ACK    ", mesh.sendAck(rx.from, rx.id));
            if (isCommandText(rx))
                handleCommand(rx);
        }
```

## Change F — FW_VERSION "2-260722-13" → "2-260722-14" (L89)

## Known limitations (accepted, documented)
- If the peer's own 10-min NodeInfo throttle happens to eat our request's reply,
  the next chance is 12 h away (their suppress records the REQUEST regardless).
  Unlikely collision (their periodic NodeInfo is hours apart); manual fallback:
  request node info from the phone app, which lands on ch2 and is learned.
- A retransmitted DM whose first ACK was lost is deduped by the transport before
  the app sees it, so it is not re-ACKed. Phone retries ride on TA2m's
  ReliableRouter (3 attempts); at bench RSSI the triple-loss odds are negligible.
  Transport-level re-ACK of duplicates is a possible follow-up, not rev 2.

## Deliberately NOT changed
- No transport auto-ACK policy (mechanism stays in the app; sendAck exists).
- Nodedb ring/persistence/`nodes` commands: already built and verified.
- The OMNI seed stays (cold-start for the gateway path only).

## Verify (rev 2)
1. Static: statics/params in place; build clean.
2. Functional (bench): flash → Peter DMs from TA2m → serial shows KEYREQ line,
   then NODEDB "key learned" for da5af428, `nodes` shows a non-0000 fingerprint,
   next DM shows pki=ok increment; plain DM shows ACK sent and "delivered" on the
   phone; `@336b ping` DM'd from TA2m gets a PKC pong.
3. Regression: boot-bundle broadcast NodeInfo unchanged; OMNI comfort path
   (status/ping via gateway) still delivered+ACKed; HB continuity unbroken.
