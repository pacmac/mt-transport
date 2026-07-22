// Vendored from Meshtastic (src/mesh/aes-ccm.h) for mt-transport PKI DMs.
// Upstream is hostap's BSD-licensed CCM; kept close to source so future diffs stay readable.
// Only change: the AES backend comes from mt_ccm_backend.h instead of CryptoEngine.
#pragma once
#include "mt_ccm_backend.h"

int aes_ccm_ae(const uint8_t *key, size_t key_len, const uint8_t *nonce, size_t M, const uint8_t *plain, size_t plain_len,
               const uint8_t *aad, size_t aad_len, uint8_t *crypt, uint8_t *auth);

bool aes_ccm_ad(const uint8_t *key, size_t key_len, const uint8_t *nonce, size_t M, const uint8_t *crypt, size_t crypt_len,
                const uint8_t *aad, size_t aad_len, const uint8_t *auth, uint8_t *plain);