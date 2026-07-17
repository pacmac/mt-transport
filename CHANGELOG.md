# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added
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
