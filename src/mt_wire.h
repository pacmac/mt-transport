// Meshtastic wire format: the 16-byte cleartext packet header and the
// channel hash. Every value verified against the reference firmware —
// citations in docs/wire-format.md.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace mt {

struct __attribute__((packed)) PacketHeader {
    uint32_t to;         // 0xFFFFFFFF = broadcast
    uint32_t from;       // sender node number
    uint32_t id;         // non-zero, non-repeating — also the AES-CTR nonce
    uint8_t  flags;      // hop_limit | want_ack<<3 | via_mqtt<<4 | hop_start<<5
    uint8_t  channel;    // xorHash(name) ^ xorHash(psk)
    uint8_t  next_hop;   // 0 = unknown/any
    uint8_t  relay_node; // 0 = not relayed
};
static_assert(sizeof(PacketHeader) == 16, "header must be 16 bytes");

static const uint32_t BROADCAST_ADDR = 0xFFFFFFFF;

uint8_t xorHash(const uint8_t *p, size_t len);
uint8_t channelHash(const char *name, const uint8_t *psk, size_t pskLen);
uint8_t packFlags(uint8_t hopLimit, uint8_t hopStart, bool wantAck = false,
                  bool viaMqtt = false);

} // namespace mt
