"""Receive HIVE's OSC and route it onto rack parameters.

The backend sends everything described in `backend/docs/OSC.md` to whatever
targets are enabled on its dashboard. This module listens for that, and holds a
table saying which incoming value drives which knob.

No dependency: the decoder is the same twenty lines as
`backend/examples/osc_listen.py`, which the repo already uses rather than
pulling in a library. Same reasoning as the backend not taking the `osc` npm
package.

A mapping is one row:

    address + argument index  ->  parameter,  input range  ->  output range

The input range matters more than it looks. `/hive/swarm/energy` arrives in
m/s² and runs roughly 0..15; a model parameter wants 0..1. Mapping the wrong
range is the difference between a knob that sweeps and a knob that sits pinned.
Every row remembers the smallest and largest value it has actually seen, so the
GUI can show you the real range and fill it in for you.

Values are applied on the OSC thread straight onto the parameter, which is a
plain float the audio worker reads. That is the same deal the GUI already has
and needs no lock.
"""

from __future__ import annotations

import json
import logging
import socket
import struct
import threading
import time
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("morpho_rack.osc")


# ---------------------------------------------------------------------------
# decoding
# ---------------------------------------------------------------------------


def _string(buf, o):
    end = buf.index(b"\0", o)
    return buf[o:end].decode("ascii", "replace"), (end + 4) & ~3


def decode(buf):
    """Yield (address, args) for a message, or for each message in a bundle."""
    if buf.startswith(b"#bundle"):
        o = 16
        while o + 4 <= len(buf):
            (n,) = struct.unpack(">I", buf[o : o + 4])
            o += 4
            if o + n > len(buf):
                return
            yield from decode(buf[o : o + n])
            o += n
        return
    try:
        address, o = _string(buf, 0)
    except ValueError:
        return
    tags = ""
    if o < len(buf) and buf[o : o + 1] == b",":
        try:
            tags, o = _string(buf, o)
        except ValueError:
            return
        tags = tags[1:]
    args = []
    for t in tags:
        try:
            if t == "f":
                args.append(struct.unpack(">f", buf[o : o + 4])[0])
                o += 4
            elif t == "i":
                args.append(struct.unpack(">i", buf[o : o + 4])[0])
                o += 4
            elif t == "s":
                s, o = _string(buf, o)
                args.append(s)
            elif t == "d":
                args.append(struct.unpack(">d", buf[o : o + 8])[0])
                o += 8
            elif t in "TF":
                args.append(1.0 if t == "T" else 0.0)
            elif t == "b":
                (n,) = struct.unpack(">I", buf[o : o + 4])
                o += 4 + ((n + 3) & ~3)
                args.append(None)
            else:
                break
        except (struct.error, ValueError, IndexError):
            break
    yield address, args


# ---------------------------------------------------------------------------
# mapping
# ---------------------------------------------------------------------------


