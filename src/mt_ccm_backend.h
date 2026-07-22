// AES backend for the vendored CCM code (aes-ccm.cpp).
//
// The upstream Meshtastic file calls a global `crypto->aesSetKey/aesEncrypt`. Rather
// than edit the vendored body (which would make future upstream diffs unreadable), we
// supply exactly that interface here and keep aes-ccm.cpp verbatim.
//
// It is an injectable interface, not a hard dependency on the Arduino Crypto library,
// so the CCM primitive can be exercised by host known-answer tests. Crypto without KATs
// is hope, not verification — and the device build cannot run them.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h> // vendored aes-ccm.cpp uses memcpy/memset and got these
                    // transitively from Arduino.h upstream; supply them here so
                    // the vendored body stays byte-identical to source.

namespace mt {

struct CcmAesBackend {
    virtual ~CcmAesBackend() {}
    // Load the AES key (32 bytes for the AES-256 that Meshtastic PKC uses).
    virtual void aesSetKey(const uint8_t *key, size_t key_len) = 0;
    // Single-block ECB encrypt: out[16] = E(K, in[16]). CCM builds CBC-MAC and CTR
    // from this one primitive, so it is the only operation the backend must provide.
    virtual void aesEncrypt(uint8_t *in, uint8_t *out) = 0;
};

// The active backend. Must be non-null before any aes_ccm_ae/ad call; mt::pkiBegin()
// installs the device one, tests install their own.
extern CcmAesBackend *crypto;
void setCcmAesBackend(CcmAesBackend *b);

} // namespace mt

// The vendored aes-ccm.cpp lives in the global namespace and says `crypto->…`.
using mt::crypto;
