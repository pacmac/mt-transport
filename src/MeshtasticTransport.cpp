#include "MeshtasticTransport.h"

#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>

#include "meshtastic/mesh.pb.h"
#include "meshtastic/portnums.pb.h"
#include "mt_crypto.h"

namespace mt {

const RegionParams EU868_LONG_FAST = {869.525f, 250.0f, 11, 5, 0x2b, 16};

// RX interrupt trampoline. setDio1Action wants a bare function pointer, so the
// ISR flags the one live instance. Set in begin(); this app runs a single radio.
MeshtasticTransport *MeshtasticTransport::_isrTarget = nullptr;
void MeshtasticTransport::_onDio1Rx()
{
    if (_isrTarget)
        _isrTarget->_radioEvent = true; // nothing else in the ISR — no SPI, no calls
}

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

    // Slot time for the contention model (MT computeSlotTimeMsec, SX126x form):
    // ~2.5 CAD symbols + propagation/turnaround/MAC (0.2+0.4+7 ms). symbolTime =
    // 2^SF / BW(kHz) ms. For SF11/BW250 → ~8.19 ms symbol → ~28 ms slot.
    float symbolMs = (float)(1u << region.sf) / region.bwKHz;
    _slotTimeMsec = (uint32_t)(2.5f * symbolMs + 7.6f);

    // Wire the DIO1 RX interrupt and arm RX now, so the radio listens
    // continuously and an inbound frame flags itself the instant it lands —
    // the app no longer has to be polling at the right moment to catch it.
    // startReceive re-maps DIO1 to RxDone and clears stale IRQ flags, so the
    // first real frame is a clean edge. wake() re-arms after sleep.
    _isrTarget = this;
    radio.setDio1Action(_onDio1Rx);
    if (radio.startReceive() == RADIOLIB_ERR_NONE)
        _rxActive = true;
    return true;
}

bool MeshtasticTransport::send(uint32_t portnum, const uint8_t *payload,
                               size_t len, uint32_t to, uint8_t hopLimit,
                               uint32_t requestId, uint32_t replyId)
{
    if (!_radio || len > sizeof(meshtastic_Data_payload_t::bytes))
        return false;

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

    // Build into a LOCAL frame, then enqueue. send() never touches the radio and
    // never blocks; service() transmits it later. Crypto/size are rejected here,
    // before the queue, so only sendable frames are ever queued.
    uint8_t f[FRAME_CAP];
    if (!ctrCrypt(_ch.psk, _ch.pskLen, id, _nodeNum, plain, f + sizeof(PacketHeader), plainLen))
        return false;

    PacketHeader h;
    h.to = to;
    h.from = _nodeNum;
    h.id = id;
    h.flags = packFlags(hopLimit, hopLimit); // hop_start = hop_limit at origin
    h.channel = _hash;
    h.next_hop = 0;
    h.relay_node = 0;
    memcpy(f, &h, sizeof(h));
    size_t frameLen = sizeof(h) + plainLen;

    if (!enqueueFrame(f, frameLen))
        return false; // queue full — caller may retry

    // Introspection (lastFrame/lastPacketId): the most recently built frame.
    _lastId = id;
    memcpy(_frame, f, frameLen);
    _frameLen = frameLen;
    return true;
}

// Copy a fully-built frame into the outbound ring. txAfter = now (step 4 will
// derive a channel-utilisation spacing here). Returns false if the ring is full.
bool MeshtasticTransport::enqueueFrame(const uint8_t *frame, size_t len)
{
    if (len == 0 || len > FRAME_CAP || _txCount >= TXQ_N)
        return false;
    // Scheduled (not blocking) send time: the one-shot override if the caller set
    // one (replies use it for an SNR-weighted delay + a spaced resend), otherwise
    // the utilisation-derived contention delay. Either way send() returns at once.
    uint32_t after = _nextTxDelaySet ? _nextTxDelay : getTxDelayMsec();
    _nextTxDelaySet = false;
    uint8_t tail = (_txHead + _txCount) % TXQ_N;
    memcpy(_txq[tail].frame, frame, len);
    _txq[tail].len = (uint16_t)len;
    _txq[tail].txAfter = millis() + after;
    _txq[tail].attempts = 0;
    _txCount++;
    return true;
}

void MeshtasticTransport::armRx()
{
    if (_radio->startReceive() == RADIOLIB_ERR_NONE)
        _rxActive = true;
}

// MT RadioInterface::getTxDelayMsec — random multiple of a slot time from a
// contention window sized by channel utilisation. Used to SCHEDULE every send;
// it is a millis() offset, never a blocking delay(). Idle channel → small window
// (snappy); busy channel → large window (back off). Channel utilisation is the
// air-accounting ratio over the current window (app resets it periodically).
uint32_t MeshtasticTransport::getTxDelayMsec()
{
    uint32_t win = airWindowMs();
    float util = win ? 100.0f * (float)(_txAirMs + _rxAirMs) / (float)win : 0.0f;
    if (util > 100.0f) util = 100.0f;
    uint8_t cw = CWMIN + (uint8_t)((util * (CWMAX - CWMIN)) / 100.0f); // map 0..100 -> CWMIN..CWMAX
    uint32_t span = 1u << cw;                                         // pow_of_2(CWsize)
    return (_rng ? _rng() % span : 0) * _slotTimeMsec;
}


