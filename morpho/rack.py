"""The engine: four model slots, their conditioning chains, and the mixer.

Signal path for one slot:

    input -> pre-chain -> MODEL -> post-chain -> dry/wet -> level -> sum

The four slots all get the same input block and run at the same time on a
thread pool. Inference never happens in the audio callback; the callback only
moves blocks between two queues.

Every knob in here is reachable by a string key through `Rack.registry()`, and
that is what the OSC table and the GUI both drive. Adding a knob anywhere means
it shows up in both without either of them knowing about it.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

import dsp
import synth as synth_mod

log = logging.getLogger("morpho_rack")

N_SLOTS = 4
MAX_PARAMS_PER_SLOT = 4


def _require(name: str, pip_name: str):
    try:
        return __import__(name)
    except ImportError:
        raise SystemExit(
            f"missing dependency '{name}'.\n"
            f"    pip install {pip_name}\n"
            f"or install everything at once:\n"
            f"    pip install -r requirements.txt"
        )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


class DelayLine:
    """Fixed integer-sample delay for (channels, samples) blocks."""

    def __init__(self, n_ch: int, delay: int = 0) -> None:
        self.n_ch = n_ch
        self.delay = 0
        self.tail = np.zeros((n_ch, 0), dtype=np.float32)
        self.set_delay(delay)

    def set_delay(self, delay: int) -> None:
        delay = max(0, int(delay))
        if delay == self.delay:
            return
        self.delay = delay
        self.tail = np.zeros((self.n_ch, delay), dtype=np.float32)

    def reset(self) -> None:
        self.tail.fill(0.0)

    def process(self, x: np.ndarray) -> np.ndarray:
        if self.delay == 0:
            return x
        n = x.shape[1]
        buf = np.concatenate((self.tail, x), axis=1)
        self.tail = buf[:, n:].copy()
        return buf[:, :n].copy()


class CpuMeter:
    """Process CPU as a percentage of one core and of the whole machine.

    `time.process_time` is CPU time charged to this process across all its
    threads, so the ratio of its increments to wall-clock increments is exactly
    what a task manager shows, with no dependency to install.
    """

    def __init__(self) -> None:
        self._cpu = time.process_time()
        self._wall = time.perf_counter()
        self.cores = max(1, os.cpu_count() or 1)
        self.percent = 0.0       # of one core
        self.machine = 0.0       # of every core

    def sample(self) -> float:
        cpu, wall = time.process_time(), time.perf_counter()
        dc, dw = cpu - self._cpu, wall - self._wall
        if dw > 1e-3:
            self._cpu, self._wall = cpu, wall
            self.percent = 100.0 * dc / dw
            self.machine = self.percent / self.cores
        return self.machine


def db_to_gain(db: float) -> float:
    return 0.0 if db <= -60.0 else float(10.0 ** (db / 20.0))


def gain_to_db(gain: float) -> float:
    return -60.0 if gain <= 0.001 else float(20.0 * np.log10(gain))


def _as_bool(v, default=True) -> bool:
    """Metadata booleans arrive as real bools from new models and as the
    strings "True"/"False" from the official ones, which predate the change."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes")
    if v is None:
        return default
    return bool(v)


def _as_float(v, default=0.5) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# parameters
# ---------------------------------------------------------------------------


@dataclass
class ParamSpec:
    """A model parameter. `row` is its row in the parameter tensor; the SDK
    maps rows to parameters by declaration order p1..p4, unused ones included."""

    row: int
    name: str
    description: str
    default: float
    continuous: bool
    labels: Optional[list]


class ParamRef:
    """One addressable knob: what it is, how to read it, how to write it."""

    __slots__ = ("key", "label", "group", "spec", "_get", "_set")

    def __init__(self, key, label, group, spec, get, set_):
        self.key = key
        self.label = label
        self.group = group
        self.spec = spec  # a dsp.Param, for range/curve/formatting
        self._get = get
        self._set = set_

    def get(self) -> float:
        return float(self._get())

    def set(self, value: float) -> None:
        lo, hi = self.spec.lo, self.spec.hi
        self._set(min(max(float(value), lo), hi))

    def text(self) -> str:
        return self.spec.format(self.get())


# 0..1 knobs, which is what every model parameter is
UNIT = dsp.Param("unit", "", 0.0, 1.0, 0.5, "")
LEVEL = dsp.Param("level", "level", -40.0, 12.0, 0.0, "dB")
MIX = dsp.Param("mix", "dry/wet", 0.0, 1.0, 1.0, "")
SWITCH = dsp.Param("switch", "on", 0.0, 1.0, 1.0, "")


