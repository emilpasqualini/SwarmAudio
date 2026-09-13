"""Every client gets their own model.

The shared and split routings put many voices into a few models. This one
gives each phone a private copy of a model, fed by nothing but that person's
voice, so each person in the room has their own neural voice with its own
state -- the per-client layer of CLAUDE.md section 2, built from the pieces
the rack already has.

What decides which model
------------------------
The four slots stop being played directly and become templates. A client's
copy is loaded from its template's .nm file, and every block it takes the
template's model parameters, dry/wet, level fader and camera-section gain, and
every few blocks its conditioning chain. Anything that drives a slot -- a
fader, a chain setup, an OSC route -- therefore drives every client on it.

    round robin   client N uses the Nth loaded template, wrapping around
    one model     everyone uses the first loaded template
    queen apart   the queen's voice goes to a dedicated copy of the first
                  template; everyone else, the queen included when she loses
                  the crown, is spread over the rest. The crown moving is a
                  crossfade between copies that are both already running, so
                  it is instant.

Why joins do not glitch
-----------------------
Loading a model takes from a fraction of a second to several seconds, which the
audio thread cannot wait for. Copies load on three background threads, below
normal priority, from a cached copy of the file, run a few silent blocks to pay
TorchScript's graph optimisation, and only then go live. One spare per template is kept loaded, so the next person
to join gets theirs immediately and a replacement spare loads behind them.

What it costs
-------------
One model per person. On this laptop a light RAVE is a few percent of the
budget per copy and a DDSP model about a quarter of a core, so `max` caps how
many private copies exist; clients past the cap share one overflow copy per
template. Copies run on the rack's thread pool like the slots do, and torch's
intra-op thread count is lowered as copies are added, because many single-voice
models on few threads beat few models fighting over many.
"""

from __future__ import annotations

import io
import logging
import math
import os
import queue
import threading
import time

import numpy as np

from dsp import Param

log = logging.getLogger("morpho_rack.personal")

ASSIGN_MODES = ("round robin", "one model", "queen apart")

PERSONAL_PARAMS = (
    Param("max", "private models", 1.0, 16.0, 6.0, ""),
    Param("assign", "which model", 0.0, len(ASSIGN_MODES) - 1.0, 0.0, ""),
)

CHAIN_SYNC_EVERY = 8   # blocks between conditioning-chain copies from templates
# A copy costs about 0.4 s to load and 1.1 s of warm-up (TorchScript optimises a
# graph on its first passes). Loads parallelise well -- four took 3 s together
# against 6 s one after another -- so a room filling up is served by three.
LOADER_THREADS = 3


class Instance:
    """One private copy: a full Slot (model, chain, strip) and whose it is."""

    __slots__ = ("key", "template", "slot", "path", "input_peak")

    def __init__(self, key, template, slot) -> None:
        self.key = key
        self.template = template
        self.slot = slot
        self.path = slot.path
        self.input_peak = 0.0

    @property
    def label(self) -> str:
        kind = self.key[0]
        if kind == "client":
            return f"client {self.key[1]}"
        if kind == "queen":
            return "the queen"
        return f"overflow on slot {self.template + 1}"


