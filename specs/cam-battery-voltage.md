---
task: cam-battery-voltage
status: IMPLEMENTED 2026-07-21 (cam fw + nRF fw 260721-5). Plumbing VERIFIED end-to-end:
        the `bat` field flows camera CMD_INFO -> nRF -> grab reply (seen live, e.g.
        "bat":5488/5580). Cell-voltage VALUE not yet validated — the bench camera is
        USB-powered so it reads the ~5 V rail; the real cell reading needs the camera on
        battery, which is gated behind cam-deep-sleep-hold (camera currently dies on battery).
        Validate the value opportunistically once it lives on battery.
priority: MEDIUM — deployment monitoring; the camera runs on its own cell, invisible today
updated: 2026-07-21
scope:
  - timercam-chunk/src/main.cpp     # read battery mV + append to CMD_INFO reply
  - pac-garage-alarm/src/main.cpp   # parse it + add to the cam grab reply
source_hash:
  timercam-chunk/src/main.cpp: 06c52d188a6f23e53de2000bfccd530a244d4bee88a026b5e10c403136f90151
  pac-garage-alarm/src/main.cpp: 8d5a8b713f429abcc216131f5d823de928b5cad0a21d7df13059769d3158d4cf
---

> ### ⚠ SUPERSEDED 2026-07-22 — the I2C camera transport NO LONGER EXISTS
> The camera link is **UART only**. All I2C code (`buildInfo`/`onReceive`/`onRequest`,
> `Wire`, `I2C_ADDR`, `g_out`), every `CAM_UART` `#ifdef`, and the second build env were
> **deleted** — see `specs/strip-cam-i2c.md`. It was already failing to compile.
>
> Anything below describing an I2C path as *retained*, a *fallback*, *untouched*, or a
> live `#else` branch is **HISTORICAL AND FALSE**. Do not act on it. Do not reintroduce
> I2C: one transport, one build env, deliberately.

# Expose the camera battery voltage in the cam grab reply

## Why
The M5 Timer Camera X runs on its own ~140 mAh cell, independent of the alarm unit's
battery. It exposes battery voltage via an ADC divider on GPIO38 (already named
`PIN_BAT_ADC 38` in timercam-chunk:50, with `BAT_HOLD` on G33), but the firmware never
reads it — there is no `analogRead` and no battery field in any reply. So the camera's
charge state is invisible. Surface it so the dashboard can watch it alongside the alarm
battery.

Decision (grab-reply, not heartbeat): the camera appends battery mV to its `CMD_INFO`
reply — which is ALSO the post-capture reply (timercam-chunk:753-755) — and the nRF adds
it to the `cam grab` JSON. Free: it piggybacks the capture we already do, no extra camera
wake, no periodic airtime. Continuous/heartbeat exposure can be added later if wanted.

## Camera change (timercam-chunk/src/main.cpp)
1. Includes: `#include "driver/adc.h"` and `#include "esp_adc_cal.h"`.
2. A characteristics global + init in `setup()` (after `PIN_BAT_HOLD` is latched):
   ```c
   static esp_adc_cal_characteristics_t s_adcChars;
   // setup():
   adc1_config_width(ADC_WIDTH_BIT_12);
   adc1_config_channel_atten(ADC1_CHANNEL_2, ADC_ATTEN_DB_11);   // GPIO38 = ADC1_CH2
   esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12, 1100, &s_adcChars);
   ```
3. A reader:
   ```c
   static uint16_t batMv() {
     uint32_t acc = 0;
     for (int i = 0; i < 8; i++) acc += adc1_get_raw(ADC1_CHANNEL_2); // small average
     uint32_t mv = esp_adc_cal_raw_to_voltage(acc / 8, &s_adcChars);
     return (uint16_t)(mv * 2);   // on-board /2 divider
   }
   ```
4. Extend `uartDispatch` `CMD_INFO` (timercam-chunk:546-554): append mV after the 9 bytes
   and return **11**:
   ```c
   uint16_t mv = batMv();
   g_ub[9] = mv >> 8; g_ub[10] = mv;   // big-endian, same convention as len/crc
   return 11;   // was 9
   ```
   `g_ub` is `UART_SEEK_MAX + 8` = 208 B — ample. The I2C `onRequest` `CMD_INFO` path is
   left at 9 bytes (non-CAM_UART build; out of scope).

## nRF change (pac-garage-alarm/src/main.cpp, cam grab UART path)
The grab already does `int rn = camuRecv(info, sizeof(info), 3000);` with `info[16]`.
- Parse: `uint16_t batMv = (rn >= 11) ? (((uint16_t)info[9] << 8) | info[10]) : 0;`
  (0 = unknown, e.g. an older camera build.)
- Add to the success reply JSON: a `"bat"` field in mV, e.g.
  `...,"crc":"%08lX","bat":%u,"cam":"asleep","upst":%u`. Emit `"bat":0` when unknown so
  the shape is stable. (Reply still fits `reply[]`.)

Reply-shape note for node-dash: the `grab` reply gains one integer field `bat` (mV).
Additive; existing fields unchanged. Flag on xsession after it lands.

## Lockstep / compat
Camera returns 11 bytes; nRF reads up to 16 and keys battery off `rn >= 11`. Either flash
order is tolerated (old camera → nRF sees 9 → `bat:0`; old nRF → ignores the extra 2 bytes),
but flash BOTH to get the field populated. Bump both `FW_VERSION`s.

## Verification (Phase 4)
- **Static:** camera returns 11 from CMD_INFO; nRF parses `info[9..10]` and emits `bat`.
- **Functional (bench):** `@336b cam grab` → reply includes `"bat":<mV>` in a plausible
  Li-ion range (~3300–4200 mV). Sanity-check against a multimeter on the cell (or against a
  known charge state); confirm it MOVES sensibly if the cell is loaded/charged.
- **Regression:** grab still captures + pushes; `camu ping/cap` unaffected; a full push still
  completes.

## Risks
- Two flash-expensive firmwares. Bench only; field unit `!987ab80f` untouched.
- ADC accuracy: single-point `esp_adc_cal` (Vref 1100) is ±5–10%; fine for a
  charge-state gauge, not for precise fuel-gauging. Averaging 8 samples smooths noise.
- `esp_adc_cal` is deprecated in newer ESP-IDF but present in arduino-esp32 for classic
  ESP32 (our board `m5stack-timer-cam`). If the build warns, it still compiles; a later
  move to `esp_adc/adc_cali` is cosmetic.
