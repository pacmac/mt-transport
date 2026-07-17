# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[SemVer](https://semver.org/).

## [0.1.0] — 2026-07-17

### Added
- `MeshtasticTransport` library (`src/`): `begin`/`send`/`busy`/`sleep`.
  App owns the radio object, entropy, message construction and sleep; the
  library owns PHY config, the `Data` envelope, AES-CTR and the header.
  Split as `mt_wire` (header/hash) and `mt_crypto` (nonce/CTR, AES128/256 by
  key length, counter size 4).
- NODEINFO_APP example: the node appears as "MT Spike"/"SPKE" — proves
  `send()` is message-agnostic. Verified on air alongside telemetry
  (0 hops, RSSI −51).
- `tools/spike_oracle.py` decodes NODEINFO/User frames too.
- Generated protobufs now ship with the library (`src/generated/`).
- SpikeSend consumes the library via `lib_deps = symlink://../..` — the same
  path real applications use.

### Changed
- Battery reality check in docs: EEMB ER14505 AA Li-SOCl2 3.6 V **2700 mAh**
  primary (no recharging) replaces the earlier ~19 Ah assumption; lifetime
  numbers recomputed (docs/rx-and-commands.md, docs/spec.md).

## [Unreleased]

### Added
- **THE SPIKE PASSES (2026-07-17)**: `examples/SpikeSend/` transmits a
  Meshtastic-compatible encrypted packet from a bare RadioLib sketch; a real
  Meshtastic node decoded it into its NodeDB at 0 hops (RSSI −51, SNR 6.2).
  Wire format, AES128-CTR, protobuf and PHY all verified end-to-end. Library
  work is now unblocked — see `docs/spike.md` §Results for build notes.
- `protobufs/` submodule (meshtastic/protobufs @ `36251667`, matching the
  reference firmware pin); nanopb 0.4.9 generation into
  `examples/SpikeSend/src/generated/`.
- `tools/spike_oracle.py` — host-side receive-path verifier (header, channel
  hash, AES-CTR decrypt, protobuf decode) with `--self-test`.
- Vendored `boards/wiscore_rak4631.json` + RAK4631 variant files (PIO's
  bundled Adafruit nRF52 core lacks them).
- Repository scaffold: `library.json` (v0.0.1), GPL-3.0 `LICENSE`, `NOTICE`
  with Meshtastic attribution, `README.md`, `.gitignore`,
  `examples/SpikeSend/` stub with `secrets.h.example`.
- Design docs: `background.md`, `wire-format.md`, `rx-and-commands.md`,
  `spec.md`.

### Changed
- Deployment secrets (channel PSK, BLE PIN, node inventory, gateway rules)
  moved out to the private `pac-garage-alarm` repo before the first commit;
  `wire-format.md` §3 and `spec.md` §3 now use placeholders.

### Notes
- Pre-spike: no code, no transmission yet. `docs/spec.md` §THE SPIKE gates
  all library work.
