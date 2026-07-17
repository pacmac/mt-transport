// SpikeSend — the spike that proved wire-compatibility (docs/spike.md PASS,
// 2026-07-17), now consuming the MeshtasticTransport library it was
// extracted into. Sends device_metrics telemetry every 30 s and a NODEINFO
// User packet at boot + every 20th cycle, so the node appears by name.
//
// The app owns what the library refuses to: board wiring, entropy, message
// construction, and (in real firmware) sleep.

#include <Arduino.h>
#include <MeshtasticTransport.h>

#include <pb_encode.h>
#include "meshtastic/mesh.pb.h"
#include "meshtastic/portnums.pb.h"
#include "meshtastic/telemetry.pb.h"

#include "secrets.h" // MESH_CHANNEL_NAME / MESH_CHANNEL_PSK[16] / MESH_NODE_NUM

// ---- board wiring: RAK4631 (fork variants/nrf52840/rak4631/variant.h) -------
static const uint32_t PIN_CS     = 42;
static const uint32_t PIN_DIO1   = 47;
static const uint32_t PIN_RESET  = 38;
static const uint32_t PIN_BUSY   = 46;
static const uint32_t PIN_PWR_EN = 37; // SX126X_POWER_EN — radio is dead without it

SX1262 radio = new Module(PIN_CS, PIN_DIO1, PIN_RESET, PIN_BUSY);
mt::MeshtasticTransport mesh;

// nRF52 hardware RNG — the app supplies entropy; the library refuses to run
// without it (packet id = CTR nonce).
static uint32_t hwRand32()
{
    uint32_t v = 0;
    NRF_RNG->CONFIG = RNG_CONFIG_DERCEN_Msk;
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

static void report(const char *what, bool ok)
{
    hexDump("FRAME ", mesh.lastFrame(), mesh.lastFrameLen());
    Serial.printf("%s: id=0x%08lx %s\n", what,
                  (unsigned long)mesh.lastPacketId(), ok ? "OK" : "FAILED");
}

static bool sendTelemetry()
{
    meshtastic_Telemetry t = meshtastic_Telemetry_init_zero;
    t.time = 0;
    t.which_variant = meshtastic_Telemetry_device_metrics_tag;
    t.variant.device_metrics.has_battery_level = true;
    t.variant.device_metrics.battery_level = 101; // 101 = mains-powered
    t.variant.device_metrics.has_voltage = true;
    t.variant.device_metrics.voltage = 3.60f;
    t.variant.device_metrics.has_uptime_seconds = true;
    t.variant.device_metrics.uptime_seconds = millis() / 1000;

    uint8_t buf[64];
    pb_ostream_t os = pb_ostream_from_buffer(buf, sizeof(buf));
    if (!pb_encode(&os, meshtastic_Telemetry_fields, &t))
        return false;
    return mesh.send(meshtastic_PortNum_TELEMETRY_APP, buf, os.bytes_written);
}

static bool sendNodeInfo()
{
    meshtastic_User u = meshtastic_User_init_zero;
    snprintf(u.id, sizeof(u.id), "!%08lx", (unsigned long)MESH_NODE_NUM);
    strlcpy(u.long_name, "MT Spike", sizeof(u.long_name));
    strlcpy(u.short_name, "SPKE", sizeof(u.short_name));
    u.hw_model = meshtastic_HardwareModel_PRIVATE_HW;

    uint8_t buf[meshtastic_User_size];
    pb_ostream_t os = pb_ostream_from_buffer(buf, sizeof(buf));
    if (!pb_encode(&os, meshtastic_User_fields, &u))
        return false;
    return mesh.send(meshtastic_PortNum_NODEINFO_APP, buf, os.bytes_written);
}

void setup()
{
    pinMode(LED_GREEN, OUTPUT);
    pinMode(PIN_PWR_EN, OUTPUT);
    digitalWrite(PIN_PWR_EN, HIGH);
    delay(100);

    Serial.begin(115200);
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 5000)
        ;

    Serial.println("\n=== SpikeSend (mt-transport) ===");

    mt::MeshChannel ch = {MESH_CHANNEL_NAME, MESH_CHANNEL_PSK, MESH_CHANNEL_PSK_LEN};
    bool ok = mesh.begin(radio, mt::EU868_LONG_FAST, ch, MESH_NODE_NUM, hwRand32);
    Serial.printf("mesh.begin: %s (channel hash 0x%02x)\n", ok ? "OK" : "FAILED",
                  mesh.channelHash());
    if (!ok) {
        while (true) { // fast blink: nothing to do without a radio
            digitalWrite(LED_GREEN, !digitalRead(LED_GREEN));
            delay(100);
        }
    }
}

void loop()
{
    static uint32_t cycle = 0;

    digitalWrite(LED_GREEN, HIGH);
    if (cycle % 20 == 0)
        report("NODEINFO", sendNodeInfo());
    report("TELEMETRY", sendTelemetry());
    digitalWrite(LED_GREEN, LOW);

    cycle++;
    delay(30000);
}
