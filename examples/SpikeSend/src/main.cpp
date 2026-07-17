// SpikeSend — transmit one Meshtastic-compatible encrypted packet from a bare
// RadioLib sketch. Everything deliberately straight-line: a failure has one
// place to hide. See ../../docs/spike.md for the gate this serves.
//
// Every value here is verified against the reference firmware — citations in
// ../../docs/wire-format.md.

#include <Arduino.h>
#include <RadioLib.h>

#include <AES.h>
#include <CTR.h>

#include <pb_encode.h>
#include "meshtastic/mesh.pb.h"
#include "meshtastic/portnums.pb.h"
#include "meshtastic/telemetry.pb.h"

#include "secrets.h" // MESH_CHANNEL_NAME / MESH_CHANNEL_PSK[16] / MESH_NODE_NUM

// ---- PHY: EU_868 LONG_FAST (wire-format.md §1) ------------------------------
static const float    FREQ_MHZ    = 869.525f;
static const float    BW_KHZ      = 250.0f;
static const uint8_t  SF          = 11;
static const uint8_t  CR          = 5;
static const uint8_t  SYNC_WORD   = 0x2b;
static const int8_t   TX_DBM      = 2; // oracle is on the same bench
static const uint16_t PREAMBLE    = 16;
static const float    TCXO_VOLTS  = 1.8f;

// ---- RAK4631 wiring (fork variants/nrf52840/rak4631/variant.h) --------------
static const uint32_t PIN_CS      = 42;
static const uint32_t PIN_DIO1    = 47;
static const uint32_t PIN_RESET   = 38;
static const uint32_t PIN_BUSY    = 46;
static const uint32_t PIN_PWR_EN  = 37; // SX126X_POWER_EN — radio is dead without it

SX1262 radio = new Module(PIN_CS, PIN_DIO1, PIN_RESET, PIN_BUSY);

// ---- 16-byte cleartext header (wire-format.md §2) ----------------------------
struct __attribute__((packed)) PacketHeader {
    uint32_t to;
    uint32_t from;
    uint32_t id;
    uint8_t  flags;      // hop_limit | want_ack<<3 | via_mqtt<<4 | hop_start<<5
    uint8_t  channel;    // xorHash(name) ^ xorHash(psk)
    uint8_t  next_hop;   // 0 = unknown/any
    uint8_t  relay_node; // 0 = not relayed
};
static_assert(sizeof(PacketHeader) == 16, "header must be 16 bytes");

// ---- helpers -----------------------------------------------------------------
static uint8_t xorHash(const uint8_t *p, size_t len)
{
    uint8_t code = 0;
    while (len--)
        code ^= *p++;
    return code;
}

// nRF52 hardware RNG. The packet id is the AES-CTR nonce: it must never
// repeat for our node number, so it comes from hardware, not a counter
// seeded at zero.
static uint32_t hwRand32()
{
    uint32_t v = 0;
    NRF_RNG->CONFIG = RNG_CONFIG_DERCEN_Msk; // bias correction
    NRF_RNG->TASKS_START = 1;
    for (int i = 0; i < 4; i++) {
        NRF_RNG->EVENTS_VALRDY = 0;
        while (!NRF_RNG->EVENTS_VALRDY)
            ;
        v = (v << 8) | (uint8_t)NRF_RNG->VALUE;
    }
    NRF_RNG->TASKS_STOP = 1;
    return v;
}

static void hexDump(const char *label, const uint8_t *p, size_t len)
{
    Serial.printf("%s (%u): ", label, (unsigned)len);
    for (size_t i = 0; i < len; i++)
        Serial.printf("%02x", p[i]);
    Serial.println();
}

// ---- packet build ------------------------------------------------------------
static uint8_t frame[sizeof(PacketHeader) + 64];

