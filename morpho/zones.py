"""Camera sections: each model's level comes from the people in its part of the room.

All four slots are equal. Nothing about the phones decides which model is
loud; the camera does, section by section. Split the picture into four, count
who stands in each, and slot N follows section N. Walking across the room
walks the sound from one model to the next.

Where the people come from
--------------------------
`/hive/cam/person` gives one message per tracked person per frame, with an x
and y in 0..1 of the frame. That is the precise source. `/hive/cam/cluster`
gives one per group with a head count and a centre, which is far fewer packets
and good enough when people stand in groups. Persons are used whenever they are
arriving; clusters are the fallback; with neither, the sections relax to equal.

The gains
---------
Square roots of each section's share of the people, as in CLAUDE.md section 8,
so the total power stays constant as the crowd moves: four sections at share
1/4 each are all at unity, and everyone crowding into one puts that model at
+6 dB while the other three fall to the floor, which is the same total power.
Proportional gains would instead dip the whole mix whenever people spread out.

Section 8 also Dirichlet-smooths the counts. That is right for estimating
entropy from a handful of people, and wrong for a fader: with six people in one
section it still leaves every empty section at -6 dB, so the model whose area is
deserted never really goes away. An empty section here goes to the floor.

Slewed over a second or two, because tracking jitter at 15 fps would otherwise
put zipper noise on four faders at once.
"""

from __future__ import annotations

import math
import time


from dsp import Param

LAYOUTS = ("columns", "quadrants")

ZONE_PARAMS = (
    Param("on", "camera sections", 0.0, 1.0, 1.0, ""),
    Param("depth", "depth", 0.0, 1.0, 1.0, ""),
    Param("floor", "empty section", -60.0, 0.0, -30.0, "dB"),
    Param("slew", "slew", 0.1, 10.0, 1.5, "s", "log"),
    Param("layout", "layout", 0.0, len(LAYOUTS) - 1.0, 0.0, ""),
)

PERSON_TTL = 0.6    # a tracker id unseen this long has left the picture
CLUSTER_TTL = 0.6
MAX_GAIN = 2.0      # +6 dB for a section that holds everyone


class CameraZones:
    def __init__(self, n_zones: int = 4) -> None:
        self.n = n_zones
        self.values = {p.name: p.default for p in ZONE_PARAMS}
        self._people = {}        # tracker id -> (x, y, t)
        self._clusters = {}      # index -> (count, x, y, t)
        self.counts = [0.0] * n_zones
        self.targets = [1.0] * n_zones
        self.gains = [1.0] * n_zones
        self.source = "none"
        self._last = time.monotonic()

    # -- parameters ---------------------------------------------------------

    def param(self, name):
        for p in ZONE_PARAMS:
            if p.name == name:
                return p
        raise KeyError(name)

    def get(self, name):
        return self.values[name]

    def set(self, name, value):
        p = self.param(name)
        self.values[name] = min(max(float(value), p.lo), p.hi)

    @property
    def layout(self) -> str:
        return LAYOUTS[int(round(self.values["layout"])) % len(LAYOUTS)]

    def set_layout(self, name: str) -> None:
        self.set("layout", float(LAYOUTS.index(name)))

    # -- input --------------------------------------------------------------

    def on_person(self, args) -> None:
        """/hive/cam/person: i id, f x, f y, f depth, f armsUp, f crouch, f energy"""
        if len(args) < 3:
            return
        try:
            self._people[int(args[0])] = (float(args[1]), float(args[2]),
                                          time.monotonic())
        except (TypeError, ValueError):
            pass

    def on_cluster(self, args) -> None:
        """/hive/cam/cluster: i index, i n, f x, f y, f r"""
        if len(args) < 4:
            return
        try:
            self._clusters[int(args[0])] = (float(args[1]), float(args[2]),
                                            float(args[3]), time.monotonic())
        except (TypeError, ValueError):
            pass

    def zone_of(self, x: float, y: float) -> int:
        x = min(max(x, 0.0), 0.999999)
        y = min(max(y, 0.0), 0.999999)
        if self.layout == "quadrants" and self.n == 4:
            return (1 if x >= 0.5 else 0) + (2 if y >= 0.5 else 0)
        return int(x * self.n)

    # -- output -------------------------------------------------------------

    def update(self) -> list:
        """Recompute the section gains. Cheap; called once per audio block."""
        now = time.monotonic()
        dt = max(now - self._last, 0.0)
        self._last = now

        counts = [0.0] * self.n
        people = {k: v for k, v in self._people.items() if now - v[2] < PERSON_TTL}
        self._people = people
        clusters = {k: v for k, v in self._clusters.items() if now - v[3] < CLUSTER_TTL}
        self._clusters = clusters
        if people:
            self.source = "people"
            for x, y, _ in people.values():
                counts[self.zone_of(x, y)] += 1.0
        elif clusters:
            self.source = "clusters"
            for n, x, y, _ in clusters.values():
                counts[self.zone_of(x, y)] += max(n, 1.0)
        else:
            self.source = "none"
        self.counts = counts

        on = self.values["on"] >= 0.5 and self.source != "none"
        if on:
            k = self.n
            total = sum(counts)
            floor = 10.0 ** (self.values["floor"] / 20.0)
            if total <= 0:
                raw = [1.0] * k          # the camera sees nobody: leave it be
            else:
                raw = [max(min(math.sqrt(c / total * k), MAX_GAIN), floor) if c > 0
                       else floor for c in counts]
            depth = self.values["depth"]
            targets = [1.0 - depth + depth * r for r in raw]
        else:
            # No camera, or switched off: the sections step aside entirely.
            targets = [1.0] * self.n
        self.targets = targets

        # Slew in dB, so a fade toward the floor sounds even rather than
        # rushing through the loud end and crawling at the quiet one.
        tau = max(self.values["slew"], 1e-3)
        a = 1.0 - math.exp(-dt / tau) if dt > 0 else 0.0
        out = []
        for g, t in zip(self.gains, targets):
            gd, td = 20 * math.log10(max(g, 1e-4)), 20 * math.log10(max(t, 1e-4))
            out.append(10.0 ** ((gd + (td - gd) * a) / 20.0))
        self.gains = out
        return out
