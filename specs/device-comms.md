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

**Command grammar** (full grammar in `docs/rx-and-commands.md`): `@<target> <verb> [args]`,
broadcast as a TEXT_MESSAGE_APP text on channel 2 (2.8 rejects PSK DMs — "legacy DM",
so commands go as broadcast text, not DMs). `<target>` matches a unit by the **last
4 hex of its node number** OR its short name. Known units:

| unit | node id | suffix (target) | short name | notes |
|---|---|---|---|---|
| bench | `!8cee336b` | `336b` | `U33B` | the flash target; swapped with remote daily — change it freely |
| remote (deployed) | `!987ab80f` | `b80f` | `U80F` | NEVER flash/sleep/test-against it; out of reach, recovery = a drive |

Suffix is `nodeNum & 0xFFFF` as 4 hex — for `!987ab80f` that is **`b80f`**, not `80f`.

Tag test sends with a HH:MM stamp so they're identifiable (memory `timestamp-test-messages`).

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

Two physical devices, three serial ports. Pin by VID:PID / serial, not by the
`ttyACMx`/`ttyUSBx` index (those renumber).

| device | role | node path | VID:PID | chip / driver | serial | stability |
|---|---|---|---|---|---|---|
| **RAK4631** (nRF52) | **upload** + `Serial` USB-CDC | `/dev/ttyACM1` | `239a:8029` | Nordic/Adafruit native USB / `cdc_acm` | `B8CBA9794FF6FA1E` | **RENUMBERS on reflash** (double-tap → bootloader → app re-enumerates) |
| **RAK4631** (nRF52) | **debug UART** — `Serial1`, MCU pins 15/16 | `/dev/ttyACM0` | `1a86:55d4` | WCH CH343/CH9102 / `cdc_acm` | `5B1F007437` | **STABLE** — survives reflash, works on battery. Use this for logs. |
| **M5 Timer Camera X** (ESP32) | **upload + debug** (one combined port) | `/dev/ttyUSB0` | `0403:6001` | FTDI FT232 / `ftdi_sio` (Product "M5stack") | `C152DED416` | single port; `ttyUSB` index can renumber if other USB-serials attach |

- All three: **115200** baud. Cam board = `m5stack-timer-cam` (ESP32, 8 MB PSRAM).
- **Flashing the RAK:** `pio run -t upload` auto-detects `ttyACM1` (the 239a native
  USB); it force-resets at 1200 bps into the bootloader, uploads via nrfutil, reboots.
- **Watching RAK logs:** read `ttyACM0` (the CH343 debug UART) — `Serial1` there is
  stable across reflashes, unlike the native USB CDC. `Serial.begin(115200)` →
  native USB (ttyACM1, drops during flash); `Serial1.begin(115200)` → ttyACM0.
  ```bash
  stty -F /dev/ttyACM0 115200 raw -echo && timeout 30 cat /dev/ttyACM0 | tr -d '\r'
  ```
  Boot logs flush in the first ~2–3 s after reset, so attach before/at reset to
  catch `setup()`/`mesh.begin`; otherwise the line is quiet between heartbeats.
- The remote unit is never on USB here — by definition only the bench unit is
  attached (memory `bench-unit-is-the-flash-target`).

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
