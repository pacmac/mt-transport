// offline_pki_vectors.cpp — host known-answer tests for the PKI (PKC) DM path.
//
// Crypto without KATs is hope, not verification, and the device build cannot run tests.
// This exercises the VENDORED CCM against the RFC 3610 reference vector, pins the
// 13-byte nonce layout (including the deliberate offset-4 overlay), and round-trips
// pkiEncrypt/pkiDecrypt including tamper rejection.
//
// The AES backend here is OpenSSL, injected through mt::CcmAesBackend — the same seam
// the device uses for the Arduino Crypto library. X25519 is NOT exercised here (that is
// the Crypto library's own tested primitive); pkiSharedKey is stubbed deterministically
// so the COMPOSITION is what gets tested.
//
// Build & run (from repo root):
//   g++ -std=c++17 -DMT_PKI_HOST_TEST -Isrc test/offline_pki_vectors.cpp \
//       src/mt_pki.cpp src/aes-ccm.cpp -lcrypto -o /tmp/pki && /tmp/pki
#include "mt_pki.h"
#include "aes-ccm.h"
#include "mt_ccm_backend.h"

#include <openssl/evp.h>
#include <cassert>
#include <cstdio>
#include <cstring>

// ---- OpenSSL-backed AES block encrypt (test backend) -------------------------
class OpenSslAes : public mt::CcmAesBackend {
  public:
    void aesSetKey(const uint8_t *key, size_t key_len) override {
        memcpy(_key, key, key_len);
        _len = key_len;
    }
    void aesEncrypt(uint8_t *in, uint8_t *out) override {
        EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
        EVP_EncryptInit_ex(c, _len == 32 ? EVP_aes_256_ecb() : EVP_aes_128_ecb(), nullptr, _key, nullptr);
        EVP_CIPHER_CTX_set_padding(c, 0);
        int outl = 0;
        EVP_EncryptUpdate(c, out, &outl, in, 16);
        EVP_CIPHER_CTX_free(c);
    }
  private:
    uint8_t _key[32] = {0};
    size_t  _len = 16;
};
static OpenSslAes g_aes;

// ---- stubs for the parts excluded from the host build ------------------------
namespace mt {
void pkiBegin() { setCcmAesBackend(&g_aes); }
// Deterministic stand-in for SHA256(X25519(...)) so the composition is testable.
bool pkiSharedKey(const uint8_t *, const uint8_t *, uint8_t keyOut[32]) {
    for (int i = 0; i < 32; i++) keyOut[i] = (uint8_t)(0xA0 + i);
    return true;
}
void pkiGenerateKeyPair(uint8_t pub[32], uint8_t priv[32]) { memset(pub, 1, 32); memset(priv, 2, 32); }
} // namespace mt

static void hexdump(const char *tag, const uint8_t *p, size_t n) {
    printf("  %s", tag);
    for (size_t i = 0; i < n; i++) printf("%02X", p[i]);
    printf("\n");
}

