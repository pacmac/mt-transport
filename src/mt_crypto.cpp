#include "mt_crypto.h"

#include <string.h>

#include <AES.h>
#include <CTR.h>

namespace mt {

bool ctrCrypt(const uint8_t *psk, size_t pskLen, uint32_t packetId,
              uint32_t fromNode, const uint8_t *in, uint8_t *out, size_t len)
{
    if (pskLen != 16 && pskLen != 32)
        return false;

    uint8_t nonce[16] = {0};
    uint64_t id64 = packetId;
    memcpy(nonce, &id64, 8);
    memcpy(nonce + 8, &fromNode, 4);

    if (pskLen == 16) {
        CTR<AES128> ctr;
        ctr.setKey(psk, pskLen);
        ctr.setIV(nonce, 16);
        ctr.setCounterSize(4); // reference CryptoEngine.cpp:388
        ctr.encrypt(out, in, len);
    } else {
        CTR<AES256> ctr;
        ctr.setKey(psk, pskLen);
        ctr.setIV(nonce, 16);
        ctr.setCounterSize(4);
        ctr.encrypt(out, in, len);
    }
    return true;
}

} // namespace mt
