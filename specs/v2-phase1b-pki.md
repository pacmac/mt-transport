---
task: v2-phase1b-pki
status: SPEC — not implemented. Unblocks the comfort-DM design that Phase 1 proved dead
        (APIV2 §5.1: Meshtastic 2.8 rejects PSK DMs). Peter's call 2026-07-22: "we need to
        use PKI, that's fine". ONE OPEN QUESTION for Peter — see "Channel 0" below.
priority: v2 Phase 1b — PKI (PKC) direct messages. Prerequisite for ANY reliable DM.
source_hash: ~
project: mt-transport (crypto + transport). Firmware follows once the lib supports it.
scope:
  - src/mt_pki.h / src/mt_pki.cpp     # PKC encrypt/decrypt — to be REPLACED by vendored CryptoEngine
  - src/mt_crypto_engine.h / .cpp     # NEW — VENDORED Meshtastic CryptoEngine PKC (official impl)
  - src/aes-ccm.h / src/aes-ccm.cpp   # vendored AES-CCM (Crypto lib has NO CCM)
  - src/MeshtasticTransport.h/.cpp    # PKI send path + RX branch for channel==0 directed
  - src/mt_wire.h                     # PKC constants
  - test/offline_pki_vectors.cpp      # host known-answer vectors
  # firmware end — "lands both ends" (sibling repo):
  - ../pac-garage-alarm/src/main.cpp        # publish User.public_key; comfort reply via sendPki;
                                            # revisit is_unmessagable; FW_VERSION bump
  - ../pac-garage-alarm/include/secrets.h   # injected PKI private key + peer public key (gitignored)
  - ../pac-garage-alarm/platformio.ini      # declare mt-transport version requirement
  - ../pac-garage-alarm/docs/spec-nodeinfo-unmessagable.md  # its "we do not implement PKI" premise is void
---

## ACCEPTANCE TEST (the gate — must flip FAIL -> PASS)
    node clients/node/test/onair-ping.js --target 336b --count 1 --dm --expect-ack acked
Today it FAILS: gateway holds `public_key: NONE` for the bench, so Meshtastic refuses to send the
DM (`Router.cpp:750`, "refusing to send legacy DM") — status stays `queued`, no ack, no reply.
Publishing a public key makes the chain `queued -> sent -> acked` with a reply. That flip is the
proof PKI works; nothing else counts as done.

# v2 Phase 1b — PKI (PKC) direct messages

Phase 1 proved a PSK-encrypted DM is silently discarded by a Meshtastic 2.8 gateway
("legacy DM"). PKI is the supported path, so the comfort lane can be a real acked DM after all.

## Verified algorithm (read from the reference implementation, NOT from memory)
Source: `/usr/share/pac/dev/projects/mt-radar/firmware/src/src/mesh/CryptoEngine.cpp`
(`encryptCurve25519`, `initNonce`, `setDHPublicKey`) — a Meshtastic firmware checkout.

```
shared   = Curve25519::dh2(peerPublicKey[32], ourPrivateKey[32])   // X25519 ECDH
key      = SHA256(shared)                                          // 32-byte AES-256 key
extraNonce = random uint32
nonce[13]: memcpy(nonce+0, &packetId, 8)
           memcpy(nonce+8, &fromNode, 4)
           if (extraNonce) memcpy(nonce+4, &extraNonce, 4)   // NOTE: offset 4 — it
                                                             // deliberately overlays part
                                                             // of packetId. Quirk, not a bug;
                                                             // reproduce it EXACTLY.
aes_ccm_ae(key, 32, nonce, /*M=*/8, plaintext, n, aad=null, 0, out, auth)
wire payload = ciphertext[n] || auth[8] || extraNonce[4]      // +12 bytes overhead
```

**Wire signalling:** a PKC packet sets header **`channel = 0`** and is directed
(`to != BROADCAST`). Reference: `Router.cpp:763-764` (`p->channel = 0; p->pki_encrypted = true;`).
The receiver identifies PKC by `to == me && channel == 0`.

## Dependencies — what we have and what we lack
| need | status |
|---|---|
| X25519 (`Curve25519::dh2`) | **have** — `Crypto` lib (`Curve25519.h`), already a lib_dep |
| SHA256 | **have** — `Crypto` lib |
| AES-256 | **have** — `Crypto` lib |
| **AES-CCM** | **MISSING** — the `Crypto` lib ships CTR/GCM/EAX/ChaChaPoly but **no CCM**. Meshtastic vendors `src/mesh/aes-ccm.{h,cpp}` (hostap-derived). We must vendor it too. |

## DECISIONS (mine; review)
- **D1b.1 Vendor `aes-ccm`** from the Meshtastic tree rather than hand-rolling CCM. Hand-rolling
  an AEAD is how you get a silent, untestable crypto bug. Preserve its licence header.
- **D1b.2 Peer public key is INJECTED, like the channel PSK.** The transport keeps no NodeDB. The
  gateway's 32-byte public key is supplied by config (`secrets.h` / begin()), consistent with
  "identity is injected, never baked in". Learning keys from NodeInfo is a later refinement.
- **D1b.3 Our keypair is generated once and PERSISTED**, and published in our NodeInfo `User.public_key`
  so the gateway can encrypt to us. A regenerated key silently breaks inbound DMs — persist it or
  the failure is invisible.