class Mapping:
    """One row of the routing table."""

    __slots__ = (
        "address", "arg", "target", "in_lo", "in_hi", "out_lo", "out_hi",
        "enabled", "invert", "slew", "seen_lo", "seen_hi", "last_in",
        "last_out", "hits", "_value", "_last_time",
    )

    def __init__(self, address="", arg=0, target="", in_lo=0.0, in_hi=1.0,
                 out_lo=0.0, out_hi=1.0, enabled=True, invert=False, slew=0.0):
        self.address = address
        self.arg = int(arg)
        self.target = target
        self.in_lo = float(in_lo)
        self.in_hi = float(in_hi)
        self.out_lo = float(out_lo)
        self.out_hi = float(out_hi)
        self.enabled = bool(enabled)
        self.invert = bool(invert)
        self.slew = float(slew)  # seconds to travel the full range, 0 = instant
        self.seen_lo = float("inf")
        self.seen_hi = float("-inf")
        self.last_in = 0.0
        self.last_out = 0.0
        self.hits = 0
        self._value = None
        self._last_time = None

    def convert(self, raw: float, _dt=None) -> float:
        # The elapsed time is measured per row, not per packet. Sharing one
        # clock across the table makes a slew depend on how much *other*
        # traffic is arriving: with a dozen addresses in flight each row sees a
        # fraction of the real gap and crawls at a fraction of its setting.
        now = time.monotonic()
        dt = 0.0 if self._last_time is None else max(now - self._last_time, 0.0)
        self._last_time = now

        self.last_in = raw
        self.seen_lo = min(self.seen_lo, raw)
        self.seen_hi = max(self.seen_hi, raw)
        span = self.in_hi - self.in_lo
        pos = 0.0 if abs(span) < 1e-12 else (raw - self.in_lo) / span
        pos = min(max(pos, 0.0), 1.0)
        if self.invert:
            pos = 1.0 - pos
        target = self.out_lo + pos * (self.out_hi - self.out_lo)

        if self.slew > 1e-4:
            # Rate limit in output units per second, so a jumpy sensor does not
            # step a parameter. Levels especially want this.
            if self._value is None:
                self._value = target
            else:
                rate = abs(self.out_hi - self.out_lo) / self.slew
                step = rate * max(dt, 0.0)
                delta = target - self._value
                self._value += max(-step, min(step, delta))
            target = self._value
        else:
            self._value = target

        self.last_out = target
        self.hits += 1
        return target

    def to_dict(self) -> dict:
        return {
            "address": self.address, "arg": self.arg, "target": self.target,
            "in_lo": self.in_lo, "in_hi": self.in_hi,
            "out_lo": self.out_lo, "out_hi": self.out_hi,
            "enabled": self.enabled, "invert": self.invert, "slew": self.slew,
        }


class Receiver:
    """UDP listener plus the routing table.

    `apply` is called with (target key, value) for every mapped message. The
    rack supplies one that writes onto the named parameter.
    """

    def __init__(self, apply: Callable[[str, float], None]) -> None:
        self._apply = apply
        self.mappings: list[Mapping] = []
        self.port = 9001
        self.running = False
        self.packets = 0
        self.errors = 0
        self.last_packet_at = 0.0
        # address -> (arg count, last values, time), for the GUI's address list
        self.seen: dict[str, tuple] = {}
        self.learn_target: Optional[str] = None
        self.learned: Optional[tuple] = None
        # Events that are not numbers and so cannot be routed through the
        # table: who the queen is, and who just left.
        self.on_queen: Optional[Callable[[str, int], None]] = None
        self.on_leave: Optional[Callable[[int], None]] = None
        self.queen_uid = ""
        self.queen_slot = 0

        self._sock = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.RLock()

    # -- lifecycle ----------------------------------------------------------

    def start(self, port: int) -> None:
        self.stop()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.3)
        sock.bind(("0.0.0.0", int(port)))
        self._sock = sock
        self.port = int(port)
        self._stop.clear()
        self.packets = self.errors = 0
        self._thread = threading.Thread(target=self._run, name="osc", daemon=True)
        self._thread.start()
        self.running = True
        log.info("osc: listening on udp %d", self.port)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None
        if self.running:
            log.info("osc: stopped")
        self.running = False

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                buf, _ = self._sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            self.packets += 1
            self.last_packet_at = time.monotonic()
            try:
                for address, args in decode(buf):
                    self._dispatch(address, args)
            except Exception as exc:  # a malformed packet must not kill the thread
                self.errors += 1
                if self.errors < 5:
                    log.warning("osc: bad packet: %s", exc)

    # -- routing ------------------------------------------------------------

    def _dispatch(self, address: str, args: list) -> None:
        numeric = [a for a in args if isinstance(a, (int, float))]
        self.seen[address] = (len(args), numeric[:8], time.monotonic())

        # /hive/queen is "s uid, i slot" and /hive/leave is "i slot, s uid", so
        # neither is a value to scale onto a knob; they say who someone is.
        if address == "/hive/queen":
            uid = args[0] if args and isinstance(args[0], str) else ""
            slot = int(args[1]) if len(args) > 1 and isinstance(
                args[1], (int, float)) else 0
            if (uid, slot) != (self.queen_uid, self.queen_slot):
                self.queen_uid, self.queen_slot = uid, slot
                if self.on_queen is not None:
                    try:
                        self.on_queen(uid, slot)
                    except Exception as exc:
                        log.warning("osc: queen handler failed: %s", exc)
        elif address == "/hive/leave" or address.endswith("/leave"):
            slot = next((int(a) for a in args if isinstance(a, (int, float))), 0)
            if slot and self.on_leave is not None:
                try:
                    self.on_leave(slot)
                except Exception as exc:
                    log.warning("osc: leave handler failed: %s", exc)

        if self.learn_target is not None and numeric:
            # Learn binds the first numeric argument of the next address that
            # carries one, which is what you get by wiggling the thing you want.
            self.learned = (address, next(
                i for i, a in enumerate(args) if isinstance(a, (int, float))
            ))
            self.learn_target = None

        with self._lock:
            rows = [m for m in self.mappings if m.enabled and m.address == address]
        for m in rows:
            if m.arg >= len(args):
                continue
            raw = args[m.arg]
            if not isinstance(raw, (int, float)):
                continue
            try:
                self._apply(m.target, m.convert(float(raw)))
            except Exception as exc:
                self.errors += 1
                if self.errors < 5:
                    log.warning("osc: cannot apply %s: %s", m.target, exc)

    # -- table --------------------------------------------------------------

    def add(self, mapping: Mapping) -> None:
        with self._lock:
            self.mappings.append(mapping)

    def remove(self, mapping: Mapping) -> None:
        with self._lock:
            if mapping in self.mappings:
                self.mappings.remove(mapping)

    def save(self, path: Path) -> None:
        with self._lock:
            rows = [m.to_dict() for m in self.mappings]
        Path(path).write_text(
            json.dumps({"port": self.port, "mappings": rows}, indent=1),
            encoding="utf-8",
        )
        log.info("osc: wrote %d mappings to %s", len(rows), path)

    def load(self, path: Path) -> int:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        rows = [Mapping(**r) for r in data.get("mappings", [])]
        with self._lock:
            self.mappings = rows
        self.port = int(data.get("port", self.port))
        log.info("osc: loaded %d mappings from %s", len(rows), path)
        return len(rows)