# ---------------------------------------------------------------------------
# slot
# ---------------------------------------------------------------------------


class Slot:
    def __init__(self, index: int, sr: int, block: int, n_ch: int) -> None:
        self.index = index
        self.sr = sr
        self.block = block
        self.n_ch = n_ch

        self.model = None
        self.metadata: dict = {}
        self.path: Optional[Path] = None
        self.name = "empty"
        self.status = "empty"
        self.params: list[ParamSpec] = []

        self.enabled = True
        self.solo = False
        self.mix = 1.0
        self.gain = 1.0
        self.param_slew = 0.25

        self.peak = 0.0
        self.latency = 0

        self.pre = dsp.PreChain(sr, n_ch)
        self.post = dsp.PostChain(sr, n_ch)

        self.param_targets = np.zeros(0, dtype=np.float32)
        self.param_smoothed = np.zeros(0, dtype=np.float32)
        self._params_buf = None
        self._dry_delay = DelayLine(n_ch)
        self._align_delay = DelayLine(n_ch)

    # -- loading ------------------------------------------------------------

    def load(self, path: Path, validate: bool = False) -> None:
        """Load a .nm model. Takes seconds; never call it from the audio path."""
        import torch

        path = Path(path)
        if validate:
            # The SDK's loader also sends an HTTP HEAD to every link in the
            # metadata, with no timeout. Behind a captive portal that hangs for
            # minutes, so it is opt-in.
            from neutone_sdk.utils import load_neutone_model

            model, metadata = load_neutone_model(str(path))
        else:
            extra = {"metadata.json": ""}
            model = torch.jit.load(str(path), _extra_files=extra)
            metadata = _read_metadata(model, extra)

        if hasattr(model, "prepare_for_inference"):
            model.prepare_for_inference()
        model.set_daw_sample_rate_and_buffer_size(self.sr, self.block)
        model.reset()

        defaults = (
            model.get_default_param_values()
            .detach().reshape(-1).to(torch.float32).numpy().copy()
        )

        self.metadata = metadata
        self.path = path
        self.name = str(metadata.get("model_name") or path.stem)
        self.params = _read_param_specs(metadata)
        self.param_targets = defaults.copy()
        self.param_smoothed = defaults.copy()
        for spec in self.params:  # metadata defaults win over the tensor's
            if spec.row < self.param_targets.shape[0]:
                self.param_targets[spec.row] = spec.default
                self.param_smoothed[spec.row] = spec.default
        self._params_buf = torch.zeros(
            (defaults.shape[0], self.block), dtype=torch.float32
        )
        try:
            self.mix = float(model.get_wet_default_value())
        except Exception:
            self.mix = 1.0

        self.latency = int(
            model.calc_buffering_delay_samples() + model.calc_model_delay_samples()
        )
        self._dry_delay.set_delay(self.latency)
        # Assigned last: the worker treats a non-None model as "fully built".
        self.model = model
        self.status = "ready"

    def unload(self) -> None:
        self.model = None
        self.metadata = {}
        self.path = None
        self.name = "empty"
        self.status = "empty"
        self.params = []
        self._params_buf = None
        self.latency = 0
        self.peak = 0.0
        self._dry_delay.set_delay(0)
        self._align_delay.set_delay(0)

    def reset(self) -> None:
        if self.model is not None:
            self.model.reset()
        self.pre.reset()
        self.post.reset()
        self._dry_delay.reset()
        self._align_delay.reset()
        if self.param_targets.size:
            self.param_smoothed = self.param_targets.copy()

    # -- processing ---------------------------------------------------------

    def set_param(self, row: int, value_0to1: float) -> None:
        if 0 <= row < self.param_targets.shape[0]:
            self.param_targets[row] = float(np.clip(value_0to1, 0.0, 1.0))

    def get_param(self, row: int) -> float:
        if 0 <= row < self.param_targets.shape[0]:
            return float(self.param_targets[row])
        return 0.0

    def _update_params(self) -> None:
        """Slew continuous parameters toward their targets.

        The wrapper averages the parameter tensor over a block, so a jump still
        lands as a step; slewing spreads it over a few blocks and stops a fader
        move from clicking.
        """
        import torch

        if self._params_buf is None:
            return
        tgt, cur = self.param_targets, self.param_smoothed
        for spec in self.params:
            if spec.continuous:
                cur[spec.row] += (tgt[spec.row] - cur[spec.row]) * self.param_slew
            else:
                cur[spec.row] = tgt[spec.row]  # stepped values must not glide
        self._params_buf.copy_(torch.from_numpy(cur).unsqueeze(1))

    def process(self, x: np.ndarray) -> np.ndarray:
        """One block. Runs on the pool, so grad mode is set here: in PyTorch it
        is thread-local and would otherwise stay on in this thread."""
        import torch

        if self.model is None:
            return np.zeros_like(x)

        conditioned = self.pre.process(x.copy())

        with torch.no_grad():
            self._update_params()
            # Copy again: the wrapper writes into its input buffer.
            xt = torch.from_numpy(np.ascontiguousarray(conditioned))
            wet = self.model.forward(xt, self._params_buf).numpy().copy()

        if wet.shape != x.shape:  # defensive; the wrapper normalises channels
            wet = np.resize(wet, x.shape).astype(np.float32)

        wet = self.post.process(wet)
        dry = self._dry_delay.process(x)
        out = self.mix * wet + (1.0 - self.mix) * dry
        out = self._align_delay.process(out)
        out = out * self.gain
        self.peak = float(np.abs(out).max()) if out.size else 0.0
        return out.astype(np.float32, copy=False)


