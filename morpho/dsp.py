"""Pre- and post-conditioning around the neural models.

Why this file exists
--------------------
`CLAUDE.md` section 7 makes the point directly: much of Morpho's perceived
advantage over a bare model is its non-neural wrapper, not the network. The
plugin puts a pitch shifter, a feedback delay, a compressor and a filter in
front of the model, and a noise gate, a limiter and a filter behind it. Feeding
a model raw, uncompressed, unfiltered audio is the single most common reason a
RAVE checkpoint sounds thin and noisy in a hand-rolled host. This module is that
wrapper.

Chain, matching the plugin:

    in -> pitch shift -> feedback delay -> compressor -> filter -> MODEL
       -> noise gate -> limiter -> filter -> reverb -> dry/wet -> out

Everything works on float32 blocks shaped (channels, samples) and keeps its own
state between blocks, so a block boundary is inaudible.

On doing this in Python
-----------------------
Recursive filters cannot be vectorised, and a per-sample Python loop at 48 kHz
is far too slow. Two techniques carry the whole file:

- Linear recursions (biquads) go through `scipy.signal.lfilter` with carried
  state, which runs the recursion in C.
- Non-linear ones (every dynamics processor: the gain depends on the signal)
  run their detector at chunk rate, 32 samples per step. That is 16 Python
  iterations per block instead of 512, and 0.67 ms of resolution, which is
  finer than any attack time worth setting. The resulting chunk gains are
  interpolated back up to sample rate.

Delay-line effects (delay, reverb combs) are written so that a whole block is
one numpy slice assignment whenever the delay is longer than the block, which
it nearly always is.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import lfilter

CHUNK = 32  # dynamics detector step, in samples


# ---------------------------------------------------------------------------
# parameter description
# ---------------------------------------------------------------------------


class Param:
    """One knob: natural units, plus how to show it.

    `curve` is how a 0..1 control position maps onto the range. Frequencies and
    times need "log" or the useful part of the range is squeezed into the last
    millimetre of the fader.
    """

    __slots__ = ("name", "label", "lo", "hi", "default", "unit", "curve")

    def __init__(self, name, label, lo, hi, default, unit="", curve="lin"):
        self.name = name
        self.label = label
        self.lo = float(lo)
        self.hi = float(hi)
        self.default = float(default)
        self.unit = unit
        self.curve = curve

    def to_norm(self, value: float) -> float:
        value = min(max(float(value), self.lo), self.hi)
        if self.curve == "log":
            lo, hi = max(self.lo, 1e-6), max(self.hi, 1e-6)
            return float(np.log(max(value, 1e-6) / lo) / np.log(hi / lo))
        return (value - self.lo) / (self.hi - self.lo) if self.hi > self.lo else 0.0

    def from_norm(self, pos: float) -> float:
        pos = min(max(float(pos), 0.0), 1.0)
        if self.curve == "log":
            lo, hi = max(self.lo, 1e-6), max(self.hi, 1e-6)
            return float(lo * (hi / lo) ** pos)
        return self.lo + pos * (self.hi - self.lo)

    def format(self, value: float) -> str:
        if self.unit == "Hz" and value >= 1000:
            return f"{value / 1000:.2f} kHz"
        digits = 0 if abs(value) >= 100 else (1 if abs(value) >= 10 else 2)
        return f"{value:.{digits}f}{' ' + self.unit if self.unit else ''}"


class Effect:
    """Base class: a named block of parameters with bypass and state."""

    name = "effect"
    params: tuple = ()

    def __init__(self, sr: int, n_ch: int) -> None:
        self.sr = sr
        self.n_ch = n_ch
        self.enabled = False
        self.values = {p.name: p.default for p in self.params}
        self._dirty = True
        self.reset()

    def param(self, name: str) -> Param:
        for p in self.params:
            if p.name == name:
                return p
        raise KeyError(name)

    def set(self, name: str, value: float) -> None:
        p = self.param(name)
        self.values[name] = min(max(float(value), p.lo), p.hi)
        self._dirty = True

    def get(self, name: str) -> float:
        return self.values[name]

    def reset(self) -> None:
        pass

    def process(self, x: np.ndarray) -> np.ndarray:
        return x


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _biquad_lowpass(sr, f0, q):
    w0 = 2.0 * np.pi * min(f0, sr * 0.49) / sr
    alpha = np.sin(w0) / (2.0 * q)
    c = np.cos(w0)
    b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2])
    a = np.array([1 + alpha, -2 * c, 1 - alpha])
    return b / a[0], a / a[0]


def _biquad_highpass(sr, f0, q):
    w0 = 2.0 * np.pi * min(f0, sr * 0.49) / sr
    alpha = np.sin(w0) / (2.0 * q)
    c = np.cos(w0)
    b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2])
    a = np.array([1 + alpha, -2 * c, 1 - alpha])
    return b / a[0], a / a[0]


def _chunk_peaks(x: np.ndarray) -> np.ndarray:
    """Peak magnitude of each CHUNK-sample step, across all channels."""
    n = x.shape[1]
    n_chunks = (n + CHUNK - 1) // CHUNK
    pad = n_chunks * CHUNK - n
    mag = np.abs(x).max(axis=0)
    if pad:
        mag = np.concatenate((mag, np.zeros(pad, dtype=mag.dtype)))
    return mag.reshape(n_chunks, CHUNK).max(axis=1)


def _expand(chunk_gains: np.ndarray, n: int, prev: float) -> np.ndarray:
    """Chunk-rate gains back up to sample rate, linearly between chunk centres.

    Interpolating rather than stepping is what keeps a fast gain change from
    clicking; the centres are half a chunk in so the ramp straddles the step.

    `prev` is the gain as it stood at the end of the previous block, anchored
    half a chunk before this one starts. Without it the ramp restarts at every
    block boundary, which puts a step in the gain at the block rate -- a faint
    buzz at 94 Hz for 512-sample blocks, and the reason this takes an argument
    instead of just interpolating what it was given.
    """
    centres = np.arange(chunk_gains.shape[0], dtype=np.float32) * CHUNK + CHUNK * 0.5
    centres = np.concatenate(([-CHUNK * 0.5], centres))
    gains = np.concatenate(([prev], chunk_gains)).astype(np.float32)
    return np.interp(np.arange(n, dtype=np.float32), centres, gains).astype(np.float32)


def _coef(time_ms: float, sr: int) -> float:
    """One-pole coefficient for a time constant, at chunk rate."""
    t = max(time_ms, 0.01) * 0.001 * sr / CHUNK
    return float(np.exp(-1.0 / max(t, 1e-6)))


def db_to_lin(db):
    return 10.0 ** (np.asarray(db, dtype=np.float64) / 20.0)


def lin_to_db(x):
    return 20.0 * np.log10(np.maximum(np.asarray(x, dtype=np.float64), 1e-9))


# ---------------------------------------------------------------------------
# filter: a high-pass / low-pass pair, the plugin's filter display
# ---------------------------------------------------------------------------


class FilterSection(Effect):
    name = "filter"
    params = (
        Param("hp", "low cut", 20.0, 2000.0, 20.0, "Hz", "log"),
        Param("lp", "high cut", 500.0, 20000.0, 20000.0, "Hz", "log"),
        Param("q", "resonance", 0.5, 4.0, 0.707, ""),
    )

    def reset(self) -> None:
        self._zi_hp = None
        self._zi_lp = None

    def _update(self):
        self._b_hp, self._a_hp = _biquad_highpass(
            self.sr, self.values["hp"], self.values["q"]
        )
        self._b_lp, self._a_lp = _biquad_lowpass(
            self.sr, self.values["lp"], self.values["q"]
        )
        self._dirty = False

    def process(self, x):
        if not self.enabled:
            return x
        if self._dirty:
            self._update()
        # A high cut at the top of the range and a low cut at the bottom are
        # both no-ops; skipping them keeps the common case free.
        if self.values["hp"] > 20.5:
            if self._zi_hp is None or self._zi_hp.shape[0] != x.shape[0]:
                self._zi_hp = np.zeros((x.shape[0], 2))
            x, self._zi_hp = lfilter(self._b_hp, self._a_hp, x, axis=-1, zi=self._zi_hp)
        if self.values["lp"] < 19000.0:
            if self._zi_lp is None or self._zi_lp.shape[0] != x.shape[0]:
                self._zi_lp = np.zeros((x.shape[0], 2))
            x, self._zi_lp = lfilter(self._b_lp, self._a_lp, x, axis=-1, zi=self._zi_lp)
        return x.astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# dynamics
# ---------------------------------------------------------------------------


class Compressor(Effect):
    """Feed-forward compressor with a soft knee and make-up gain.

    Gain-staging the input is the part of the wrapper that matters most to a
    model: RAVE encoders were trained on level-consistent material and a quiet
    or wildly dynamic input decodes to mush.
    """

    name = "compressor"
    params = (
        Param("threshold", "threshold", -48.0, 0.0, -18.0, "dB"),
        Param("ratio", "ratio", 1.0, 20.0, 4.0, ":1"),
        Param("attack", "attack", 0.5, 200.0, 10.0, "ms", "log"),
        Param("release", "release", 10.0, 2000.0, 150.0, "ms", "log"),
        Param("knee", "knee", 0.0, 24.0, 6.0, "dB"),
        Param("gain", "make-up", -12.0, 24.0, 0.0, "dB"),
    )

    def reset(self) -> None:
        self._g = 1.0
        self.reduction_db = 0.0

    def process(self, x):
        if not self.enabled:
            self.reduction_db = 0.0
            return x
        v = self.values
        peaks = _chunk_peaks(x)
        level = lin_to_db(peaks)

        thr, ratio, knee = v["threshold"], v["ratio"], v["knee"]
        over = level - thr
        # Soft knee: quadratic blend across the knee width, hard above it.
        target_db = np.where(
            over <= -knee / 2,
            0.0,
            np.where(
                over >= knee / 2,
                over * (1.0 / ratio - 1.0),
                (1.0 / ratio - 1.0) * (over + knee / 2) ** 2 / (2.0 * max(knee, 1e-9)),
            ),
        )
        target = db_to_lin(target_db)

        a = _coef(v["attack"], self.sr)
        r = _coef(v["release"], self.sr)
        g = prev = self._g
        out = np.empty_like(target)
        for i, t in enumerate(target):
            # Attack when the gain must come down, release when it comes back.
            c = a if t < g else r
            g = c * g + (1.0 - c) * t
            out[i] = g
        self._g = g
        self.reduction_db = float(lin_to_db(g))

        y = x * _expand(out, x.shape[1], prev)
        return (y * db_to_lin(v["gain"])).astype(np.float32, copy=False)


class NoiseGate(Effect):
    """Gate on the model's output.

    Neural decoders idle noisily: with no input, RAVE still decodes its prior
    into a faint wash. On a PA with four of them running that floor adds up,
    so the gate is what makes silence actually silent.
    """

    name = "gate"
    params = (
        Param("threshold", "threshold", -90.0, 0.0, -60.0, "dB"),
        Param("attack", "attack", 0.1, 100.0, 2.0, "ms", "log"),
        Param("release", "release", 5.0, 2000.0, 120.0, "ms", "log"),
        Param("range", "range", -90.0, 0.0, -60.0, "dB"),
    )

    def reset(self) -> None:
        self._g = 1.0
        self.reduction_db = 0.0

    def process(self, x):
        if not self.enabled:
            self.reduction_db = 0.0
            return x
        v = self.values
        level = lin_to_db(_chunk_peaks(x))
        floor = db_to_lin(v["range"])
        target = np.where(level >= v["threshold"], 1.0, floor)

        a = _coef(v["attack"], self.sr)
        r = _coef(v["release"], self.sr)
        g = prev = self._g
        out = np.empty_like(target)
        for i, t in enumerate(target):
            c = a if t > g else r  # opening is the attack, closing the release
            g = c * g + (1.0 - c) * t
            out[i] = g
        self._g = g
        self.reduction_db = float(lin_to_db(g))
        return (x * _expand(out, x.shape[1], prev)).astype(np.float32, copy=False)


class Limiter(Effect):
    """Peak limiter with instant attack.

    The gain for a chunk is computed from that chunk's own peak and applied
    across it, so a peak can never get out ahead of the gain reduction and
    there is no lookahead delay to compensate. The final clip is a backstop for
    the interpolation ramp, not the working mechanism.
    """

    name = "limiter"
    params = (
        Param("ceiling", "ceiling", -24.0, 0.0, -1.0, "dB"),
        Param("release", "release", 10.0, 1000.0, 80.0, "ms", "log"),
    )

    def reset(self) -> None:
        self._g = 1.0
        self.reduction_db = 0.0

    def process(self, x):
        if not self.enabled:
            self.reduction_db = 0.0
            return x
        v = self.values
        ceiling = db_to_lin(v["ceiling"])
        peaks = np.maximum(_chunk_peaks(x), 1e-9)
        target = np.minimum(1.0, ceiling / peaks)

        r = _coef(v["release"], self.sr)
        g = prev = self._g
        out = np.empty_like(target)
        for i, t in enumerate(target):
            g = t if t < g else r * g + (1.0 - r) * t  # instant attack
            out[i] = g
        self._g = g
        self.reduction_db = float(lin_to_db(g))

        # The ramp from the previous block's gain can sit above the target for
        # the first half chunk, so the clip below is what actually guarantees
        # the ceiling.
        y = x * _expand(out, x.shape[1], prev)
        np.clip(y, -ceiling, ceiling, out=y)
        return y.astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# delay-line effects
# ---------------------------------------------------------------------------


class PitchShifter(Effect):
    """Two-tap crossfading delay-line shifter.

    Two read pointers drift through a window at the rate that produces the
    interval, half a window apart, mixed with a constant-power crossfade so
    that whichever tap is about to wrap is silent when it does. It is the
    classic cheap shifter: no transform, no added latency, and the artefacts
    are a mild warble rather than the smearing a phase vocoder gives.
    """

    name = "pitch"
    params = (
        Param("semitones", "pitch", -24.0, 24.0, 0.0, "st"),
        Param("mix", "mix", 0.0, 1.0, 1.0, ""),
        Param("window", "grain", 20.0, 120.0, 45.0, "ms", "log"),
    )

    def reset(self) -> None:
        self._buf = None
        self._w = 0
        self._phase = 0.0

    def process(self, x):
        if not self.enabled or (
            abs(self.values["semitones"]) < 1e-3 and self.values["mix"] >= 0.999
        ):
            if not self.enabled:
                return x
        n_ch, n = x.shape
        window = max(int(self.values["window"] * 0.001 * self.sr), 64)
        size = 1 << int(np.ceil(np.log2(window + n + 2)))
        if self._buf is None or self._buf.shape != (n_ch, size):
            self._buf = np.zeros((n_ch, size), dtype=np.float32)
            self._w = 0

        buf, w = self._buf, self._w
        idx = (w + np.arange(n)) % size
        buf[:, idx] = x

        ratio = 2.0 ** (self.values["semitones"] / 12.0)
        # Delay shrinks at (ratio - 1) samples per sample; as a fraction of the
        # window that is the phase increment.
        dp = -(ratio - 1.0) / window
        j = np.arange(n, dtype=np.float64)
        p1 = (self._phase + dp * j) % 1.0
        p2 = (p1 + 0.5) % 1.0
        self._phase = float((self._phase + dp * n) % 1.0)

        out = np.zeros_like(x)
        for phase, gain in ((p1, np.sin(np.pi * p1)), (p2, np.sin(np.pi * p2))):
            read = (w + j - phase * window) % size
            i0 = np.floor(read).astype(np.int64)
            frac = (read - i0).astype(np.float32)
            i1 = (i0 + 1) % size
            i0 %= size
            out += (buf[:, i0] * (1.0 - frac) + buf[:, i1] * frac) * gain.astype(
                np.float32
            )

        self._w = (w + n) % size
        mix = self.values["mix"]
        return (mix * out + (1.0 - mix) * x).astype(np.float32, copy=False)


class FeedbackDelay(Effect):
    name = "delay"
    params = (
        Param("time", "time", 10.0, 2000.0, 300.0, "ms", "log"),
        Param("feedback", "feedback", 0.0, 0.95, 0.35, ""),
        Param("mix", "mix", 0.0, 1.0, 0.25, ""),
        Param("damp", "damping", 500.0, 20000.0, 6000.0, "Hz", "log"),
    )

    def reset(self) -> None:
        self._buf = None
        self._w = 0
        self._damp_state = None

    def process(self, x):
        if not self.enabled:
            return x
        n_ch, n = x.shape
        delay = max(int(self.values["time"] * 0.001 * self.sr), 1)
        # Read and write share an index, so the delay IS the buffer length.
        # Any slack added here would be heard as extra delay time.
        size = delay
        if self._buf is None or self._buf.shape != (n_ch, size):
            self._buf = np.zeros((n_ch, size), dtype=np.float32)
            self._w = 0
            self._damp_state = np.zeros((n_ch, 1), dtype=np.float32)

        buf, w = self._buf, self._w
        fb = self.values["feedback"]
        # One-pole damping in the feedback path, so repeats darken instead of
        # ringing forever at the same brightness.
        a = float(np.exp(-2.0 * np.pi * self.values["damp"] / self.sr))

        out = np.empty_like(x)
        done = 0
        while done < n:
            # A step never crosses the write pointer, so the recursion is
            # between steps and each step is one vector operation.
            step = min(n - done, delay)
            r = (w + np.arange(step)) % size
            echo = buf[:, r].copy()
            if a > 1e-4:
                for c in range(n_ch):
                    echo[c], self._damp_state[c] = lfilter(
                        [1.0 - a], [1.0, -a], echo[c], zi=self._damp_state[c]
                    )
            buf[:, r] = x[:, done : done + step] + echo * fb
            out[:, done : done + step] = echo
            w = (w + step) % size
            done += step

        self._w = w
        mix = self.values["mix"]
        return (x + mix * out).astype(np.float32, copy=False)


class Reverb(Effect):
    """Freeverb: eight parallel damped combs into four series allpasses.

    Schroeder/Moorer topology with Jezar's tunings. Every comb delay is longer
    than an audio block, so a block is a single slice read, a multiply and a
    slice write.
    """

    name = "reverb"
    params = (
        Param("mix", "mix", 0.0, 1.0, 0.25, ""),
        Param("size", "size", 0.0, 1.0, 0.6, ""),
        Param("damp", "damping", 0.0, 1.0, 0.5, ""),
        Param("width", "width", 0.0, 1.0, 1.0, ""),
        Param("predelay", "pre-delay", 0.0, 200.0, 10.0, "ms"),
    )

    COMBS = (1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)
    ALLPASS = (556, 441, 341, 225)
    STEREO_SPREAD = 23

    def reset(self) -> None:
        self._built = None

    def _build(self, n_ch):
        scale = self.sr / 44100.0  # Jezar's tunings are in 44.1 kHz samples
        self._comb_buf, self._comb_i, self._comb_lp = [], [], []
        self._ap_buf, self._ap_i = [], []
        for c in range(n_ch):
            spread = self.STEREO_SPREAD if c else 0
            self._comb_buf.append(
                [np.zeros(int((d + spread) * scale), dtype=np.float32) for d in self.COMBS]
            )
            self._comb_i.append([0] * len(self.COMBS))
            self._comb_lp.append([0.0] * len(self.COMBS))
            self._ap_buf.append(
                [np.zeros(int((d + spread) * scale), dtype=np.float32) for d in self.ALLPASS]
            )
            self._ap_i.append([0] * len(self.ALLPASS))
        self._pre = np.zeros((n_ch, int(0.2 * self.sr) + 1), dtype=np.float32)
        self._pre_w = 0
        self._built = n_ch

    def process(self, x):
        if not self.enabled:
            return x
        n_ch, n = x.shape
        if self._built != n_ch:
            self._build(n_ch)

        v = self.values
        # Pre-delay, read before write so a zero pre-delay is a pass-through.
        pd = int(v["predelay"] * 0.001 * self.sr)
        if pd > 0:
            size = self._pre.shape[1]
            wr = (self._pre_w + np.arange(n)) % size
            rd = (self._pre_w - pd + np.arange(n)) % size
            self._pre[:, wr] = x
            src = self._pre[:, rd].copy()
            self._pre_w = (self._pre_w + n) % size
        else:
            src = x

        feedback = 0.7 + 0.28 * v["size"]
        damp = v["damp"] * 0.4
        wet = np.zeros_like(src)

        for c in range(n_ch):
            acc = np.zeros(n, dtype=np.float32)
            mono = src[c] * 0.015  # Freeverb's fixed input gain
            for k, buf in enumerate(self._comb_buf[c]):
                L = buf.shape[0]
                i = self._comb_i[c][k]
                lp = self._comb_lp[c][k]
                done = 0
                while done < n:
                    step = min(n - done, L)
                    r = (i + np.arange(step)) % L
                    out = buf[r].copy()
                    # One-pole damping inside the comb loop.
                    if damp > 1e-6:
                        out_f, lp_arr = lfilter(
                            [1.0 - damp], [1.0, -damp], out, zi=np.array([lp])
                        )
                        out = out_f.astype(np.float32)
                        lp = float(lp_arr[0])
                    buf[r] = mono[done : done + step] + out * feedback
                    acc[done : done + step] += out
                    i = (i + step) % L
                    done += step
                self._comb_i[c][k] = i
                self._comb_lp[c][k] = lp

            for k, buf in enumerate(self._ap_buf[c]):
                L = buf.shape[0]
                i = self._ap_i[c][k]
                done = 0
                while done < n:
                    step = min(n - done, L)
                    r = (i + np.arange(step)) % L
                    delayed = buf[r].copy()
                    seg = acc[done : done + step]
                    buf[r] = seg + delayed * 0.5
                    acc[done : done + step] = delayed - seg
                    i = (i + step) % L
                    done += step
                self._ap_i[c][k] = i
            wet[c] = acc

        if n_ch == 2:
            w = v["width"]
            left = wet[0] * (0.5 + 0.5 * w) + wet[1] * (0.5 - 0.5 * w)
            right = wet[1] * (0.5 + 0.5 * w) + wet[0] * (0.5 - 0.5 * w)
            wet = np.stack((left, right))

        mix = v["mix"]
        return (x * (1.0 - mix) + wet * mix).astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# the chains
# ---------------------------------------------------------------------------


class PreChain:
    """What the plugin puts in front of the model."""

    def __init__(self, sr: int, n_ch: int) -> None:
        self.pitch = PitchShifter(sr, n_ch)
        self.delay = FeedbackDelay(sr, n_ch)
        self.comp = Compressor(sr, n_ch)
        self.filter = FilterSection(sr, n_ch)
        # The compressor is the one that earns its keep on every source, so it
        # is the only part of the chain that starts switched on.
        self.comp.enabled = True
        self.effects = (self.pitch, self.delay, self.comp, self.filter)

    def reset(self):
        for e in self.effects:
            e.reset()

    def process(self, x):
        for e in self.effects:
            x = e.process(x)
        return x


class PostChain:
    """What the plugin puts behind the model, plus the reverb."""

    def __init__(self, sr: int, n_ch: int) -> None:
        self.gate = NoiseGate(sr, n_ch)
        self.limiter = Limiter(sr, n_ch)
        self.filter = FilterSection(sr, n_ch)
        self.reverb = Reverb(sr, n_ch)
        self.effects = (self.gate, self.limiter, self.filter, self.reverb)

    def reset(self):
        for e in self.effects:
            e.reset()

    def process(self, x):
        for e in self.effects:
            x = e.process(x)
        return x


# ---------------------------------------------------------------------------
# starting points
# ---------------------------------------------------------------------------

# Named pre/post setups. Each entry is {effect: {"on": bool, param: value}}.
# These exist because the honest default -- everything off -- sounds worse than
# the plugin, and hunting for why means learning what section 7 already says:
# condition the input, gate the output.
CHAIN_PRESETS = {
    "clean": {
        "why": "Gain-staging only. The safe default and the cheapest.",
        "pre": {
            "compressor": {"on": True, "threshold": -18.0, "ratio": 4.0,
                           "attack": 10.0, "release": 150.0, "gain": 3.0},
            "pitch": {"on": False},
            "delay": {"on": False},
            "filter": {"on": False},
        },
        "post": {
            "gate": {"on": True, "threshold": -55.0, "release": 150.0,
                     "range": -40.0},
            "limiter": {"on": True, "ceiling": -3.0},
            "filter": {"on": False},
            "reverb": {"on": False},
        },
    },
    "voice": {
        "why": "For RAVE voice and choir models: tight band, hard levelling, "
               "firm gate against the decoder's idle wash.",
        "pre": {
            "compressor": {"on": True, "threshold": -24.0, "ratio": 6.0,
                           "attack": 5.0, "release": 120.0, "gain": 6.0},
            "filter": {"on": True, "hp": 120.0, "lp": 8000.0},
            "pitch": {"on": False},
            "delay": {"on": False},
        },
        "post": {
            "gate": {"on": True, "threshold": -48.0, "attack": 2.0,
                     "release": 100.0, "range": -50.0},
            "limiter": {"on": True, "ceiling": -3.0, "release": 60.0},
            "filter": {"on": True, "hp": 80.0, "lp": 12000.0},
            "reverb": {"on": False},
        },
    },
    "percussive": {
        "why": "For drum and percussion models: fast, open, no smearing.",
        "pre": {
            "compressor": {"on": True, "threshold": -14.0, "ratio": 3.0,
                           "attack": 1.0, "release": 60.0, "gain": 2.0},
            "filter": {"on": True, "hp": 40.0, "lp": 16000.0},
            "pitch": {"on": False},
            "delay": {"on": False},
        },
        "post": {
            "gate": {"on": True, "threshold": -50.0, "attack": 0.5,
                     "release": 60.0, "range": -45.0},
            "limiter": {"on": True, "ceiling": -2.0, "release": 40.0},
            "filter": {"on": False},
            "reverb": {"on": False},
        },
    },
    "drone": {
        "why": "Slow and wide, for sustained models: an octave down into the "
               "model, long delay, gentle levelling.",
        "pre": {
            "pitch": {"on": True, "semitones": -12.0, "mix": 0.6, "window": 60.0},
            "delay": {"on": True, "time": 500.0, "feedback": 0.45, "mix": 0.3,
                      "damp": 4000.0},
            "compressor": {"on": True, "threshold": -26.0, "ratio": 8.0,
                           "attack": 30.0, "release": 400.0, "gain": 6.0},
            "filter": {"on": True, "hp": 60.0, "lp": 6000.0},
        },
        "post": {
            "gate": {"on": True, "threshold": -58.0, "release": 400.0,
                     "range": -35.0},
            "limiter": {"on": True, "ceiling": -3.0, "release": 200.0},
            "filter": {"on": False},
            "reverb": {"on": True, "mix": 0.3, "size": 0.8, "damp": 0.4,
                       "predelay": 30.0},
        },
    },
    "bypass": {
        "why": "Everything off. The model raw, for hearing what the "
               "conditioning is actually doing.",
        "pre": {k: {"on": False} for k in ("pitch", "delay", "compressor", "filter")},
        "post": {k: {"on": False} for k in ("gate", "limiter", "filter", "reverb")},
    },
}


def apply_chain_preset(slot, name: str) -> None:
    """Set one slot's pre- and post-chain from a named setup."""
    preset = CHAIN_PRESETS.get(name)
    if preset is None:
        raise KeyError(name)
    for stage, chain in (("pre", slot.pre), ("post", slot.post)):
        for eff in chain.effects:
            spec = preset.get(stage, {}).get(eff.name)
            if spec is None:
                continue
            eff.enabled = bool(spec.get("on", eff.enabled))
            for key, value in spec.items():
                if key == "on":
                    continue
                try:
                    eff.set(key, value)
                except KeyError:
                    pass
