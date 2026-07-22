// mt_crypto_engine.h — VENDORED from Meshtastic src/mesh/CryptoEngine.{h,cpp}.
//
// Rule: use the official Meshtastic implementation, never a home-grown one. The PKC
// half of CryptoEngine depends on nothing but LOG_* macros (no NodeDB, no config, no
// channels, no Lock), so it ports cleanly. Function bodies are kept as close to
// upstream as possible so future diffs stay readable; the only changes are:
//   - LOG_*/printBytes reduced to no-ops (we have no Meshtastic logger)
//   - it implements mt::CcmAesBackend, so the vendored aes-ccm.cpp keeps calling
//     `crypto->aesSetKey/aesEncrypt` exactly as upstream does
//   - the remote public key is passed as a plain pointer rather than a NodeInfoLite
//     protobuf, because this library deliberately keeps no NodeDB
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "mt_ccm_backend.h"

namespace mt {

class MtCryptoEngine : public CcmAesBackend {
  public:
    // Upstream: setDHPrivateKey. Our private key, injected by the application.
    void setDHPrivateKey(const uint8_t *priv);

    // Upstream: setDHPublicKey — X25519 with the peer's public key, leaving the
    // shared secret in shared_key. Returns false on a weak/invalid point.
    bool setDHPublicKey(const uint8_t *pubKey);

    // Upstream: encryptCurve25519 / decryptCurve25519. `bytesOut` must tolerate
    // numBytes + 15 (CCM writes whole 16-byte blocks) — see mt_pki.h PKI_SCRATCH.
    bool encryptCurve25519(uint32_t toNode, uint32_t fromNode, const uint8_t *remotePublic,
                           uint64_t packetNum, uint32_t extraNonce, size_t numBytes,
                           const uint8_t *bytes, uint8_t *bytesOut);
    bool decryptCurve25519(uint32_t fromNode, const uint8_t *remotePublic, uint64_t packetNum,
                           size_t numBytes, const uint8_t *bytes, uint8_t *bytesOut);

    // Upstream: hash() — SHA256 IN PLACE over the first 32 bytes.
    void hash(uint8_t *bytes, size_t numBytes);
    // Upstream: initNonce().
    void initNonce(uint32_t fromNode, uint64_t packetId, uint32_t extraNonce);

    // Derive the public key from private_key (Curve25519::eval against the base point).
    bool regeneratePublicKey(uint8_t *pubKey);

    // CcmAesBackend — what the vendored aes-ccm.cpp calls.
    void aesSetKey(const uint8_t *key, size_t key_len) override;
    void aesEncrypt(uint8_t *in, uint8_t *out) override;

    uint8_t public_key[32] = {0};

  private:
    uint8_t nonce[16] = {0};
    uint8_t shared_key[32] = {0};
    uint8_t private_key[32] = {0};
    void *_aes = nullptr; // AESSmall256, opaque here to keep Arduino headers out
};

// The single engine instance. aes-ccm.cpp calls `crypto->…`; mt::crypto points here
// on device, or at a test backend in the host KAT build.
MtCryptoEngine &engine();

} // namespace mt
