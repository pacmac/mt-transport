#!/usr/bin/env python3
"""Host-side oracle for the SpikeSend gate (docs/spike.md).

Feed it the FRAME hex line the sketch prints and it runs the full receive
path a Meshtastic node would: parse header -> check channel hash -> AES-CTR
decrypt -> protobuf-decode Data -> Telemetry. If this passes, the only
remaining failure modes are PHY-level.

Usage:
    spike_oracle.py --psk <hex16or32> --channel <name> <frame-hex>
    spike_oracle.py --psk <hex> --channel <name> --self-test
"""

import argparse
import struct
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from meshtastic.protobuf import mesh_pb2, portnums_pb2, telemetry_pb2


def xor_hash(data: bytes) -> int:
    code = 0
    for b in data:
        code ^= b
    return code


def decrypt(psk: bytes, packet_id: int, from_node: int, cipher: bytes) -> bytes:
    nonce = struct.pack("<QI", packet_id, from_node) + b"\x00\x00\x00\x00"
    algo = algorithms.AES(psk)  # 16 bytes -> AES128, 32 -> AES256
    ctx = Cipher(algo, modes.CTR(nonce)).decryptor()
    return ctx.update(cipher) + ctx.finalize()


def run(psk: bytes, channel_name: str, frame: bytes) -> int:
    if len(frame) < 17:
        print(f"FAIL: frame is {len(frame)} bytes; need 16-byte header + payload")
        return 1

    to, frm, pid = struct.unpack_from("<III", frame, 0)
    flags, chan, next_hop, relay = struct.unpack_from("<BBBB", frame, 12)
    hop_limit = flags & 0x07
    want_ack = bool(flags & 0x08)
    via_mqtt = bool(flags & 0x10)
    hop_start = (flags >> 5) & 0x07

    print(f"header: to={to:#010x} from={frm:#010x} id={pid:#010x}")
    print(f"        flags={flags:#04x} (hop_limit={hop_limit} want_ack={want_ack}"
          f" via_mqtt={via_mqtt} hop_start={hop_start})")
    print(f"        channel_hash={chan:#04x} next_hop={next_hop} relay={relay}")

    expect = xor_hash(channel_name.encode()) ^ xor_hash(psk)
    if chan != expect:
        print(f"FAIL: channel hash {chan:#04x} != expected {expect:#04x} — receiver would drop")
        return 1
    print(f"channel hash OK ({expect:#04x})")

    plain = decrypt(psk, pid, frm, frame[16:])
    print(f"plain ({len(plain)}): {plain.hex()}")

    data = mesh_pb2.Data()
    data.ParseFromString(plain)  # raises on garbage
    port = portnums_pb2.PortNum.Name(data.portnum)
    print(f"Data: portnum={port} payload={len(data.payload)}B")

    if data.portnum == portnums_pb2.TELEMETRY_APP:
        tel = telemetry_pb2.Telemetry()
        tel.ParseFromString(data.payload)
        variant = tel.WhichOneof("variant")
        print(f"Telemetry: time={tel.time} variant={variant}")
        if variant != "device_metrics":
            print("FAIL: expected device_metrics")
            return 1
        dm = tel.device_metrics
        print(f"  battery_level={dm.battery_level} voltage={dm.voltage:.2f}"
              f" uptime_seconds={dm.uptime_seconds}")
    elif data.portnum == portnums_pb2.NODEINFO_APP:
        user = mesh_pb2.User()
        user.ParseFromString(data.payload)
        print(f"User: id={user.id!r} long_name={user.long_name!r}"
              f" short_name={user.short_name!r} hw_model={user.hw_model}")
        if not user.long_name:
            print("FAIL: empty long_name")
            return 1
    else:
        print("FAIL: expected TELEMETRY_APP or NODEINFO_APP")
        return 1

    print("\nPASS — a Meshtastic receiver on this channel decodes this frame.")
    return 0


def self_test(psk: bytes, channel_name: str) -> int:
    """Build a frame the same way the sketch does, then verify it."""
    tel = telemetry_pb2.Telemetry()
    tel.time = 0
    tel.device_metrics.battery_level = 101
    tel.device_metrics.voltage = 3.60
    tel.device_metrics.uptime_seconds = 42

    data = mesh_pb2.Data()
    data.portnum = portnums_pb2.TELEMETRY_APP
    data.payload = tel.SerializeToString()
    plain = data.SerializeToString()

    pid, frm = 0x12345678, 0x5B1CE001
    cipher = decrypt(psk, pid, frm, plain)  # CTR: encrypt == decrypt
    hdr = struct.pack("<IIIBBBB", 0xFFFFFFFF, frm, pid,
                      3 | (3 << 5),
                      xor_hash(channel_name.encode()) ^ xor_hash(psk), 0, 0)
    print("self-test frame:", (hdr + cipher).hex(), "\n")
    return run(psk, channel_name, hdr + cipher)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--psk", required=True, help="channel PSK, hex (16 or 32 bytes)")
    ap.add_argument("--channel", required=True, help="channel name")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("frame", nargs="?", help="FRAME hex from the sketch's serial output")
    args = ap.parse_args()

    psk = bytes.fromhex(args.psk)
    if len(psk) not in (16, 32):
        ap.error("PSK must be 16 or 32 bytes of hex")

    if args.self_test:
        return self_test(psk, args.channel)
    if not args.frame:
        ap.error("provide a frame hex dump or --self-test")
    return run(psk, args.channel, bytes.fromhex(args.frame))


if __name__ == "__main__":
    sys.exit(main())