class PersonalLayer:
    def __init__(self, rack) -> None:
        self.rack = rack
        self.values = {p.name: p.default for p in PERSONAL_PARAMS}
        self.instances: dict = {}   # key -> Instance
        self.spares: dict = {}      # template index -> [Slot]
        self.pending: set = set()   # keys (and ("spare", t)) being loaded
        self.route: dict = {}       # voice index -> instance key for its own voice
        self.failures: dict = {}    # template index -> last error text
        self.active = 0
        self._jobs: queue.Queue = queue.Queue()
        self._blobs: dict = {}
        self._blob_lock = threading.Lock()
        self._threads = []
        self._tick = 0
        self._last_count = -1

    # -- parameters ---------------------------------------------------------

    def param(self, name):
        for p in PERSONAL_PARAMS:
            if p.name == name:
                return p
        raise KeyError(name)

    def get(self, name):
        return self.values[name]

    def set(self, name, value):
        p = self.param(name)
        self.values[name] = min(max(float(value), p.lo), p.hi)

    @property
    def assign(self) -> str:
        return ASSIGN_MODES[int(round(self.values["assign"])) % len(ASSIGN_MODES)]

    def set_assign(self, name: str) -> None:
        self.set("assign", float(ASSIGN_MODES.index(name)))

    @property
    def cap(self) -> int:
        return int(round(self.values["max"]))

    # -- who gets which model -----------------------------------------------

    def _templates(self):
        return [i for i, s in enumerate(self.rack.slots) if s.model is not None]

    def template_for(self, client_slot: int, queen: bool = False):
        loaded = self._templates()
        if not loaded:
            return None
        mode = self.assign
        if mode == "one model":
            return loaded[0]
        if mode == "queen apart":
            if queen:
                return loaded[0]
            rest = loaded[1:] or loaded
            return rest[(client_slot - 1) % len(rest)]
        return loaded[(client_slot - 1) % len(loaded)]

    def _wanted(self):
        """The copies that should exist right now: key -> template index."""
        sy = self.rack.synth
        wanted, route = {}, {}
        people = sorted(sy.connected(), key=lambda v: v.slot)
        for n, v in enumerate(people):
            t = self.template_for(v.slot)
            if t is None:
                continue
            key = ("client", v.slot) if n < self.cap else ("overflow", t)
            wanted[key] = t
            route[v.index] = key
        if self.assign == "queen apart" and sy.queen_index >= 0 and people:
            t = self.template_for(0, queen=True)
            if t is not None:
                wanted[("queen",)] = t
        return wanted, route

    # -- keeping the set of copies in step with the room ---------------------

    def sync(self) -> None:
        """Called once per block from the worker. Only bookkeeping happens here;
        anything slow is queued for the loader thread."""
        rack = self.rack
        wanted, route = self._wanted()
        self.route = route

        with rack._lock:
            # retire copies nobody needs, or whose template changed underneath
            for key in list(self.instances):
                inst = self.instances[key]
                t = wanted.get(key)
                tmpl = rack.slots[inst.template]
                if t is None or t != inst.template or tmpl.path != inst.path:
                    del self.instances[key]
                    self._park(inst.template, inst.slot, tmpl.path)
            # create the missing ones, from a spare if there is one
            for key, t in wanted.items():
                if key in self.instances or key in self.pending:
                    continue
                sl = self._take_spare(t)
                if sl is not None:
                    self._activate(key, t, sl)
                else:
                    self.pending.add(key)
                    self._jobs.put((key, t))
            # one spare per template in use, loaded ahead of the next join
            for t in set(wanted.values()):
                if not self.spares.get(t) and ("spare", t) not in self.pending:
                    self.pending.add(("spare", t))
                    self._jobs.put((("spare", t), t))
            # spares for templates no longer loaded are just memory
            for t in list(self.spares):
                if rack.slots[t].model is None:
                    del self.spares[t]
        self._ensure_loader()

        count = len(self.instances)
        if count != self._last_count:
            self._last_count = count
            self._retune_threads(count)

    def _take_spare(self, t):
        pool = self.spares.get(t)
        path = self.rack.slots[t].path
        while pool:
            sl = pool.pop()
            if sl.path == path and sl.block == self.rack.block:
                sl.reset()
                return sl
        return None

    def _park(self, t, sl, template_path) -> None:
        if sl.path == template_path and len(self.spares.setdefault(t, [])) < 1:
            self.spares[t].append(sl)

    def _activate(self, key, t, sl) -> None:
        rack = self.rack
        rack.paste_chain_into(sl, rack.copy_chain(t))
        sl._align_delay.set_delay(max(rack.latency - sl.latency, 0))
        self.instances[key] = Instance(key, t, sl)
        log.debug("personal: %s on slot %d's model", key, t + 1)

    # -- loading off the audio thread ----------------------------------------

    def _ensure_loader(self) -> None:
        self._threads = [t for t in self._threads if t.is_alive()]
        while len(self._threads) < LOADER_THREADS:
            t = threading.Thread(target=self._loader, daemon=True,
                                 name=f"personal-loader-{len(self._threads)}")
            t.start()
            self._threads.append(t)

    def _blob(self, path):
        with self._blob_lock:
            return self._blob_locked(path)

    def _blob_locked(self, path):
        data = self._blobs.get(path)
        if data is None:
            with open(path, "rb") as f:
                data = f.read()
            self._blobs = {path: data, **{k: v for k, v in self._blobs.items()
                                          if k != path}}
            # keep at most four files in memory, one per slot
            while len(self._blobs) > 4:
                self._blobs.pop(next(reversed(self._blobs)))
        return data

    def _load(self, t):
        from rack import Slot

        rack = self.rack
        tmpl = rack.slots[t]
        if tmpl.path is None:
            raise RuntimeError("template slot is empty")
        sl = Slot(t, rack.sr, rack.block, rack.n_ch)
        sl.load(tmpl.path, device=rack.device, data=self._blob(tmpl.path))
        silence = np.zeros((rack.n_ch, rack.block), dtype=np.float32)
        for _ in range(6):
            sl.process(silence)
        sl.reset()
        return sl

    @staticmethod
    def _lower_own_priority() -> None:
        """Loading is urgent-ish; the audio is urgent. The rack raises its whole
        process to high priority, so without this a burst of joins would take
        cores from the models that are already playing."""
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes

            k = ctypes.WinDLL("kernel32")
            k.GetCurrentThread.restype = wintypes.HANDLE
            k.SetThreadPriority.argtypes = (wintypes.HANDLE, ctypes.c_int)
            THREAD_PRIORITY_BELOW_NORMAL = -1
            k.SetThreadPriority(k.GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL)
        except Exception:
            pass

    def _loader(self) -> None:
        self._lower_own_priority()
        while True:
            key, t = self._jobs.get()
            try:
                sl = self._load(t)
                self.failures.pop(t, None)
            except Exception as exc:
                self.failures[t] = str(exc).splitlines()[-1][:120] if str(exc) else repr(exc)
                log.error("personal: could not load a copy of slot %d: %s", t + 1, exc)
                with self.rack._lock:
                    self.pending.discard(key)
                time.sleep(1.0)
                continue
            with self.rack._lock:
                self.pending.discard(key)
                tmpl = self.rack.slots[t]
                if sl.block != self.rack.block:
                    sl.set_block(self.rack.block)
                if tmpl.path != sl.path:
                    continue  # the template changed while this loaded
                if key[0] == "spare" or key in self.instances:
                    self.spares.setdefault(t, []).append(sl)
                else:
                    self._activate(key, t, sl)

    def _retune_threads(self, count: int) -> None:
        if self.rack.routing != "personal":
            return
        try:
            import torch

            cores = os.cpu_count() or 4
            threads = max(1, min(4, cores // max(count, 1)))
            torch.set_num_threads(threads)
        except Exception:
            pass

    # -- the audio ----------------------------------------------------------

    def set_block(self, block: int) -> None:
        with self.rack._lock:
            for inst in self.instances.values():
                inst.slot.set_block(block)
                inst.slot._align_delay.set_delay(max(self.rack.latency - inst.slot.latency, 0))
            for pool in self.spares.values():
                for sl in pool:
                    sl.set_block(block)

    def clear(self) -> None:
        with self.rack._lock:
            self.instances.clear()
            self.spares.clear()

    def _sync_from_templates(self, inst, chains: bool) -> None:
        src = self.rack.slots[inst.template]
        dst = inst.slot
        if src.param_targets.shape == dst.param_targets.shape:
            dst.param_targets[:] = src.param_targets
        dst.mix = src.mix
        dst.gain = src.gain
        dst.zone_gain = src.zone_gain
        want = max(self.rack.latency - dst.latency, 0)
        if dst._align_delay.delay != want:
            dst._align_delay.set_delay(want)
        if chains:
            for s_chain, d_chain in ((src.pre, dst.pre), (src.post, dst.post)):
                for se, de in zip(s_chain.effects, d_chain.effects):
                    de.enabled = se.enabled
                    if de.values != se.values:
                        de.values.update(se.values)
                        de._dirty = True

    def process(self, pool) -> np.ndarray:
        """Render every private copy for this block and mix them."""
        rack = self.rack
        n, n_ch = rack.block, rack.n_ch
        self.sync()
        self._tick += 1
        chains = self._tick % CHAIN_SYNC_EVERY == 0

        with rack._lock:
            instances = list(self.instances.values())
        if not instances:
            self.active = 0
            return np.zeros((n_ch, n), dtype=np.float32)

        sy = rack.synth
        g = 10.0 ** (sy.values["level"] / 20.0)
        feeds = {inst.key: np.zeros(n, dtype=np.float32) for inst in instances}
        queen_key = ("queen",) if ("queen",) in feeds else None
        for vi, (sig, w0, w1) in sy.last_voice_sigs.items():
            own = self.route.get(vi)
            if queen_key is not None and (w0 > 0.0 or w1 > 0.0):
                w = np.linspace(w0, w1, n, dtype=np.float32)
                feeds[queen_key] += sig * w * g
                if own in feeds:
                    feeds[own] += sig * (1.0 - w) * g
            elif own in feeds:
                feeds[own] += sig * g

        any_solo = any(s.solo for s in rack.slots if s.model is not None)
        for inst in instances:
            self._sync_from_templates(inst, chains)

        def job(inst):
            x = feeds[inst.key]
            inst.input_peak = float(np.abs(x).max()) if n else 0.0
            return inst.slot.process(np.repeat(x[None, :], n_ch, axis=0))

        if pool is not None:
            futures = [(inst, pool.submit(job, inst)) for inst in instances]
            results = [(inst, f.result) for inst, f in futures]
        else:
            results = [(inst, lambda i=inst: job(i)) for inst in instances]

        mix = np.zeros((n_ch, n), dtype=np.float32)
        peaks = {}
        heard = 0
        for inst, get in results:
            try:
                out = get()
            except Exception as exc:
                log.error("personal: %s failed: %s", inst.label, exc)
                continue
            tmpl = rack.slots[inst.template]
            peaks[inst.template] = max(peaks.get(inst.template, 0.0), inst.slot.peak)
            if tmpl.solo if any_solo else tmpl.enabled:
                mix += out
                heard += 1
        # N private models summed would be N times louder than one; the square
        # root keeps the room's overall level steady as people arrive, the same
        # rule the synth bank uses for its voices.
        if heard > 1:
            mix /= math.sqrt(heard)
        for i, sl in enumerate(rack.slots):
            sl.peak = peaks.get(i, 0.0)
        self.active = len(instances)
        return mix

    # -- for the window -----------------------------------------------------

    def describe_voice(self, voice_index: int) -> str:
        key = self.route.get(voice_index)
        if key is None:
            return "-"
        inst = self.instances.get(key)
        if inst is None:
            return "loading" if key in self.pending else "waiting"
        name = self.rack.slots[inst.template].name
        if key[0] == "overflow":
            return f"{name} (shared)"
        return name