- **D1b.4 PKI is opt-in per send**, alongside the existing PSK path. `send()` gains a PKI route; the
  broadcast PSK path is untouched. Nothing regresses if PKI is unused.
- **D1b.5 RX must branch BEFORE the channel-hash filter.** Today `handleRxDone()` drops anything
  whose `h.channel != _hash`; a PKC packet carries `channel = 0` and would be discarded. The PKI
  branch (`to == _nodeNum && h.channel == 0`) must come first.
- **D1b.6 Payload budget shrinks by 12 bytes** on PKI DMs (auth 8 + extraNonce 4). `MESH_PAYLOAD_MAX`
  231 → **219 effective** for PKI. The chunk layer must not be handed a PKI DM sized for 231.

## Channel 0 — RESOLVED (Peter, 2026-07-22)
PKC **requires the header `channel` byte to be 0**. Asked rather than assumed, and the rule turned
out to be narrower than its wording:

> "DMs on channel 0 is fine, what I am banning is flooding the public mesh with messages."

So the ban is on **BROADCASTS** into the public/primary mesh, not on the channel byte itself. A
PKI DM is directed at exactly one node and floods nothing, so `channel = 0` on a **directed** send
is permitted. **This is not a licence to broadcast on channel 0 — that stays banned.**

**Enforce it in code:** the PKI send path must assert `to != BROADCAST_ADDR`. A PKC broadcast is
both meaningless (no recipient key) and a violation of the rule, so it must be impossible to
express, not merely discouraged.

## Tests
- **Offline (`offline_pki_vectors.cpp`, host):** known-answer vectors — fixed keypair + packetId +
  extraNonce must produce byte-identical ciphertext/auth to the reference. Crypto without KATs is
  hope, not verification. Also assert the 13-byte nonce layout including the offset-4 overlay.
- **On-air (bench):** a PKI DM reply that the 2.8 gateway ACCEPTS — the exact thing that failed in
  Phase 1. Pass = the reply appears in mesh-gw's raw `/events` (the check that caught the failure),
  and `ackFailTotal` stays flat while `pendingAckId` clears.

## PHASE 2 — exact firmware changes (review before implementing)

**1. `src/main.cpp` — include** (after `#include <MeshtasticTransport.h>`)
```c
#include <mt_pki.h>   // derive our PKC public key from the injected private key
```

**2. `src/main.cpp` — globals** (after `static uint32_t g_nodeNum = 0;`)
```c
static uint8_t g_pkiPublic[32] = {0};   // DERIVED at boot, published in NodeInfo
static bool    g_pkiReady = false;
```

**3. `src/main.cpp` — `setup()`, after `applyRxSensitivityPatch("begin")`**
```c
if (ok && mesh.setPkiIdentity(MESH_PKI_PRIVATE_KEY)) {
    g_pkiReady = mt::pkiPublicFromPrivate(g_pkiPublic, MESH_PKI_PRIVATE_KEY);
    DBG("PKI: pub %02x%02x..%02x derive=%s peer=%s\n", g_pkiPublic[0], g_pkiPublic[1],
        g_pkiPublic[31], g_pkiReady ? "OK" : "FAIL",
        mesh.addPkiPeer(MESH_PKI_PEER_NODE, MESH_PKI_PEER_PUBLIC_KEY) ? "OK" : "FAIL");
}
```

**4. `src/main.cpp` — `sendNodeInfo()`, replacing the `is_unmessagable` block (~line 1233)**
```c
// PKC is MUTUAL: without our public key the gateway cannot decrypt anything we
// send, and refuses to send us a DM at all (Router.cpp:750).
if (g_pkiReady) { u.public_key.size = 32; memcpy(u.public_key.bytes, g_pkiPublic, 32); }
u.has_is_unmessagable = true;
u.is_unmessagable = !g_pkiReady;   // was hard true; we ARE messagable once PKI is up
```

**5. `src/main.cpp` — comfort flag** (`handleCommand`, at `char reply[237];`)
```c
bool comfort = false;              // set true in the `ping` and `status` branches
```

**6. `src/main.cpp` — reply send (~line 2223), replacing `if (reply[0]) sendReply(reply, rx.id);`**
```c
if (reply[0]) {
    bool sent = false;
    if (comfort && rx.from != mt::BROADCAST_ADDR)
        sent = mesh.sendPki(meshtastic_PortNum_TEXT_MESSAGE_APP, (const uint8_t *)reply,
                            strlen(reply), rx.from, 3, rx.id, rx.id, /*wantAck=*/true);
    if (sent) report("REPLY pki", true);
    else      sendReply(reply, rx.id);   // fallback: unknown peer / non-comfort verb
}
```

**7. `src/main.cpp` — `FW_VERSION` → `2-260722-5`.**

**8. `docs/spec-nodeinfo-unmessagable.md`** — record that its premise ("we do not implement
PKI... a fake key is off the table") is now void: we implement PKI and publish a REAL derived
key, so `is_unmessagable` follows `g_pkiReady` instead of being hard-coded true.

**NOT changed:** `platformio.ini` (the lib requirement note already landed in Phase 1),
`secrets.h` (keys already present, gitignored).

**Risk:** flash grows ~75 KB once Curve25519 links in (34.8%, measured). Bench only; field unit
untouched.

## Out of scope
Key exchange/discovery via NodeInfo (D1b.2 injects instead), XEdDSA signing, admin-key handling.
