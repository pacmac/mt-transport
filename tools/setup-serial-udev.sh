#!/usr/bin/env bash
# setup-serial-udev.sh — install the bench serial ROLE ALIASES from the SSOT.
#
# The mapping lives in pac-garage-alarm/platformio.ini section [pac_serial]
# (alias = vid|serial) — the same file that consumes the aliases via
# upload_port. This script is a pure transformer: parse SSOT -> udev rules.
#
# Idempotent: re-running REPLACES the previous rules file wholesale.
#
# Rationale for aliases at all: raw ttyACMx renumbers on every replug/reflash
# and burned us three times (by-id literal: bootloader renames; ttyACM* glob:
# matched the debug adapter; camera FTDI probed by a stray DFU touch).
set -euo pipefail

# ---- locations (edit here) ----------------------------------------------------
INI=/usr/share/pac/dev/pio/projects/pac-garage-alarm/platformio.ini
SECTION=pac_serial
RULES_FILE=/etc/udev/rules.d/99-pac-serial.rules
# --------------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (writes $RULES_FILE)" >&2
  exit 1
fi

# Parse "[pac_serial]" entries: alias = vid|serial (serial may be empty).
mapfile -t ENTRIES < <(python3 - "$INI" "$SECTION" <<'PY'
import configparser, sys
cp = configparser.ConfigParser(strict=False, inline_comment_prefixes=(';', '#'))
cp.read(sys.argv[1])
if sys.argv[2] not in cp:
    sys.exit(f"section [{sys.argv[2]}] not found in {sys.argv[1]}")
for alias, spec in cp[sys.argv[2]].items():
    vid, _, serial = spec.partition('|')
    print(f"{alias}|{vid.strip()}|{serial.strip()}")
PY
)

[[ ${#ENTRIES[@]} -gt 0 ]] || { echo "no entries parsed from [$SECTION] in $INI" >&2; exit 1; }

{
  echo "# GENERATED from $INI [$SECTION] by mt-transport/tools/setup-serial-udev.sh"
  echo "# Edit the ini (SSOT), then re-run the script to replace this file."
  echo "# $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
  for e in "${ENTRIES[@]}"; do
    IFS='|' read -r name vid serial <<< "$e"
    if [[ -n "$serial" ]]; then
      echo "SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"$vid\", ATTRS{serial}==\"$serial\", SYMLINK+=\"$name\""
    else
      echo "SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"$vid\", SYMLINK+=\"$name\""
    fi
  done
} > "$RULES_FILE"

udevadm control --reload-rules
udevadm trigger --subsystem-match=tty
sleep 1

echo "installed $RULES_FILE:"
sed 's/^/  /' "$RULES_FILE"
echo "live aliases:"
for e in "${ENTRIES[@]}"; do
  name="${e%%|*}"
  if [[ -e "/dev/$name" ]]; then
    printf '  /dev/%s -> %s\n' "$name" "$(readlink -f "/dev/$name")"
  else
    printf '  /dev/%s : NOT PRESENT (device unplugged?)\n' "$name"
  fi
done
