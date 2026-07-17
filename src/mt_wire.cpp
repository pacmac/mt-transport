#include "mt_wire.h"

#include <string.h>

namespace mt {

uint8_t xorHash(const uint8_t *p, size_t len)
{
    uint8_t code = 0;
    while (len--)
        code ^= *p++;
    return code;
}

uint8_t channelHash(const char *name, const uint8_t *psk, size_t pskLen)
{
    return xorHash((const uint8_t *)name, strlen(name)) ^ xorHash(psk, pskLen);
}

uint8_t packFlags(uint8_t hopLimit, uint8_t hopStart, bool wantAck, bool viaMqtt)
{
    return (hopLimit & 0x07) | (wantAck ? 0x08 : 0) | (viaMqtt ? 0x10 : 0) |
           ((hopStart & 0x07) << 5);
}

} // namespace mt