// Choke point for the actual transmit: airtime accounting + startTransmit. The
// chip is in standby here (CAD left it there; or RX on the fail-open path, which
// startTransmit stands by anyway). getTimeOnAir's getPacketType() SPI read is
// valid in standby — the "garbage in sleep" hazard does not apply, we never
// transmit from sleep. Non-blocking: returns as soon as TX is started; TX-done
// arrives later as a DIO1 interrupt.
void MeshtasticTransport::startSending()
{
    TxItem &it = _txq[_txHead];
    // A frame may have arrived while RX was armed between backoffs; transmitting
    // destroys it. service() now drains RX normally, so this is rare, but a frame
    // caught at this exact instant is still lost — COUNT it (step 5 adds the
    // isActivelyReceiving guard that prevents it instead).
    if (_radio->getIrqFlags() & RADIOLIB_SX126X_IRQ_RX_DONE)
        _rxDroppedByTx++;
    _txAirMs += _radio->getTimeOnAir(it.len) / 1000;
    _rxActive = false;
    memcpy(_frame, it.frame, it.len); // introspection: the frame going on air
    _frameLen = it.len;
    if (_radio->startTransmit(it.frame, it.len) != RADIOLIB_ERR_NONE) {
        _txFailStreak++;
        _txDropped++; // queued, never went out — otherwise invisible to the caller
        _txCount--; _txHead = (_txHead + 1) % TXQ_N; // drop the unsendable frame
        _txState = TX_IDLE;
        armRx();
        return;
    }
    _txState = TX_SENDING;
    _txStateMs = millis();
}

// Advance the TX state machine by time. Never blocks: it either starts an async
// CAD, starts a transmit, or waits for the scheduled instant / an interrupt.
void MeshtasticTransport::driveTx()
{
    uint32_t now = millis();
    if (_txState == TX_IDLE && _txCount > 0)
        _txState = TX_WAITING;

    switch (_txState) {
    case TX_WAITING: {
        if (_txCount == 0) { _txState = TX_IDLE; break; }
        TxItem &it = _txq[_txHead];
        if ((int32_t)(now - it.txAfter) < 0)
            break; // scheduled for later — come back next pass
        if (it.attempts >= 8) {            // fail-open: 8 busy scans, send anyway
            startSending();
        } else if (_radio->startChannelScan() == RADIOLIB_ERR_NONE) {
            _txState = TX_SCANNING;        // CAD result arrives as a DIO1 interrupt
            _txStateMs = now;
            _rxActive = false;
        } else {
            startSending();                // CAD could not start — just send
        }
        break;
    }
    case TX_SCANNING:
        // Safety net: if the CAD-done interrupt is missed, don't wedge — CAD is a
        // few symbols (tens of ms), so after 200 ms give up scanning and send.
        if ((int32_t)(now - _txStateMs) > 200)
            startSending();
        break;
    case TX_SENDING:
        // Safety net: if TX-done is missed, force-finish after airtime+margin so
        // one frame can never stall the queue forever.
        if ((int32_t)(now - _txStateMs) > 5000) {
            _radio->finishTransmit();
            _txFailStreak++;
            _txDropped++; // TX-done never arrived; the frame is abandoned here
            _txCount--; _txHead = (_txHead + 1) % TXQ_N;
            _txState = TX_IDLE;
            armRx();
        }
        break;
    default:
        break;
    }
}

bool MeshtasticTransport::pushRx(const RxPacket &p)
{
    if (_rxqCount >= RXQ_N)
        return false; // app not draining fast enough — drop this frame, not older ones
    uint8_t tail = (_rxqHead + _rxqCount) % RXQ_N;
    _rxq[tail] = p;
    _rxqCount++;
    return true;
}

