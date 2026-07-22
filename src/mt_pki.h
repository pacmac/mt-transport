// Meshtastic PKC (PKI) direct messages.
//
// Phase 1 proved a channel-PSK DM is silently discarded by a Meshtastic 2.8 gateway
// ("legacy DM"); PKC is the supported carrier, so this is what makes an ACKed DM — and
// therefore the v2 comfort lane — possible at all. See specs/v2-phase1b-pki.md and
// docs/v2/APIV2.md §5.1.
//
// The algorithm is transcribed from the reference implementation
// (Meshtastic src/mesh/CryptoEngine.cpp: encryptCurve25519 / initNonce / setDHPublicKey),
// NOT from memory:
//
//   shared = X25519(peerPublicKey, ourPrivateKey)
//   key    = SHA256(shared)                                   // AES-256 key
//   nonce[13]: packetId @0 (8B), fromNode @8 (4B), extraNonce @4 (4B)
//   aes_ccm_ae(key, 32, nonce, M=8, plaintext, n, aad=NULL, 0, out, auth)
//   wire  = ciphertext[n] || auth[8] || extraNonce[4]          // +12 bytes
//
// WIRE MARKER: a PKC packet sets the header `channel` byte to 0 and is DIRECTED.
// Channel 0 here is a crypto marker, not the primary broadcast channel — permitted
// because a DM floods nothing. Broadcasting on channel 0 remains banned, which is why
// pkiEncrypt() refuses a broadcast destination outright.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace mt {

static const size_t PKI_KEY_LEN     = 32; // X25519 public/private key
static const size_t PKI_AUTH_LEN    = 8;  // CCM auth tag (M=8)
static const size_t PKI_XNONCE_LEN  = 4;  // extraNonce appended after the tag
static const size_t PKI_OVERHEAD    = PKI_AUTH_LEN + PKI_XNONCE_LEN; // 12
static const uint8_t PKI_CHANNEL    = 0;  // PKC marker in PacketHeader.channel

// CCM encrypts in whole 16-byte blocks, so aes_ccm_ae can write up to 15 bytes PAST
// the plaintext length (upstream Meshtastic warns of exactly this). The output buffer
// must therefore tolerate len + PKI_SCRATCH, which is MORE than len + PKI_OVERHEAD.
// Undersizing it silently corrupts whatever follows the buffer — this was caught by
// the host KAT clobbering its own stack, not by any compiler warning.
static const size_t PKI_SCRATCH     = 16;
// Minimum output capacity for a plaintext of `n` bytes.
static inline size_t pkiOutCap(size_t n) { return n + (PKI_SCRATCH > PKI_OVERHEAD ? PKI_SCRATCH : PKI_OVERHEAD); }

// Install the AES backend used by the CCM code. Call once before any PKI operation.
// (Separate from pkiEncrypt so host tests can inject their own backend.)
void pkiBegin();

// Build the 13-byte PKC nonce. Exposed for known-answer tests: the extraNonce lands at
// offset 4 and deliberately OVERLAYS part of packetId — a quirk of the reference
// initNonce() that must be reproduced exactly or nothing interoperates.
void pkiInitNonce(uint8_t nonce[13], uint32_t fromNode, uint64_t packetId, uint32_t extraNonce);

// Derive the AES-256 key for a peer: SHA256(X25519(peerPub, ourPriv)).
// Returns false on a weak/invalid public key (Curve25519::dh2 checks for these).
bool pkiSharedKey(const uint8_t peerPublic[32], const uint8_t ourPrivate[32], uint8_t keyOut[32]);

// Encrypt `len` plaintext bytes for `toNode`, writing ciphertext || auth[8] || extraNonce[4].
// `outCap` is the real capacity of `out` and MUST be >= pkiOutCap(len) — the call is
// refused otherwise rather than overrunning (see PKI_SCRATCH).
// REFUSES a broadcast destination: PKC has no recipient key for a broadcast, and
// broadcasting on channel 0 is banned.
bool pkiEncrypt(uint32_t toNode, uint32_t fromNode, const uint8_t peerPublic[32],
                const uint8_t ourPrivate[32], uint32_t packetId, uint32_t extraNonce,
                const uint8_t *plain, size_t len, uint8_t *out, size_t outCap, size_t *outLen);

// Decrypt a received PKC payload (ciphertext || auth || extraNonce) of `len` bytes.
// Returns false if the auth tag fails — a forged or corrupt packet must never be
// delivered as plaintext.
bool pkiDecrypt(uint32_t fromNode, const uint8_t peerPublic[32], const uint8_t ourPrivate[32],
                uint32_t packetId, const uint8_t *in, size_t len, uint8_t *plainOut, size_t *plainLen);

// Generate an X25519 keypair. The private key MUST be persisted: regenerating it
// silently breaks every inbound DM, and the failure is invisible from the device.
void pkiGenerateKeyPair(uint8_t publicOut[32], uint8_t privateOut[32]);

} // namespace mt
