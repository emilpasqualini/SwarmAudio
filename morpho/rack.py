"""The engine: four model slots, their conditioning chains, and the mixer.

Signal path for one slot:

    input -> pre-chain -> MODEL -> post-chain -> dry/wet -> level -> pan -> sum

The four slots all get the same input block and run at the same time on a
thread pool. Inference never happens in the audio callback; the callback only
moves blocks between two queues.

Every knob in here is reachable by a string key through `Rack.registry()`, and
that is what the OSC table and the GUI both drive. Adding a knob anywhere means
it shows up in both without either of them knowing about it.
"""

from __future__ import annotations

import io
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

import devices as devices_mod
import dsp
import personal as personal_mod
import runner as runner_mod
import synth as synth_mod
import zones as zones_mod

log = logging.getLogger("morpho_rack")

N_SLOTS = 4
MAX_PARAMS_PER_SLOT = 4

# The slots sum into a stereo bus whatever the models run at, so a slot can sit
# somewhere in the picture. A mono output device gets the two sides folded back
# together in `_push_out`.
OUT_CH = 2


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
        self.percent = 0.0  # of one core
        self.machine = 0.0  # of every core

    def sample(self) -> float:
        cpu, wall = time.process_time(), time.perf_counter()
        dc, dw = cpu - self._cpu, wall - self._wall
        if dw > 1e-3:
            self._cpu, self._wall = cpu, wall
            self.percent = 100.0 * dc / dw
            self.machine = self.percent / self.cores
        return self.machine


def prefer_performance() -> list:
    """Ask the OS not to treat the rack as a background job.

    On a laptop with performance and efficiency cores, Windows 11 moves a
    process whose window is not in focus onto the efficiency cores and caps its
    power ("EcoQoS"). The same four models measured between 41% and over 200%
    of the block budget on this machine depending on exactly that, plus heat.
    Opting out of power throttling and raising the priority class is what DAWs
    do; it cannot make the cores faster, but it stops the scheduler handing the
    audio work to the slow ones. Returns what was changed, for the log.
    """
    done = []
    if os.name != "nt":
        try:
            os.nice(-5)
            done.append("nice -5")
        except (OSError, AttributeError):
            pass
        return done
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Without explicit types ctypes passes the handle as a 32-bit int, the
        # upper half of the 64-bit pseudo-handle is lost, and every call fails
        # quietly with "invalid handle".
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.SetPriorityClass.restype = wintypes.BOOL
        kernel32.SetProcessInformation.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        )
        kernel32.SetProcessInformation.restype = wintypes.BOOL
        proc = kernel32.GetCurrentProcess()
        HIGH_PRIORITY_CLASS = 0x80
        if kernel32.SetPriorityClass(proc, HIGH_PRIORITY_CLASS):
            done.append("high priority")

        class PowerThrottling(ctypes.Structure):
            _fields_ = [
                ("Version", wintypes.ULONG),
                ("ControlMask", wintypes.ULONG),
                ("StateMask", wintypes.ULONG),
            ]

        ProcessPowerThrottling = 4
        EXECUTION_SPEED = 0x1
        state = PowerThrottling(1, EXECUTION_SPEED, 0)  # control speed, never throttle
        ok = kernel32.SetProcessInformation(
            proc, ProcessPowerThrottling, ctypes.byref(state), ctypes.sizeof(state)
        )
        if ok:
            done.append("no EcoQoS")
        winmm = ctypes.WinDLL("winmm")
        if winmm.timeBeginPeriod(1) == 0:
            done.append("1 ms timer")
    except Exception as exc:
        log.debug("could not raise process priority: %s", exc)
    return done


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


class PanParam(dsp.Param):
    """-1 hard left, 0 centre, +1 hard right, written the way a desk writes it."""

    __slots__ = ()

    def format(self, value: float) -> str:
        if abs(value) < 0.005:
            return "C"
        return f"{'L' if value < 0 else 'R'}{abs(value) * 100:.0f}"


PAN = PanParam("pan", "pan", -1.0, 1.0, 0.0, "")


def pan_law(position, n: int = 0, previous=None):
    """Constant-power gains for one block: -3 dB in the middle, so sweeping a
    slot across the picture does not make it louder on the way past.

    Given the previous position, the gains ramp across the block instead of
    stepping, which is what keeps an OSC-driven sweep from clicking.
    """
    p1 = float(min(max(position, -1.0), 1.0))
    if previous is None or n <= 0 or abs(p1 - previous) < 1e-6:
        p = p1
    else:
        p = np.linspace(previous, p1, n, dtype=np.float32)
    a = (np.asarray(p, dtype=np.float32) + 1.0) * (np.pi / 4.0)
    return np.cos(a), np.sin(a)


def sum_stereo(bus, block, gl=1.0, gr=1.0) -> None:
    """Add one slot's output to the stereo bus.

    A mono slot is placed with the two gains; a stereo one keeps its own sides
    and the gains act as a balance between them.
    """
    left = block[0]
    right = block[1] if block.shape[0] > 1 else left
    bus[0] += left * gl
    bus[1] += right * gr


# What a slot listens to. "all" is the input mixer (mic, synth, file, test);
# "queen" and "crowd" are the two halves of the synth in split routing.
SOURCES = ("all", "queen", "crowd", "off")
SOURCE = dsp.Param("source", "input", 0.0, len(SOURCES) - 1.0, 0.0, "")


# ---------------------------------------------------------------------------
# slot
# ---------------------------------------------------------------------------


def _short_reason(exc) -> str:
    """The last line of a TorchScript error, which is the one that says why."""
    lines = [ln.strip() for ln in str(exc).splitlines() if ln.strip()]
    return lines[-1] if lines else type(exc).__name__


