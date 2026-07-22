---
task: device-comms-doc
status: reference (living doc — keep current)
updated: 2026-07-20
scope:
  - specs/device-comms.md
---

# Device comms: how to talk to and monitor the units over the mesh

This is the standing rig. It has been the comms + monitoring path for weeks — do
NOT rediscover it each session, and do NOT invent a new path. Two services plus
one BLE gateway node put you on the private mesh; the units answer `@`-prefixed
text commands.

**Authoritative API docs live in mt-radar** (read them for exhaustive detail; this
file is the orientation + the recipes you actually run):

- `/usr/share/pac/dev/projects/mt-radar/docs/GW_API.md` — mesh-gw REST + WS (ground truth)
- `/usr/share/pac/dev/projects/mt-radar/docs/NODE_API.md` — node-dash REST + WS (ground truth)
- `.../docs/MESSAGES_SPEC.md`, `.../docs/BLE-SPEC.md`, `.../docs/OVERVIEW.md`, `.../docs/UI_API.md`
- `.../mesh-gw/docs/API_REST.md`, `API_V1_V2.md`, `API_SSE.md`, `API_MCP.md`
- This repo: `docs/rx-and-commands.md` (device-side RX + command grammar), `docs/wire-format.md`

mt-radar is its OWN project with its own `/idiot` enforcement. Read it freely;
never EDIT it as a side effect of transport/firmware work.

## The rig

```
  you (curl / node client / browser)
        │  HTTP :8000 + ws :8000/events
        ▼
  node-dash  (node, port 8000)  ── UI + own REST + WebSocket
        │  proxies /!{hexid}/…, /devices, /ble, /ota, /sections, /schema,
        │  /bridge_config, /mqtt_publish  ─────────────┐
        ▼                                              ▼
  mesh-gw  (python3, port 8001) ── raw REST + ws :8001/events; owns ALL BLE via bleak
        │  BLE
        ▼
  OMNI gateway node  !2687afb1  (short "TA2o", "Peter Omni RAK", RAK4631 2.8.0,
        │  LoRa                  BLE addr E9:B0:3F:17:27:91)
        ▼
  private mesh, channel 2  ──►  the units (bench, remote, …)
```

- **node-dash** — port **8000**. The dashboard UI (`http://localhost:8000/`, the
  "mesh radar" page), its own REST, and a WebSocket at `ws://localhost:8000/events`.
  It transparently proxies device-namespaced and bridge paths to mesh-gw, so for
  sending/reading you can hit :8000 and never touch :8001 directly.
  `GET /status` → `{bridge_connected, bridge:{…}}`.
- **mesh-gw** — port **8001**. The BLE gateway. Owns all BLE state through bleak
  (this is why `bluetoothctl` is FORBIDDEN — see Hard rules). `GET /status` →
  `{server, devices[…]}`. WebSocket at `ws://localhost:8001/events`.
- **OMNI** `!2687afb1` — the RAK4631 that actually transmits your commands onto the
  LoRa mesh. It is the `{gatewayId}` in the URLs below. (A second BLE device,
  Heltec `!fa39f7b4`, is also connected — OMNI is the one to use; see
  memory `omni-gateway-channel-2`.)
- **Private channel = 2.** NEVER channel 0 (PRIMARY) — that is the public mesh.

## Send a command to a unit

`POST /{gatewayId}/messages` with `{text, to?, channel?, reply_id?}`. Hit node-dash
(:8000, proxied) or mesh-gw (:8001) — same route. `channel` MUST be 2.

```bash
# Send "@336b status" to the bench unit via OMNI on the private channel
curl -s -X POST http://localhost:8000/!2687afb1/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"@336b status","channel":2}'
# → {"id": <packetId>, …}
```

**Command grammar** (full grammar in `docs/rx-and-commands.md`; parser at
`pac-garage-alarm/src/main.cpp:992`): `@<target> <verb> [args]`, broadcast as a
TEXT_MESSAGE_APP text on channel 2 (2.8 rejects PSK DMs — "legacy DM", so commands
go as broadcast text, not DMs). The device splits on the **first space**: the token
after `@` is the target, and the very next token MUST be the verb. **Nothing may
sit between the target and the verb** — `@336b 08:55 status` parses `08:55` as the
verb and is rejected (`{"type":"err","msg":"unknown cmd"}`). It is `@336b status`,
full stop. `<target>` matches a unit by the **last 4 hex of its node number** OR its
short name (`*` = all units). Known units:

