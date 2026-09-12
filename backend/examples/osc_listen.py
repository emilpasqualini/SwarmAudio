#!/usr/bin/env python3
"""Print the OSC that HIVE sends — a stand-in for Pd/Max when checking a laptop
<<<<<<< HEAD
receives the stream.  No dependencies.  Protocol: docs/OSC.md.
=======
receives the stream.  No dependencies.
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

    python3 examples/osc_listen.py 9001

On the dashboard, add this machine as a target (its IP, port 9001), press Ping,
and `/hive/ping` should show up here.
"""
import socket
import struct
import sys
import time


def _string(buf, o):
    end = buf.index(b"\0", o)
    s = buf[o:end].decode("ascii")
    return s, (end + 4) & ~3


def decode(buf):
    """Yields (address, [args]) for a message or every message in a bundle."""
    if buf.startswith(b"#bundle"):
        o = 16
        while o + 4 <= len(buf):
            (n,) = struct.unpack(">I", buf[o:o + 4])
            o += 4
            yield from decode(buf[o:o + n])
            o += n
        return
    address, o = _string(buf, 0)
    tags = ""
    if o < len(buf) and buf[o:o + 1] == b",":
        tags, o = _string(buf, o)
        tags = tags[1:]
    args = []
    for t in tags:
        if t == "f":
            args.append(struct.unpack(">f", buf[o:o + 4])[0]); o += 4
        elif t == "i":
            args.append(struct.unpack(">i", buf[o:o + 4])[0]); o += 4
        elif t == "s":
            s, o = _string(buf, o); args.append(s)
        else:
            break
    yield address, args


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    print(f"listening for OSC on udp {port}")
    counts = {}
    last = time.time()
    while True:
        buf, (host, _) = sock.recvfrom(4096)
        for address, args in decode(buf):
            counts[address] = counts.get(address, 0) + 1
<<<<<<< HEAD
            streaming = address in ("/hive/sample", "/hive/swarm", "/hive/roster", "/hive/schema") or \
                address.endswith(("/acc", "/rel", "/gyro", "/activity", "/mag", "/energy", "/motion", "/sync", "/count"))
            if not streaming:
=======
            if not address.endswith(("/acc", "/gyro", "/mag", "/energy", "/motion", "/sync", "/count")):
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
                print(address, *(f"{a:.3f}" if isinstance(a, float) else a for a in args), f"  from {host}")
        now = time.time()
        if now - last > 1:
            last = now
            print("  ".join(f"{a}={n}/s" for a, n in sorted(counts.items())))
            counts.clear()


if __name__ == "__main__":
    main()
