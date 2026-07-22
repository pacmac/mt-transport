// mt_pki.cpp — thin facade over the PKC crypto.
//
// On device, EVERY crypto operation is delegated to the VENDORED Meshtastic
// CryptoEngine (mt_crypto_engine.{h,cpp}). Nothing here reimplements ECDH, key
// derivation, nonce construction or the encrypt/decrypt composition — that was the
// mistake this file used to make.
//
// The host KAT build (MT_PKI_HOST_TEST) cannot use the Arduino Crypto library, so it
// supplies its own composition below, exercising the SAME vendored aes-ccm primitive
// and the same nonce layout. The CCM primitive is what carries the real interop risk,
// and it is verified against the RFC 3610 vector.
#include "mt_pki.h"

#include <string.h>

#include "aes-ccm.h"
#include "mt_ccm_backend.h"

#ifndef MT_PKI_HOST_TEST
#include <Curve25519.h>
#include "mt_crypto_engine.h"
#endif

namespace mt {

CcmAesBackend *crypto = nullptr;
void setCcmAesBackend(CcmAesBackend *b) { crypto = b; }

// Clamping is spec (RFC 7748) and idempotent, so it is safe on a key from any source.
// Applied once on storage so key derivation and ECDH cannot disagree on the scalar.
void pkiClampPrivate(uint8_t priv[32])
{
    priv[0] &= 0xF8;
    priv[31] = (priv[31] & 0x7F) | 0x40;
}

// Nonce layout, matching CryptoEngine::initNonce. The extraNonce write lands at offset
// 4 and OVERLAYS the upper half of packetId — a quirk of the reference that must be
// reproduced exactly or nothing interoperates.
void pkiInitNonce(uint8_t nonce[13], uint32_t fromNode, uint64_t packetId, uint32_t extraNonce)
{
    memset(nonce, 0, 13);
    memcpy(nonce, &packetId, sizeof(uint64_t));
    memcpy(nonce + sizeof(uint64_t), &fromNode, sizeof(uint32_t));
    if (extraNonce)
        memcpy(nonce + sizeof(uint32_t), &extraNonce, sizeof(uint32_t));
}

#ifndef MT_PKI_HOST_TEST
// ---- device: delegate everything to the vendored engine ---------------------
void pkiBegin() { setCcmAesBackend(&engine()); }

void pkiGenerateKeyPair(uint8_t publicOut[32], uint8_t privateOut[32])
{
    Curve25519::dh1(publicOut, privateOut);
}

bool pkiPublicFromPrivate(uint8_t publicOut[32], const uint8_t privateKey[32])
{
    engine().setDHPrivateKey(privateKey);
    return engine().regeneratePublicKey(publicOut);
}

bool pkiEncrypt(uint32_t toNode, uint32_t fromNode, const uint8_t peerPublic[32],
                const uint8_t ourPrivate[32], uint32_t packetId, uint32_t extraNonce,
                const uint8_t *plain, size_t len, uint8_t *out, size_t outCap, size_t *outLen)
{
    // A PKC broadcast has no recipient key AND would be a broadcast on channel 0,
    // which is banned. Refuse rather than silently downgrade to something undeliverable.
    if (toNode == BROADCAST_NODE || !plain || !out)
        return false;
    // CCM writes whole 16-byte blocks and can run up to 15 bytes past `len`.
    if (outCap < pkiOutCap(len))
        return false;

    engine().setDHPrivateKey(ourPrivate);
    if (!engine().encryptCurve25519(toNode, fromNode, peerPublic, packetId, extraNonce,
                                    len, plain, out))
        return false;
    if (outLen)
        *outLen = len + PKI_OVERHEAD;
    return true;
}

bool pkiDecrypt(uint32_t fromNode, const uint8_t peerPublic[32], const uint8_t ourPrivate[32],
                uint32_t packetId, const uint8_t *in, size_t len, uint8_t *plainOut, size_t *plainLen)
{
    if (!in || !plainOut || len < PKI_OVERHEAD)
        return false;
    engine().setDHPrivateKey(ourPrivate);
    // A failed auth tag must yield NOTHING — the engine returns false and writes no
    // usable plaintext.
    if (!engine().decryptCurve25519(fromNode, peerPublic, packetId, len, in, plainOut))
        return false;
    if (plainLen)
        *plainLen = len - PKI_OVERHEAD;
    return true;
}

#else // MT_PKI_HOST_TEST
// ---- host KATs: same aes-ccm primitive + same nonce, test-supplied shared key ----
// pkiSharedKey/pkiBegin/pkiGenerateKeyPair/pkiPublicFromPrivate come from the test.
bool pkiSharedKey(const uint8_t peerPublic[32], const uint8_t ourPrivate[32], uint8_t keyOut[32]);

bool pkiEncrypt(uint32_t toNode, uint32_t fromNode, const uint8_t peerPublic[32],
                const uint8_t ourPrivate[32], uint32_t packetId, uint32_t extraNonce,
                const uint8_t *plain, size_t len, uint8_t *out, size_t outCap, size_t *outLen)
{
    if (toNode == BROADCAST_NODE || !crypto || !plain || !out)
        return false;
    if (outCap < pkiOutCap(len))
        return false;

    uint8_t key[32];
    if (!pkiSharedKey(peerPublic, ourPrivate, key))
        return false;

    uint8_t nonce[13];
    pkiInitNonce(nonce, fromNode, packetId, extraNonce);

    uint8_t *auth = out + len;
    if (aes_ccm_ae(key, 32, nonce, PKI_AUTH_LEN, plain, len, nullptr, 0, out, auth) != 0)
        return false;
    memcpy(auth + PKI_AUTH_LEN, &extraNonce, sizeof(uint32_t));
    if (outLen)
        *outLen = len + PKI_OVERHEAD;
    return true;
}

bool pkiDecrypt(uint32_t fromNode, const uint8_t peerPublic[32], const uint8_t ourPrivate[32],
                uint32_t packetId, const uint8_t *in, size_t len, uint8_t *plainOut, size_t *plainLen)
{
    if (!crypto || !in || !plainOut || len < PKI_OVERHEAD)
        return false;
    const size_t cryptLen = len - PKI_OVERHEAD;

    uint32_t extraNonce;
    memcpy(&extraNonce, in + cryptLen + PKI_AUTH_LEN, sizeof(uint32_t));

    uint8_t key[32];
    if (!pkiSharedKey(peerPublic, ourPrivate, key))
        return false;

    uint8_t nonce[13];
    pkiInitNonce(nonce, fromNode, packetId, extraNonce);

    if (!aes_ccm_ad(key, 32, nonce, PKI_AUTH_LEN, in, cryptLen, nullptr, 0,
                    in + cryptLen, plainOut))
        return false;
    if (plainLen)
        *plainLen = cryptLen;
    return true;
}
#endif

} // namespace mt