def _read_metadata(model, extra: dict) -> dict:
    """Get a model's metadata, whichever SDK era it came from.

    Current models embed `metadata.json` as a TorchScript extra file. Models
    published before that -- which is all of the official library -- carry it
    only as an exported method, and the older ones of those have `to_metadata`
    but not `get_metadata_json`. Without this fallback every official model
    loads with no name and no parameters.
    """
    blob = extra.get("metadata.json") or b""
    if blob:
        try:
            return json.loads(blob.decode() if isinstance(blob, bytes) else blob)
        except Exception:
            pass
    if hasattr(model, "get_metadata_json"):
        try:
            return json.loads(model.get_metadata_json())
        except Exception:
            pass
    if hasattr(model, "to_metadata"):
        try:
            md = model.to_metadata()
            if isinstance(md, dict):
                return md
            # A TorchScript NamedTuple: pull the fields off by name.
            return {
                f: getattr(md, f)
                for f in dir(md)
                if not f.startswith("_") and f not in ("count", "index")
            }
        except Exception as exc:
            log.warning("could not read model metadata: %s", exc)
    return {}


def _read_param_specs(metadata: dict) -> list:
    """Read p1..p4 out of the metadata.

    Three things vary by SDK era and all three have bitten: the type is
    "continuous" now and "knob" in the official library, `used` is a bool now
    and the string "True"/"False" then, and `default_value` is a number now and
    a string then. A knob's default is already 0..1.
    """
    specs: list[ParamSpec] = []
    declared = metadata.get("neutone_parameters") or {}
    for i in range(MAX_PARAMS_PER_SLOT):
        p = declared.get(f"p{i + 1}")
        if not isinstance(p, dict) or not _as_bool(p.get("used"), True):
            continue
        kind = str(p.get("type", "continuous")).lower()
        if kind == "text":
            continue  # not a numeric row, nothing to put on a fader
        default = p.get("default_value_0to1")
        if default is None:
            default = p.get("default_value")
        specs.append(
            ParamSpec(
                row=i,
                name=str(p.get("name") or f"p{i + 1}"),
                description=str(p.get("description") or ""),
                default=min(max(_as_float(default, 0.5), 0.0), 1.0),
                continuous=kind in ("continuous", "knob", ""),
                labels=p.get("labels") if isinstance(p.get("labels"), list) else None,
            )
        )
    return specs


# ---------------------------------------------------------------------------
# rack
# ---------------------------------------------------------------------------


