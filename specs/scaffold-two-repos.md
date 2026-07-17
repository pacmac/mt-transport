---
task: scaffold-two-repos
status: active
updated: 2026-07-17
---

# Spec: scaffold the public/private repo split

## Goal

`mt-transport` (this repo) becomes public-clean from its **first** commit:
GPL-3.0, `library.json`, generic docs only. Deployment secrets (PSK, BLE PIN,
gateway rules) move to a new **private sibling** repo, `pac-garage-alarm`,
before anything is committed anywhere. No firmware code in this task.

Verification gate: grep working tree **and** `git log -p` for the PSK (hex and
b64) and the BLE PIN — zero hits in mt-transport, both before and after the
first commit.

## Files in scope — mt-transport (public)

| file | action |
|---|---|
| `specs/scaffold-two-repos.md` | this file (new) |
| `docs/hardware.md` | **move** to `../pac-garage-alarm/docs/hardware.md` |
| `docs/wire-format.md` | §3: replace real PSK with placeholder; keep table shape, keep `0x7e` hash and the public `AQ==` row |
| `docs/background.md` | fix stale line 3 (`docs/sensor-mode-behavior.md` → this file); remove BLE PIN from §Next actions |
| `docs/spec.md` | §3 channel hash: replace real PSK with placeholder (found by sweep, same secret as wire-format.md) |
| `AGENTS.md` | fix dangling refs: CHANGELOG.md (created), spike.md (mark "task 2"); note hardware.md's new home; remove BLE PIN from §Hardware |
| `.gitignore` | new: `.pio/`, `.vscode/`, `**/secrets.h` |
| `library.json` | new: name/version 0.0.1/GPL-3.0-or-later/nordicnrf52/arduino; deps RadioLib + nanopb |
| `examples/SpikeSend/platformio.ini` | new: env:rak4631 stub for task 2 |
| `examples/SpikeSend/secrets.h.example` | new: placeholder channel name/PSK |
| `LICENSE` | new: verbatim GPL-3.0 |
| `NOTICE` | new: Meshtastic attribution |
| `README.md` | new: thesis + honest pre-spike status |
| `CHANGELOG.md` | new: Keep-a-Changelog, `[Unreleased]` |

## Files in scope — pac-garage-alarm (new private sibling)

Root: `/usr/share/pac/dev/pio/projects/pac-garage-alarm` (sibling — the
`symlink://../mt-transport` dev path depends on it).

| file | action |
|---|---|
| `.git/` | `git init` |
| `docs/hardware.md` | received from mt-transport, verbatim |
| `platformio.ini` | new: empty env:rak4631, **no** lib_deps yet |
| `include/secrets.h.example` | new: placeholders |
| `.gitignore` | new: `.pio/`, `include/secrets.h` |
| `README.md` | new: minimal — what this is, pointer to mt-transport |
| `src/`, `include/` | empty dirs (`.gitkeep`) |

## Out of scope

Any `src/` code in either repo, the spike, protobufs submodule, AES library
choice, remotes/pushing, rewriting `background.md`'s prediction table.

## Commit plan

1. Verify no-secrets grep passes in mt-transport working tree.
2. mt-transport: single commit, everything above.
3. Re-verify against `git log -p`.
4. pac-garage-alarm: single commit (hardware.md **is** in it — repo is private).
