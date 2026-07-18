#include "MeshtasticTransport.h"

#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>

#include "meshtastic/mesh.pb.h"
#include "meshtastic/portnums.pb.h"
#include "mt_crypto.h"

namespace mt {

const RegionParams EU868_LONG_FAST = {869.525f, 250.0f, 11, 5, 0x2b, 16};

bool MeshtasticTransport::begin(SX1262 &radio, const RegionParams &region,
                                const MeshChannel &ch, uint32_t nodeNum,
                                uint32_t (*rng)(), int8_t txDbm)
{
    if (!rng || !ch.psk || (ch.pskLen != 16 && ch.pskLen != 32) || nodeNum == 0)
        return false;

    _radio = &radio;
    _ch = ch;
    _nodeNum = nodeNum;
    _rng = rng;
    _hash = mt::channelHash(ch.name, ch.psk, ch.pskLen);

    // Mirrors SX126xInterface::init in the reference firmware.
    int st = radio.begin(region.freqMHz, region.bwKHz, region.sf, region.cr,
                         region.syncWord, txDbm, region.preambleLen,
                         1.8f /* DIO3 TCXO */, false /* DCDC, not LDO */);
    if (st != RADIOLIB_ERR_NONE)
        return false;
    radio.setCurrentLimit(140.0f);
    radio.setDio2AsRfSwitch(true);
    radio.setCRC(RADIOLIB_SX126X_LORA_CRC_ON);
    return true;
}

bool MeshtasticTransport::send(uint32_t portnum, const uint8_t *payload,
                               size_t len, uint32_t to, uint8_t hopLimit,
                               uint32_t requestId, uint32_t replyId)
{
    if (!_radio || len > sizeof(meshtastic_Data_payload_t::bytes))
        return false;
    _rxActive = false; // transmit takes the radio out of RX

    // Envelope: Data{portnum, payload}
    meshtastic_Data data = meshtastic_Data_init_zero;
    data.portnum = (meshtastic_PortNum)portnum;
    data.payload.size = len;
    memcpy(data.payload.bytes, payload, len);
    data.request_id = requestId;
    data.reply_id = replyId;

    uint8_t plain[MAX_PAYLOAD];
    pb_ostream_t os = pb_ostream_from_buffer(plain, sizeof(plain));
    if (!pb_encode(&os, meshtastic_Data_fields, &data))
        return false;
    size_t plainLen = os.bytes_written;

    // Packet id: non-zero, non-repeating — it is the CTR nonce.
    uint32_t id = _rng();
    if (id == 0)
        id = 1;
    _lastId = id;

    uint8_t *cipher = _frame + sizeof(PacketHeader);
    if (!ctrCrypt(_ch.psk, _ch.pskLen, id, _nodeNum, plain, cipher, plainLen))
        return false;

    PacketHeader h;
    h.to = to;
    h.from = _nodeNum;
    h.id = id;
    h.flags = packFlags(hopLimit, hopLimit); // hop_start = hop_limit at origin
    h.channel = _hash;
    h.next_hop = 0;
    h.relay_node = 0;
    memcpy(_frame, &h, sizeof(h));
    _frameLen = sizeof(h) + plainLen;

    return transmitFrame();
}

void MeshtasticTransport::waitForClearChannel()
{
    // Listen-before-talk: transmitting blind is how deployment #1 lost
    // nearly every reply. CAD before TX; escalating random backoff while the
    // channel is busy; FAIL-OPEN after ~2 s — an alarm that politely never
    // speaks is worse than a collision.
    _rxActive = false; // CAD ends in standby
    for (int attempt = 0; attempt < 8; attempt++) {
        if (_radio->scanChannel() == RADIOLIB_CHANNEL_FREE)
            return;
        _csmaDeferrals++;
        uint32_t window = 60u << (attempt < 3 ? attempt : 3);
        delay(30 + (_rng ? _rng() : 0) % window);
    }
    // 8 busy scans: transmit anyway.
}

// The single choke point for every transmission. send() and resend() both
// route through here, so CSMA, airtime accounting and the transmit itself can
// never drift apart (F6) — and there is exactly one place that knows whether a
// frame actually reached the antenna.
//
// Airtime is computed BEFORE transmit() and must stay that way:
// getTimeOnAir() opens with a getPacketType() SPI read, which is valid in
// standby (where CAD leaves the chip) but returns garbage in sleep.
bool MeshtasticTransport::transmitFrame()
{
    waitForClearChannel();                              // also clears _rxActive
    _txAirMs += _radio->getTimeOnAir(_frameLen) / 1000;
    // Only radio-level outcomes reach here: send() rejects encode/size/crypto
    // failures before this point, so the streak can never be inflated by a bad
    // payload. A sustained streak therefore means hardware, not contention —
    // CSMA fails open, so a busy channel still reaches transmit() and a healthy
    // radio still clears the count.
    if (_radio->transmit(_frame, _frameLen) != RADIOLIB_ERR_NONE) {
        _txFailStreak++;
        return false;
    }
    _txFailStreak = 0;
    return true;
}

bool MeshtasticTransport::isDuplicate(uint32_t from, uint32_t id)
{
    uint64_t key = ((uint64_t)from << 32) | id;
    for (uint64_t k : _seen)
        if (k == key)
            return true;
    _seen[_seenIdx] = key;
    _seenIdx = (_seenIdx + 1) % 8;
    return false;
}

bool MeshtasticTransport::receive(uint32_t timeoutMs, RxPacket &out)
{
    if (!_radio)
        return false;

    if (!_rxActive) {
        if (_radio->startReceive() != RADIOLIB_ERR_NONE)
            return false;
        _rxActive = true;
    }

    uint32_t deadline = millis() + timeoutMs;
    do {
        if (!(_radio->getIrqFlags() & RADIOLIB_SX126X_IRQ_RX_DONE)) {
            delay(2);
            continue;
        }

        // A frame arrived: read it, then re-arm RX immediately — filter
        // rejects must not blind the rest of the window.
        uint8_t raw[sizeof(PacketHeader) + MAX_PAYLOAD];
        size_t rawLen = _radio->getPacketLength();
        int st = _radio->readData(raw, rawLen > sizeof(raw) ? sizeof(raw) : rawLen);
        float rssi = _radio->getRSSI(), snr = _radio->getSNR();
        if (st == RADIOLIB_ERR_NONE && rawLen > 0)
            _rxAirMs += _radio->getTimeOnAir(rawLen) / 1000; // channel occupancy
        _radio->startReceive();
        if (st != RADIOLIB_ERR_NONE || rawLen <= sizeof(PacketHeader) ||
            rawLen > sizeof(raw))
            continue;

        PacketHeader h;
        memcpy(&h, raw, sizeof(h));
        if (h.channel != _hash)
            continue; // not our channel
        if (h.from == _nodeNum)
            continue; // our own packet relayed back to us (rebroadcast peers)
        if (h.to != _nodeNum && h.to != BROADCAST_ADDR)
            continue; // not for us

        uint8_t plain[MAX_PAYLOAD];
        size_t plainLen = rawLen - sizeof(PacketHeader);
        if (!ctrCrypt(_ch.psk, _ch.pskLen, h.id, h.from, raw + sizeof(h),
                      plain, plainLen))
            continue;

        meshtastic_Data data = meshtastic_Data_init_zero;
        pb_istream_t is = pb_istream_from_buffer(plain, plainLen);
        if (!pb_decode(&is, meshtastic_Data_fields, &data))
            continue; // wrong PSK garbage decodes to noise; protobuf catches it

        if (isDuplicate(h.from, h.id))
            continue; // ReliableRouter retries land here

        out.from = h.from;
        out.to = h.to;
        out.id = h.id;
        out.portnum = data.portnum;
        out.requestId = data.request_id;
        out.hopLimit = h.flags & 0x07;
        out.wantAck = h.flags & 0x08;
        out.rssi = rssi;
        out.snr = snr;
        out.payloadLen = data.payload.size;
        memcpy(out.payload, data.payload.bytes, data.payload.size);
        return true;
    } while ((int32_t)(deadline - millis()) > 0);

    return false; // window closed; radio stays in RX for the next call
}

bool MeshtasticTransport::sendAck(uint32_t to, uint32_t requestId)
{
    meshtastic_Routing r = meshtastic_Routing_init_zero;
    r.which_variant = meshtastic_Routing_error_reason_tag;
    r.error_reason = meshtastic_Routing_Error_NONE;

    uint8_t buf[16];
    pb_ostream_t os = pb_ostream_from_buffer(buf, sizeof(buf));
    if (!pb_encode(&os, meshtastic_Routing_fields, &r))
        return false;
    return send(meshtastic_PortNum_ROUTING_APP, buf, os.bytes_written, to, 3,
                requestId);
}

bool MeshtasticTransport::resend()
{
    if (!_radio || _frameLen == 0)
        return false;
    return transmitFrame();
}

bool MeshtasticTransport::sleep()
{
    _rxActive = false;      // set BEFORE the radio call: a failure must never
    if (!_radio)            // leave the flag claiming RX is still armed
        return false;       // "no radio" is not "slept successfully"
    return _radio->sleep() == RADIOLIB_ERR_NONE;
}

// Counterpart to sleep(). RadioLib's no-arg sleep() is warm start with config
// retained (SX126x_commands.cpp:47), so standby() alone brings the radio back —
// no begin() re-init needed.
//
// Offering sleep() with no wake() is what pushed the firmware into calling
// radio.standby() directly and dropping its int16_t status. The missing API
// caused the discarded error, so the fix is the API, not a comment.
//
// NOTE: true means the SX1262 acknowledged the standby command. It does NOT
// prove the radio will transmit — a wedged part may answer and stay mute.
// txFailStreak() is the detector for that; this is the silent-failure half.
bool MeshtasticTransport::wake()
{
    _rxActive = false;
    if (!_radio)
        return false;
    return _radio->standby() == RADIOLIB_ERR_NONE;
}

} // namespace mt
