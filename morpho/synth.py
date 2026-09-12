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
                 "_pitch", "_level", "_rough", "_ph", "_pm")

    def __init__(self, index: int, sr: int) -> None:
        self.index = index
        self.sr = sr
        self.pitch = 220.0
        self.rough = 0.0
        self.level = 0.0
        self.peak = 0.0
        self.touched = 0.0  # when OSC last wrote the level
        self._pitch = 220.0
        self._level = 0.0
        self._rough = 0.0
        self._ph = 0.0
        self._pm = 0.0

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


class Synth:
    """The bank of voices, one per client."""

    def __init__(self, sr: int, n_ch: int, n_voices: int = 8) -> None:
        self.sr = sr
        self.n_ch = n_ch
        self.n_voices = max(1, min(int(n_voices), MAX_VOICES))
        self.voices = [Voice(i, sr) for i in range(self.n_voices)]
        self.values = {p.name: p.default for p in SYNTH_PARAMS}
        self.peak = 0.0
        # Who wears the crown. Slot numbers are 1-based on the wire; -1 is
        # nobody. The uid is kept only so the GUI can show which person it is.
        self.queen_slot = 0
        self.queen_uid = ""
        self.clips = 0

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

    def touch(self, index: int) -> None:
        """Note that OSC just wrote to this voice, for the idle timeout."""
        if 0 <= index < self.n_voices:
            self.voices[index].touched = time.monotonic()

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

    @property
    def queen_index(self) -> int:
        """Voice index of the queen, or -1 when there is no queen or her slot
        is past the end of the bank."""
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
        the voice that must not time out. Doing it once per block rather than
        per voice keeps the rules in one readable place.
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
        if mode == "loudest":
            # She stands out mostly by everyone else dropping, because boosting
            # her past unity only eats headroom: at full amount the gap is
            # already about 26 dB.
            gains[qi] = 1.0 + 0.35 * amount
            for i in range(n):
                if i != qi:
                    gains[i] = 1.0 - 0.9 * amount
        elif mode == "duck":
            # The hole only opens while she is actually moving.
            duck = 1.0 - 0.9 * amount * min(max(queen.level, 0.0), 1.0)
            for i in range(n):
                if i != qi:
                    gains[i] = duck
        elif mode == "solo":
            for i in range(n):
                if i != qi:
                    gains[i] = 1.0 - amount
        elif mode == "tuning":
            # She sets the key without getting louder.
            root_override = hz_to_midi(max(queen.pitch, 20.0)) % 12.0 + 36.0
        elif mode == "harmony":
            base = max(queen.pitch, 20.0)
            for i in range(n):
                if i == qi:
                    continue
                ratio = HARMONY_RATIOS[i % len(HARMONY_RATIOS)]
                want = base * ratio
                # At amount 1 the crowd is entirely her chord; below that they
                # are pulled toward it in cents rather than snapped.
                pitches[i] = float(
                    self.voices[i].pitch * (want / max(self.voices[i].pitch, 1e-6))
                    ** amount)
        elif mode == "drone":
            pitches[qi] = max(queen.pitch, 20.0) * 0.5
            gains[qi] = 1.0 + 0.25 * amount
            immortal = qi
        return gains, pitches, root_override, immortal

    def queen_floor(self) -> float:
        """The level the queen is held at in drone mode, so she never drops
        out even when the person holding the crown stands still."""
        if self.queen_mode_name() != "drone" or self.queen_index < 0:
            return 0.0
        return 0.2 + 0.35 * float(self.values["queen_amount"])

    def reset(self) -> None:
        for v in self.voices:
            v.reset()
        self.peak = 0.0

    def active_count(self) -> int:
        return sum(1 for v in self.voices if v.active)

    def render(self, n: int) -> np.ndarray:
        """One block of the whole bank, shaped (channels, samples)."""
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

        mono = np.zeros(n, dtype=np.float32)
        for i, v in enumerate(self.voices):
            # A client that left stops sending, so its last activity would
            # otherwise stick and leave the voice droning forever. The drone
            # queen is the deliberate exception.
            stale = (v.touched > 0.0 and (now - v.touched) > timeout
                     and i != immortal)
            if not v.active and (v.level <= 1e-4 or stale):
                v.peak = 0.0
                if v._level <= 1e-4:
                    continue
            mono += v.render(n, root, scale, glide, detune, silent=stale,
                             gain=gains[i], pitch_override=pitches[i])

        # Voices sum, so keep the bank at a sane level however many arrive.
        gain = 10.0 ** (self.values["level"] / 20.0)
        mono *= gain / max(1.0, np.sqrt(max(self.active_count(), 1)))
        # A backstop, not the working mechanism: the queen rules and a loud
        # bank can together ask for more than full scale, and this feeds a
        # compressor that would rather not be handed something out of range.
        self.peak = float(np.abs(mono).max()) if n else 0.0
        if self.peak > 1.0:
            self.clips += 1
            np.clip(mono, -1.0, 1.0, out=mono)
            self.peak = 1.0
        return np.repeat(mono[None, :], self.n_ch, axis=0)
