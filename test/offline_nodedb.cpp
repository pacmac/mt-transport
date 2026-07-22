// offline_nodedb.cpp — host tests for the alarm's small node database.
//
// The ring decides which PKI peer keys survive, so its eviction order and its
// persistence round-trip are worth proving deterministically before any of it goes
// near a radio. Pure logic: no Arduino, no flash, no mesh.
//
// Build & run (from the mt-transport repo root):
//   g++ -std=c++17 -I../pac-garage-alarm/src test/offline_nodedb.cpp \
//       ../pac-garage-alarm/src/mt_nodedb.cpp -o /tmp/ndb && /tmp/ndb
#include "mt_nodedb.h"

#include <cassert>
#include <cstdio>
#include <cstring>

using namespace mtdb;

static void key(uint8_t k[32], uint8_t seed) { memset(k, seed, 32); }

int main() {
    uint8_t k1[32], k2[32];
    key(k1, 0xA1); key(k2, 0xB2);

    // ---- 1. admit, look up, and the no-key case -----------------------------
    begin();
    assert(count() == 0);
    assert(keyFor(1001) == nullptr && "unknown node must have no key -> broadcast fallback");
    heard(1001, 100);
    assert(count() == 1);
    assert(keyFor(1001) == nullptr && "admitted but keyless is still no key");
    assert(learnKey(1001, k1, 101) && "first key is a change");
    assert(keyFor(1001) != nullptr && memcmp(keyFor(1001), k1, 32) == 0);
    assert(!learnKey(1001, k1, 102) && "same key again is NOT a change (no flash write)");
    printf("PASS  admit / keyless lookup / learn / idempotent relearn\n");

    // ---- 2. a CHANGED key overwrites ----------------------------------------
    // Meshtastic refuses this; we deliberately do the opposite, because refusing
    // strands an unreflashable node forever and buys nothing against an attacker
    // who already holds the channel PSK.
    assert(learnKey(1001, k2, 103) && "changed key must report a change");
    assert(memcmp(keyFor(1001), k2, 32) == 0 && "changed key must OVERWRITE");
    printf("PASS  changed key overwrites (self-healing, not a dead end)\n");

    // ---- 3. LRU eviction order ----------------------------------------------
    begin();
    for (uint8_t i = 0; i < NODEDB_MAX; i++)
        heard(2000 + i, 1000 + i);          // 2000 oldest ... 2015 newest
    assert(count() == NODEDB_MAX);
    heard(3001, 2000);                      // full -> evict the oldest (2000)
    assert(count() == NODEDB_MAX && "ring stays full, does not grow");
    assert(keyFor(2000) == nullptr);
    bool has2000 = false, has3001 = false, has2015 = false;
    for (uint8_t i = 0; i < NODEDB_MAX; i++) {
        const Entry *e = at(i);
        if (e->nodeNum == 2000) has2000 = true;
        if (e->nodeNum == 3001) has3001 = true;
        if (e->nodeNum == 2015) has2015 = true;
    }
    assert(!has2000 && "least-recently-heard must be evicted");
    assert(has3001 && "new node must be admitted");
    assert(has2015 && "most-recently-heard must survive");
    printf("PASS  LRU eviction: oldest dropped, newest kept\n");

    // ---- 4. a bump rescues a node from eviction -----------------------------
    begin();
    for (uint8_t i = 0; i < NODEDB_MAX; i++)
        heard(2000 + i, 1000 + i);
    heard(2000, 5000);                      // 2000 was oldest; a command bumps it
    heard(4001, 6000);                      // now 2001 should be the victim
    bool still2000 = false, still2001 = false;
    for (uint8_t i = 0; i < NODEDB_MAX; i++) {
        if (at(i)->nodeNum == 2000) still2000 = true;
        if (at(i)->nodeNum == 2001) still2001 = true;
    }
    assert(still2000 && "a bumped node must survive — commands keep peers alive");
    assert(!still2001 && "the new oldest becomes the victim");
    printf("PASS  bump-on-traffic rescues a node from eviction\n");

    // ---- 5. the node we are replying to is never evicted --------------------
    begin();
    for (uint8_t i = 0; i < NODEDB_MAX; i++)
        heard(2000 + i, 1000 + i);
    setProtected(2000);                     // 2000 is the oldest AND in hand
    heard(5001, 7000);
    bool prot = false, victim2001 = true;
    for (uint8_t i = 0; i < NODEDB_MAX; i++) {
        if (at(i)->nodeNum == 2000) prot = true;
        if (at(i)->nodeNum == 2001) victim2001 = false;
    }
    assert(prot && "protected node must NOT be evicted even when oldest");
    assert(victim2001 && "the next-oldest is taken instead");
    setProtected(0);
    printf("PASS  never evict the node currently being replied to\n");

    // ---- 6. forget / clear (the no-reflash escape hatch) --------------------
    begin();
    heard(1001, 10); learnKey(1001, k1, 10);
    heard(1002, 11); learnKey(1002, k2, 11);
    assert(count() == 2);
    assert(forget(1001) && keyFor(1001) == nullptr && count() == 1);
    assert(!forget(9999) && "forgetting an unknown node reports false");
    clear();
    assert(count() == 0 && keyFor(1002) == nullptr);
    printf("PASS  forget / clear\n");

    // ---- 7. persistence round-trip + corruption rejection -------------------
    begin();
    heard(1001, 50); learnKey(1001, k1, 50); learnName(1001, "U33B");
    heard(1002, 60); learnKey(1002, k2, 60);
    uint8_t buf[2048];
    size_t n = serialize(buf, sizeof(buf));
    assert(n > 0 && "serialize must fit");
    assert(serialize(buf, 8) == 0 && "undersized buffer must be refused, not overrun");

    clear();
    assert(count() == 0);
    assert(deserialize(buf, n) && "round-trip must load");
    assert(count() == 2);
    assert(memcmp(keyFor(1001), k1, 32) == 0);
    assert(memcmp(keyFor(1002), k2, 32) == 0);
    assert(strcmp(at(0)->shortName, "U33B") == 0);
    assert(!dirty() && "a freshly loaded table is not dirty (no pointless flash write)");

    buf[10] ^= 0xFF;                        // corrupt a byte inside the payload
    assert(!deserialize(buf, n) && "CRC mismatch must be REJECTED wholesale");
    buf[10] ^= 0xFF;
    buf[4] = 99;                            // wrong version
    assert(!deserialize(buf, n) && "version mismatch must be rejected");
    printf("PASS  persistence round-trip, undersize refusal, CRC + version rejection\n");

    printf("\nALL NODEDB TESTS PASS\n");
    return 0;
}
