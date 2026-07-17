// Meshtastic channel crypto: AES-CTR with the packet id + sender as nonce.
// Mirrors the reference CryptoEngine exactly (docs/wire-format.md §4):
// key length selects AES128/AES256, counter size 4, nonce =
// packetId (u64 LE) ‖ fromNode (u32 LE) ‖ 4 zero bytes.
//
// CTR is symmetric — decrypt() will be the same call when RX lands.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace mt {

// In-place-safe encrypt (out may equal in). Returns false on bad key length
// (must be 16 or 32 bytes).
bool ctrCrypt(const uint8_t *psk, size_t pskLen, uint32_t packetId,
              uint32_t fromNode, const uint8_t *in, uint8_t *out, size_t len);

} // namespace mt