# ---------------------------------------------------------------------------
# where an address comes from
# ---------------------------------------------------------------------------

# The split that matters when routing, and the reason both lists in the GUI are
# grouped. Protocol v3 has five families:
#
#   swarm    how much the crowd moves      -> the collective layer
#   global   how it moves: alike, in step, what rhythm, everyone or a soloist
#   camera   what the room looks like from the webcam
#   mix      where the bees on the wall and the bodies in the room meet
#   client   one phone                     -> that phone's synth voice
#
# Only client addresses are per-person, so only they belong on a voice.

SWARM = "swarm"
GLOBAL = "global"
CAMERA = "camera"
MIX = "mix"
CLIENT = "client"
EVENT = "event"
OTHER = "other"

_DEV_PREFIX = "/hive/dev/"


def classify(address: str):
    """Return (kind, client number or None) for an OSC address."""
    if address.startswith(_DEV_PREFIX):
        rest = address[len(_DEV_PREFIX):]
        num, _, tail = rest.partition("/")
        if num.isdigit():
            if tail in ("join", "leave"):
                return EVENT, int(num)
            return CLIENT, int(num)
        return OTHER, None
    if address in ("/hive/join", "/hive/leave", "/hive/roster", "/hive/queen",
                   "/hive/schema", "/hive/ping", "/hive/cam/status"):
        return EVENT, None
    if address.startswith("/hive/global"):
        return GLOBAL, None
    if address.startswith("/hive/cam"):
        # One message per person per frame, with the tracker id inside it, so
        # routing it straight at a knob means every person writes the same one.
        if address == "/hive/cam/person":
            return OTHER, None
        return CAMERA, None
    if address.startswith("/hive/mix"):
        return MIX, None
    if address.startswith("/hive/swarm"):
        return SWARM, None
    if address == "/hive/sample":
        # Same problem: one message per phone per sample, slot inside it.
        return OTHER, None
    return OTHER, None


def group_label(address: str) -> str:
    kind, num = classify(address)
    if kind == CLIENT:
        return f"client {num}"
    if kind == EVENT:
        return "events"
    return kind


