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
    // Encrypt and ENQUEUE one packet, then return immediately — never blocks.
    // The frame leaves the antenna later, driven by service() (scheduled send +
    // async CAD + startTransmit). Returns false on encode/size/crypto error or a
    // full queue; true means "accepted for transmission", not "on air yet".
    //
    // wantAck (v2 reliability): when true AND this is a directed send (to !=
    // BROADCAST_ADDR), the want_ack flag is set and the transport auto-retransmits
    // the frame (verbatim, same id) until a matching ROUTING_APP ACK arrives or the
    // attempt budget is spent — see setAckTimeoutMs/setAckMaxAttempts. On a broadcast
    // the flag is silently dropped: broadcasts are never ACKed (the mesh floods them),
    // so requesting an ACK is meaningless. Default false keeps v1 callers unchanged.
    bool send(uint32_t portnum, const uint8_t *payload, size_t len,
              uint32_t to = BROADCAST_ADDR, uint8_t hopLimit = 3,
              uint32_t requestId = 0, uint32_t replyId = 0, bool wantAck = false);

    // The pump. Call once every loop() pass. NEVER blocks — no delay(), no spin.
    // Services one radio interrupt if one fired (RX-done → decode+queue, TX-done
    // → advance the send queue, CAD-done → gate the pending transmit) and drives
    // the transmit state machine (scheduled send time, async CAD, startTransmit).
    // Everything the radio does happens here, on the main context; the ISR only
    // sets a flag. This is what lets loop() stay live through a whole heartbeat
    // bundle instead of going deaf for each frame's airtime.
    void service();

    // Non-blocking RX delivery. Pops AT MOST one decoded packet that service()
    // has already read off the radio and queued; returns immediately. True on a
    // packet that passed every filter (channel/addr/dup/decrypt), false when the
    // queue is empty. Touches no radio state — safe to call right after
    // service(). Call in a loop to drain more than one.
    bool poll(RxPacket &out);

    // Bounded listen (the Class-A window; the sleep-cycle RX window uses it).
    // Loops service()+poll() until a good packet lands or timeoutMs elapses. The
    // delay(2) yield here is confined to this sleep-adjacent path; the always-awake
    // loop() calls service()+poll() directly and never blocks.
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

    // ---- v2 Phase 1b: PKI (PKC) direct messages ------------------------------
    // Meshtastic 2.8 discards PSK-encrypted DMs ("legacy DM"), so PKC is the only
    // carrier a stock gateway will accept — see docs/v2/APIV2.md §5.1.
    //
    // Identity is INJECTED, never baked in or generated behind the app's back: the
    // application owns and PERSISTS the 32-byte private key, exactly as it owns the
    // channel PSK. Regenerating it silently breaks every inbound DM, and the device
    // cannot tell you that happened — so the lib refuses to own that decision.
    bool setPkiIdentity(const uint8_t privateKey[32]);
    bool pkiReady() const { return _pkiHavePriv; }

    // Register a peer's public key so we can encrypt to it. Small table by design:
    // we talk to a gateway, not a whole mesh. Replaces the key if the node is known.
    bool addPkiPeer(uint32_t nodeNum, const uint8_t publicKey[32]);

    // Send a PKC direct message. Always directed — a PKC broadcast has no recipient
    // key AND would be a broadcast on channel 0, which stays banned. Sets the header
    // channel byte to 0 (the PKC marker, not the primary channel) and costs 12 bytes
    // of payload budget. wantAck works here, which is the entire point: this is the
    // path on which the acked comfort reply becomes possible.
    bool sendPki(uint32_t portnum, const uint8_t *payload, size_t len, uint32_t to,
                 uint8_t hopLimit = 3, uint32_t requestId = 0, uint32_t replyId = 0,
                 bool wantAck = false);

    // v2 reliability config (RAM-only, not persisted — a reboot restores defaults,
    // so a test value can never silently outlive a test). A directed want_ack send
    // is retransmitted every timeoutMs until ACKed, for at most maxAttempts total
    // transmissions (the original counts as attempt 1). Defaults 4000 ms / 3 — worst
    // case ~12 s, inside the observed reply tolerance.
    void setAckTimeoutMs(uint32_t ms) { _ackTimeoutMs = ms; }
    void setAckMaxAttempts(uint8_t n) { _ackMaxAttempts = n ? n : 1; }

    // TX-path trace hook (diagnostics). NULL by default; the library never logs on
    // its own. Every call site is guarded, so with no hook registered behaviour is
    // byte-identical.
    void setTxTrace(void (*fn)(const char *ev, uint32_t a, uint32_t b)) { _txTrace = fn; }

    // PKC RECEIVE diagnostics. A PKC packet that cannot be decrypted is dropped
    // inside handleRxDone(), before the application sees anything — so a REJECTED DM
    // looks exactly like one that never arrived. These make the two distinguishable,
    // which is the difference between debugging and guessing. The library still does
    // no logging of its own; the app reports these.
    uint32_t pkiRxOk() const { return _pkiRxOk; }             // decrypted successfully
    uint32_t pkiRxNoKey() const { return _pkiRxNoKey; }       // sender's public key unknown
    uint32_t pkiRxAuthFail() const { return _pkiRxAuthFail; } // wrong key / forged frame
    uint32_t pkiLastFrom() const { return _pkiLastFrom; }     // sender of the last PKC packet seen

    // Introspection for oracles/tests and app diagnostics.
    uint32_t pendingAckId() const { return _pendingId; }        // 0 = no reliable send outstanding
    uint32_t ackRetransmits() const { return _ackRetransmits; } // cumulative retransmit frames sent
    // Reliable sends that ended WITHOUT a confirmed ACK: attempts exhausted, OR
    // superseded by a newer reliable send before this one was ACKed (single-slot).
    uint32_t ackFailTotal() const { return _ackFailTotal; }

    // True while a transmission is queued or in flight — the send path is async
    // now, so this actually means something (unlike the old blocking transmit()).
    bool busy() const { return _txState != TX_IDLE || _txCount > 0; }

    // Meshtastic contention model (RadioInterface::getTxDelayMsec). NOT a delay():
    // how many ms to SCHEDULE a transmit ahead — a random multiple of a slot time
    // from a window whose size grows with channel utilisation. Every enqueue uses
    // it by default. scheduleNextTxIn() overrides the scheduled delay for the NEXT
    // enqueued frame only (used to space a reply's resend behind the reply).
    // (MT's SNR-weighted variant is deliberately NOT provided: it delays STRONG
    // links longest — a flood-rebroadcast priority rule that is wrong for a direct
    // reply, and this transport does not rebroadcast.)
    uint32_t getTxDelayMsec();
    void     scheduleNextTxIn(uint32_t ms) { _nextTxDelay = ms; _nextTxDelaySet = true; }

    // One-shot: the NEXT enqueued frame carries Data.want_response = true. Used by
    // the key-request bootstrap (directed NodeInfo asking the peer to answer with
    // its User/public key). Mirrors the scheduleNextTxIn one-shot pattern.
    void wantResponseNext() { _wantRespNext = true; }

    // TEST/DIAGNOSTIC hop override. When 1..7, send() forces EVERY frame's hop_limit
    // to this value regardless of the per-call argument; 0 = off (use the per-call
    // value). RAM-only — NOT persisted — so a reboot clears it; a forced hop must
    // never silently outlive a test. Drives the hop-latency matrix (tools/hop-matrix.js),
    // which sweeps hop across all data types on one build.
    void    setHopOverride(uint8_t h) { _hopOverride = h > 7 ? 7 : h; }
    uint8_t hopOverride() const { return _hopOverride; }

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
    // CUMULATIVE count of periodic AGC resets performed (see resetAGC). Surfaced in the
    // DEBUG frame so the reset's effect on csmaDeferrals is verifiable before/after.
    uint32_t agcResets() const { return _agcResets; }

    // Consecutive RADIO-LEVEL transmit failures; cleared by the first success.
    // Encode/size/crypto rejections return before the transmit path is reached,
    // so they can never inflate this. A sustained streak means hardware, not
    // contention: CSMA fails open, so a busy channel still reaches transmit()
    // and a healthy radio still returns ERR_NONE and clears the count.
    uint32_t txFailStreak() const { return _txFailStreak; }

    // CUMULATIVE frames discarded by the TX state machine after send() already
    // returned true — startTransmit() errored, or TX-done never arrived. NEVER
    // reset, which is the whole point: txFailStreak() above is a STREAK zeroed by
    // the next success, so it is blind to INTERMITTENT loss. send() reports success
    // at ENQUEUE, so without this number a frame that was queued and never went out
    // is invisible to the application — and "the device transmitted it" becomes an
    // unfounded claim. This is the only counter that can contradict it.
    uint32_t txDropped() const { return _txDropped; }

    // DEBUG/TEST ONLY. Forces the streak so a node can prove its own watchdog
    // gate without a genuinely broken radio. Never called in normal operation;
    // any successful transmit clears it again.
    void forceTxFailStreak(uint32_t n) { _txFailStreak = n; }

    // Frames that arrived but were destroyed by a transmit before we could read
    // them. Non-zero means real inbound traffic is being lost to our own TX
    // path. Also diagnostic: if this climbs while csmaDeferrals climbs, the CAD
    // detections were real traffic; if it stays zero while deferrals climb, CAD
    // is detecting preambles that never become frames.
    uint32_t rxDroppedByTx() const { return _rxDroppedByTx; }

    // Airtime accounting, ported from Meshtastic's AirTime (src/airtime.{h,cpp}).
    //
    // The previous homegrown version had the CALLER own the window: it read
    // airWindowMs() then called resetAirWindow(), so the denominator was "time since
    // someone last looked". Once telemetry became change-gated that could be hours,
    // and the microsecond counters could wrap (~71 min of accumulated airtime) —
    // producing an arbitrary utilisation that then sized the CSMA contention window.
    // Fixed buckets remove that entire class of failure: each bucket holds at most
    // one bucket-period of airtime, and the denominator is a constant.

    // Channel occupancy over a fixed 60 s window (6 x 10 s buckets). Everything on
    // air counts — our TX and every frame the radio completed, valid or noise —
    // because occupancy is a property of the channel, not of whether we liked the
    // packet. This is what getTxDelayMsec() may safely use: bounded 0..100.
    float channelUtilizationPercent() const;

    // Our own TX duty cycle over a fixed 1 h window (60 x 1 min buckets).
    float utilizationTxPercent() const;

    // Cumulative totals, diagnostics only. Upstream's note applies:
    // rxAll - rxValid = airtime from other LoRa radios on our frequency.
    uint32_t airTxMsTotal() const { return _txMs; }
    uint32_t airRxMsTotal() const { return _rxValidMs; }
    uint32_t airRxAllMsTotal() const { return _rxAllMs; }

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
    static const size_t FRAME_CAP = sizeof(PacketHeader) + MAX_PAYLOAD;

    // Contention-window bounds (MT RadioInterface.h) and the slot time computed
    // from the region's SF/BW at begin(). Scheduled TX delays are multiples of it.
    static const uint8_t CWMIN = 3, CWMAX = 8;
    uint32_t _slotTimeMsec = 30;      // recomputed in begin() from SF/BW
    uint32_t _nextTxDelay = 0;        // one-shot scheduled-delay override…
    bool     _nextTxDelaySet = false; // …consumed by the next enqueueFrame()
    bool     _wantRespNext = false;   // one-shot Data.want_response (wantResponseNext)
    uint8_t  _hopOverride = 0;        // 0=off; 1..7 forces every frame's hop (test, RAM-only)
    uint8_t _frame[FRAME_CAP];    // introspection: the most recently built frame
    size_t  _frameLen = 0;

    // v2 reliable-send pending slot: ONE outstanding directed want_ack send. Its
    // own frame copy — _frame above is overwritten by any later send(), so the
    // retransmit must NOT reuse it. _pendingId 0 = slot empty (send() forces id != 0).
    uint8_t  _pendingFrame[FRAME_CAP];
    size_t   _pendingLen = 0;
    uint32_t _pendingId = 0;
    uint32_t _pendingDeadline = 0;    // millis() when the next retransmit is due
    uint8_t  _pendingAttempts = 0;    // transmissions so far (original = 1)
    uint32_t _ackTimeoutMs = 4000;
    uint8_t  _ackMaxAttempts = 3;
    uint32_t _ackRetransmits = 0;     // cumulative
    uint32_t _ackFailTotal = 0;       // cumulative (exhausted or superseded)
    uint32_t _pkiRxOk = 0, _pkiRxNoKey = 0, _pkiRxAuthFail = 0, _pkiLastFrom = 0;

    void (*_txTrace)(const char *, uint32_t, uint32_t) = nullptr;
    void trace(const char *ev, uint32_t a, uint32_t b) { if (_txTrace) _txTrace(ev, a, b); }

    bool _rxActive = false;       // radio currently in RX (survives short polls)

    // DIO1 interrupt. RadioLib's setDio1Action takes a plain void(*)(void), so the
    // handler is a static trampoline that flags the one live instance — this app
    // has a single radio. The ISR does NOTHING but set the flag (no SPI, no
    // library calls); service() reads getIrqFlags() on the main context to learn
    // WHICH event it was. DIO1 fires for RX-done, TX-done AND CAD-done, so the
    // flag is generic. Volatile: the ISR and service() race on it.
    static MeshtasticTransport *_isrTarget;
    static void _onDio1Rx();
    volatile bool _radioEvent = false;

    // Outbound queue + transmit state machine (async, non-blocking).
    enum TxState : uint8_t { TX_IDLE, TX_WAITING, TX_SCANNING, TX_SENDING };
    struct TxItem {
        uint8_t  frame[FRAME_CAP];
        uint16_t len;
        uint32_t txAfter;   // millis() gate — do not transmit before this
        uint8_t  attempts;  // CSMA backoff count; >=8 fails open (transmit anyway)
    };
    // Sized to hold a heartbeat bundle (6) PLUS an in-flight chunk pull batch
    // (node-dash pulls 4) PLUS a command reply, so a chunk transfer coinciding
    // with a heartbeat never overflows the queue and silently drops a frame.
    // (ChunkServer::onFrame enqueues the whole pulled batch in one call.)
    static const uint8_t TXQ_N = 16;
    TxItem   _txq[TXQ_N];
    uint8_t  _txHead = 0, _txCount = 0;
    TxState  _txState = TX_IDLE;
    uint32_t _txStateMs = 0;          // when the current SCANNING/SENDING began (timeout safety)
    float    _freqMHz = 0.0f;         // stored from region in begin(), for the periodic calibrateImage()
    uint32_t _lastAgcResetMs = 0;     // millis() of the last periodic AGC reset

    // Decoded RX packets service() has pulled off the radio, waiting for poll().
    static const uint8_t RXQ_N = 4;
    RxPacket _rxq[RXQ_N];
    uint8_t  _rxqHead = 0, _rxqCount = 0;

    uint64_t _seen[8] = {0};      // (from<<32|id) dedupe ring
    uint8_t  _seenIdx = 0;
    uint32_t _csmaDeferrals = 0;
    uint32_t _agcResets = 0;          // cumulative; never reset
    uint32_t _txFailStreak = 0;
    uint32_t _txDropped = 0;
    uint32_t _rxDroppedByTx = 0;
    // ---- airtime buckets (ported from Meshtastic AirTime) --------------------
    // Milliseconds, not microseconds: bucketing makes the precision argument moot
    // (a bucket holds <= its period) and µs is what allowed the wrap.
    static const uint8_t  AIR_UTIL_BUCKETS   = 6;      // x 10 s = 60 s window
    static const uint32_t AIR_UTIL_BUCKET_MS = 10000;
    static const uint8_t  AIR_TX_BUCKETS     = 60;     // x 1 min = 1 h window
    static const uint32_t AIR_TX_BUCKET_MS   = 60000;
    uint32_t _chanUtil[AIR_UTIL_BUCKETS] = {0}; // all airtime: our TX + every RX
    uint32_t _txUtil[AIR_TX_BUCKETS]     = {0}; // our TX only
    uint32_t _utilEpoch = 0, _txEpoch = 0;      // last bucket index seen, for rotation
    uint32_t _txMs = 0, _rxValidMs = 0, _rxAllMs = 0; // cumulative, diagnostics only

    enum AirKind { AIR_TX, AIR_RX_VALID, AIR_RX_ALL };
    void airLog(AirKind kind, uint32_t ms);
    void airRotate();

    bool isDuplicate(uint32_t from, uint32_t id);
    void armRx();                 // startReceive() + set _rxActive
    void handleRxDone();          // read one frame off the radio, decode, queue it
    bool pushRx(const RxPacket &p);
    bool enqueueFrame(const uint8_t *frame, size_t len); // copy into the TX ring
    void serviceAck();            // v2: retransmit the pending want_ack frame on timeout

    static constexpr uint32_t AGC_RESET_INTERVAL_MS = 60000; // upstream cadence
    void maybeResetAGC();         // per service(): fires resetAGC() when idle AND interval elapsed
    void resetAGC();              // standby -> CALIBRATE_ALL -> calibrateImage -> re-apply gain -> startReceive

    // Shared build+encrypt+queue path for send() and sendPki(); `usePki` selects the
    // PKC route (channel 0, X25519/CCM) over the channel-PSK route (channel hash, CTR).
    bool buildAndQueue(uint32_t portnum, const uint8_t *payload, size_t len, uint32_t to,
                       uint8_t hopLimit, uint32_t requestId, uint32_t replyId,
                       bool wantAck, bool usePki);
    const uint8_t *pkiPeerKey(uint32_t nodeNum) const;

    // PKI identity + peer table (see setPkiIdentity/addPkiPeer).
    static const uint8_t PKI_PEERS_N = 4;
    struct PkiPeer { uint32_t node; uint8_t pub[32]; };
    PkiPeer  _pkiPeers[PKI_PEERS_N]{};
    uint8_t  _pkiPeerCount = 0;
    uint8_t  _pkiPriv[32]{};
    bool     _pkiHavePriv = false;
    void driveTx();               // advance the TX state machine (timing)
    void startSending();          // startTransmit() the head item (+ airtime accounting)
};

} // namespace mt
