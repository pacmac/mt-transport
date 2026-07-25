---
task: txp-runtime-bench-only
status: IMPLEMENTED 2026-07-25 (fw 2-260725-20 on the bench unit). MEASURED ON AIR, not merely
  acked — gateway-heard RSSI tracked the setting exactly: +22 = -57 dBm, txp 0 = -80 dBm
  (23 dB down), txp -9 = -89 dBm (32 dB, the full range). Range refusals work. NON-PERSISTENCE
  VERIFIED BY SIDE EFFECT: after a reboot the unit was heard at -56/-57 again, i.e. back at +22
  without being told. STILL PENDING: the GARAGE REFUSAL branch — see Findings.
source_hash:
  src/MeshtasticTransport.h:         2ce49888e78b41bd
  src/MeshtasticTransport.cpp:       6c85f24c947063b3
  ../pac-garage-alarm/src/main.cpp:  6f9f46627836815d
  ../pac-garage-alarm/docs/API.md:   2a5ef6222f83a9a3
scope:
  - specs/txp-runtime-bench-only.md
  - src/MeshtasticTransport.h        # setTxPower() + txPower() accessor
  - src/MeshtasticTransport.cpp      # wraps SX1262::setOutputPower
  - library.json                     # version bump
  # SEPARATE REPO (/usr/share/pac/dev/pio/projects/pac-garage-alarm) — its own commit:
  - ../pac-garage-alarm/src/main.cpp # g_txDbm, the `txp` verb, the ROLE INTERLOCK, reporting
  - ../pac-garage-alarm/docs/API.md  # ADDED MID-IMPLEMENTATION (Peter: "what about the docs?").
                                     #   A verb that is not documented repeats the exact defect
                                     #   already logged as `command-help-sync`.
# NOT changing: the config schema's `writable` flag for txp (it stays FALSE and that is
#   CORRECT — see Schema below), persistence (deliberately none — see Safety), the PA
#   optimisation table, or anything about how frames are queued/sent.
---

# Spec: txp-runtime-bench-only — attenuation as an instrument, refused on the deployed unit

## Why

Peter: *"is everything completed... have you tried attenuating the power on bench so that
it emulates the remote?"* and earlier *"attenuation is a good feature for BENCH but never
the deployed unit."*

We cannot currently characterise the garage link without transmitting to the garage. That
costs GARG battery (65%, ~1.1 %/hr, ~2 days left) and its link is marginal enough that
tests frequently return nothing — align got **no reading at all** from either target
today, partly for this reason. Attenuating BNCH reproduces a -120 dBm link **on the desk**,
where a flash is free and a mistake costs nothing.

31 dB of controllable attenuation is also a far better instrument than the 50 Ω load we
improvised on the bench previously.

## Hardware facts — verified from RadioLib, not assumed

- `SX1262::checkOutputPower` is `RADIOLIB_CHECK_RANGE(power, -9, 22)`, and the PA
  optimisation table is indexed `paOptTable[power + 9]`. **The range is -9 … +22 dBm.**
- The firmware already runs `TX_DBM = 22` (`main.cpp:204`) — the ceiling. The optimised
  table programs `hpMax = 0x07`, the maximum high-power setting.
- The gateways request 27 and are clipped to the same 22 (`SX126X_MAX_POWER`), so there is
  **no asymmetry and nothing to gain upward**. This is only ever about going DOWN.

## Design

### Library: a setter that did not exist

`begin()` takes `txDbm` and offers no way to change it afterwards. Add:

```cpp
int16_t setTxPower(int8_t dbm);   // -9..22; returns the RadioLib status
int8_t  txPower() const;          // what is actually applied
```

`setTxPower` calls `_radio->setOutputPower(dbm)`, which itself range-checks and
reprograms the PA config. On a non-`RADIOLIB_ERR_NONE` status the stored value is left
unchanged, so `txPower()` never claims a setting the radio refused.

### Firmware: the `txp` verb

`TX_DBM` becomes the boot default for a new runtime `g_txDbm`. A new text verb:

```
txp          -> report:  {"type":"txp","dbm":22,"role":"bench","ok":true}
txp <dbm>    -> set, or refuse
```

It needs its **own text verb** and cannot ride the config `set` path — the uniform
`{type:set}` port-260 channel is unreachable over the text-only gateway (learned at the
cost of a reflash; see `remote-config-needs-text-verb`).

### THE INTERLOCK — the reason this is safe to build at all

```
role bench  -> settable across -9 .. +22
role garage -> REFUSED, with an explicit error
```

**Refused, never silently clamped.** A silent clamp teaches an operator that the command
worked; an error teaches them it did not apply. GARG sits at -114…-128 dBm at full power:
attenuating it drops it off the mesh, and with no OTA the only recovery is an hour's drive
each way.

