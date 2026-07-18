// MeshtasticTransport — Meshtastic as a transport, not an operating system.
//
// Sends Meshtastic-compatible encrypted LoRa packets from a bare RadioLib
// sketch. No NodeDB, no router, no power state machine, no opinion about when
// your CPU sleeps. Wire format verified against the reference firmware —
// docs/wire-format.md cites every value.
//
// The application owns:
//   - the radio object (pins and board wiring are board problems)
//   - entropy (the packet id is the AES-CTR nonce; predictable ids are a
//     crypto failure, so begin() refuses to run without an RNG)
//   - message construction (send() takes a portnum and pre-encoded protobuf
//     bytes — this library does not know what a Telemetry is)
//   - CPU sleep, always
#pragma once

#include <RadioLib.h>

#include "mt_wire.h"

namespace mt {

struct MeshChannel {
    const char    *name;
    const uint8_t *psk;    // 16 bytes → AES128, 32 → AES256
    size_t         pskLen;
};

struct RegionParams {
    float    freqMHz;
    float    bwKHz;
    uint8_t  sf;
    uint8_t  cr;
    uint8_t  syncWord;
    uint16_t preambleLen;
};

// EU_868 single-slot + LONG_FAST preset: every EU_868 node, regardless of
// channel name, sits on 869.525 MHz (docs/wire-format.md §1).
extern const RegionParams EU868_LONG_FAST;

// A received, decrypted, decoded packet from our channel.
struct RxPacket {
    uint32_t from, to, id;
    uint32_t portnum;
    uint32_t requestId; // Data.request_id — ACKs reference the packet they answer
    uint8_t  hopLimit;
    bool     wantAck;
    float    rssi, snr;
    uint8_t  payload[237];
    size_t   payloadLen;
};

class MeshtasticTransport {
public:
    // Applies the PHY configuration sequence the reference firmware uses
    // (begin → setCurrentLimit(140) → setDio2AsRfSwitch → setCRC on).
    // txDbm is deliberately a parameter with a modest default — crank it only
    // when the link needs it. Returns false on radio error, bad PSK length,
    // or missing rng.
    bool begin(SX1262 &radio, const RegionParams &region, const MeshChannel &ch,
               uint32_t nodeNum, uint32_t (*rng)(), int8_t txDbm = 2);

    // Encrypt and transmit one packet, blocking. payload = the app-level
    // protobuf bytes (an encoded Telemetry, User, or raw bytes for e.g.
    // DETECTION_SENSOR_APP); this wraps them in Data{portnum, payload} —
    // the Data envelope is transport, what goes inside it is yours.
    // requestId (0 = absent) fills Data.request_id — set it when this packet
    // answers another (ACKs, command responses).
    // Returns false on encode, size or radio error.
    // replyId (0 = absent) fills Data.reply_id — Meshtastic apps render the
    // message as a threaded reply to that packet.
    bool send(uint32_t portnum, const uint8_t *payload, size_t len,
              uint32_t to = BROADCAST_ADDR, uint8_t hopLimit = 3,
              uint32_t requestId = 0, uint32_t replyId = 0);

    // Bounded listen (the Class-A window; an always-awake app just calls it
    // in a loop). True when a packet on OUR channel, addressed to us or
    // broadcast, decrypts, decodes and is not a recent duplicate. Frames
    // failing any filter are dropped and the wait continues to the deadline.
    bool receive(uint32_t timeoutMs, RxPacket &out);

    // Protocol ACK: Routing{error_reason=NONE} on ROUTING_APP with
    // request_id=id. Stops the sender's ReliableRouter retransmissions and
    // marks a phone's DM "delivered".
    bool sendAck(uint32_t to, uint32_t requestId);

    // Retransmit the last transmitted frame verbatim — same packet id, same
    // bytes. Crypto-safe (identical plaintext under the same keystream is a
    // retransmission, not a nonce reuse) and mesh-friendly: receivers that
    // caught the first copy dedupe this one, so exactly one message surfaces.
    // Use to shore up one-shot replies on lossy links.
    bool resend();

    bool busy() const { return false; } // transmit() is blocking; real once RX lands

    // Radio only — CPU sleep is yours. Both return whether the radio
    // acknowledged; a caller that ignores the result is back to a silently
    // dead radio. wake() is the supported counterpart to sleep(): reaching
    // past this API to radio.standby() is how the wake error came to be
    // discarded in the first place.
    bool sleep();
    bool wake();

    uint32_t lastPacketId() const { return _lastId; }
    uint8_t  channelHash() const { return _hash; }

    // Times a transmit was deferred because CAD heard LoRa activity —
    // real-world contention data for the app to log.
    uint32_t csmaDeferrals() const { return _csmaDeferrals; }

    // Consecutive RADIO-LEVEL transmit failures; cleared by the first success.
    // Encode/size/crypto rejections return before the transmit path is reached,
    // so they can never inflate this. A sustained streak means hardware, not
    // contention: CSMA fails open, so a busy channel still reaches transmit()
    // and a healthy radio still returns ERR_NONE and clears the count.
    uint32_t txFailStreak() const { return _txFailStreak; }

    // DEBUG/TEST ONLY. Forces the streak so a node can prove its own watchdog
    // gate without a genuinely broken radio. Never called in normal operation;
    // any successful transmit clears it again.
    void forceTxFailStreak(uint32_t n) { _txFailStreak = n; }

    // Airtime accounting since the last resetAirWindow(). TX airtime is exact
    // (we own every transmit); RX airtime is every frame the radio decoded,
    // whether or not it passed our filters (channel occupancy is RF-level).
    // air_util_tx = airTxMs/airWindowMs is honest in any mode; channel util
    // = (airTxMs+airRxMs)/airWindowMs is meaningful ONLY while continuously
    // listening (a sleeping node hears almost nothing).
    uint32_t airTxMs() const { return _txAirMs; }
    uint32_t airRxMs() const { return _rxAirMs; }
    uint32_t airWindowMs() const { return millis() - _airWindowStart; }
    void resetAirWindow() { _txAirMs = 0; _rxAirMs = 0; _airWindowStart = millis(); }

    // Introspection for oracles/tests: the exact frame last transmitted.
    const uint8_t *lastFrame() const { return _frame; }
    size_t         lastFrameLen() const { return _frameLen; }

private:
    SX1262      *_radio = nullptr;
    MeshChannel  _ch{};
    uint32_t     _nodeNum = 0;
    uint32_t (*_rng)() = nullptr;
    uint8_t      _hash = 0;
    uint32_t     _lastId = 0;

    static const size_t MAX_PAYLOAD = 237; // MAX_LORA_PAYLOAD_LEN+1-16 (RadioInterface.h:66)
    uint8_t _frame[sizeof(PacketHeader) + MAX_PAYLOAD];
    size_t  _frameLen = 0;

    bool _rxActive = false;       // radio currently in RX (survives short polls)
    uint64_t _seen[8] = {0};      // (from<<32|id) dedupe ring
    uint8_t  _seenIdx = 0;
    uint32_t _csmaDeferrals = 0;
    uint32_t _txFailStreak = 0;
    uint32_t _txAirMs = 0, _rxAirMs = 0, _airWindowStart = 0;
    bool isDuplicate(uint32_t from, uint32_t id);
    void waitForClearChannel();   // CSMA: CAD + backoff, fail-open ~2 s
    bool transmitFrame();         // the ONE transmit path: CSMA + airtime + transmit
};

} // namespace mt