class Rack:
    # What the models can be fed. They sum, so "both" is a blend rather than a
    # switch, which lets the swarm crossfade between the room and itself.
    INPUTS = ("mic", "synth", "file", "test")

    def __init__(self, sr=48000, block=512, n_ch=1, source="device", wav=None,
                 in_device=None, out_device=None, prime=3, validate=False,
                 voices=8) -> None:
        self.sr = sr
        self.block = block
        self.n_ch = n_ch
        self.source = source
        self.wav = wav
        self.in_device = in_device
        self.out_device = out_device
        self.prime = prime
        self.validate = validate

        self.slots = [Slot(i, sr, block, n_ch) for i in range(N_SLOTS)]
        self.synth = synth_mod.Synth(sr, n_ch, voices)
        self.input_gain = {k: 0.0 for k in self.INPUTS}
        self.input_gain["mic" if source == "device" else source] = 1.0
        self.input_peak = 0.0
        # Always try for a duplex stream so the mic can be switched on
        # later without a restart; falls back if there is no input device.
        self.duplex = True
        self.duplex_active = False
        # When linked, editing any slot's conditioning edits all four. The
        # four models usually want the same treatment, and keeping them in
        # step by hand across four tabs is where mistakes live.
        self.link_chains = False
        self.cpu = CpuMeter()
        self.master_gain = db_to_gain(-6.0)
        self.master_peak = 0.0
        self.latency = 0

        # The master chain is what protects the PA: everything else is taste.
        self.master_reverb = dsp.Reverb(sr, n_ch)
        self.master_limiter = dsp.Limiter(sr, n_ch)
        self.master_limiter.enabled = True

        self.underruns = 0
        self.dropped = 0
        self.clips = 0
        self.load_pct = 0.0

        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._reset_req = threading.Event()
        self._in_q: queue.Queue = queue.Queue(maxsize=8)
        self._out_q: queue.Queue = queue.Queue(maxsize=prime + 4)
        self._pool: Optional[ThreadPoolExecutor] = None
        self._worker = None
        self._stream = None
        self.running = False

        self._src_audio = None
        self._src_pos = 0
        self._phase = 0
        self._registry_version = 0
        self._reg_cache = None
        self._reg_cache_version = -1

    # -- models -------------------------------------------------------------

    def load_slot(self, index: int, path) -> None:
        slot = self.slots[index]
        slot.status = "loading"
        try:
            slot.load(Path(path), validate=self.validate)
        except Exception as exc:  # a bad .nm must not take the rack down
            slot.unload()
            slot.status = f"error: {exc}"
            log.error("slot %d failed to load %s: %s", index + 1, path, exc)
            raise
        finally:
            with self._lock:
                self._rebalance_latency()
                self._registry_version += 1

    def unload_slot(self, index: int) -> None:
        with self._lock:
            self.slots[index].unload()
            self._rebalance_latency()
            self._registry_version += 1

    def _rebalance_latency(self) -> None:
        """Delay every slot up to the slowest, so the four stay in phase."""
        loaded = [s for s in self.slots if s.model is not None]
        worst = max((s.latency for s in loaded), default=0)
        for s in self.slots:
            s._align_delay.set_delay(worst - s.latency if s.model is not None else 0)
        self.latency = worst

    def bind_osc(self, receiver) -> None:
        """Hook up the events that are not numbers: the crown, and leaving."""
        receiver.on_queen = self.set_queen
        receiver.on_leave = self.release_voice

    def set_queen(self, uid: str, slot: int) -> None:
        self.synth.set_queen(uid, slot)
        log.info("queen: %s (slot %s)", uid or "nobody", slot or "-")

    def release_voice(self, slot: int) -> None:
        """A phone left, so free its voice now rather than waiting for the
        timeout. The drone queen is exempt: she is meant to hang on."""
        i = int(slot) - 1
        if 0 <= i < self.synth.n_voices:
            if i == self.synth.queen_index and self.synth.queen_floor() > 0.0:
                return
            self.synth.voices[i].level = 0.0
            self.synth.voices[i].touched = 0.0

    def set_block(self, block: int) -> None:
        """Change the audio block size, restarting the stream if it is running.

        Every loaded model has to be told, because the wrapper sizes its queues
        and its I/O buffers from the block and will not otherwise accept one of
        a different length.
        """
        import torch

        block = int(block)
        if block == self.block or block < 32:
            return
        was_running = self.running
        if was_running:
            self.stop()
        self.block = block
        with self._lock:
            for s in self.slots:
                s.block = block
                if s.model is None:
                    continue
                s.model.set_daw_sample_rate_and_buffer_size(self.sr, block)
                s.model.reset()
                rows = s.param_targets.shape[0]
                s._params_buf = torch.zeros((rows, block), dtype=torch.float32)
                s.latency = int(s.model.calc_buffering_delay_samples()
                                + s.model.calc_model_delay_samples())
                s._dry_delay.set_delay(s.latency)
            self._rebalance_latency()
        log.info("block size now %d (%.1f ms), model latency %d samples",
                 block, 1000.0 * block / self.sr, self.latency)
        if was_running:
            self.start()

    def reset_models(self) -> None:
        """Clear model and effect state. Deferred to the worker while running:
        clearing a wrapper's queues under a forward pass in another thread
        would hand that pass half-cleared buffers."""
        if self.running:
            self._reset_req.set()
            return
        with self._lock:
            for s in self.slots:
                s.reset()
            self.synth.reset()
            self.master_reverb.reset()
            self.master_limiter.reset()

    # -- the parameter registry --------------------------------------------

    def registry(self) -> dict:
        """Every addressable knob, keyed by a stable string.

        Cached, and rebuilt only when a model load changes which parameters
        exist. It has to be: OSC calls `set_param` for every routed message, a
        busy room sends about a thousand a second, and building two hundred
        closures each time burned more CPU than all four models put together
        and starved the audio worker into underruns.
        """
        if (self._reg_cache is None
                or self._reg_cache_version != self._registry_version):
            self._reg_cache = self._build_registry()
            self._reg_cache_version = self._registry_version
        return self._reg_cache

    def _build_registry(self) -> dict:
        reg: dict = {}

        def add(key, label, group, spec, get, set_):
            reg[key] = ParamRef(key, label, group, spec, get, set_)

        for i, slot in enumerate(self.slots):
            n = i + 1
            g = f"slot {n}"
            add(f"slot{n}.level", "level", g, LEVEL,
                lambda s=slot: gain_to_db(s.gain),
                lambda v, s=slot: setattr(s, "gain", db_to_gain(v)))
            add(f"slot{n}.mix", "dry/wet", g, MIX,
                lambda s=slot: s.mix,
                lambda v, s=slot: setattr(s, "mix", v))
            add(f"slot{n}.on", "on", g, SWITCH,
                lambda s=slot: 1.0 if s.enabled else 0.0,
                lambda v, s=slot: setattr(s, "enabled", v >= 0.5))

            for spec in slot.params:
                add(f"slot{n}.model.p{spec.row + 1}", spec.name, f"slot {n} model",
                    UNIT,
                    lambda s=slot, r=spec.row: s.get_param(r),
                    lambda v, s=slot, r=spec.row: s.set_param(r, v))

            for stage, chain in (("pre", slot.pre), ("post", slot.post)):
                for eff in chain.effects:
                    grp = f"slot {n} {stage} {eff.name}"
                    # Written through the rack rather than straight at the
                    # effect, so "link all slots" works for OSC as well as for
                    # the window.
                    add(f"slot{n}.{stage}.{eff.name}.on", "enabled", grp, SWITCH,
                        lambda e=eff: 1.0 if e.enabled else 0.0,
                        lambda v, st=stage, en=eff.name, sl=slot:
                            self.set_chain_enabled(st, en, v >= 0.5, sl))
                    for p in eff.params:
                        add(f"slot{n}.{stage}.{eff.name}.{p.name}", p.label, grp, p,
                            lambda e=eff, nm=p.name: e.get(nm),
                            lambda v, st=stage, en=eff.name, nm=p.name, sl=slot:
                                self.set_chain_param(st, en, nm, v, sl))

        # the input mixer: what the four models are chewing on
        for name in self.INPUTS:
            add(f"input.{name}", name, "input", LEVEL,
                lambda k=name: gain_to_db(self.input_gain[k]),
                lambda v, k=name: self.input_gain.__setitem__(k, db_to_gain(v)))

        # the synth: one voice per client
        for p in synth_mod.SYNTH_PARAMS:
            add(f"synth.{p.name}", p.label, "synth", p,
                lambda nm=p.name: self.synth.get(nm),
                lambda v, nm=p.name: self.synth.set(nm, v))
        for v_i, voice in enumerate(self.synth.voices):
            n = v_i + 1
            grp = f"synth voice {n}"
            for p in synth_mod.VOICE_PARAMS:
                if p.name == "level":
                    # Writing a level is also what marks the voice alive, so a
                    # client that leaves and stops sending times out instead of
                    # droning on its last value forever.
                    add(f"synth.voice{n}.level", "level", grp, p,
                        lambda vo=voice: vo.level,
                        lambda val, vo=voice, k=v_i: (
                            setattr(vo, "level", val), self.synth.touch(k)
                        )[0])
                else:
                    add(f"synth.voice{n}.{p.name}", p.label, grp, p,
                        lambda vo=voice, nm=p.name: getattr(vo, nm),
                        lambda val, vo=voice, nm=p.name: setattr(vo, nm, val))

        add("master.level", "level", "master", LEVEL,
            lambda: gain_to_db(self.master_gain),
            lambda v: setattr(self, "master_gain", db_to_gain(v)))
        for eff in (self.master_reverb, self.master_limiter):
            grp = f"master {eff.name}"
            add(f"master.{eff.name}.on", "enabled", grp, SWITCH,
                lambda e=eff: 1.0 if e.enabled else 0.0,
                lambda v, e=eff: setattr(e, "enabled", v >= 0.5))
            for p in eff.params:
                add(f"master.{eff.name}.{p.name}", p.label, grp, p,
                    lambda e=eff, nm=p.name: e.get(nm),
                    lambda v, e=eff, nm=p.name: e.set(nm, v))
        return reg

    @property
    def registry_version(self) -> int:
        return self._registry_version

    def set_param(self, key: str, value: float) -> None:
        """Write one knob by key. This is what OSC calls, very often."""
        ref = self.registry().get(key)
        if ref is not None:
            ref.set(value)

    @staticmethod
    def _chain_of(slot, stage: str):
        return slot.pre if stage == "pre" else slot.post

    def _effects_named(self, stage: str, name: str, slot=None):
        """Every effect with this name: one slot's, or all four when linked."""
        slots = self.slots if (self.link_chains or slot is None) else [slot]
        out = []
        for s in slots:
            for eff in self._chain_of(s, stage).effects:
                if eff.name == name:
                    out.append(eff)
        return out

    def set_chain_param(self, stage, effect, param, value, slot=None) -> None:
        for eff in self._effects_named(stage, effect, slot):
            eff.set(param, value)

    def set_chain_enabled(self, stage, effect, on, slot=None) -> None:
        for eff in self._effects_named(stage, effect, slot):
            eff.enabled = bool(on)

    def copy_chain(self, index: int) -> dict:
        """Snapshot one slot's conditioning, for pasting onto another."""
        slot = self.slots[index]
        out = {}
        for stage in ("pre", "post"):
            out[stage] = {
                eff.name: dict({"on": eff.enabled}, **dict(eff.values))
                for eff in self._chain_of(slot, stage).effects
            }
        return out

    def paste_chain(self, data: dict, index=None) -> None:
        """Apply a snapshot to one slot, or to all of them."""
        targets = self.slots if index is None else [self.slots[index]]
        for slot in targets:
            for stage in ("pre", "post"):
                for eff in self._chain_of(slot, stage).effects:
                    spec = (data.get(stage) or {}).get(eff.name)
                    if not spec:
                        continue
                    eff.enabled = bool(spec.get("on", eff.enabled))
                    for key, value in spec.items():
                        if key != "on":
                            try:
                                eff.set(key, value)
                            except KeyError:
                                pass

    def apply_chain_preset(self, name: str, slot_index=None) -> None:
        """Set a named conditioning setup on one slot, or on all of them."""
        targets = (
            self.slots if slot_index is None else [self.slots[slot_index]]
        )
        for s in targets:
            dsp.apply_chain_preset(s, name)
        log.info("chain setup %r applied to %d slot(s)", name, len(targets))

    # -- presets ------------------------------------------------------------

    def save_preset(self, path) -> None:
        reg = self.registry()
        data = {
            "models": [str(s.path) if s.path else None for s in self.slots],
            "params": {k: r.get() for k, r in reg.items()},
        }
        Path(path).write_text(json.dumps(data, indent=1), encoding="utf-8")
        log.info("wrote preset to %s", path)

    def load_preset(self, path, load_models=True) -> None:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if load_models:
            for i, p in enumerate(data.get("models") or []):
                if i >= N_SLOTS:
                    break
                if p and Path(p).exists():
                    try:
                        self.load_slot(i, p)
                    except Exception:
                        pass
        reg = self.registry()
        for k, v in (data.get("params") or {}).items():
            ref = reg.get(k)
            if ref is not None:
                try:
                    ref.set(float(v))
                except Exception:
                    pass
        log.info("loaded preset from %s", path)

    # -- input sources ------------------------------------------------------

    def _load_wav(self) -> None:
        sf = _require("soundfile", "soundfile")
        data, file_sr = sf.read(str(self.wav), dtype="float32", always_2d=True)
        if file_sr != self.sr:
            log.warning(
                "%s is %d Hz but the rack runs at %d Hz, so it will play back at "
                "the wrong pitch. Resample the file, or run with --sr %d.",
                self.wav, file_sr, self.sr, file_sr,
            )
        data = data.T
        if data.shape[0] < self.n_ch:
            data = np.repeat(data[:1], self.n_ch, axis=0)
        self._src_audio = np.ascontiguousarray(data[: self.n_ch], dtype=np.float32)
        self._src_pos = 0

    def select_input(self, name: str) -> None:
        """Switch what the models are fed: an INPUTS name, or "both"."""
        wanted = {"mic", "synth"} if name == "both" else {name}
        for k in self.INPUTS:
            self.input_gain[k] = 1.0 if k in wanted else 0.0

    def current_input(self) -> str:
        on = [k for k in self.INPUTS if self.input_gain[k] > 1e-4]
        if on == ["mic", "synth"]:
            return "both"
        if len(on) == 1:
            return on[0]
        return "silent" if not on else "mixed"

    def _file_block(self) -> np.ndarray:
        src, n = self._src_audio, self.block
        out = np.empty((self.n_ch, n), dtype=np.float32)
        filled = 0
        while filled < n:
            take = min(n - filled, src.shape[1] - self._src_pos)
            out[:, filled : filled + take] = src[:, self._src_pos : self._src_pos + take]
            filled += take
            self._src_pos = (self._src_pos + take) % src.shape[1]
        return out

    def _test_block(self) -> np.ndarray:
        """A slowly swept tone plus noise, so pitched and noisy models both
        have something to bite on with no hardware attached."""
        t = (np.arange(self.block) + self._phase) / self.sr
        self._phase += self.block
        f = 220.0 * (2.0 ** (0.5 * np.sin(2.0 * np.pi * 0.1 * float(t[0]))))
        mono = (0.3 * np.sin(2.0 * np.pi * f * t)) + 0.02 * np.random.randn(self.block)
        return np.repeat(mono.astype(np.float32)[None, :], self.n_ch, axis=0)

    def _build_input(self, mic) -> np.ndarray:
        """Mix whichever sources are up into the block the models will see."""
        g = self.input_gain
        out = np.zeros((self.n_ch, self.block), dtype=np.float32)
        if mic is not None and g["mic"] > 1e-4:
            out += mic * g["mic"]
        if g["synth"] > 1e-4:
            out += self.synth.render(self.block) * g["synth"]
        if g["file"] > 1e-4 and self._src_audio is not None:
            out += self._file_block() * g["file"]
        if g["test"] > 1e-4:
            out += self._test_block() * g["test"]
        self.input_peak = float(np.abs(out).max()) if out.size else 0.0
        return out

    def _generate_input(self) -> np.ndarray:
        """The input with no microphone, for driving the rack directly."""
        return self._build_input(None)

    # -- audio callbacks (no inference here, ever) --------------------------

    def _push_out(self, outdata) -> None:
        try:
            y = self._out_q.get_nowait()
        except queue.Empty:
            outdata.fill(0.0)
            self.underruns += 1
            return
        if self.n_ch == 1:
            outdata[:, 0] = y[0]
            if outdata.shape[1] > 1:
                outdata[:, 1] = y[0]
        else:
            outdata[:] = y.T

    def _duplex_cb(self, indata, outdata, frames, time_info, status) -> None:
        if status:
            self.dropped += 1
        try:
            self._in_q.put_nowait(indata.T.copy())
        except queue.Full:
            self.dropped += 1
        self._push_out(outdata)

    def _output_cb(self, outdata, frames, time_info, status) -> None:
        if status:
            self.dropped += 1
        self._push_out(outdata)

    # -- worker -------------------------------------------------------------

    def _run(self) -> None:
        budget = self.block / self.sr
        while not self._stop.is_set():
            if self._reset_req.is_set():
                self._reset_req.clear()
                with self._lock:
                    for s in self.slots:
                        s.reset()
                    self.master_reverb.reset()
                    self.master_limiter.reset()
            mic = None
            if self.duplex_active:
                # The duplex queue paces the worker, so it is drained even
                # when the mic is turned all the way down.
                try:
                    mic = self._in_q.get(timeout=0.5)
                except queue.Empty:
                    continue
            x = self._build_input(mic)

            t0 = time.perf_counter()
            y = self._process_block(x)
            elapsed = time.perf_counter() - t0
            self.load_pct += 0.1 * (100.0 * elapsed / budget - self.load_pct)

            try:
                # Blocking put paces the file and test sources to the audio
                # clock; with a device source the queue is rarely full.
                self._out_q.put(y, timeout=1.0)
            except queue.Full:
                pass

    def _process_block(self, x: np.ndarray) -> np.ndarray:
        with self._lock:
            slots = [s for s in self.slots if s.model is not None]
            any_solo = any(s.solo for s in slots)

        mix = np.zeros((self.n_ch, self.block), dtype=np.float32)
        if slots:
            # Every loaded model runs every block, muted or not: CPU load stays
            # flat and unmuting is instant and still time-aligned. Torch
            # releases the GIL in the forward pass so the four overlap. Without
            # a pool they run in turn, so the rack works when driven directly.
            if self._pool is not None:
                pending = [(s, self._pool.submit(s.process, x)) for s in slots]
                results = [(s, f.result) for s, f in pending]
            else:
                results = [(s, lambda s=s: s.process(x)) for s in slots]
            for s, get in results:
                try:
                    out = get()
                except Exception as exc:
                    s.status = f"error: {exc}"
                    log.error("slot %d failed: %s", s.index + 1, exc)
                    continue
                if (s.solo if any_solo else s.enabled):
                    mix += out

        mix = self.master_reverb.process(mix)
        mix = mix * self.master_gain
        mix = self.master_limiter.process(mix)
        self.master_peak = float(np.abs(mix).max()) if mix.size else 0.0
        if self.master_peak > 1.0:
            self.clips += 1
            np.clip(mix, -1.0, 1.0, out=mix)
        return mix.astype(np.float32, copy=False)

    # -- lifecycle ----------------------------------------------------------

    def _warmup(self, n_blocks: int = 16) -> None:
        """Push silence through everything before the stream opens.

        A TorchScript module's first forward passes do lazy allocation and run
        several times slower than the rest. With a live stream that cost lands
        in the first blocks of audio as a burst of underruns, so it is paid
        here, where nobody can hear it.
        """
        silence = np.zeros((self.n_ch, self.block), dtype=np.float32)
        t0 = time.perf_counter()
        for _ in range(n_blocks):
            self._process_block(silence)
        with self._lock:
            for s in self.slots:
                s.reset()
            self.master_reverb.reset()
            self.master_limiter.reset()
        self.load_pct = 0.0
        self.master_peak = 0.0
        log.debug("warm-up: %d blocks in %.0f ms", n_blocks,
                  1000 * (time.perf_counter() - t0))

    def start(self) -> None:
        if self.running:
            return
        sd = _require("sounddevice", "sounddevice")

        if self.wav:
            self._load_wav()
        elif self.input_gain["file"] > 1e-4:
            raise ValueError("file input needs a wav path")

        self._stop.clear()
        self._reset_req.clear()
        self.underruns = self.dropped = self.clips = 0
        with self._in_q.mutex:
            self._in_q.queue.clear()
        with self._out_q.mutex:
            self._out_q.queue.clear()
        for _ in range(self.prime):
            self._out_q.put_nowait(np.zeros((self.n_ch, self.block), dtype=np.float32))

        self._pool = ThreadPoolExecutor(max_workers=N_SLOTS, thread_name_prefix="slot")
        self._warmup()
        self._worker = threading.Thread(target=self._run, name="rack", daemon=True)
        self._worker.start()

        try:
            self._stream = None
            if self.duplex:
                try:
                    self._stream = sd.Stream(
                        samplerate=self.sr, blocksize=self.block, dtype="float32",
                        channels=(self.n_ch, 2),
                        device=(self.in_device, self.out_device),
                        callback=self._duplex_cb,
                    )
                    self.duplex_active = True
                except Exception as exc:
                    # No usable input device. Everything except the mic still
                    # works, so open output-only rather than refusing to start.
                    log.warning("no audio input (%s); the mic source is off", exc)
                    self.duplex_active = False
            if self._stream is None:
                self._stream = sd.OutputStream(
                    samplerate=self.sr, blocksize=self.block, dtype="float32",
                    channels=2, device=self.out_device, callback=self._output_cb,
                )
            self._stream.start()
        except Exception:
            self._stop.set()
            self._worker.join(timeout=2.0)
            self._pool.shutdown(wait=False)
            self._worker, self._pool, self._stream = None, None, None
            raise

        self.running = True
        log.info(
            "rack running: %d Hz, %d-sample blocks, %s input, model latency %d "
            "samples (%.1f ms)",
            self.sr, self.block, self.current_input(), self.latency,
            1000.0 * self.latency / self.sr,
        )

    def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        self._stop.set()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if self._worker is not None:
            self._worker.join(timeout=2.0)
            self._worker = None
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None
        self.duplex_active = False
        log.info("rack stopped")