class SqwEngine:
    """The SDK's own wrapper, on the CPU. Proven, and the fallback for any model
    the GPU runner cannot take."""

    kind = "cpu"

    def __init__(self, model, sr: int, block: int, rows: int) -> None:
        self.m = model
        self.sr = sr
        self.rows = rows
        self.set_block(block)

    def set_block(self, block: int) -> None:
        import torch

        self.block = int(block)
        self.m.set_daw_sample_rate_and_buffer_size(self.sr, self.block)
        self.m.reset()
        self._params = torch.zeros((self.rows, self.block), dtype=torch.float32)

    @property
    def latency(self) -> int:
        return int(
            self.m.calc_buffering_delay_samples() + self.m.calc_model_delay_samples()
        )

    def reset(self) -> None:
        self.m.reset()

    def forward(self, x: np.ndarray, params: np.ndarray) -> np.ndarray:
        import torch

        with torch.no_grad():
            self._params.copy_(torch.from_numpy(params).unsqueeze(1))
            # Copy: the wrapper writes into its input buffer.
            xt = torch.from_numpy(np.ascontiguousarray(x).copy())
            return self.m.forward(xt, self._params).numpy().copy()


class Slot:
    def __init__(self, index: int, sr: int, block: int, n_ch: int) -> None:
        self.index = index
        self.sr = sr
        self.block = block
        self.n_ch = n_ch

        self.model = None  # the engine; None means nothing loaded
        self.metadata: dict = {}
        self.path: Optional[Path] = None
        self.name = "empty"
        self.status = "empty"
        self.params: list[ParamSpec] = []
        self.device = "-"
        self.input_mono = True

        self.enabled = True
        self.solo = False
        self.mix = 1.0
        self.gain = 1.0
        # Where this slot sits between the speakers, -1..+1. Ramped per block
        # from `_pan_p`, so a swarm-driven sweep is smooth.
        self.pan = 0.0
        self._pan_p = 0.0
        self.param_slew = 0.25
        self.source = "all"
        # Set by the camera sections every block; ramped inside process().
        self.zone_gain = 1.0
        self._zone_g = 1.0

        self.peak = 0.0
        self.latency = 0

        self.pre = dsp.PreChain(sr, n_ch)
        self.post = dsp.PostChain(sr, n_ch)

        self.param_targets = np.zeros(0, dtype=np.float32)
        self.param_smoothed = np.zeros(0, dtype=np.float32)
        self._dry_delay = DelayLine(n_ch)
        self._align_delay = DelayLine(n_ch)

    # -- loading ------------------------------------------------------------

    def load(
        self,
        path: Path,
        validate: bool = False,
        device: str = "cpu",
        data: Optional[bytes] = None,
    ) -> None:
        """Load a .nm model onto `device`. Takes seconds; never from the audio path.

        The metadata, defaults and dry/wet always come from the SDK wrapper on
        the CPU. On a GPU the network is then reloaded onto the device and
        driven directly (runner.py); if that fails for any reason the wrapper is
        kept and the slot says so, rather than the load failing.
        """
        import torch

        path = Path(path)
        if validate:
            from neutone_sdk.utils import load_neutone_model

            model, metadata = load_neutone_model(str(path))
        else:
            extra = {"metadata.json": ""}
            # `data` is the file already in memory, which is how the personal
            # layer loads many copies of one model without rereading it.
            source = io.BytesIO(data) if data is not None else str(path)
            model = torch.jit.load(source, _extra_files=extra)
            metadata = _read_metadata(model, extra)

        if hasattr(model, "prepare_for_inference"):
            model.prepare_for_inference()

        defaults = (
            model.get_default_param_values()
            .detach()
            .reshape(-1)
            .to(torch.float32)
            .numpy()
            .copy()
        )
        params = _read_param_specs(metadata)
        targets = defaults.copy()
        for spec in params:  # metadata defaults win over the tensor's
            if spec.row < targets.shape[0]:
                targets[spec.row] = spec.default
        try:
            mix = float(model.get_wet_default_value())
        except Exception:
            mix = 1.0
        input_mono = bool(model.is_input_mono())

        engine, label = None, "cpu"
        if str(device).startswith("cuda"):
            try:
                engine = runner_mod.load_direct(
                    path,
                    self.sr,
                    self.block,
                    self.n_ch,
                    device,
                    targets.shape[0],
                    targets,
                )
                engine.kind = "gpu"
                label = "gpu"
            except Exception as exc:
                reason = _short_reason(exc)
                label = f"cpu (gpu refused: {reason[:60]})"
                log.warning(
                    "slot %d: %s cannot run on %s (%s); using the CPU",
                    self.index + 1,
                    path.name,
                    device,
                    reason,
                )
                engine = None
        if engine is None:
            engine = SqwEngine(model, self.sr, self.block, targets.shape[0])
        else:
            del model  # the GPU copy is the one that runs; free the CPU weights

        self.metadata = metadata
        self.path = path
        self.name = str(metadata.get("model_name") or path.stem)
        self.params = params
        self.param_targets = targets.copy()
        self.param_smoothed = targets.copy()
        self.mix = mix
        self.input_mono = input_mono
        self.device = label
        self.latency = int(engine.latency)
        self._dry_delay.set_delay(self.latency)
        # Assigned last: the worker treats a non-None model as "fully built".
        self.model = engine
        self.status = "ready"

    def unload(self) -> None:
        self.model = None
        self.metadata = {}
        self.path = None
        self.name = "empty"
        self.status = "empty"
        self.params = []
        self.device = "-"
        self.latency = 0
        self.peak = 0.0
        self._dry_delay.set_delay(0)
        self._align_delay.set_delay(0)

    def set_block(self, block: int) -> None:
        self.block = int(block)
        if self.model is not None:
            self.model.set_block(self.block)
            self.latency = int(self.model.latency)
            self._dry_delay.set_delay(self.latency)

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
        """Slew continuous parameters toward their targets, so a fader move or
        an OSC jump spreads over a few blocks instead of stepping."""
        tgt, cur = self.param_targets, self.param_smoothed
        for spec in self.params:
            if spec.continuous:
                cur[spec.row] += (tgt[spec.row] - cur[spec.row]) * self.param_slew
            else:
                cur[spec.row] = tgt[spec.row]

    def pan_gains(self, n: int):
        """This block's pan gains, ramped from where the slot sat last block."""
        gl, gr = pan_law(self.pan, n, self._pan_p)
        self._pan_p = float(min(max(self.pan, -1.0), 1.0))
        return gl, gr

    def process(self, x: np.ndarray) -> np.ndarray:
        """One block. Runs on the pool, so grad mode is handled inside the
        engines: in PyTorch it is thread-local."""
        if self.model is None:
            return np.zeros_like(x)

        conditioned = self.pre.process(x.copy())
        self._update_params()
        wet = self.model.forward(conditioned, self.param_smoothed)
        if wet.shape != x.shape:  # defensive; both engines normalise channels
            wet = np.resize(wet, x.shape).astype(np.float32)

        wet = self.post.process(wet)
        dry = self._dry_delay.process(x)
        out = self.mix * wet + (1.0 - self.mix) * dry
        out = self._align_delay.process(out)

        g0, g1 = self._zone_g, float(self.zone_gain)
        if abs(g1 - g0) > 1e-5:
            out = out * np.linspace(
                g0 * self.gain, g1 * self.gain, out.shape[1], dtype=np.float32
            )
        else:
            out = out * (g1 * self.gain)
        self._zone_g = g1
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

    def __init__(
        self,
        sr=48000,
        block=512,
        n_ch=1,
        source="device",
        wav=None,
        in_device=None,
        out_device=None,
        prime=3,
        validate=False,
        voices=synth_mod.MAX_VOICES,
        device="cpu",
        torch_threads="auto",
    ) -> None:
        self.sr = sr
        self.block = block
        self.n_ch = n_ch
        self.source = source
        self.wav = wav
        self.in_device = in_device
        self.out_device = out_device
        self.prime = prime
        self.validate = validate

        self.device = runner_mod.resolve_device(device)
        self.torch_threads = torch_threads
        self.slots = [Slot(i, sr, block, n_ch) for i in range(N_SLOTS)]
        self.synth = synth_mod.Synth(sr, n_ch, voices)
        self.zones = zones_mod.CameraZones(N_SLOTS)
        # Split routing: the queen's voice into some models, the crowd into the
        # others, each bus levelled so neither wins on loudness.
        self.split = False
        # shared: every slot hears the input mixer; split: queen and crowd
        # buses; personal: one private model per client (personal.py)
        self.routing = "shared"
        self.personal = personal_mod.PersonalLayer(self)
        self.levellers = {
            "queen": synth_mod.BusLeveller(sr),
            "crowd": synth_mod.BusLeveller(sr),
        }
        self._buses = None
        self.input_gain = {k: 0.0 for k in self.INPUTS}
        self.input_gain["mic" if source == "device" else source] = 1.0
        self.input_peak = 0.0
        # Always try for an input so the mic can be switched on later without
        # a restart; falls back to output only if there is no input device.
        # `duplex` means "an input is wanted", `duplex_active` "one is open".
        self.duplex = True
        self.duplex_active = False
        # Which device channels are used. In: first channel, 0-based, or -1 to
        # average all of them. Out: the first of the pair written to.
        self.in_channel = 0
        self.out_channel = 0
        self._in_open = 1
        self._out_open = 2
        self._in_stream = None
        self.io_mode = "stopped"
        self.input_error = ""
        # Raw device input, before the input gain: for the meter.
        self.mic_peak = 0.0
        self.mic_clips = 0
        self.mic_blocks = 0
        # Loudest peak since the window last asked. The window refreshes ten
        # times a second and blocks arrive about fifty times, so reading the
        # latest block alone would miss most transients.
        self._mic_peak_acc = 0.0
        self._out_peak_acc = 0.0
        # When linked, editing any slot's conditioning edits all four. The
        # four models usually want the same treatment, and keeping them in
        # step by hand across four tabs is where mistakes live.
        self.link_chains = False
        self.cpu = CpuMeter()
        self.master_gain = db_to_gain(-6.0)
        self.master_peak = 0.0
        self.latency = 0

        # The master chain is what protects the PA: everything else is taste.
        # The master chain sits after the pans, so it is stereo whatever the
        # models run at.
        self.master_reverb = dsp.Reverb(sr, OUT_CH)
        self.master_limiter = dsp.Limiter(sr, OUT_CH)
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
        self.tuned_threads = 0
        self._reg_cache = None
        self._reg_cache_version = -1

    # -- models -------------------------------------------------------------

    def load_slot(self, index: int, path) -> None:
        slot = self.slots[index]
        slot.status = "loading"
        try:
            slot.load(Path(path), validate=self.validate, device=self.device)
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
        """Hook up everything that is an identity rather than a value: who is
        present, who left, who wears the crown, and where people stand."""
        receiver.on_queen = self.set_queen
        receiver.on_leave = self.release_voice
        receiver.on_join = self.synth.join
        receiver.on_roster = self.synth.roster
        receiver.on_cam_person = self.zones.on_person
        receiver.on_cam_cluster = self.zones.on_cluster

    def set_queen(self, uid: str, slot: int) -> None:
        self.synth.set_queen(uid, slot)
        log.info("queen: %s (slot %s)", uid or "nobody", slot or "-")

    def release_voice(self, slot: int, uid: str = "") -> None:
        """A phone left, so fade its voice now rather than waiting for the
        timeout. The drone queen is exempt: she is meant to hang on."""
        self.synth.leave(int(slot), uid)

    # -- routing the synth to the slots --------------------------------------

    def set_slot_source(self, index: int, source: str) -> None:
        if source not in SOURCES:
            raise KeyError(source)
        self.slots[index].source = source

    ROUTINGS = ("shared", "split", "personal")

    def set_routing(self, mode: str) -> None:
        """shared, split, or personal. Personal hands the synth voices to one
        model per client and leaves the four slots as templates."""
        if mode not in self.ROUTINGS:
            raise KeyError(mode)
        if mode == "split":
            self.set_split(True)
        elif self.split:
            self.set_split(False)
        self.routing = mode
        if mode == "personal":
            self.select_input("synth")
            self.personal._last_count = -1
        else:
            self.personal.clear()
        log.info("routing: %s", mode)

    def set_split(self, on: bool) -> None:
        """The queen game: her voice into slots 1 and 3, everyone else's into 2
        and 4. Load different models into the odd and even slots and the room
        has to work out which timbre is the queen. Level-changing queen modes
        are bypassed while this is on, so loudness never gives it away."""
        self.split = bool(on)
        self.synth.split = self.split
        if self.split:
            self.routing = "split"
        elif self.routing == "split":
            self.routing = "shared"
        plan = (
            ("queen", "crowd", "queen", "crowd") if self.split else ("all",) * N_SLOTS
        )
        for slot, src in zip(self.slots, plan):
            slot.source = src
        for lv in self.levellers.values():
            lv.reset()
        log.info("split routing %s", "on" if self.split else "off")

    def set_block(self, block: int) -> None:
        """Change the audio block size, restarting the stream if it is running.

        Every loaded model has to be told, because the wrapper sizes its queues
        and its I/O buffers from the block and will not otherwise accept one of
        a different length.
        """
        block = int(block)
        if block == self.block or block < 32:
            return
        was_running = self.running
        if was_running:
            self.stop()
        self.block = block
        with self._lock:
            for s in self.slots:
                s.set_block(block)
            self._rebalance_latency()
        self.personal.set_block(block)
        log.info(
            "block size now %d (%.1f ms), model latency %d samples",
            block,
            1000.0 * block / self.sr,
            self.latency,
        )
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
        if self._reg_cache is None or self._reg_cache_version != self._registry_version:
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
            add(
                f"slot{n}.level",
                "level",
                g,
                LEVEL,
                lambda s=slot: gain_to_db(s.gain),
                lambda v, s=slot: setattr(s, "gain", db_to_gain(v)),
            )
            add(
                f"slot{n}.mix",
                "dry/wet",
                g,
                MIX,
                lambda s=slot: s.mix,
                lambda v, s=slot: setattr(s, "mix", v),
            )
            add(
                f"slot{n}.pan",
                "pan",
                g,
                PAN,
                lambda s=slot: s.pan,
                lambda v, s=slot: setattr(s, "pan", v),
            )
            add(
                f"slot{n}.on",
                "on",
                g,
                SWITCH,
                lambda s=slot: 1.0 if s.enabled else 0.0,
                lambda v, s=slot: setattr(s, "enabled", v >= 0.5),
            )
            add(
                f"slot{n}.source",
                "input",
                g,
                SOURCE,
                lambda s=slot: float(SOURCES.index(s.source)),
                lambda v, s=slot: setattr(
                    s, "source", SOURCES[int(round(v)) % len(SOURCES)]
                ),
            )

            for spec in slot.params:
                add(
                    f"slot{n}.model.p{spec.row + 1}",
                    spec.name,
                    f"slot {n} model",
                    UNIT,
                    lambda s=slot, r=spec.row: s.get_param(r),
                    lambda v, s=slot, r=spec.row: s.set_param(r, v),
                )

            for stage, chain in (("pre", slot.pre), ("post", slot.post)):
                for eff in chain.effects:
                    grp = f"slot {n} {stage} {eff.name}"
                    # Written through the rack rather than straight at the
                    # effect, so "link all slots" works for OSC as well as for
                    # the window.
                    add(
                        f"slot{n}.{stage}.{eff.name}.on",
                        "enabled",
                        grp,
                        SWITCH,
                        lambda e=eff: 1.0 if e.enabled else 0.0,
                        lambda v, st=stage, en=eff.name, sl=slot: self.set_chain_enabled(
                            st, en, v >= 0.5, sl
                        ),
                    )
                    for p in eff.params:
                        add(
                            f"slot{n}.{stage}.{eff.name}.{p.name}",
                            p.label,
                            grp,
                            p,
                            lambda e=eff, nm=p.name: e.get(nm),
                            lambda v, st=stage, en=eff.name, nm=p.name, sl=slot: self.set_chain_param(
                                st, en, nm, v, sl
                            ),
                        )

        # the input mixer: what the four models are chewing on
        for name in self.INPUTS:
            add(
                f"input.{name}",
                name,
                "input",
                LEVEL,
                lambda k=name: gain_to_db(self.input_gain[k]),
                lambda v, k=name: self.input_gain.__setitem__(k, db_to_gain(v)),
            )

        # the synth: one voice per client
        for p in synth_mod.SYNTH_PARAMS:
            add(
                f"synth.{p.name}",
                p.label,
                "synth",
                p,
                lambda nm=p.name: self.synth.get(nm),
                lambda v, nm=p.name: self.synth.set(nm, v),
            )
        for v_i, voice in enumerate(self.synth.voices):
            n = v_i + 1
            grp = f"synth voice {n}"
            for p in synth_mod.VOICE_PARAMS:
                # Any write is proof a client holds this slot, and refreshes
                # the timeout that fades a voice whose phone has gone quiet.
                add(
                    f"synth.voice{n}.{p.name}",
                    p.label,
                    grp,
                    p,
                    lambda vo=voice, nm=p.name: getattr(vo, nm),
                    lambda val, vo=voice, nm=p.name, k=v_i: (
                        setattr(vo, nm, val),
                        self.synth.touch(k),
                    )[0],
                )

        add(
            "routing.split",
            "queen split",
            "routing",
            SWITCH,
            lambda: 1.0 if self.split else 0.0,
            lambda v: self.set_split(v >= 0.5),
        )
        add(
            "routing.mode",
            "routing",
            "routing",
            dsp.Param("mode", "routing", 0.0, len(self.ROUTINGS) - 1.0, 0.0, ""),
            lambda: float(self.ROUTINGS.index(self.routing)),
            lambda v: self.set_routing(
                self.ROUTINGS[int(round(v)) % len(self.ROUTINGS)]
            ),
        )
        for p in personal_mod.PERSONAL_PARAMS:
            add(
                f"personal.{p.name}",
                p.label,
                "personal models",
                p,
                lambda nm=p.name: self.personal.get(nm),
                lambda v, nm=p.name: self.personal.set(nm, v),
            )
        for p in zones_mod.ZONE_PARAMS:
            add(
                f"zones.{p.name}",
                p.label,
                "camera sections",
                p,
                lambda nm=p.name: self.zones.get(nm),
                lambda v, nm=p.name: self.zones.set(nm, v),
            )

        add(
            "master.level",
            "level",
            "master",
            LEVEL,
            lambda: gain_to_db(self.master_gain),
            lambda v: setattr(self, "master_gain", db_to_gain(v)),
        )
        for eff in (self.master_reverb, self.master_limiter):
            grp = f"master {eff.name}"
            add(
                f"master.{eff.name}.on",
                "enabled",
                grp,
                SWITCH,
                lambda e=eff: 1.0 if e.enabled else 0.0,
                lambda v, e=eff: setattr(e, "enabled", v >= 0.5),
            )
            for p in eff.params:
                add(
                    f"master.{eff.name}.{p.name}",
                    p.label,
                    grp,
                    p,
                    lambda e=eff, nm=p.name: e.get(nm),
                    lambda v, e=eff, nm=p.name: e.set(nm, v),
                )
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
            self.paste_chain_into(slot, data)

    def paste_chain_into(self, slot, data: dict) -> None:
        """Apply a snapshot to any Slot object, including a personal copy."""
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
        targets = self.slots if slot_index is None else [self.slots[slot_index]]
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
                self.wav,
                file_sr,
                self.sr,
                file_sr,
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
            out[:, filled : filled + take] = src[
                :, self._src_pos : self._src_pos + take
            ]
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
        """Mix whichever sources are up into the block the models will see.

        Returns the "all" bus; the queen and crowd buses for split routing are
        left in self._buses, rendered from the same pass of the synth.
        """
        g = self.input_gain
        n = self.block
        out = np.zeros((self.n_ch, n), dtype=np.float32)
        if mic is not None and g["mic"] > 1e-4:
            out += mic * g["mic"]
        wants_split = (
            any(sl.source in ("queen", "crowd") for sl in self.slots)
            or self.routing == "personal"
        )
        if g["synth"] > 1e-4 or wants_split:
            full, queen, crowd = self.synth.render_buses(n)
            if g["synth"] > 1e-4:
                out += full[None, :] * g["synth"]
            if wants_split:
                q = self.levellers["queen"].process(queen)
                c = self.levellers["crowd"].process(crowd)
                self._buses = (
                    np.repeat(q[None, :], self.n_ch, axis=0),
                    np.repeat(c[None, :], self.n_ch, axis=0),
                )
            else:
                self._buses = None
        else:
            self._buses = None
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
        outdata.fill(0.0)
        try:
            y = self._out_q.get_nowait()
        except queue.Empty:
            self.underruns += 1
            return
        # Write to the chosen pair and leave every other output channel silent,
        # so a multi-channel interface can feed a particular pair of speakers.
        width = outdata.shape[1]
        left = min(self.out_channel, width - 1)
        right = left + 1
        if y.shape[0] > 1 and right >= width:
            # Only one output channel left: fold the pair back together at the
            # same constant-power law the pans used, so a centred slot keeps
            # its level instead of doubling.
            outdata[:, left] = (y[0] + y[1]) * 0.70710678
            return
        outdata[:, left] = y[0]
        if right < width:
            outdata[:, right] = y[1] if y.shape[0] > 1 else y[0]

    def _capture(self, indata) -> None:
        """Take the chosen channels from a device block and queue them."""
        if self.in_channel < 0:
            mono = indata.mean(axis=1)
            block = np.repeat(mono[None, :], self.n_ch, axis=0)
        else:
            width = indata.shape[1]
            cols = [min(self.in_channel + c, width - 1) for c in range(self.n_ch)]
            block = indata[:, cols].T
        try:
            self._in_q.put_nowait(np.ascontiguousarray(block, dtype=np.float32))
        except queue.Full:
            self.dropped += 1

    def _duplex_cb(self, indata, outdata, frames, time_info, status) -> None:
        if status:
            self.dropped += 1
        self._capture(indata)
        self._push_out(outdata)

    def _input_cb(self, indata, frames, time_info, status) -> None:
        # Only used when input and output could not share one stream.
        if status:
            self.dropped += 1
        self._capture(indata)

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
                # Metered here rather than in the callback, which must stay
                # as short as possible.
                peak = float(np.abs(mic).max()) if mic.size else 0.0
                self.mic_peak = peak
                self.mic_blocks += 1
                if peak > self._mic_peak_acc:
                    self._mic_peak_acc = peak
                if peak >= 0.999:
                    self.mic_clips += 1
            else:
                self.mic_peak = 0.0
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

        mix = np.zeros((OUT_CH, self.block), dtype=np.float32)
        gains = self.zones.update()
        for i, sl in enumerate(self.slots):
            sl.zone_gain = gains[i]
        silence = np.zeros_like(x)
        buses = self._buses
        if self.routing == "personal":
            # The slots are templates now; the private copies are what plays.
            slots = []
            # Private per-client models sit in the middle: they belong to a
            # person in the room, not to a slot with a place in the picture.
            sum_stereo(mix, self.personal.process(self._pool))

        def feed(sl):
            if sl.source == "all":
                return x
            if sl.source == "off" or buses is None:
                return silence
            return buses[0] if sl.source == "queen" else buses[1]

        if slots:
            # Every loaded model runs every block, muted or not: CPU load stays
            # flat and unmuting is instant and still time-aligned. Without a
            # pool they run in turn, so the rack works when driven directly.
            if self._pool is not None:
                pending = [(s, self._pool.submit(s.process, feed(s))) for s in slots]
                results = [(s, f.result) for s, f in pending]
            else:
                results = [(s, lambda s=s: s.process(feed(s))) for s in slots]
            for s, get in results:
                try:
                    out = get()
                except Exception as exc:
                    s.status = f"error: {exc}"
                    log.error("slot %d failed: %s", s.index + 1, exc)
                    continue
                if s.solo if any_solo else s.enabled:
                    gl, gr = s.pan_gains(out.shape[1])
                    sum_stereo(mix, out, gl, gr)
                else:
                    # Keep the pan ramp following even while muted, so unmuting
                    # does not jump the slot across the picture.
                    s.pan_gains(out.shape[1])

        mix = self.master_reverb.process(mix)
        mix = mix * self.master_gain
        mix = self.master_limiter.process(mix)
        self.master_peak = float(np.abs(mix).max()) if mix.size else 0.0
        if self.master_peak > self._out_peak_acc:
            self._out_peak_acc = self.master_peak
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
        self._tune_threads(silence)
        for _ in range(n_blocks):
            self._process_block(silence)
        with self._lock:
            for s in self.slots:
                s.reset()
            self.master_reverb.reset()
            self.master_limiter.reset()
        self.load_pct = 0.0
        self.master_peak = 0.0
        log.debug(
            "warm-up: %d blocks in %.0f ms", n_blocks, 1000 * (time.perf_counter() - t0)
        )

    def _tune_threads(self, silence) -> None:
        """Pick torch's intra-op thread count by timing it, once per start.

        The right number depends on the models and the machine, so it is
        measured, starting from one thread and only stepping up for a clear win.
        GPU slots do almost no CPU work, so they need no tuning.
        """
        import torch

        if self.torch_threads != "auto":
            torch.set_num_threads(max(1, int(self.torch_threads)))
            return
        cpu_slots = [
            sl
            for sl in self.slots
            if sl.model is not None and getattr(sl.model, "kind", "cpu") == "cpu"
        ]
        if not cpu_slots:
            torch.set_num_threads(2)
            self.tuned_threads = 2
            return
        cores = os.cpu_count() or 4
        best, best_t = 1, float("inf")
        for t in (1, 2, 3, 4, 6):
            if t * len(cpu_slots) > cores:
                break
            torch.set_num_threads(t)
            for _ in range(4):
                self._process_block(silence)
            t0 = time.perf_counter()
            for _ in range(6):
                self._process_block(silence)
            took = time.perf_counter() - t0
            # More threads must earn their keep. Torch's workers spin while they
            # wait, so three threads per model cost the four heavy models here
            # 54% of the machine against 15% at one thread, for the same audio
            # speed -- cores the backend and the camera need. Only a clear win
            # (15% faster) justifies stepping up.
            if took < best_t * 0.85:
                best, best_t = t, took
        torch.set_num_threads(best)
        self.tuned_threads = best
        log.info(
            "torch: %d intra-op thread(s) per model is fastest here (%.0f%% "
            "of the block budget)",
            best,
            100.0 * best_t / 6.0 / (self.block / self.sr),
        )

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
            self._out_q.put_nowait(np.zeros((OUT_CH, self.block), dtype=np.float32))

        # Sixteen workers rather than four, so private per-client models run
        # side by side too; idle workers cost nothing.
        self._pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="slot")
        self._warmup()
        self._worker = threading.Thread(target=self._run, name="rack", daemon=True)
        self._worker.start()

        try:
            self._open_streams(sd)
        except Exception:
            self._stop.set()
            self._worker.join(timeout=2.0)
            self._pool.shutdown(wait=False)
            self._close_streams()
            self._worker, self._pool = None, None
            raise

        self.running = True
        log.info(
            "rack running: %d Hz, %d-sample blocks, %s input, model latency %d "
            "samples (%.1f ms)",
            self.sr,
            self.block,
            self.current_input(),
            self.latency,
            1000.0 * self.latency / self.sr,
        )

    def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        self._stop.set()
        self._close_streams()
        if self._worker is not None:
            self._worker.join(timeout=2.0)
            self._worker = None
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None
        self.duplex_active = False
        self.io_mode = "stopped"
        self.mic_peak = 0.0
        log.info("rack stopped")

    # -- devices ------------------------------------------------------------

    def _open_streams(self, sd) -> None:
        """Open the sound card: one duplex stream when possible, else two.

        A duplex stream shares one clock between input and output, which is
        best. PortAudio can only build one when both devices are on the same
        host API, though -- ASIO in with WASAPI out is refused -- so in that case
        the input gets its own stream. The two clocks then drift by a few parts
        per million, which shows up as an occasional dropped or repeated block
        many minutes apart. With no usable input at all, the rack runs output
        only and says why, rather than refusing to start.
        """
        self._stream = None
        self._in_stream = None
        self.duplex_active = False
        self.input_error = ""
        devices_mod.use_preferred_defaults()

        out_info = sd.query_devices(self.out_device, "output")
        max_out = int(out_info["max_output_channels"])
        if max_out < 1:
            raise RuntimeError("the chosen output device has no outputs")
        self._out_open = max(1, min(max_out, self.out_channel + 2))
        common = dict(samplerate=self.sr, blocksize=self.block, dtype="float32")
        out_extra = devices_mod.extra_settings(self.out_device, "out")

        if self.duplex:
            try:
                in_info = sd.query_devices(self.in_device, "input")
                max_in = int(in_info["max_input_channels"])
                if max_in < 1:
                    raise RuntimeError("the chosen input device has no inputs")
                if self.in_channel < 0:
                    self._in_open = min(max_in, 32)
                else:
                    self._in_open = max(1, min(max_in, self.in_channel + self.n_ch))
                in_extra = devices_mod.extra_settings(self.in_device, "in")
                if in_info["hostapi"] == out_info["hostapi"]:
                    try:
                        self._stream = sd.Stream(
                            channels=(self._in_open, self._out_open),
                            device=(self.in_device, self.out_device),
                            callback=self._duplex_cb,
                            extra_settings=(in_extra, out_extra),
                            **common,
                        )
                        self.io_mode = "duplex"
                    except Exception as exc:
                        log.info("duplex stream refused (%s); trying two streams", exc)
                if self._stream is None:
                    self._in_stream = sd.InputStream(
                        channels=self._in_open,
                        device=self.in_device,
                        callback=self._input_cb,
                        extra_settings=in_extra,
                        **common,
                    )
                    self.io_mode = "separate"
                self.duplex_active = True
            except Exception as exc:
                self._in_stream = None
                self.input_error = str(exc).splitlines()[0][:160]
                log.warning(
                    "no audio input (%s); the mic source is off", self.input_error
                )

        if self._stream is None:
            self._stream = sd.OutputStream(
                channels=self._out_open,
                device=self.out_device,
                callback=self._output_cb,
                extra_settings=out_extra,
                **common,
            )
            if not self.duplex_active:
                self.io_mode = "output only"
        if self._in_stream is not None:
            self._in_stream.start()
        self._stream.start()

    def _close_streams(self) -> None:
        for name in ("_in_stream", "_stream"):
            st = getattr(self, name, None)
            if st is not None:
                try:
                    st.stop()
                    st.close()
                except Exception:
                    pass
            setattr(self, name, None)

    def set_audio(
        self,
        in_device="keep",
        out_device="keep",
        in_channel=None,
        out_channel=None,
        input_enabled=None,
    ) -> None:
        """Change devices or channels, restarting the stream if it is running.

        "keep" leaves a device as it is; None means the system default. If the
        new settings will not open, the old ones are put back and the error is
        raised, so a bad choice never leaves the rack silent.
        """
        old = (
            self.in_device,
            self.out_device,
            self.in_channel,
            self.out_channel,
            self.duplex,
        )
        was_running = self.running
        if was_running:
            self.stop()
        if in_device != "keep":
            self.in_device = in_device
        if out_device != "keep":
            self.out_device = out_device
        if in_channel is not None:
            self.in_channel = int(in_channel)
        if out_channel is not None:
            self.out_channel = max(0, int(out_channel))
        if input_enabled is not None:
            self.duplex = bool(input_enabled)
        self.mic_clips = 0
        if not was_running:
            return
        try:
            self.start()
        except Exception:
            (
                self.in_device,
                self.out_device,
                self.in_channel,
                self.out_channel,
                self.duplex,
            ) = old
            try:
                self.start()
            except Exception as exc:
                log.error("could not restore the previous audio devices: %s", exc)
            raise

    def take_peaks(self):
        """(input peak, output peak) since the last call, then start over."""
        mic, out = self._mic_peak_acc, self._out_peak_acc
        self._mic_peak_acc = 0.0
        self._out_peak_acc = 0.0
        return mic, out