# What each source carries and the range it really produces in a room, from
# backend/docs/OSC.md. "use seen" in the GUI replaces these with what actually
# arrived, which is always better.
SWARM_SOURCES = [
    ("/hive/swarm/sync", 0, 0.0, 1.0, "all phones turning equally hard, 0..1"),
    ("/hive/swarm/energy", 0, 0.0, 10.0, "how hard the swarm moves, m/s^2"),
    ("/hive/swarm/motion", 0, 0.0, 200.0, "how much it turns, deg/s"),
    ("/hive/swarm/count", 0, 0.0, 12.0, "phones connected"),
    ("/hive/swarm", 4, 0.0, 1.0, "sync, from the wide message"),
    ("/hive/swarm", 2, 0.0, 10.0, "energy, from the wide message"),
    ("/hive/swarm", 3, 0.0, 200.0, "motion, from the wide message"),
    ("/hive/swarm", 1, 0.0, 12.0, "count, from the wide message"),
]

# /hive/global, v3. The wide message is s,f,i then ten floats, so the argument
# index of a field is its column number minus one.
GLOBAL_FIELDS = [
    ("coherence", 3, -1.0, 1.0, "everyone moving alike, -1..1"),
    ("phaseSync", 4, 0.0, 1.0, "in step with each other, 0..1"),
    ("tempo", 5, 0.0, 6.0, "dominant movement frequency, Hz (walking ~2)"),
    ("centroid", 6, 0.0, 8.0, "slow sways low, jitter high, Hz"),
    ("entropy", 7, 0.0, 1.0, "1 everyone equally active, 0 one soloist"),
    ("dispersion", 8, 0.0, 6.0, "how different the tilts are, m/s^2"),
    ("leanX", 9, -4.0, 4.0, "where the swarm leans, left/right"),
    ("leanY", 10, -4.0, 4.0, "where it leans, forward/back"),
    ("onsets", 11, 0.0, 8.0, "rest-to-moving onsets per second"),
    ("crest", 12, 1.0, 6.0, "peak/RMS: 1 steady, high spiky"),
]

# /hive/cam, v3. Wide message is f,i,i then thirteen floats.
CAM_FIELDS = [
    ("count", 1, 0.0, 12.0, "people in view"),
    ("clusters", 2, 0.0, 5.0, "groups of people"),
    ("spread", 3, 0.0, 1.0, "mean distance between people, frame widths"),
    ("energy", 4, 0.0, 1.0, "how fast people are moving"),
    ("armsUp", 7, 0.0, 2.0, "raised arms per person"),
    ("turbulence", 10, 0.0, 1.0, "0 drifting together, high milling about"),
    ("moveSync", 11, -1.0, 1.0, "moving the same way, -1..1"),
    ("converge", 12, -0.5, 0.5, "negative = coming together"),
    ("nearest", 13, 0.0, 0.6, "distance to nearest neighbour"),
    ("stillness", 14, 0.0, 1.0, "fraction standing still"),
    ("occupancy", 15, 0.0, 1.0, "how much of the room is in use"),
]

# /hive/mix, v3. Wide message is f,i,i then six.
MIX_FIELDS = [
    ("distance", 3, 0.0, 1.0, "bees' centroid to crowd's centroid"),
    ("beesInCrowd", 4, 0.0, 1.0, "fraction of bees inside a group"),
    ("queenInCrowd", 5, 0.0, 1.0, "1 when the queen is inside a group"),
    ("covered", 6, 0.0, 1.0, "fraction of people with a bee near them"),
    ("alignment", 7, -1.0, 1.0, "swarm and crowd moving the same way"),
    ("balance", 8, 0.0, 1.0, "0.5 as many phones as bodies"),
]


def _family(prefix, fields, wide):
    """Both spellings of a v3 family: the per-field twin and the wide message."""
    rows = [(f"{prefix}/{name}", 0, lo, hi, why)
            for name, _, lo, hi, why in fields]
    rows += [(wide, idx, lo, hi, f"{name}, from the wide message")
             for name, idx, lo, hi, _ in fields]
    return rows


