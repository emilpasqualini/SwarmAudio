"""A voice per phone: sine, roughness, pitch, level.

The alternative to a microphone as the thing the four models chew on. Each
client the backend reports gets one voice, its loudness driven by that client's
activity, so the raw material the models transform is itself made of the crowd
rather than of whatever the room happens to sound like.

Roughness
---------
"Rough" here is the psychoacoustic sense: amplitude modulation somewhere in the
15-300 Hz band, which the ear hears as grating rather than as tremolo or as a
separate pitch. Sensory roughness peaks around 70 Hz of modulation, so the knob
sweeps modulation rate from 20 to 70 Hz and depth from nothing to full:

    out = sin(carrier) * (1 - d + d * cos(modulator)),  d = roughness / 2

Written this way the envelope is exactly 1 when roughness is 0, so the voice
degenerates to a clean sine. Summing two detuned sines gives the same beating
and is the more obvious way to write it, but the two phases drift apart and
then cancel when the detune returns to zero, which silences the voice. This
form has no such state to get stuck in.

Everything ramps across the block. A phone's activity arrives at 60 Hz and a
block is 21 ms, so an un-ramped level would step several times a second and
every step is a click.
"""

from __future__ import annotations

import time

import numpy as np

from dsp import Param

MAX_VOICES = 16

