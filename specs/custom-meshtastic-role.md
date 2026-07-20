---
task: custom-meshtastic-role
status: active — implement PAC_ALARM role marker (2026-07-20)
scope:
  - projects/pac-garage-alarm/src/main.cpp
---

# Spec: custom-meshtastic-role — advertise a PAC_ALARM device role

## Why
Our alarm nodes need a distinct identity so node-dash's command/response
("control") stream can recognise them. We own the alarm firmware and generate our
own protobuf, and the Meshtastic `Config.DeviceConfig.Role` enum is actively
extended upstream (currently 0..12; `ROUTER_LATE`=11, `CLIENT_BASE`=12 are recent),
so adding our own value is legitimate.

## Decision — a spaced private block, not the next slot
- Reserve **200–255 as the PAC private role range**. `PAC_ALARM = 200` (first of it).
- Rationale (Peter): do NOT take the next free upstream slot (13) — a future
  Meshtastic release would collide. Upstream grows ~1 per release from 12 UPWARD, so
  13–199 is headroom it will never exhaust, and 201–255 leaves room for future PAC
  roles, spaced clear of upstream.
- **Identity ONLY.** OMNI stays stock and merely relays the value; it does NOT change
  rebroadcast/hop behaviour — self-congestion remains the `hop_limit` lever (see
  chunk-flow-control). The stock phone app will show an unknown role for our nodes;
  acceptable, they are already `is_unmessagable`.
- **Fixed identity, not a per-unit tunable.** Every alarm node is always PAC_ALARM,
  so it is set unconditionally in `sendNodeInfo()` — no runtime command, no persistence.

## Change (main.cpp only)
- Define `static const int PAC_ALARM_ROLE = 200;` with the block rationale.
- In `sendNodeInfo()`: `u.role = (meshtastic_Config_DeviceConfig_Role)PAC_ALARM_ROLE;`
  (encodes as a plain varint; no protobuf regen needed yet).
- Bump `FW_VERSION` (260720-2).

## Contract with node-dash
node-dash keys on `user.role == 200` to classify/route alarm nodes on the control
stream. If node-dash wants a different number, change the ONE constant.

## Verify
- Compile (rak4631).
- On air, once the node-dash control stream is back: flash bench, confirm node-dash
  sees `role == 200` for `!8cee336b` in its NodeInfo. Then, if it proves out,
  formalise `PAC_ALARM` in the shared `.proto` so node-dash shares the definition.