# ---------------------------------------------------------------------------
# finding a model's register, and its knobs
# ---------------------------------------------------------------------------
#
# Both probes ask the same question of a private copy of a slot's model:
# "does the output still follow the input?". Morpho models are timbre
# transfer, and a model pushed off its manifold does not go quiet -- it goes
# its own way, often loudly -- so output level points at exactly the wrong
# settings. What disappears off-manifold is the *following*, and that is
# measured: the probe tone carries a slow 5 Hz swell, and the score is how
# strongly that swell shows in the output's envelope (track) times how much
# of the output's energy stays within an octave of the tone (focus).

PROBE_F_MOD = 5.0  # burst rate, well under RAVE's ~23 Hz latent rate
PROBE_FRAME = 256  # envelope frame, ~187 Hz -- plenty for 5 Hz


def _follow_score(
    sl,
    f: float,
    params: np.ndarray,
    block: int,
    sr: int,
    n_ch: int,
    settle: int,
    measure: int,
):
    """(rms, track, focus) of one model's answer to a swelling tone at f Hz."""
    w = 2.0 * np.pi * f / sr
    w_mod = 2.0 * np.pi * PROBE_F_MOD / sr
    pos, taken = 0, []
    for b in range(settle + measure):
        j = np.arange(pos, pos + block, dtype=np.float64)
        pos += block
        # A few harmonics so models trained on voices or instruments have
        # more than a bare sine to recognise; the raised-cosine swell is what
        # the scoring listens for in the output.
        swell = 0.5 - 0.5 * np.cos(w_mod * j)
        mono = (
            (0.3 * np.sin(w * j) + 0.12 * np.sin(2 * w * j) + 0.06 * np.sin(3 * w * j))
            * swell
        ).astype(np.float32)
        x = np.repeat(mono[None, :], n_ch, axis=0)
        y = sl.model.forward(x, params)
        if b >= settle:
            taken.append(y[0].astype(np.float64))
    y0 = np.concatenate(taken)
    rms = float(np.sqrt(np.mean(y0**2)))

    # track: does the output's envelope carry the 5 Hz swell?
    n_fr = y0.shape[0] // PROBE_FRAME
    env = np.sqrt(
        np.mean(y0[: n_fr * PROBE_FRAME].reshape(n_fr, PROBE_FRAME) ** 2, axis=1)
    )
    env -= env.mean()
    ph = 2.0 * np.pi * PROBE_F_MOD * (np.arange(n_fr) * PROBE_FRAME / sr)
    norm = float(np.sqrt(np.sum(env**2)) * np.sqrt(n_fr / 2.0))
    if norm > 1e-9:
        track = min(
            float(np.hypot(np.dot(env, np.cos(ph)), np.dot(env, np.sin(ph))) / norm),
            1.0,
        )
    else:
        track = 0.0

    # focus: does the output live where the input does?
    spec = np.abs(np.fft.rfft(y0)) ** 2
    freqs = np.fft.rfftfreq(y0.shape[0], 1.0 / sr)
    valid = freqs >= 30.0
    total = float(spec[valid].sum())
    band = valid & (freqs >= f / 2.0) & (freqs <= f * 2.0)
    focus = float(spec[band].sum()) / total if total > 1e-12 else 0.0
    return rms, track, focus


