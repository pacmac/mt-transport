---
task: cam-deep-sleep-hold
status: IMPLEMENTED 2026-07-21 (cam fw). Root cause confirmed in code; standard gpio_hold
        fix applied (hold G33 across deep sleep, release in setup). USB regression CLEAN
        (grab still works post-fix, pid 3242). On-battery deep-sleep SURVIVAL not yet
        empirically confirmed — a deep-sleep cycle can't be forced over the mesh (needs the
        queue to idle-empty), so it will confirm in real battery use. Also pinned
        timercam-chunk upload_port to the by-id serial so a bare-port flash can't hit the
        wrong camera.
priority: HIGH — camera dies on battery; blocks battery operation and the bat-voltage reading
updated: 2026-07-21
scope:
  - timercam-chunk/src/main.cpp
  - timercam-chunk/platformio.ini   # pin upload_port to the by-id serial (wrong-camera guard)
source_hash:
  timercam-chunk/src/main.cpp: 06c52d188a6f23e53de2000bfccd530a244d4bee88a026b5e10c403136f90151
---

# Camera dies on battery: hold BAT_HOLD (G33) across deep sleep

## Root cause (confirmed in code)
`setup()` latches `PIN_BAT_HOLD` (G33) HIGH (main.cpp:649-650) to hold the regulator on.
`goToSleep()` enters `esp_deep_sleep_start()` (queue empty) **without holding G33** — grep
shows no `hold_en` anywhere. In ESP32 deep sleep an un-held GPIO drops to its reset state,
so G33 releases, the regulator cuts, and **on battery the board fully powers off** (USB
masks this). A powered-off ESP can't ext0-wake, so it's dead until USB/button.

Timeline that matches the symptom: a grab leaves an image held (`g_qn>0`) → LIGHT sleep
(survives); `MAX_HOLD` later drops the aged image → `g_qn==0` → DEEP sleep → power cut →
`camu ping`=FF / `cam grab`=st255.

## Fix (timercam-chunk/src/main.cpp)
1. Include `<driver/gpio.h>` (for `gpio_hold_en` / `gpio_deep_sleep_hold_en` / `gpio_hold_dis`).
2. In `goToSleep()`, deep-sleep branch, immediately before `esp_deep_sleep_start()`:
   ```c
   gpio_hold_en((gpio_num_t)PIN_BAT_HOLD);   // latch G33 HIGH through deep sleep...
   gpio_deep_sleep_hold_en();                // ...so the regulator stays on (true ~10uA)
   ```
3. In `setup()`, after `digitalWrite(PIN_BAT_HOLD, HIGH)` (main.cpp:650), release the
   carried-over hold so the pin is under normal control again (it stayed HIGH through the
   wake reboot, so no power glitch):
   ```c
   gpio_hold_dis((gpio_num_t)PIN_BAT_HOLD);
   ```
   Order matters: re-drive HIGH first, then dis the hold — the pin is HIGH the whole time.

Light sleep is untouched (it already retains state). Only the deep-sleep path changes.

## Verification (Phase 4)
- **Static:** `gpio_hold_en(GPIO33)` + `gpio_deep_sleep_hold_en()` before deep sleep;
  `gpio_hold_dis(GPIO33)` in setup.
- **Functional (ON BATTERY, USB off the ESP):** grab once (works), then force the queue to
  empty and a deep-sleep cycle (wait past `MAX_HOLD`, or `camu`/console sleep), then confirm
  the camera STILL answers `camu ping` (=AA) and `cam grab` (real pid) — i.e. it survived a
  deep-sleep cycle on battery, which today kills it.
- **Regression:** on USB everything still works; wake latency unchanged.

## Risks
- Camera-firmware flash (bench). Field unit `!987ab80f` untouched.
- If `gpio_deep_sleep_hold_en` interacts with the ext0 wake config, verify wake still fires
  (it should — hold and ext0 are independent). Covered by the battery functional test.