// Read one completed frame off the radio, decode+filter it, and queue it for
// poll(). Re-arms RX immediately so a reject does not blind us.
void MeshtasticTransport::handleRxDone()
{
    uint8_t raw[FRAME_CAP];
    size_t rawLen = _radio->getPacketLength();
    int st = _radio->readData(raw, rawLen > sizeof(raw) ? sizeof(raw) : rawLen);
    float rssi = _radio->getRSSI(), snr = _radio->getSNR();
    if (st == RADIOLIB_ERR_NONE && rawLen > 0)
        _rxAirMs += _radio->getTimeOnAir(rawLen) / 1000; // channel occupancy
    armRx();
    if (st != RADIOLIB_ERR_NONE || rawLen <= sizeof(PacketHeader) || rawLen > sizeof(raw))
        return;

    PacketHeader h;
    memcpy(&h, raw, sizeof(h));
    if (h.channel != _hash)
        return; // not our channel
    if (h.from == _nodeNum)
        return; // our own packet relayed back to us (rebroadcast peers)
    if (h.to != _nodeNum && h.to != BROADCAST_ADDR)
        return; // not for us

    uint8_t plain[MAX_PAYLOAD];
    size_t plainLen = rawLen - sizeof(PacketHeader);
    if (!ctrCrypt(_ch.psk, _ch.pskLen, h.id, h.from, raw + sizeof(h), plain, plainLen))
        return;

    meshtastic_Data data = meshtastic_Data_init_zero;
    pb_istream_t is = pb_istream_from_buffer(plain, plainLen);
    if (!pb_decode(&is, meshtastic_Data_fields, &data))
        return; // wrong PSK garbage decodes to noise; protobuf catches it

    if (isDuplicate(h.from, h.id))
        return; // ReliableRouter retries land here

    RxPacket p;
    p.from = h.from;
    p.to = h.to;
    p.id = h.id;
    p.portnum = data.portnum;
    p.requestId = data.request_id;
    p.hopLimit = h.flags & 0x07;
    p.wantAck = h.flags & 0x08;
    p.rssi = rssi;
    p.snr = snr;
    p.payloadLen = data.payload.size;
    memcpy(p.payload, data.payload.bytes, data.payload.size);
    pushRx(p);
}

// The pump. Non-blocking: services at most one radio interrupt (the DIO1 flag
// tells us something happened; getIrqFlags tells us WHAT), then advances the TX
// state machine. RX-done → decode+queue; TX-done → drop the sent frame + next;
// CAD-done → free: send, busy: listen + reschedule. Called every loop() pass.
void MeshtasticTransport::service()
{
    if (!_radio)
        return;

    if (_radioEvent) {
        _radioEvent = false;
        uint16_t irq = _radio->getIrqFlags();

        if (_txState == TX_SENDING && (irq & RADIOLIB_SX126X_IRQ_TX_DONE)) {
            _radio->finishTransmit();                     // clears IRQ, chip to standby
            _txFailStreak = 0;
            _txCount--; _txHead = (_txHead + 1) % TXQ_N;  // sent — drop it
            _txState = TX_IDLE;
            armRx();
        } else if (_txState == TX_SCANNING &&
                   (irq & (RADIOLIB_SX126X_IRQ_CAD_DONE | RADIOLIB_SX126X_IRQ_CAD_DETECTED))) {
            if (irq & RADIOLIB_SX126X_IRQ_CAD_DETECTED) {
                // Busy: a preamble is on air. LISTEN (don't sit deaf), back off,
                // retry the same frame later. Live listen with zero blocking.
                _csmaDeferrals++;
                _txq[_txHead].attempts++;
                _txq[_txHead].txAfter = millis() + getTxDelayMsec(); // re-roll the window
                _txState = TX_WAITING;
                armRx();
            } else {
                startSending();                           // channel free — go
            }
        } else if (irq & RADIOLIB_SX126X_IRQ_RX_DONE) {
            handleRxDone();
        }
    }

    driveTx();
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

bool MeshtasticTransport::poll(RxPacket &out)
{
    // Pure queue pop — service() already did the radio read and decode. No radio
    // access here, so it cannot race service() for the SPI bus.
    if (_rxqCount == 0)
        return false;
    out = _rxq[_rxqHead];
    _rxqHead = (_rxqHead + 1) % RXQ_N;
    _rxqCount--;
    return true;
}

// Bounded blocking listen, built on service()+poll(). This is the SLEEP-window
// listener (sleepCycle); the always-awake loop() calls service()+poll() directly
// and never blocks here. service() is pumped inside the loop so RX is decoded and
// any queued TX still drains while we wait. The delay(2) yield is confined to
// this sleep-adjacent path — not the awake message path this task is clearing.
bool MeshtasticTransport::receive(uint32_t timeoutMs, RxPacket &out)
{
    if (!_radio)
        return false;

    uint32_t deadline = millis() + timeoutMs;
    do {
        service();
        if (poll(out))
            return true;
        delay(2);
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
    // Re-enqueue the last built frame verbatim — same id, same bytes, so receivers
    // that caught the first copy dedupe this one. Non-blocking like send().
    if (!_radio || _frameLen == 0)
        return false;
    return enqueueFrame(_frame, _frameLen);
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
    _txState = TX_IDLE;     // radio comes back in standby — restart the TX SM
                            // cleanly; queued frames survive and re-drive via
                            // service(). The DIO1 action (MCU interrupt) persists
                            // across radio sleep, so RX flags itself again once
                            // service() re-arms RX.
    if (!_radio)
        return false;
    return _radio->standby() == RADIOLIB_ERR_NONE;
}

} // namespace mt