int main() {
    mt::pkiBegin();

    // ---- 1. RFC 3610 Packet Vector #1 — validates the vendored CCM -----------
    // 8 octets of AAD (cleartext header) + 23 octets payload, M = 8, L = 2.
    const uint8_t key[16]   = {0xC0,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,
                               0xC8,0xC9,0xCA,0xCB,0xCC,0xCD,0xCE,0xCF};
    const uint8_t nonce[13] = {0x00,0x00,0x00,0x03,0x02,0x01,0x00,0xA0,0xA1,0xA2,0xA3,0xA4,0xA5};
    uint8_t aad[8], plain[23];
    for (int i = 0; i < 8; i++)  aad[i] = (uint8_t)i;          // 00..07
    for (int i = 0; i < 23; i++) plain[i] = (uint8_t)(i + 8);  // 08..1E

    const uint8_t wantCrypt[23] = {0x58,0x8C,0x97,0x9A,0x61,0xC6,0x63,0xD2,
                                   0xF0,0x66,0xD0,0xC2,0xC0,0xF9,0x89,0x80,
                                   0x6D,0x5F,0x6B,0x61,0xDA,0xC3,0x84};
    const uint8_t wantAuth[8]   = {0x17,0xE8,0xD1,0x2C,0xFD,0xF9,0x26,0xE0};

    // +16 scratch: CCM writes whole 16-byte blocks and overruns `len` by up to 15.
    uint8_t crypt[23 + 16], auth[8];
    int rc = aes_ccm_ae(key, 16, nonce, 8, plain, sizeof(plain), aad, sizeof(aad), crypt, auth);
    assert(rc == 0 && "aes_ccm_ae must succeed");
    hexdump("ciphertext = ", crypt, sizeof(plain));
    hexdump("auth       = ", auth, sizeof(auth));
    assert(memcmp(crypt, wantCrypt, sizeof(wantCrypt)) == 0 && "RFC 3610 ciphertext mismatch");
    assert(memcmp(auth, wantAuth, sizeof(wantAuth)) == 0 && "RFC 3610 auth tag mismatch");
    printf("PASS  RFC 3610 Packet Vector #1 (vendored CCM is correct)\n");

    // Decrypt side of the same vector.
    // NB: the real ciphertext length is 23 — NOT sizeof(crypt), which now carries
    // the +16 block scratch. Passing the buffer size here silently authenticates
    // the padding too and fails.
    uint8_t back[23 + 16];
    bool ok = aes_ccm_ad(key, 16, nonce, 8, crypt, sizeof(plain), aad, sizeof(aad), auth, back);
    assert(ok && memcmp(back, plain, sizeof(plain)) == 0);
    printf("PASS  RFC 3610 decrypt round-trip\n");

    // ---- 2. Nonce layout, including the offset-4 overlay ---------------------
    uint8_t n2[13];
    const uint64_t packetId = 0x1122334455667788ull;
    const uint32_t fromNode = 0x8CEE336B, extra = 0xAABBCCDD;
    mt::pkiInitNonce(n2, fromNode, packetId, extra);
    hexdump("nonce      = ", n2, 13);
    // packetId little-endian at 0..7, but bytes 4..7 are OVERWRITTEN by extraNonce.
    assert(n2[0] == 0x88 && n2[1] == 0x77 && n2[2] == 0x66 && n2[3] == 0x55);
    assert(n2[4] == 0xDD && n2[5] == 0xCC && n2[6] == 0xBB && n2[7] == 0xAA
           && "extraNonce MUST overlay packetId at offset 4 (reference quirk)");
    assert(n2[8] == 0x6B && n2[9] == 0x33 && n2[10] == 0xEE && n2[11] == 0x8C);
    assert(n2[12] == 0x00);
    // With extraNonce == 0 the overlay is skipped and packetId survives intact.
    mt::pkiInitNonce(n2, fromNode, packetId, 0);
    assert(n2[4] == 0x44 && n2[5] == 0x33 && n2[6] == 0x22 && n2[7] == 0x11);
    printf("PASS  nonce layout (packetId@0, fromNode@8, extraNonce@4 overlay)\n");

    // ---- 3. pkiEncrypt / pkiDecrypt composition ------------------------------
    const uint8_t peerPub[32] = {0}, ourPriv[32] = {0};
    const char *msg = "{\"type\":\"pong\",\"upt\":42}";
    const size_t mlen = strlen(msg);
    uint8_t out[128], rt[128];
    size_t outLen = 0, rtLen = 0;

    ok = mt::pkiEncrypt(0x2687AFB1, fromNode, peerPub, ourPriv, 0xDEADBEEF, 0x01020304,
                        (const uint8_t *)msg, mlen, out, sizeof(out), &outLen);
    assert(ok && "pkiEncrypt must succeed for a directed send");
    assert(outLen == mlen + mt::PKI_OVERHEAD && "wire = ciphertext || auth[8] || extraNonce[4]");
    // The extraNonce must be recoverable from the tail — that is how the receiver
    // rebuilds the nonce it never saw.
    uint32_t tailNonce;
    memcpy(&tailNonce, out + mlen + mt::PKI_AUTH_LEN, 4);
    assert(tailNonce == 0x01020304u);

    ok = mt::pkiDecrypt(fromNode, peerPub, ourPriv, 0xDEADBEEF, out, outLen, rt, &rtLen);
    assert(ok && rtLen == mlen && memcmp(rt, msg, mlen) == 0);
    printf("PASS  pkiEncrypt -> pkiDecrypt round-trip (+%zu bytes overhead)\n", mt::PKI_OVERHEAD);

    // ---- 4. Tampering must be REJECTED, not silently delivered ---------------
    out[0] ^= 0x01;
    ok = mt::pkiDecrypt(fromNode, peerPub, ourPriv, 0xDEADBEEF, out, outLen, rt, &rtLen);
    assert(!ok && "a flipped ciphertext bit MUST fail the auth tag");
    out[0] ^= 0x01;
    out[mlen] ^= 0x01; // corrupt the auth tag itself
    ok = mt::pkiDecrypt(fromNode, peerPub, ourPriv, 0xDEADBEEF, out, outLen, rt, &rtLen);
    assert(!ok && "a corrupted auth tag MUST fail");
    printf("PASS  tamper rejection (ciphertext and auth tag)\n");

    // ---- 5. A PKC broadcast must be impossible to express --------------------
    ok = mt::pkiEncrypt(0xFFFFFFFF, fromNode, peerPub, ourPriv, 1, 1,
                        (const uint8_t *)msg, mlen, out, sizeof(out), &outLen);
    assert(!ok && "PKC to BROADCAST must be refused (no recipient key; channel-0 flood ban)");
    printf("PASS  broadcast refused (channel-0 flooding stays banned)\n");

    // ---- 6. Undersized output buffer must be REFUSED, not overrun ------------
    ok = mt::pkiEncrypt(0x2687AFB1, fromNode, peerPub, ourPriv, 1, 1,
                        (const uint8_t *)msg, mlen, out, mlen + mt::PKI_OVERHEAD, &outLen);
    assert(!ok && "len+PKI_OVERHEAD is NOT enough: CCM needs PKI_SCRATCH");
    printf("PASS  undersized buffer refused (no silent overrun)\n");

    printf("\nALL PKI VECTORS PASS\n");
    return 0;
}