GLOBAL_SOURCES = _family("/hive/global", GLOBAL_FIELDS, "/hive/global")
CAM_SOURCES = (
    _family("/hive/cam", CAM_FIELDS, "/hive/cam")
    + [("/hive/cam/centroid", 0, 0.0, 1.0, "where everyone is, left-right"),
       ("/hive/cam/centroid", 1, 0.0, 1.0, "where everyone is, top-bottom"),
       ("/hive/cam/flow", 0, -1.0, 1.0, "crowd drift, left-right per second"),
       ("/hive/cam/flow", 1, -1.0, 1.0, "crowd drift, top-bottom per second")]
)
MIX_SOURCES = _family("/hive/mix", MIX_FIELDS, "/hive/mix")

# Per client. `n` is substituted for the client number.
CLIENT_SOURCES = [
    ("/hive/dev/{n}/activity", 0, 0.0, 1.0, "how much this phone moves, 0..1"),
    ("/hive/dev/{n}/turn", 0, -150.0, 150.0, "turning about the vertical, deg/s"),
    ("/hive/dev/{n}/mag", 1, 0.0, 8.0, "|rel|, how far from rest"),
    ("/hive/dev/{n}/mag", 2, 0.0, 300.0, "|gyro|, how fast it turns"),
    ("/hive/dev/{n}/mag", 0, 0.0, 20.0, "|acc|, including gravity"),
    ("/hive/dev/{n}/rel", 0, -6.0, 6.0, "rel x, left/right"),
    ("/hive/dev/{n}/rel", 1, -6.0, 6.0, "rel y, forward/back"),
    ("/hive/dev/{n}/rel", 2, -6.0, 6.0, "rel z"),
]

FAMILIES = {
    SWARM: SWARM_SOURCES,
    GLOBAL: GLOBAL_SOURCES,
    CAMERA: CAM_SOURCES,
    MIX: MIX_SOURCES,
}


def client_sources(n: int):
    return [(a.format(n=n), arg, lo, hi, why)
            for a, arg, lo, hi, why in CLIENT_SOURCES]


# ---------------------------------------------------------------------------
# default routing
# ---------------------------------------------------------------------------