def _probe_reference(rack, index: int, repitched: bool) -> float:
    """The register to probe in: where the connected voices sing (geometric
    mean of their pitches, middle C with nobody there), through the slot's
    repitch when ``repitched`` -- so the knob probe hears what the model will
    actually be fed once the register probe has done its work."""
    voiced = [v.pitch for v in rack.synth.voices if v.connected and v.pitch > 0]
    f = float(np.exp(np.mean(np.log(voiced)))) if voiced else 261.6
    if repitched:
        for eff in rack.slots[index].pre.effects:
            if eff.name == "pitch" and eff.enabled:
                f *= 2.0 ** (eff.values["semitones"] / 12.0)
    return min(max(f, 30.0), rack.sr * 0.45)


def probe_pitch(rack, index: int, span: int = 30, step: int = 3, progress=None) -> dict:
    """Which input register does this slot's model answer in?

    Plays the swelling probe tone at every ``step`` semitones within
    ±``span`` of the reference register and scores each step by
    track · focus (see above); steps quieter than 2% of the loudest are
    gated out. A private copy of the model is loaded, so the live one keeps
    playing and keeps its stream state.

    Returns ``offsets``, ``levels`` (the scores), ``best`` (semitones for
    the pre-chain repitch), ``confidence`` (peak score over the median; near
    1 means the model does not care), ``f_ref``/``f_best`` in Hz, and the
    raw ``rms``/``track``/``focus`` curves for the log. Blocking for some
    seconds: call from a background thread, never the audio path.
    """
    slot = rack.slots[index]
    if slot.model is None or slot.path is None:
        raise RuntimeError("no model in this slot")
    # The rack raises the whole process to high priority; drop this thread
    # below normal so probing never starves the models that are playing.
    personal_mod.PersonalLayer._lower_own_priority()
    block, sr, n_ch = rack.block, rack.sr, rack.n_ch
    f_ref = _probe_reference(rack, index, repitched=False)

    sl = Slot(index, sr, block, n_ch)
    sl.load(slot.path, device=rack.device)
    try:
        offsets = [
            o
            for o in range(-span, span + 1, step)
            if 30.0 <= f_ref * 2.0 ** (o / 12.0) <= sr * 0.45
        ]
        settle = max(3, int(np.ceil(sl.latency / block)) + 3)
        measure = max(4, int(np.ceil(0.7 * sr / block)))  # 3.5 swell cycles
        rms_c, track_c, focus_c = [], [], []
        for k, off in enumerate(offsets):
            if progress is not None:
                progress(k + 1, len(offsets))
            rms, track, focus = _follow_score(
                sl,
                f_ref * 2.0 ** (off / 12.0),
                sl.param_smoothed,
                block,
                sr,
                n_ch,
                settle,
                measure,
            )
            rms_c.append(rms)
            track_c.append(track)
            focus_c.append(focus)

        loudest = max(rms_c, default=0.0)
        levels = [
            (t * fo if r >= 0.02 * loudest else 0.0)
            for r, t, fo in zip(rms_c, track_c, focus_c)
        ]
        peak = max(levels) if levels else 0.0
        med = float(np.median(levels)) if levels else 0.0
        best = offsets[int(np.argmax(levels))] if levels else 0
        confidence = peak / med if med > 1e-6 else (2.0 if peak > 0.05 else 1.0)
        log.info(
            "slot %d register probe: best %+d st (%.0f Hz), " "peak/median %.2f",
            index + 1,
            best,
            f_ref * 2.0 ** (best / 12.0),
            confidence,
        )
        for o, r, t, fo, s in zip(offsets, rms_c, track_c, focus_c, levels):
            log.debug(
                "  %+3d st  rms %.3f  track %.2f  focus %.2f  -> %.3f", o, r, t, fo, s
            )
        return {
            "offsets": offsets,
            "levels": levels,
            "best": float(best),
            "confidence": float(confidence),
            "f_ref": f_ref,
            "f_best": f_ref * 2.0 ** (best / 12.0),
            "rms": rms_c,
            "track": track_c,
            "focus": focus_c,
        }
    finally:
        sl.unload()


