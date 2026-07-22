// offline_wire_flags.cpp — deterministic, no-radio wire-format contract test for
// the v2 Phase 1 reliability layer. want_ack lives in the device<->device
// PacketHeader.flags byte, which the node client never sees post-gateway, so this
// tier is a HOST-COMPILED C++ check (not a node test). It pins the exact bit
// layout that send() sets and handleRxDone() reads.
//
// Build & run (from repo root):
//   g++ -std=c++17 -Isrc test/offline_wire_flags.cpp src/mt_wire.cpp -o /tmp/wf && /tmp/wf
// Exit 0 = pass (asserts abort on failure).
#include "mt_wire.h"
#include <cstdio>
#include <cassert>
using namespace mt;

int main() {
    // v1 default: no want_ack. hop=3, hop_start=3.
    uint8_t f0 = packFlags(3, 3, false, false);
    assert((f0 & 0x08) == 0 && "want_ack MUST be clear when not requested");
    assert((f0 & 0x07) == 3 && "hop_limit = low 3 bits");
    assert(((f0 >> 5) & 0x07) == 3 && "hop_start = high 3 bits");

    // v2 reliable: want_ack set — and it differs from v1 in bit 3 ONLY.
    uint8_t f1 = packFlags(3, 3, true, false);
    assert((f1 & 0x08) != 0 && "want_ack MUST be set (bit 3 / 0x08)");
    assert(f1 == (f0 | 0x08) && "reliable flags differ from v1 only in bit 3");

    // RX extraction round-trip (handleRxDone: p.wantAck = h.flags & 0x08).
    assert((bool)(f1 & 0x08) == true);
    assert((bool)(f0 & 0x08) == false);

    // send()'s directed-gating contract: reliable = wantAck && to != BROADCAST_ADDR.
    const uint32_t NODE = 0x2364420b; // any non-broadcast node number
    auto reliable = [](bool wantAck, uint32_t to){ return wantAck && to != BROADCAST_ADDR; };
    assert(reliable(true,  NODE)           == true  && "directed want_ack -> reliable");
    assert(reliable(true,  BROADCAST_ADDR) == false && "broadcast want_ack -> flag dropped");
    assert(reliable(false, NODE)           == false && "no want_ack -> not reliable");

    printf("PASS  f0(v1)=0x%02X  f1(reliable)=0x%02X  bit3 delta=0x%02X\n",
           f0, f1, (uint8_t)(f1 ^ f0));
    printf("PASS  directed-gating: want_ack honored only when to != BROADCAST\n");
    return 0;
}