# Scales as semitone offsets. Quantising is the difference between a bank of
# test tones and something that sounds intentional in a room.
SCALES = (
    ("free", None),
    ("chromatic", (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
    ("major", (0, 2, 4, 5, 7, 9, 11)),
    ("minor", (0, 2, 3, 5, 7, 8, 10)),
    ("pentatonic", (0, 3, 5, 7, 10)),
    ("whole tone", (0, 2, 4, 6, 8, 10)),
)

VOICE_PARAMS = (
    Param("pitch", "pitch", 40.0, 2000.0, 220.0, "Hz", "log"),
    Param("rough", "roughness", 0.0, 1.0, 0.0, ""),
    Param("level", "level", 0.0, 1.0, 0.0, ""),
)

# How the queen takes precedence. She is one client, named by uid on
# /hive/queen, and the point is that the room can hear which person she is
# without being told. Each mode is a different answer to "what does having the
# crown sound like".
QUEEN_MODES = (
    ("off", "No precedence. The queen is just another voice."),
    ("loudest", "Her voice is pushed up and everyone else is pulled down. "
                "The bluntest and the most legible from the back of a room."),
    ("duck", "Everyone else ducks only while she actually moves, so she "
             "carves a hole by moving rather than by existing."),
    ("solo", "Only her voice feeds the models. The rest of the crowd goes "
             "silent; the piece becomes a portrait of one person."),
    ("tuning", "Her pitch becomes the root note everyone else is quantised "
               "to. She decides what key the room is in without being louder."),
    ("harmony", "Everyone else snaps to an octave or a fifth of her pitch. "
                "The crowd becomes her chord."),
    ("drone", "She is held as a sustained pedal an octave down, never timing "
              "out. The crowd plays over a bass note that is a person."),
)


def queen_mode_names():
    return [name for name, _ in QUEEN_MODES]


SYNTH_PARAMS = (
    Param("level", "level", -40.0, 12.0, -6.0, "dB"),
    Param("glide", "glide", 0.0, 2.0, 0.08, "s", "log"),
    Param("scale", "scale", 0.0, len(SCALES) - 1.0, 4.0, ""),
    Param("root", "root note", 24.0, 72.0, 45.0, ""),
    Param("spread", "detune", 0.0, 50.0, 0.0, "cent"),
    Param("timeout", "voice timeout", 0.5, 30.0, 5.0, "s", "log"),
    Param("queen_mode", "queen mode", 0.0, len(QUEEN_MODES) - 1.0, 0.0, ""),
    Param("queen_amount", "queen amount", 0.0, 1.0, 0.7, ""),
)

# Intervals the crowd snaps to in "harmony" mode: octaves and a fifth, which
# stay consonant whatever she does.
HARMONY_RATIOS = (0.5, 1.0, 1.5, 2.0, 3.0)


def midi_to_hz(note: float) -> float:
    return 440.0 * 2.0 ** ((note - 69.0) / 12.0)


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * np.log2(max(hz, 1e-6) / 440.0)


def quantize(hz: float, root: float, scale) -> float:
    """Snap a frequency to the nearest note of a scale rooted at `root`."""
    if not scale:
        return hz
    note = hz_to_midi(hz)
    rel = note - root
    octave, within = divmod(rel, 12.0)
    best = min(scale, key=lambda s: abs(s - within))
    # The step above the octave is a candidate too, or everything near the top
    # of an octave snaps downward.
    alt = scale[0] + 12.0
    if abs(alt - within) < abs(best - within):
        best = alt
    return midi_to_hz(root + octave * 12.0 + best)


class Voice:
    """One client's tone."""

    __slots__ = ("index", "sr", "pitch", "rough", "level", "peak", "touched",
                 "uid", "name", "platform", "connected", "joined",
                 "queen_w", "_pitch", "_level", "_rough", "_ph", "_pm")

    def __init__(self, index: int, sr: int) -> None:
        self.index = index
        self.sr = sr
        self.pitch = 220.0
        self.rough = 0.0
        self.level = 0.0
        self.peak = 0.0
        self.touched = 0.0  # when OSC last wrote the level
        # Who this voice belongs to. Voice N is whoever holds slot N, and a
        # different uid arriving in that slot gets a fresh voice rather than
        # inheriting the last person's pitch and loudness.
        self.uid = ""
        self.name = ""
        self.platform = ""
        self.connected = False
        self.joined = 0.0
        # How much of this voice goes to the queen bus in split routing,
        # ramped so a change of crown crossfades instead of clicking.
        self.queen_w = 0.0
        self._pitch = 220.0
        self._level = 0.0
        self._rough = 0.0
        self._ph = 0.0
        self._pm = 0.0

    @property
    def slot(self) -> int:
        return self.index + 1

    def clear(self) -> None:
        """Forget the person, so the next one in this slot starts clean."""
        self.uid = self.name = self.platform = ""
        self.connected = False
        self.level = 0.0
        self.rough = 0.0
        self.touched = 0.0
        self.queen_w = 0.0
        self.reset()

    @property
    def active(self) -> bool:
        return self.level > 1e-4 or self._level > 1e-4

    def reset(self) -> None:
        self._level = 0.0
        self._ph = 0.0
        self._pm = 0.0
        self.peak = 0.0

    def render(self, n: int, root: float, scale, glide: float, detune: float,
               silent: bool, gain: float = 1.0,
               pitch_override: float = 0.0) -> np.ndarray:
        target_level = 0.0 if silent else float(self.level) * gain
        raw_pitch = pitch_override if pitch_override > 0.0 else float(self.pitch)
        target_pitch = quantize(raw_pitch, root, scale)
        if detune:
            target_pitch *= 2.0 ** ((detune * (self.index % 2 and 1 or -1)) / 1200.0)

        # Glide is a time constant, converted to how far we may move this block.
        if glide > 1e-4:
            k = min(1.0, (n / self.sr) / glide)
            pitch_end = self._pitch + (target_pitch - self._pitch) * k
        else:
            pitch_end = target_pitch

        f = np.linspace(self._pitch, pitch_end, n, dtype=np.float64)
        amp = np.linspace(self._level, target_level, n, dtype=np.float64)
        rough = np.linspace(self._rough, float(self.rough), n, dtype=np.float64)

        ph = self._ph + np.cumsum(2.0 * np.pi * f / self.sr)
        mod_f = 20.0 + 50.0 * rough
        pm = self._pm + np.cumsum(2.0 * np.pi * mod_f / self.sr)

        depth = rough * 0.5
        sig = np.sin(ph) * (1.0 - depth + depth * np.cos(pm)) * amp

        self._ph = float(ph[-1] % (2.0 * np.pi))
        self._pm = float(pm[-1] % (2.0 * np.pi))
        self._pitch = float(pitch_end)
        self._level = target_level
        self._rough = float(self.rough)
        self.peak = float(np.abs(sig).max()) if n else 0.0
        return sig.astype(np.float32)


class BusLeveller:
    """Slow automatic gain for one synth bus.

    In split routing one person's voice feeds one model and everyone else's
    feeds another. A single sine against a sum of seven would otherwise be
    about 17 dB quieter, and the game -- which model is the queen? -- would be
    decided by loudness instead of by listening. Both buses are pulled toward
    the same RMS over a second or two, and below a gate the gain holds, so a
    still queen is not boosted into audible noise.
    """

    def __init__(self, sr: int, target_db: float = -18.0, max_gain_db: float = 18.0,
                 min_gain_db: float = -12.0, time_s: float = 1.5,
                 gate_db: float = -55.0) -> None:
        self.sr = sr
        self.target_db = target_db
        self.max_gain_db = max_gain_db
        self.min_gain_db = min_gain_db
        self.time_s = time_s
        self.gate_db = gate_db
        self.gain_db = 0.0
        self.level_db = -120.0

    def reset(self) -> None:
        self.gain_db = 0.0

    def process(self, x: np.ndarray) -> np.ndarray:
        n = x.shape[-1]
        if n == 0:
            return x
        rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
        self.level_db = 20.0 * np.log10(max(rms, 1e-9))
        if self.level_db > self.gate_db:
            want = min(max(self.target_db - self.level_db, self.min_gain_db),
                       self.max_gain_db)
        else:
            want = self.gain_db
        k = 1.0 - np.exp(-(n / self.sr) / max(self.time_s, 1e-3))
        start = self.gain_db
        self.gain_db = start + (want - start) * k
        ramp = np.linspace(10.0 ** (start / 20.0), 10.0 ** (self.gain_db / 20.0), n,
                           dtype=np.float32)
        return (x * ramp).astype(np.float32, copy=False)


class Synth:
    """The bank of voices, one per connected client.

    Voice N belongs to whoever holds slot N on the backend. That is the only
    mapping the per-client OSC addresses allow (they are addressed by slot),
    so it is also the one that stays intuitive: client 3 on the dashboard is
    voice 3 here. Identity is still tracked by uid underneath, from /hive/join,
    /hive/leave and the once-a-second /hive/roster, so a slot handed to a new
    person gets a fresh voice, and the queen is found by uid rather than by a
    slot number that might have moved.
    """

    ROSTER_GRACE_S = 2.5  # how long a client may be missing from the roster

    def __init__(self, sr: int, n_ch: int, n_voices: int = MAX_VOICES) -> None:
        self.sr = sr
        self.n_ch = n_ch
        self.n_voices = max(1, min(int(n_voices), MAX_VOICES))
        self.voices = [Voice(i, sr) for i in range(self.n_voices)]
        self.values = {p.name: p.default for p in SYNTH_PARAMS}
        self.peak = 0.0
        self.queen_slot = 0
        self.queen_uid = ""
        self.clips = 0
        # Split routing: when on, level-changing queen modes are bypassed so the
        # two buses stay comparable; see BusLeveller.
        self.split = False
        self.roster_at = 0.0
        # Each voice's own signal from the last render, before any bus mixing:
        # voice index -> (signal, queen weight at block start, at block end).
        # The personal routing feeds these to one model per client.
        self.last_voice_sigs = {}

    def param(self, name: str) -> Param:
        for p in SYNTH_PARAMS:
            if p.name == name:
                return p
        raise KeyError(name)

    def get(self, name: str) -> float:
        return self.values[name]

    def set(self, name: str, value: float) -> None:
        p = self.param(name)
        self.values[name] = min(max(float(value), p.lo), p.hi)

    # -- who is here --------------------------------------------------------

    def _voice_for_slot(self, slot: int):
        i = int(slot) - 1
        return self.voices[i] if 0 <= i < self.n_voices else None

    def touch(self, index: int) -> None:
        """OSC just wrote to this voice. Data arriving is itself proof that a
        client holds the slot, so a voice lights up even before the roster
        names who it is."""
        if 0 <= index < self.n_voices:
            v = self.voices[index]
            v.touched = time.monotonic()
            if not v.connected:
                v.connected = True
                v.joined = v.touched

    def join(self, slot: int, uid: str = "", name: str = "", platform: str = "") -> None:
        v = self._voice_for_slot(slot)
        if v is None:
            return
        uid = uid or ""
        if uid and v.uid and v.uid != uid:
            # A different person took this slot: start them from silence.
            v.clear()
        now = time.monotonic()
        if not v.connected:
            v.joined = now
        v.connected = True
        if uid:
            v.uid = uid
        if name:
            v.name = name
        if platform:
            v.platform = platform
        v.touched = max(v.touched, now)

    def leave(self, slot: int, uid: str = "") -> None:
        v = self._voice_for_slot(slot)
        if v is None:
            return
        if uid and v.uid and v.uid != uid:
            return  # a stale leave for someone who already gave the slot up
        if self.queen_index == v.index and self.queen_floor() > 0.0:
            return  # the drone queen is meant to hang on
        v.connected = False
        v.level = 0.0

    def roster(self, entries) -> None:
        """Reconcile with the backend's full list of who is present."""
        now = time.monotonic()
        self.roster_at = now
        present = set()
        for slot, uid, name in entries:
            present.add(int(slot))
            self.join(int(slot), uid, name)
        for v in self.voices:
            if v.connected and v.slot not in present and v.uid:
                # Named by an earlier roster and missing from this one.
                if now - v.touched > self.ROSTER_GRACE_S:
                    self.leave(v.slot, v.uid)

    def connected(self):
        return [v for v in self.voices if v.connected or v._level > 1e-4]

    def connected_count(self) -> int:
        return sum(1 for v in self.voices if v.connected)

    def scale(self):
        idx = int(round(self.values["scale"]))
        return SCALES[min(max(idx, 0), len(SCALES) - 1)][1]

    def scale_name(self) -> str:
        idx = int(round(self.values["scale"]))
        return SCALES[min(max(idx, 0), len(SCALES) - 1)][0]

    def set_scale_by_name(self, name: str) -> None:
        for i, (n, _) in enumerate(SCALES):
            if n == name:
                self.set("scale", float(i))
                return
        raise KeyError(name)

    # -- the queen ----------------------------------------------------------

    def set_queen(self, uid: str, slot: int) -> None:
        """Called when /hive/queen says the crown has moved."""
        self.queen_uid = uid or ""
        self.queen_slot = int(slot or 0)
        # Only name an anonymous voice after her if nobody already carries her
        # uid; otherwise a slot number that has gone stale would give two
        # voices the same identity and the wrong one could wear the crown.
        if self.queen_uid and self.queen_slot and not any(
                v.uid == self.queen_uid for v in self.voices):
            v = self._voice_for_slot(self.queen_slot)
            if v is not None and not v.uid:
                v.uid = self.queen_uid

    @property
    def queen_index(self) -> int:
        """Voice index of the queen, or -1. Found by uid first, because a slot
        number can be reassigned between one /hive/queen and the next."""
        if self.queen_uid:
            for v in self.voices:
                if v.uid == self.queen_uid:
                    return v.index
        i = self.queen_slot - 1
        return i if 0 <= i < self.n_voices else -1

    def queen_mode_name(self) -> str:
        idx = int(round(self.values["queen_mode"]))
        return QUEEN_MODES[min(max(idx, 0), len(QUEEN_MODES) - 1)][0]

    def set_queen_mode_by_name(self, name: str) -> None:
        for i, (n, _) in enumerate(QUEEN_MODES):
            if n == name:
                self.set("queen_mode", float(i))
                return
        raise KeyError(name)

    def _queen_plan(self):
        """Work out, for this block, each voice's extra gain and any pitch the
        queen is imposing on it.

        Returns (gains, pitches, root_override, immortal), where `immortal` is
        the voice that must not time out. In split routing the modes that
        change loudness are bypassed: there the queen is meant to be found by
        timbre, and a louder queen would give the answer away.
        """
        n = self.n_voices
        gains = [1.0] * n
        pitches = [0.0] * n
        root_override = None
        immortal = -1

        qi = self.queen_index
        mode = self.queen_mode_name()
        amount = float(self.values["queen_amount"])
        if qi < 0 or mode == "off" or amount <= 1e-4:
            return gains, pitches, root_override, immortal

        queen = self.voices[qi]
        loud_modes = ("loudest", "duck", "solo")
        if self.split and mode in loud_modes:
            return gains, pitches, root_override, immortal

        if mode == "loudest":
            # She stands out mostly by everyone else dropping, because boosting
            # her past unity only eats headroom: at full amount the gap is
            # already about 23 dB.
            gains[qi] = 1.0 + 0.35 * amount
            for i in range(n):
                if i != qi:
                    gains[i] = 1.0 - 0.9 * amount
        elif mode == "duck":
            duck = 1.0 - 0.9 * amount * min(max(queen.level, 0.0), 1.0)
            for i in range(n):
                if i != qi:
                    gains[i] = duck
        elif mode == "solo":
            for i in range(n):
                if i != qi:
                    gains[i] = 1.0 - amount
        elif mode == "tuning":
            root_override = hz_to_midi(max(queen.pitch, 20.0)) % 12.0 + 36.0
        elif mode == "harmony":
            base = max(queen.pitch, 20.0)
            for i in range(n):
                if i == qi:
                    continue
                want = base * HARMONY_RATIOS[i % len(HARMONY_RATIOS)]
                pitches[i] = float(
                    self.voices[i].pitch * (want / max(self.voices[i].pitch, 1e-6))
                    ** amount)
        elif mode == "drone":
            pitches[qi] = max(queen.pitch, 20.0) * 0.5
            if not self.split:
                gains[qi] = 1.0 + 0.25 * amount
            immortal = qi
        return gains, pitches, root_override, immortal

    def queen_floor(self) -> float:
        """The level the queen is held at in drone mode."""
        if self.queen_mode_name() != "drone" or self.queen_index < 0:
            return 0.0
        return 0.2 + 0.35 * float(self.values["queen_amount"])

    def reset(self) -> None:
        for v in self.voices:
            v.reset()
        self.peak = 0.0

    def active_count(self) -> int:
        return sum(1 for v in self.voices if v.active)

    # -- rendering ----------------------------------------------------------

    def render_buses(self, n: int):
        """One block as three mono buses: everyone, the queen, everyone else.

        Each voice is rendered once and split between the queen and crowd buses
        by a weight that ramps over a third of a second, so when the crown
        moves the old queen's voice slides into the crowd and the new one's
        slides out, instead of jumping.
        """
        scale = self.scale()
        glide = self.values["glide"]
        detune = self.values["spread"]
        timeout = self.values["timeout"]
        now = time.monotonic()

        gains, pitches, root_override, immortal = self._queen_plan()
        root = root_override if root_override is not None else self.values["root"]
        floor = self.queen_floor()
        if floor > 0.0 and immortal >= 0:
            self.voices[immortal].level = max(self.voices[immortal].level, floor)

        qi = self.queen_index
        swing = min(1.0, (n / self.sr) / 0.33)

        full = np.zeros(n, dtype=np.float32)
        queen = np.zeros(n, dtype=np.float32)
        crowd = np.zeros(n, dtype=np.float32)
        audible, crowd_audible = 0, 0
        voice_sigs = {}
        for i, v in enumerate(self.voices):
            stale = (v.touched > 0.0 and (now - v.touched) > timeout
                     and i != immortal)
            if stale and v.connected and self.roster_at <= 0.0:
                # No roster to consult, so silence for `timeout` is the only
                # evidence the phone has gone.
                v.connected = False
            target_w = 1.0 if i == qi else 0.0
            w0 = v.queen_w
            v.queen_w = w0 + max(-swing, min(swing, target_w - w0))
            if not v.active and (v.level <= 1e-4 or stale):
                v.peak = 0.0
                if v._level <= 1e-4:
                    if not v.connected and v.uid and v._level <= 1e-4:
                        v.clear()
                    continue
            sig = v.render(n, root, scale, glide, detune, silent=stale or not v.connected,
                           gain=gains[i], pitch_override=pitches[i])
            voice_sigs[i] = (sig, w0, v.queen_w)
            full += sig
            if w0 == 0.0 and v.queen_w == 0.0:
                crowd += sig
                crowd_audible += 1
            elif w0 == 1.0 and v.queen_w == 1.0:
                queen += sig
            else:
                w = np.linspace(w0, v.queen_w, n, dtype=np.float32)
                queen += sig * w
                crowd += sig * (1.0 - w)
                crowd_audible += 1
            audible += 1

        g = 10.0 ** (self.values["level"] / 20.0)
        full *= g / max(1.0, np.sqrt(max(audible, 1)))
        crowd *= g / max(1.0, np.sqrt(max(crowd_audible, 1)))
        queen *= g

        self.peak = float(np.abs(full).max()) if n else 0.0
        for bus in (full, queen, crowd):
            if n and float(np.abs(bus).max()) > 1.0:
                self.clips += 1
                np.clip(bus, -1.0, 1.0, out=bus)
        self.peak = min(self.peak, 1.0)
        self.last_voice_sigs = voice_sigs
        return full, queen, crowd

    def render(self, n: int) -> np.ndarray:
        """One block of the whole bank, shaped (channels, samples)."""
        full, _, _ = self.render_buses(n)
        return np.repeat(full[None, :], self.n_ch, axis=0)