The role comes from `g_role->role`, which is selected at boot from VBUS
(`dev-role-site`) — USB means bench, battery means deployed. So the interlock is derived
from a physical fact about the unit, not from an operator remembering.

### Safety: NOT persisted, deliberately

`txp` does **not** call `saveSettings()`. It is RAM-only and resets to `TX_DBM` on every
boot.

This is the single most important property here. A persisted attenuation would survive
reboots and could leave a unit crippled with no obvious cause — exactly the class of
incident we already had when a persisted `hop 0` outlived the test that set it
(`persisted-config-outlives-tests`). Non-persistence also contains the swap hazard: a
bench unit left at -9 dBm and then deployed comes back at full power the moment it boots
on battery.

### Schema: `writable` stays FALSE, and that is correct

`main.cpp:2934` declares `txp` with `writable = false`. Leave it. That flag describes the
**config `set` path**, which genuinely cannot write this field in either role — the verb
is the supported route. Marking it writable would advertise a path that does not work.

(`dev-role-site` mused that the flag "becomes role-dependent". On inspection that is the
wrong lever: the correct role-dependent behaviour is the verb refusing, which this spec
implements. Deferred deliberately, not forgotten.)

### Reporting

`status` and the debug frame report `jn(TX_DBM)` at `main.cpp:1851` and `:1899`. Both
become `g_txDbm`, so the frames tell the truth about what the radio is doing rather than
what it booted with. `txp` is added to the `help` verb list — a new verb that cannot be
discovered repeats the defect already logged as `command-help-sync`.

`FW_VERSION` is bumped: the bench build diverges from the deployed unit the moment this
lands (`bump-fw-version-on-divergence`).

## Observe

1. **Static** — `setTxPower` present in the library; `g_txDbm` replaces `TX_DBM` at both
   reporting sites; the interlock branches on `g_role`.
2. **Functional, on BNCH only** — `txp` reports 22; `txp 0` succeeds and `status` then
   reports `"txp":0`; the *received* RSSI at the gateway drops by roughly the attenuation
   (the actual measurement this exists to enable); `txp -9` succeeds; `txp 30` and
   `txp -20` are refused with a range error; **reboot restores 22** (the non-persistence
   assertion, and the one that matters most).
3. **Regression** — normal command/telemetry traffic still works at reduced power; the
   offline library tests still pass.

## Risks

- **A bench unit attenuated to -9 dBm may be hard to reach** to command back up, since the
  command path is the same radio. Mitigations: it is on USB (console access), and a reboot
  restores full power. Do not attenuate a unit you cannot physically touch — which is
  precisely what the interlock enforces.
- `setOutputPower` reprograms the PA while the transport may have frames queued. RadioLib
  writes the registers immediately; a frame already in flight is unaffected, and the next
  transmission uses the new setting. Not expected to be an issue, but it is the reason to
  apply this while idle rather than mid-transfer.
- **Attenuating TX does not emulate the remote fully.** It changes what our gateway hears
  from the bench; it does not reproduce the 2.5 km path, multipath, or the remote's own
  receive conditions. It is a link-margin instrument, not a simulator — do not present its
  results as "the garage link".

## Findings from the live run

**The attenuation is real, and measured rather than trusted.** A command returning `ok`
only proves it parsed; the proof is the RECEIVED signal at the gateway:

| setting | OMNI-heard RSSI | delta |
|---|---|---|
| +22 (boot default) | -57 dBm | — |
| set to 0 | -80 dBm | 23 dB |
| set to -9 | -89 dBm | 32 dB (full range) |

**A control that rules out coincidence:** the unit's OWN reading of our pings stayed at
-55 dBm throughout. We changed only the unit's transmit power, so only what WE hear should
move — and only that moved. A shift in both directions would have meant something else
changed.

**Non-persistence verified by side effect.** After a reboot the unit was heard at -56/-57
again, back at full power without being told. Checked via RSSI rather than by asking the
device, since asking would only report a variable, not the PA.

**PENDING: the garage refusal.** The branch protecting the deployed unit is still unproven.
It cannot be tested on USB — the role is chosen from VBUS at boot — so it needs a battery
boot. Peter put the bench unit on an 18650 at 14:52 and it correctly adopted the garage
role; a set-power command is queued against it and will confirm the refusal on its next
wake window. Until that returns the refusal error, treat the interlock as READ-VERIFIED
ONLY.

**Incidental: dev-role-site verified itself.** That spec listed its re-baseline as STILL
UNVERIFIED because it needed a physical unplug. On battery the unit took the garage role
and re-baselined name AND position (long name became "Garage 2-260725-20", latitude_i
510146831). Worth recording against that task.

**Note on versions:** `pio run -t upload` REBUILDS, and bump_fw.py increments per build, so
the flashed image is 2-260725-20 even though the preceding compile produced -19.