def default_mappings(n_voices: int = 8, n_slots: int = 4,
                     camera: bool = True) -> list:
    """A routing table that already makes musical sense.

    Per client, onto that client's voice -- the three things a person can feel
    themselves doing: moving makes you audible, turning on the spot is your
    note, and how far you are from rest is how harsh you sound.

    For the crowd, protocol v3 separates *how much* from *how*, so the two go to
    different places. `/hive/swarm` is amount and drives loudness and
    brightness. `/hive/global` is character and drives the things that change
    what the piece is: coherence dries the room, entropy decides whether this is
    a chorus or a soloist, tempo and crest shape the conditioning.

    Synchrony is the signal the piece is built around -- section 7's claim is
    that synchrony becomes timbral unison -- so it gets several reinforcing
    gestures. Scattered, you hear one voice in a large wash. As the crowd locks
    together the room dries out and the other models rise in behind the first,
    which stays up so there is never silence.

    Camera routes are included by default but cost nothing when no camera is
    attached, because nothing arrives on those addresses.
    """
    rows = []

    for i in range(1, n_voices + 1):
        rows.append(Mapping(
            address=f"/hive/dev/{i}/activity", arg=0,
            target=f"synth.voice{i}.level",
            in_lo=0.0, in_hi=1.0, out_lo=0.0, out_hi=1.0, slew=0.25))
        rows.append(Mapping(
            address=f"/hive/dev/{i}/turn", arg=0,
            target=f"synth.voice{i}.pitch",
            in_lo=-150.0, in_hi=150.0, out_lo=110.0, out_hi=880.0))
        rows.append(Mapping(
            address=f"/hive/dev/{i}/mag", arg=1,
            target=f"synth.voice{i}.rough",
            in_lo=0.5, in_hi=6.0, out_lo=0.0, out_hi=0.8, slew=0.4))

    # --- how together the crowd is -----------------------------------------
    # coherence is the better signal than swarm/sync: it is a real correlation
    # of movement rather than of how hard people are turning.
    rows.append(Mapping(
        address="/hive/global/coherence", arg=0, target="master.reverb.mix",
        in_lo=0.0, in_hi=0.8, out_lo=0.55, out_hi=0.05, slew=3.0))
    for slot in range(2, n_slots + 1):
        rows.append(Mapping(
            address="/hive/global/phaseSync", arg=0, target=f"slot{slot}.level",
            in_lo=0.2, in_hi=0.9, out_lo=-40.0, out_hi=-3.0, slew=4.0))

    # --- chorus or soloist --------------------------------------------------
    # entropy 1 is everyone equally active, 0 is one person carrying the room.
    # A soloist should be heard as a soloist, so the bank thins out.
    rows.append(Mapping(
        address="/hive/global/entropy", arg=0, target="synth.spread",
        in_lo=0.3, in_hi=1.0, out_lo=0.0, out_hi=18.0, slew=4.0))

    # --- how hard, how fast -------------------------------------------------
    for slot in range(1, n_slots + 1):
        rows.append(Mapping(
            address="/hive/swarm/energy", arg=0,
            target=f"slot{slot}.pre.filter.lp",
            in_lo=0.3, in_hi=8.0, out_lo=1200.0, out_hi=16000.0, slew=1.5))
        rows.append(Mapping(
            address="/hive/swarm/motion", arg=0, target=f"slot{slot}.model.p1",
            in_lo=0.0, in_hi=180.0, out_lo=0.0, out_hi=0.7, slew=2.0))

    # tempo is the crowd's pulse; let it set how fast the conditioning breathes
    rows.append(Mapping(
        address="/hive/global/tempo", arg=0, target="slot1.pre.compressor.release",
        in_lo=0.5, in_hi=4.0, out_lo=600.0, out_hi=60.0, slew=3.0))
    # crest: a spiky room gets a harder gate, a steady one a gentler
    rows.append(Mapping(
        address="/hive/global/crest", arg=0, target="slot1.post.gate.threshold",
        in_lo=1.0, in_hi=5.0, out_lo=-60.0, out_hi=-38.0, slew=3.0))

    rows.append(Mapping(
        address="/hive/swarm/count", arg=0, target="master.reverb.size",
        in_lo=1.0, in_hi=12.0, out_lo=0.3, out_hi=0.9, slew=8.0))

    if camera:
        # --- the room as the camera sees it ---------------------------------
        # People coming together is the same gesture as phones synchronising,
        # from the other subsystem, so it lands on the same kind of thing.
        rows.append(Mapping(
            address="/hive/cam/spread", arg=0, target="master.reverb.predelay",
            in_lo=0.05, in_hi=0.6, out_lo=5.0, out_hi=60.0, slew=4.0))
        rows.append(Mapping(
            address="/hive/cam/armsUp", arg=0, target="master.level",
            in_lo=0.0, in_hi=1.2, out_lo=-9.0, out_hi=-1.0, slew=2.0))
        rows.append(Mapping(
            address="/hive/cam/stillness", arg=0, target="synth.level",
            in_lo=0.0, in_hi=1.0, out_lo=-6.0, out_hi=-20.0, slew=4.0))
        rows.append(Mapping(
            address="/hive/cam/occupancy", arg=0, target="slot1.mix",
            in_lo=0.1, in_hi=0.9, out_lo=0.5, out_hi=1.0, slew=5.0))
        # the two subsystems agreeing is worth hearing
        rows.append(Mapping(
            address="/hive/mix/covered", arg=0, target="slot1.post.reverb.mix",
            in_lo=0.0, in_hi=0.8, out_lo=0.0, out_hi=0.35, slew=5.0))
    return rows


DEFAULT_NOTES = [
    "client N activity    -> synth voice N level",
    "client N turn        -> synth voice N pitch",
    "client N |rel|       -> synth voice N roughness",
    "global coherence     -> master reverb mix (together is dry)",
    "global phaseSync     -> slots 2-4 level (in step is unison)",
    "global entropy       -> synth detune (a soloist thins the bank)",
    "global tempo         -> slot 1 compressor release (the crowd's pulse)",
    "global crest         -> slot 1 gate threshold (spiky rooms gate harder)",
    "swarm energy         -> every slot's input high cut",
    "swarm motion         -> every slot's first model parameter",
    "swarm count          -> master reverb size",
    "cam spread           -> master reverb pre-delay",
    "cam armsUp           -> master level",
    "cam stillness        -> synth level (a still room quietens)",
    "cam occupancy        -> slot 1 dry/wet",
    "mix covered          -> slot 1 reverb (the two subsystems agreeing)",
]
