#!/usr/bin/env python3
"""serial-log.py — reliable debug capture from the bench RAK4631.

WHY THIS EXISTS: the RAK's `Serial` is TinyUSB **USB CDC**, and CDC only emits once
the HOST ASSERTS DTR. `cat /dev/ttyACM0` does not raise DTR, so it returns absolutely
nothing while the board is alive and transmitting — and flashing doesn't need DTR
either, so uploads succeed while reads stay mute. That combination reads as a dead
board and is not. See specs/device-comms.md.

It also:
  - resolves the port via /dev/serial/by-id (the ttyACMx index RENUMBERS on reflash),
  - RECONNECTS automatically, so a capture survives a flash cycle instead of dying,
  - timestamps every line and tees to a log file, so you can grep after the fact
    rather than having to be watching at the right moment.

Usage:
  tools/serial-log.py                          # stream + log, until Ctrl-C
  tools/serial-log.py --seconds 60             # bounded capture
  tools/serial-log.py --grep 'PKI|REPLY|RX:'   # only matching lines to stdout
  tools/serial-log.py --log /tmp/bench.log
  tools/serial-log.py --quiet --seconds 300 &  # background capture, grep the log later
"""
import argparse
import glob
import os
import re
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial missing — use /usr/share/pac/py/bin/python (has pyserial 3.5)")

DEFAULT_GLOB = "/dev/serial/by-id/*RAK*"
DEFAULT_LOG = "/tmp/bench-serial.log"

# A capture holding the port during a DFU write is what corrupted the app image and
# left the board stuck in the bootloader for over an hour (2026-07-22). That must not
# depend on anyone REMEMBERING to stop the logger first, so this script enforces it:
# it refuses to start while a flash is running, and drops the port the moment one
# begins. pio owns the port during an upload; this tool always yields.
FLASH_MARKERS = ("nrfutil", "-t upload", "pio run")


def flash_in_progress():
    """True if a pio upload / nrfutil DFU is running. Scans /proc, no extra deps."""
    me = os.getpid()
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == me:
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmd = fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        if "serial-log.py" in cmd:
            continue                      # that's us / a sibling capture
        if any(m in cmd for m in FLASH_MARKERS):
            return cmd.strip()[:70]
    return None


def find_port(pattern):
    """Resolve by stable by-id path, never a bare ttyACMx (those renumber on reflash)."""
    hits = sorted(glob.glob(pattern))
    return hits[0] if hits else None


def open_port(path, baud):
    """Open read-only. DTR is the ONLY control line this tool may set, and it is set
    as INITIAL PORT STATE — never driven on a live device, never toggled, never pulsed.

    RTS used to be asserted here too. It was never needed (CDC output depends on DTR
    alone) and it is a gratuitous risk: on this board the control lines are the
    documented reset/DFU vector. Peter, 2026-07-22, after the second board incident of
    the day: "I did NOT say dont open the Port, I said stop fucking around with the
    control lines". Reading the port is fine. Driving control lines is not.

    Assigning s.dtr/s.rts AFTER open() drives a transition on a device that is already
    running. Configuring an unopened Serial() makes the levels part of the initial
    state instead, so the board never sees an edge from us. Do not add a reset pulse,
    a 1200-baud touch, or any other "kick" here — if a board needs resetting that is a
    physical action and Peter's call.
    """
    s = serial.Serial()
    s.port = path
    s.baudrate = baud
    s.timeout = 1
    s.dtr = True    # required: the RAK's CDC stays mute until the host raises DTR
    s.rts = False   # explicitly LOW so pyserial's default assertion never reaches the board
    s.open()
    time.sleep(0.3)
    s.reset_input_buffer()
    return s


def main():
    ap = argparse.ArgumentParser(description="Capture RAK4631 debug serial (DTR asserted).")
    ap.add_argument("--port", default=DEFAULT_GLOB, help="by-id glob or explicit device path")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--log", default=DEFAULT_LOG, help="append captured lines here")
    ap.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = forever)")
    ap.add_argument("--grep", default=None, help="regex; only matching lines go to stdout")
    ap.add_argument("--quiet", action="store_true", help="log only, no stdout")
    args = ap.parse_args()

    busy = flash_in_progress()
    if busy:
        sys.exit(f"REFUSING to open the port: a flash is in progress ({busy}).\n"
                 f"pio owns the port during an upload — holding it corrupts the write.")

    pat = re.compile(args.grep) if args.grep else None
    deadline = time.time() + args.seconds if args.seconds > 0 else None
    logf = open(args.log, "a", buffering=1)
    logf.write(f"\n===== capture started {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")

    ser, shown = None, None
    lines = 0
    last_check = 0.0
    try:
        while deadline is None or time.time() < deadline:
            if ser is None:
                path = args.port if os.path.exists(args.port) else find_port(args.port)
                if not path:
                    if shown != "waiting":
                        print("[waiting for port…]", flush=True)
                        shown = "waiting"
                    time.sleep(1)
                    continue
                try:
                    ser = open_port(path, args.baud)
                except (OSError, serial.SerialException) as e:
                    # Port exists but isn't ready (mid-reflash enumeration) — retry.
                    if shown != f"busy:{e}":
                        print(f"[port not ready: {e}]", flush=True)
                        shown = f"busy:{e}"
                    time.sleep(1)
                    continue
                msg = f"[connected {path} dtr=on]"
                print(msg, flush=True)
                logf.write(msg + "\n")
                shown = None

            try:
                raw = ser.readline()
            except (OSError, serial.SerialException):
                # Device went away — almost always a reflash. Reconnect rather than die.
                print("[disconnected — waiting for reconnect]", flush=True)
                logf.write("[disconnected]\n")
                try:
                    ser.close()
                except Exception:
                    pass
                ser = None
                time.sleep(1)
                continue

            # Yield immediately if a flash starts while we are attached.
            now = time.time()
            if now - last_check > 1.0:
                last_check = now
                busy = flash_in_progress()
                if busy:
                    print(f"[flash detected ({busy}) — releasing port]", flush=True)
                    logf.write("[released port for flash]\n")
                    try:
                        ser.close()
                    except Exception:
                        pass
                    ser = None
                    while flash_in_progress():
                        time.sleep(1)
                    print("[flash finished — reattaching]", flush=True)
                    continue

            if not raw:
                continue
            text = raw.decode("utf-8", "replace").rstrip()
            stamped = f"{time.strftime('%H:%M:%S')} {text}"
            logf.write(stamped + "\n")
            lines += 1
            if not args.quiet and (pat is None or pat.search(text)):
                print(stamped, flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        if ser:
            try:
                ser.close()
            except Exception:
                pass
        logf.write(f"===== {lines} lines, ended {time.strftime('%H:%M:%S')} =====\n")
        logf.close()
        print(f"[{lines} lines -> {args.log}]", flush=True)


if __name__ == "__main__":
    main()