| unit | node id | suffix (target) | short name | notes |
|---|---|---|---|---|
| bench | `!8cee336b` | `336b` | `U33B` | the flash target; swapped with remote daily — change it freely |
| remote (deployed) | `!987ab80f` | `b80f` | `U80F` | NEVER flash/sleep/test-against it; out of reach, recovery = a drive |

Suffix is `nodeNum & 0xFFFF` as 4 hex — for `!987ab80f` that is **`b80f`**, not `80f`.

The HH:MM-tag convention (memory `timestamp-test-messages`) is for **plain-text**
test sends only — so you can spot them in the phone/node-dash message list. NEVER
put it in a command: a command has no free-text tag, and any extra token breaks the
target→verb parse (see above). To identify a command's reply, correlate on
`reply_id` (it echoes your command's `packet_id`), not on a tag.

## Read the reply

A unit's command reply is a JSON **TEXT_MESSAGE_APP** broadcast. Three ways to see it:

**1. node-dash browser UI** — open `http://localhost:8000/`, the Messages panel shows
text replies; the node table / telemetry panels show heartbeat metrics. This is the
normal monitoring surface.

**2. Poll REST** (scriptable, no socket):
```bash
curl -s http://localhost:8000/messages                       # node-dash recent messages
curl -s "http://localhost:8001/!2687afb1/messages?since_id=0" # mesh-gw message list
```

**3. Live WebSocket** — the reply arrives as a `text` event; read `ev.data.text`
(and `ev.from_num` = the unit). Example with a one-liner (node is always available):
```bash
node -e '
  const ws=new (require("ws"))("ws://localhost:8000/events");
  ws.on("message",m=>{const e=JSON.parse(m);
    if(e.type==="text") console.log("TEXT from",e.from_num,":",e.data?.text);
    if(e.type==="private_app") console.log("port",e.portnum,"b64",e.payload_b64?.slice(0,24));});
' &
# …then POST the command; the reply prints within a few seconds.
```

**Event mapping** (per GW_API.md): TEXT_MESSAGE_APP → `text` event. Our private
ports arrive as `private_app` events `{portnum, payload_b64}`: **port 260**
(`PAC_ALARM_APP` — debug/config/adverts JSON) and **port 261** (`PAC_CHUNK_APP` —
binary chunk frames). Telemetry heartbeats → `telemetry` events.

## Programmatic path — the Node client

`clients/node/index.js` wraps all of the above (queueing, reply correlation, and the
chunked-image `fetch`/resume). Prefer it for anything scripted:

```js
const { Client } = require('./clients/node');
const c = new Client({ host: 'localhost:8000', gatewayId: '!2687afb1', channel: 2 });
await c.connect();
const status = await c.command('336b', 'status');   // send + await JSON reply
const jpg    = await c.fetch('336b', pid);           // pull a chunked image (resumable)
```

Channel 0 is refused by the constructor; it must be given explicitly.

## USB ports — no ambiguity

Pin by VID:PID / serial, **not** by the `ttyACMx`/`ttyUSBx` index — those
renumber, and one just did (see the 2026-07-21 change below).

| device | role | node path (2026-07-21) | VID:PID | serial | stability |
|---|---|---|---|---|---|
| **RAK4631** (nRF52) | **upload** + `Serial` USB-CDC (logs) | `/dev/ttyACM0` | `239a:8029` | `B8CBA9794FF6FA1E` | **RENUMBERS on reflash**. Now the ONLY RAK port. |
| **M5 Timer Camera X** (ESP32) | **upload + `Serial` console** (own USB) | `/dev/ttyUSB0` | Hades2001 M5stack | `5D52ADF916` | own USB, unaffected by the RAK |

### CHANGE 2026-07-21 — debug adapter removed, camera moved to UART

The separate **WCH CH343 debug-UART→USB adapter** (`1a86:55d4`, previously
`/dev/ttyACM0`) that tapped the RAK's `Serial1` (MCU pins 15/16) **has been removed
from the bench.** Consequences, all verified this session:

- **The RAK native USB renumbered `ttyACM1` → `ttyACM0`** (nothing else holds ACM0
  now). Flash and logs are both `ttyACM0`. A stale "flash on ttyACM1" assumption
  cost a failed upload before I checked `by-id`.
- **`Serial1` (pins 15/16) is no longer a debug port — the M5 camera is wired to
  it** (Grove G4/G13 ↔ RAK 15/16). In `CAM_UART` builds `Serial1` is the **camera
  link**; `DBG` no longer mirrors there (else debug text clocks at the camera).
  Do NOT read `Serial1` as a log source.
- **RAK logs are now USB-only** (`Serial`, `ttyACM0`), which **drops during flash**
  and the bootloader window. There is no longer a battery-independent, reflash-stable
  log tap — the memory `rak-debug-uart-is-stable` is now WRONG and superseded. If a
  stable tap is needed again, add a CH343 on spare pins, NOT on 15/16.

- All ports **115200** baud. Cam board = `m5stack-timer-cam` (ESP32; `psram=4194304`
  = **4 MiB** measured, not the 8 MB sometimes quoted).
- **Flash the RAK:** `pio run -e rak4631_camuart -t upload --upload-port /dev/ttyACM0`
  (auto-detect also works). 1200 bps touch → bootloader → nrfutil → reboot; the port
  renumbers mid-cycle and pio waits it out.
- **Flash the camera:** `pio run -e timercam_uart -t upload` over `ttyUSB0` (own USB —
  the adapter removal did not affect this).
- **Watching a log — the two boards need OPPOSITE handling. Get this wrong and you
  get silence that looks like a dead board.**
  - **RAK4631 (`ttyACM0`) — DTR must be ASSERTED.** `Serial` is TinyUSB **USB CDC**,
    and CDC only emits once the host raises DTR; the firmware's own comment says so
    (`main.cpp` setup: *"Serial is USB CDC and its operator bool() is DTR-based"*).
    **`cat /dev/ttyACM0` does NOT raise DTR — it returns absolutely nothing**, even
    while the device is alive and transmitting on air. Flashing does not need DTR
    either, so uploads succeed while reads stay mute: a genuinely misleading pair.
    Working headless recipe:
    ```bash
    /usr/share/pac/py/bin/python - <<'PY'
    import serial, time
    s = serial.Serial('/dev/ttyACM0', 115200, timeout=1)
    s.dtr = True; s.rts = True          # <-- the whole trick
    time.sleep(0.3); s.reset_input_buffer()
    end = time.time() + 30
    while time.time() < end:
        ln = s.readline()
        if ln: print(ln.decode('utf-8','replace').rstrip(), flush=True)
    PY
    ```
    `pio device monitor` also asserts DTR but requires a TTY, so it dies headless with
    a `start_terminal` traceback.
  - **M5 camera (`ttyUSB0`, ESP32) — DTR/RTS deasserted**, because there they are
    wired to reset/boot and asserting them RESETS the board.
- **When RAK serial is silent, check in this order** (both causes were hit on
  2026-07-22): (1) a leaked/orphaned reader still holding the port — look for
  `ttyACM0` in `/proc/*/fd`; (2) DTR not asserted, per above. Silence is **not**
  evidence the board is dead — confirm liveness positively via the gateway's
  `last_heard`, not by absence of output.
- The remote unit is never on USB here — only the bench unit is attached (memory
  `bench-unit-is-the-flash-target`).

### Camera link (spec `pir-image-pipeline.md` §7)

- **Transport:** UART, RAK `Serial1` (15/16) ↔ camera Grove **G4/G13**, 115200,
  framed `[7E][len][payload][crc16-CCITT]`. Verified TX/RX orientation: camera
  `CAM_UART_RX=13, TX=4`; raw `0x55`→`0xAA` ping returns `AA` (`camu ping`).
- **Was I2C** (camera as slave 0x62 on the same Grove pins). The I2C path is retained
  as a build fallback (default `timercam` / `rak4631` envs) but the bench is now wired
  for UART, so I2C cannot reach the camera until rewired back.
- **nRF verbs (CAM_UART build):** `camu ping` (raw link), `camu count`, `camu cap`.

## Hard rules (do not violate)

- **`bluetoothctl` is FORBIDDEN**, everywhere and always. mesh-gw is the single
  owner of BLE state (bleak). Go through the HTTP API, never the BLE stack directly.
- **Never send on channel 0 (PRIMARY).** The units listen on the private channel 2;
  channel 0 leaks alarm traffic and commands to the public mesh.
- **Never flash, sleep, or test-against the REMOTE unit.** It is out of BLE range,
  has no OTA, and recovery is a drive. Only the attached BENCH unit is fair game.
- Reading mt-radar source/docs is fine; editing mt-radar as a side effect is not.

## Related memory

`mesh-gw-and-node-dash`, `omni-gateway-channel-2`, `bench-unit-is-the-flash-target`,
`rak-debug-uart-is-stable`, `timestamp-test-messages`, `remote-device-use-cumulative-counters`.
