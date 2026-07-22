#include "mt_pki.h"

#include <string.h>

#include "aes-ccm.h"
#include "mt_ccm_backend.h"

// Curve25519/SHA256/AES come from the Arduino `Crypto` library (already a lib_dep).
// The host KAT build defines MT_PKI_HOST_TEST and supplies its own primitives, because
// that library is Arduino-flavoured and the device build cannot run tests.
#ifndef MT_PKI_HOST_TEST
#include <AES.h>
#include <Curve25519.h>
#include <RNG.h>
#include <SHA256.h>
#endif

namespace mt {

CcmAesBackend *crypto = nullptr;
void setCcmAesBackend(CcmAesBackend *b) { crypto = b; }

#ifndef MT_PKI_HOST_TEST
namespace {
// AESSmall256 matches the reference (encrypt-only, smaller table footprint).
class CryptoLibAes : public CcmAesBackend {
  public:
    void aesSetKey(const uint8_t *key, size_t key_len) override { _aes.setKey(key, key_len); }
    void aesEncrypt(uint8_t *in, uint8_t *out) override { _aes.encryptBlock(out, in); }
  private:
    AESSmall256 _aes;
};
CryptoLibAes g_deviceAes;
} // namespace

void pkiBegin() { setCcmAesBackend(&g_deviceAes); }

bool pkiSharedKey(const uint8_t peerPublic[32], const uint8_t ourPrivate[32], uint8_t keyOut[32])
{
    // dh2 consumes both buffers in place, so work on copies — a caller's long-lived
    // private key must not be destroyed by deriving a session key from it.
    uint8_t shared[32], priv[32];
    memcpy(shared, peerPublic, 32);
    memcpy(priv, ourPrivate, 32);
    if (!Curve25519::dh2(shared, priv))
        return false; // weak/invalid point (includes the all-zero key)

    SHA256 h;
    h.reset();
    h.update(shared, 32);
    h.finalize(keyOut, 32);
    return true;
}

void pkiGenerateKeyPair(uint8_t publicOut[32], uint8_t privateOut[32])
{
    Curve25519::dh1(publicOut, privateOut);
}

bool pkiPublicFromPrivate(uint8_t publicOut[32], const uint8_t privateKey[32])
{
    uint8_t f[32];
    memcpy(f, privateKey, 32);
    pkiClampPrivate(f);
    // eval(k, f, 0): NULL x means the base point 9 — the same call dh1() makes.
    return Curve25519::eval(publicOut, f, nullptr);
}
#endif // !MT_PKI_HOST_TEST

// Clamping is spec (RFC 7748) and idempotent. Kept outside the host-test guard so the
// KATs can exercise it without the Arduino Crypto library.
void pkiClampPrivate(uint8_t priv[32])
{
    priv[0] &= 0xF8;
    priv[31] = (priv[31] & 0x7F) | 0x40;
}


// Reference: CryptoEngine::initNonce. The extraNonce write lands at offset 4 and
// OVERLAYS the upper half of packetId. That looks like a bug and is not ours to fix:
// deviating breaks interoperability with every stock node.
void pkiInitNonce(uint8_t nonce[13], uint32_t fromNode, uint64_t packetId, uint32_t extraNonce)
{
    memset(nonce, 0, 13);
    memcpy(nonce, &packetId, sizeof(uint64_t));                     // @0, 8 bytes
    memcpy(nonce + sizeof(uint64_t), &fromNode, sizeof(uint32_t));  // @8, 4 bytes
    if (extraNonce)
        memcpy(nonce + sizeof(uint32_t), &extraNonce, sizeof(uint32_t)); // @4 — overlays
}

bool pkiEncrypt(uint32_t toNode, uint32_t fromNode, const uint8_t peerPublic[32],
                const uint8_t ourPrivate[32], uint32_t packetId, uint32_t extraNonce,
                const uint8_t *plain, size_t len, uint8_t *out, size_t outCap, size_t *outLen)
{
    // A PKC broadcast is meaningless (no recipient key) AND would put a broadcast on
    // channel 0, which is banned. Refuse rather than silently downgrade.
    if (toNode == 0xFFFFFFFFu || !crypto || !plain || !out)
        return false;
    // CCM writes whole 16-byte blocks and can run up to 15 bytes past `len`. Refusing
    // here is the difference between a failed call and silent memory corruption.
    if (outCap < pkiOutCap(len))
        return false;

    uint8_t key[32];
    if (!pkiSharedKey(peerPublic, ourPrivate, key))
        return false;

    uint8_t nonce[13];
    pkiInitNonce(nonce, fromNode, packetId, extraNonce);

    uint8_t *auth = out + len;                    // tag sits directly after ciphertext
    if (aes_ccm_ae(key, 32, nonce, PKI_AUTH_LEN, plain, len, nullptr, 0, out, auth) != 0)
        return false;
    memcpy(auth + PKI_AUTH_LEN, &extraNonce, sizeof(uint32_t)); // then the extraNonce

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

    // aes_ccm_ad verifies the tag in constant time; a failure must yield NOTHING.
    if (!aes_ccm_ad(key, 32, nonce, PKI_AUTH_LEN, in, cryptLen, nullptr, 0,
                    in + cryptLen, plainOut))
        return false;

    if (plainLen)
        *plainLen = cryptLen;
    return true;
}

} // namespace mt
