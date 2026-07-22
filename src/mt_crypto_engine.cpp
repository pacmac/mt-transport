// Vendored from Meshtastic src/mesh/CryptoEngine.cpp — see mt_crypto_engine.h.
// Bodies follow upstream; LOG_*/printBytes are dropped (no Meshtastic logger here).
#include "mt_crypto_engine.h"

#include <string.h>

#include "aes-ccm.h"

#ifndef MT_PKI_HOST_TEST
#include <AES.h>
#include <Curve25519.h>
#include <SHA256.h>

namespace mt {

static AESSmall256 g_aes;

MtCryptoEngine &engine()
{
    static MtCryptoEngine e;
    return e;
}

void MtCryptoEngine::setDHPrivateKey(const uint8_t *priv)
{
    memcpy(private_key, priv, 32);
}

// Upstream setDHPublicKey: shared_key starts as the peer public key; dh2 replaces it
// with the shared secret. dh2 consumes both buffers, so the caller's private key is
// copied first — upstream does the same via local_priv.
bool MtCryptoEngine::setDHPublicKey(const uint8_t *pubKey)
{
    uint8_t local_priv[32];
    memcpy(shared_key, pubKey, 32);
    memcpy(local_priv, private_key, 32);
    // Includes an internal weak-key check (rejects an all-zero public/shared key).
    if (!Curve25519::dh2(shared_key, local_priv))
        return false;
    return true;
}

// Upstream hash(): SHA256 in place, fed in 16-byte chunks.
void MtCryptoEngine::hash(uint8_t *bytes, size_t numBytes)
{
    SHA256 h;
    size_t posn;
    uint8_t size = numBytes;
    uint8_t inc = 16;
    h.reset();
    for (posn = 0; posn < size; posn += inc) {
        size_t len = size - posn;
        if (len > inc)
            len = inc;
        h.update(bytes + posn, len);
    }
    h.finalize(bytes, 32);
}

bool MtCryptoEngine::regeneratePublicKey(uint8_t *pubKey)
{
    // Clamp per RFC 7748 exactly as dh1() does before eval, then evaluate against
    // the base point (NULL x means 9).
    uint8_t f[32];
    memcpy(f, private_key, 32);
    f[0] &= 0xF8;
    f[31] = (f[31] & 0x7F) | 0x40;
    if (!Curve25519::eval(pubKey, f, nullptr))
        return false;
    memcpy(public_key, pubKey, 32);
    return true;
}

void MtCryptoEngine::aesSetKey(const uint8_t *key, size_t key_len)
{
    if (key_len != 0) {
        g_aes.setKey(key, key_len);
        _aes = &g_aes;
    } else {
        _aes = nullptr;
    }
}

void MtCryptoEngine::aesEncrypt(uint8_t *in, uint8_t *out)
{
    if (_aes)
        static_cast<AESSmall256 *>(_aes)->encryptBlock(out, in);
}

} // namespace mt
#endif // !MT_PKI_HOST_TEST

namespace mt {

// Upstream initNonce. The extraNonce write lands at offset 4 and OVERLAYS the upper
// half of packetId. That looks like a bug and is NOT ours to fix — deviating breaks
// interoperability with every stock node.
void MtCryptoEngine::initNonce(uint32_t fromNode, uint64_t packetId, uint32_t extraNonce)
{
    memset(nonce, 0, sizeof(nonce));
    memcpy(nonce, &packetId, sizeof(uint64_t));
    memcpy(nonce + sizeof(uint64_t), &fromNode, sizeof(uint32_t));
    if (extraNonce)
        memcpy(nonce + sizeof(uint32_t), &extraNonce, sizeof(uint32_t));
}

// Upstream encryptCurve25519. Wire layout: ciphertext || auth[8] || extraNonce[4].
// extraNonce is supplied by the caller (upstream rolls it internally from random())
// so it can be pinned in known-answer tests.
bool MtCryptoEngine::encryptCurve25519(uint32_t toNode, uint32_t fromNode, const uint8_t *remotePublic,
                                       uint64_t packetNum, uint32_t extraNonce, size_t numBytes,
                                       const uint8_t *bytes, uint8_t *bytesOut)
{
    (void)toNode;
    uint8_t *auth = bytesOut + numBytes;
    if (!remotePublic)
        return false;
    if (!setDHPublicKey(remotePublic))
        return false;
    hash(shared_key, 32);
    initNonce(fromNode, packetNum, extraNonce);
    if (aes_ccm_ae(shared_key, 32, nonce, 8, bytes, numBytes, nullptr, 0, bytesOut, auth) != 0)
        return false;
    memcpy(auth + 8, &extraNonce, sizeof(uint32_t));
    return true;
}

// Upstream decryptCurve25519. The trailing 12 bytes are auth[8] || extraNonce[4];
// the extraNonce is read back out to rebuild the nonce the sender used.
bool MtCryptoEngine::decryptCurve25519(uint32_t fromNode, const uint8_t *remotePublic, uint64_t packetNum,
                                       size_t numBytes, const uint8_t *bytes, uint8_t *bytesOut)
{
    if (numBytes < 12 || !remotePublic)
        return false;
    const uint8_t *auth = bytes + numBytes - 12;
    uint32_t extraNonce;
    memcpy(&extraNonce, auth + 8, sizeof(uint32_t));

    if (!setDHPublicKey(remotePublic))
        return false;
    hash(shared_key, 32);

    initNonce(fromNode, packetNum, extraNonce);
    return aes_ccm_ad(shared_key, 32, nonce, 8, bytes, numBytes - 12, nullptr, 0, auth, bytesOut);
}

} // namespace mt