def probe_params(rack, index: int, progress=None) -> dict:
    """Where do this model's own knobs follow the input best?

    Same question and same score as :func:`probe_pitch`, asked of the
    model's declared parameters (the Morpho plugin's macro knobs -- for RAVE
    typically Chaos, Z edit index, Z scale, Z offset) instead of the input
    register. The probe tone sits at the register the model will actually
    hear: the reference register through the slot's repitch, so running the
    register probe first and this one second composes.

    The search is coordinate descent from the knobs' current values: each
    used parameter in declaration order is swept over a coarse grid (its
    discrete label points if it has labels) with the others held, the best
    value kept; continuous parameters then get a second, finer sweep around
    the winner. Nothing can come out worse than the starting point, because
    the starting point is always among the candidates.

    Returns ``values`` ([(row, name, value)] for the best setting),
    ``score``, ``baseline`` (the score of the current setting),
    ``improvement`` (score/baseline), ``f_probe`` and ``evals``. Blocking
    for some seconds; call from a background thread.
    """
    slot = rack.slots[index]
    if slot.model is None or slot.path is None:
        raise RuntimeError("no model in this slot")
    if not slot.params:
        raise RuntimeError("this model declares no parameters")
    personal_mod.PersonalLayer._lower_own_priority()
    block, sr, n_ch = rack.block, rack.sr, rack.n_ch
    f_probe = _probe_reference(rack, index, repitched=True)

    sl = Slot(index, sr, block, n_ch)
    sl.load(slot.path, device=rack.device)
    try:
        settle = max(3, int(np.ceil(sl.latency / block)) + 3)
        measure = max(4, int(np.ceil(0.5 * sr / block)))  # 2.5 swell cycles
        vec = sl.param_targets.copy()
        for spec in slot.params:  # start from the knobs as they are set now
            if spec.row < vec.shape[0]:
                vec[spec.row] = slot.get_param(spec.row)

        def grid(spec, around=None):
            if not spec.continuous and spec.labels and len(spec.labels) > 1:
                return (
                    None
                    if around is not None
                    else [i / (len(spec.labels) - 1) for i in range(len(spec.labels))]
                )
            if around is None:
                return [0.0, 0.25, 0.5, 0.75, 1.0]
            return [
                min(max(around + d, 0.0), 1.0) for d in (-0.15, -0.075, 0.075, 0.15)
            ]

        # Every candidate that will be scored, counted up front for progress.
        plan = [1]
        for spec in slot.params:
            plan.append(len(grid(spec)))
            if grid(spec, around=0.5) is not None:
                plan.append(4)
        total, done = sum(plan), 0

        def score_at(v):
            nonlocal done
            done += 1
            if progress is not None:
                progress(done, total)
            rms, track, focus = _follow_score(
                sl, f_probe, v, block, sr, n_ch, settle, measure
            )
            return track * focus if rms > 1e-4 else 0.0

        baseline = score_at(vec)
        best = baseline
        for refine in (False, True):
            for spec in slot.params:
                if spec.row >= vec.shape[0]:
                    continue
                cands = grid(spec, around=vec[spec.row] if refine else None)
                if cands is None:
                    continue
                for c in cands:
                    if abs(c - vec[spec.row]) < 1e-3:
                        continue  # already the current value
                    trial = vec.copy()
                    trial[spec.row] = c
                    s = score_at(trial)
                    if s > best:
                        best, vec = s, trial

        # Capped: a baseline of almost zero (the current knobs answer with
        # nothing) makes the ratio meaningless past "much better".
        improvement = (
            min(best / baseline, 99.0)
            if baseline > 1e-6
            else (99.0 if best > 0.05 else 1.0)
        )
        values = [
            (spec.row, spec.name, float(vec[spec.row]))
            for spec in slot.params
            if spec.row < vec.shape[0]
        ]
        log.info(
            "slot %d knob probe at %.0f Hz: %s -- score %.3f vs %.3f "
            "(%.1fx, %d evals)",
            index + 1,
            f_probe,
            ", ".join(f"{n} {v:.2f}" for _, n, v in values),
            best,
            baseline,
            improvement,
            done,
        )
        return {
            "values": values,
            "score": float(best),
            "baseline": float(baseline),
            "improvement": float(improvement),
            "f_probe": f_probe,
            "evals": done,
        }
    finally:
        sl.unload()