static size_t buildPacket(uint32_t packetId, uint32_t uptimeSecs)
{
    // 1. Telemetry{device_metrics}
    meshtastic_Telemetry telemetry = meshtastic_Telemetry_init_zero;
    telemetry.time = 0; // no RTC — receivers timestamp on arrival
    telemetry.which_variant = meshtastic_Telemetry_device_metrics_tag;
    telemetry.variant.device_metrics.has_battery_level = true;
    telemetry.variant.device_metrics.battery_level = 101; // 101 = mains-powered
    telemetry.variant.device_metrics.has_voltage = true;
    telemetry.variant.device_metrics.voltage = 3.60f;
    telemetry.variant.device_metrics.has_uptime_seconds = true;
    telemetry.variant.device_metrics.uptime_seconds = uptimeSecs;

    uint8_t tbuf[64];
    pb_ostream_t ts = pb_ostream_from_buffer(tbuf, sizeof(tbuf));
    if (!pb_encode(&ts, meshtastic_Telemetry_fields, &telemetry)) {
        Serial.printf("FATAL telemetry encode: %s\n", PB_GET_ERROR(&ts));
        return 0;
    }

    // 2. Data{portnum, payload}
    meshtastic_Data data = meshtastic_Data_init_zero;
    data.portnum = meshtastic_PortNum_TELEMETRY_APP;
    data.payload.size = ts.bytes_written;
    memcpy(data.payload.bytes, tbuf, ts.bytes_written);

    uint8_t plain[64];
    pb_ostream_t ds = pb_ostream_from_buffer(plain, sizeof(plain));
    if (!pb_encode(&ds, meshtastic_Data_fields, &data)) {
        Serial.printf("FATAL data encode: %s\n", PB_GET_ERROR(&ds));
        return 0;
    }
    size_t plainLen = ds.bytes_written;
    hexDump("PLAIN ", plain, plainLen);

    // 3. AES128-CTR (wire-format.md §4). Nonce = id u64 LE ‖ from u32 LE ‖ 0⁴.
    //    setCounterSize(4) mirrors the reference CryptoEngine exactly.
    uint8_t nonce[16] = {0};
    uint64_t id64 = packetId;
    uint32_t from = MESH_NODE_NUM;
    memcpy(nonce, &id64, 8);
    memcpy(nonce + 8, &from, 4);

    CTR<AES128> ctr;
    ctr.setKey(MESH_CHANNEL_PSK, MESH_CHANNEL_PSK_LEN);
    ctr.setIV(nonce, 16);
    ctr.setCounterSize(4);

    uint8_t *cipher = frame + sizeof(PacketHeader);
    ctr.encrypt(cipher, plain, plainLen);
    hexDump("NONCE ", nonce, 16);
    hexDump("CIPHER", cipher, plainLen);

    // 4. Header, in clear
    PacketHeader h;
    h.to         = 0xFFFFFFFF;
    h.from       = MESH_NODE_NUM;
    h.id         = packetId;
    h.flags      = 3 | (3 << 5); // hop_limit=3, hop_start=3 → 0x63
    h.channel    = xorHash((const uint8_t *)MESH_CHANNEL_NAME, strlen(MESH_CHANNEL_NAME)) ^
                   xorHash(MESH_CHANNEL_PSK, MESH_CHANNEL_PSK_LEN);
    h.next_hop   = 0;
    h.relay_node = 0;
    memcpy(frame, &h, sizeof(h));
    hexDump("HEADER", frame, sizeof(h));
    hexDump("FRAME ", frame, sizeof(h) + plainLen);

    return sizeof(h) + plainLen;
}

// ---- arduino -----------------------------------------------------------------
void setup()
{
    pinMode(LED_GREEN, OUTPUT);
    pinMode(PIN_PWR_EN, OUTPUT);
    digitalWrite(PIN_PWR_EN, HIGH);
    delay(100);

    Serial.begin(115200);
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 5000)
        ; // wait for USB, but boot headless too

    Serial.println("\n=== SpikeSend ===");

    // Mirrors SX126xInterface::init in the reference firmware.
    int st = radio.begin(FREQ_MHZ, BW_KHZ, SF, CR, SYNC_WORD, TX_DBM, PREAMBLE, TCXO_VOLTS, false);
    Serial.printf("radio.begin: %d\n", st);
    if (st == RADIOLIB_ERR_NONE) {
        radio.setCurrentLimit(140.0f);
        radio.setDio2AsRfSwitch(true);
        radio.setCRC(RADIOLIB_SX126X_LORA_CRC_ON);
    } else {
        while (true) { // radio init failed: fast blink, nothing to do
            digitalWrite(LED_GREEN, !digitalRead(LED_GREEN));
            delay(100);
        }
    }
}

void loop()
{
    static uint32_t txCount = 0;

    uint32_t packetId = hwRand32();
    if (packetId == 0)
        packetId = 1; // id must be non-zero

    Serial.printf("\n--- TX #%lu, id=0x%08lx, from=0x%08lx ---\n",
                  (unsigned long)++txCount, (unsigned long)packetId,
                  (unsigned long)MESH_NODE_NUM);

    size_t len = buildPacket(packetId, millis() / 1000);
    if (len) {
        digitalWrite(LED_GREEN, HIGH);
        int st = radio.transmit(frame, len);
        digitalWrite(LED_GREEN, LOW);
        Serial.printf("transmit: %d %s\n", st,
                      st == RADIOLIB_ERR_NONE ? "(OK)" : "(FAILED)");
    }

    delay(30000); // resend with a fresh id — pass/fail is read off the oracle
}
