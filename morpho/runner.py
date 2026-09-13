"""Running a Neutone model on the GPU, by going around its wrapper.

Why this exists
---------------
Every `.nm` file is a `SampleQueueWrapper` around the actual network. The
wrapper handles buffer-size adaptation and resampling, and it is written so it
cannot leave the CPU: it allocates its queues and I/O buffers as plain tensors
inside TorchScript, reallocates them whenever the block size is set, and its
queue type is a TorchScript class that Python cannot even read. `.to("cuda")`
therefore moves the weights and leaves the plumbing behind, and the first
forward pass dies on a device mismatch.

The network inside, `w2w_base`, has none of that. Its `forward` takes exactly
one native buffer (2048 samples for every model in the library) at its native
sample rate and returns the same. So this module does the wrapper's job in
numpy -- a FIFO in, a FIFO out, a streaming resampler when the rates differ --
and hands only the network to the GPU.

What is kept identical to the wrapper
-------------------------------------
- Parameters go in as a (rows, native buffer) tensor of 0..1 values, which the
  network averages per buffer exactly as it does inside the wrapper.
- The buffering delay is the smallest prefill that can never run dry, the same
  quantity the SDK calls `saturation_n - io_bs`. Reported latency is that plus
  the network's own `calc_model_delay_samples`, so slot alignment still works.
- Resampling is linear, which is what the SDK's own resampler does.

What falls back to the CPU wrapper
----------------------------------
A model with a look-behind buffer (its network reallocates CPU queues too), and
any model whose forward pass fails on the device -- some older exports create
tensors inside `forward` without a device and cannot run on a GPU at all. The
load does a test pass on the device to find out, rather than failing live.
"""

from __future__ import annotations

import logging
import math

import numpy as np

log = logging.getLogger("morpho_rack.runner")


def cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_device(pref: str) -> str:
    """"auto" means the GPU when there is one. An explicit "cuda" on a machine
    without one degrades to the CPU with a warning rather than refusing to run."""
    pref = (pref or "auto").lower()
    if pref in ("auto", "gpu"):
        return "cuda" if cuda_available() else "cpu"
    if pref.startswith("cuda") and not cuda_available():
        log.warning("cuda requested but this torch build has no GPU support; "
                    "using the CPU")
        return "cpu"
    return pref


def buffering_delay(io_bs: int, model_bs: int) -> int:
    """Smallest output prefill that guarantees the output FIFO never runs dry.

    After k callbacks, k*io_bs samples have been asked for and
    model_bs*floor(k*io_bs/model_bs) produced. The shortfall is (k*io_bs) mod
    model_bs, whose maximum over one cycle is the prefill needed.
    """
    if io_bs <= 0 or model_bs <= 0:
        return 0
    cycle = (io_bs * model_bs) // math.gcd(io_bs, model_bs) // io_bs
    return max(((k * io_bs) % model_bs) for k in range(1, cycle + 1))


class LinearResampler:
    """Streaming linear-interpolation resampler for (channels, samples) blocks.

    Linear is what the Neutone SDK uses itself. It is only needed for the few
    models whose native rate differs from the rack's, e.g. 44.1 kHz ones.
    """

    def __init__(self, in_sr: int, out_sr: int, n_ch: int) -> None:
        self.step = float(in_sr) / float(out_sr)
        self.n_ch = n_ch
        self.pos = 0.0
        self.buf = np.zeros((n_ch, 0), dtype=np.float32)

    def reset(self) -> None:
        self.pos = 0.0
        self.buf = np.zeros((self.n_ch, 0), dtype=np.float32)

    def process(self, x: np.ndarray) -> np.ndarray:
        buf = np.concatenate((self.buf, x), axis=1) if self.buf.size else x
        n_in = buf.shape[1]
        if n_in < 2 or self.pos > n_in - 1:
            self.buf = buf
            return np.zeros((self.n_ch, 0), dtype=np.float32)
        count = int(math.floor((n_in - 1 - self.pos) / self.step)) + 1
        idx = self.pos + self.step * np.arange(count)
        i0 = np.floor(idx).astype(np.int64)
        i1 = np.minimum(i0 + 1, n_in - 1)
        frac = (idx - i0).astype(np.float32)
        y = buf[:, i0] * (1.0 - frac) + buf[:, i1] * frac
        nxt = self.pos + self.step * count
        drop = min(int(math.floor(nxt)), n_in)
        self.buf = buf[:, drop:].copy()
        self.pos = nxt - drop
        return y.astype(np.float32, copy=False)


class _Fifo:
    """A growable (channels, samples) FIFO. Numpy slicing, no per-sample work."""

    def __init__(self, n_ch: int) -> None:
        self.n_ch = n_ch
        self.data = np.zeros((n_ch, 0), dtype=np.float32)

    def __len__(self) -> int:
        return self.data.shape[1]

    def push(self, x: np.ndarray) -> None:
        self.data = np.concatenate((self.data, x), axis=1) if len(self) else x.copy()

    def pop(self, n: int) -> np.ndarray:
        out = self.data[:, :n]
        self.data = self.data[:, n:]
        return out

    def clear(self) -> None:
        self.data = np.zeros((self.n_ch, 0), dtype=np.float32)


class DirectRunner:
    """Drives a model's inner network on any device, doing the wrapper's
    buffering in numpy. See the module docstring for why."""

    def __init__(self, scripted, rack_sr: int, block: int, n_ch: int,
                 device: str, param_rows: int) -> None:
        import torch

        self.torch = torch
        self.device = torch.device(device)
        self.w = scripted.w2w_base
        self.n_ch = n_ch
        self.rack_sr = int(rack_sr)
        self.param_rows = int(param_rows)

        if int(self.w.get_look_behind_samples()) > 0:
            raise RuntimeError("model uses a look-behind buffer")

        rates = list(self.w.get_native_sample_rates())
        self.model_sr = self.rack_sr if (not rates or self.rack_sr in rates) else int(rates[0])
        # No declared size means "any", and the wrapper then runs the network at
        # the callback size with no buffering at all; mirror that so latency
        # figures agree with the plugin.
        sizes = list(self.w.get_native_buffer_sizes())
        self.fixed_bs = bool(sizes)
        self.model_bs = int(sizes[0]) if sizes else int(block)
        self.w.set_sample_rate_and_buffer_size(self.model_sr, self.model_bs)

        self.in_ch = 1 if bool(self.w.is_input_mono()) else 2
        self.out_ch = 1 if bool(self.w.is_output_mono()) else 2
        self.model_delay = int(self.w.calc_model_delay_samples())

        self._params = torch.zeros((self.param_rows, self.model_bs),
                                   dtype=torch.float32, device=self.device)
        self._in = torch.zeros((self.in_ch, self.model_bs), dtype=torch.float32,
                               device=self.device)
        self.set_block(block)

    # -- configuration ------------------------------------------------------

    def set_block(self, block: int) -> None:
        self.block = int(block)
        if not self.fixed_bs and self.model_bs != self.block:
            self.model_bs = self.block
            self.w.set_sample_rate_and_buffer_size(self.model_sr, self.model_bs)
            self._params = self.torch.zeros((self.param_rows, self.model_bs),
                                            dtype=self.torch.float32,
                                            device=self.device)
            self._in = self.torch.zeros((self.in_ch, self.model_bs),
                                        dtype=self.torch.float32, device=self.device)
        self.resampling = self.model_sr != self.rack_sr
        if self.resampling:
            self.rs_in = LinearResampler(self.rack_sr, self.model_sr, self.in_ch)
            self.rs_out = LinearResampler(self.model_sr, self.rack_sr, self.out_ch)
            # Resampled callbacks arrive in uneven sizes, so allow one whole
            # native buffer of slack, converted to the rack's rate.
            prefill = int(math.ceil(self.model_bs * self.rack_sr / self.model_sr)) + 2
        else:
            self.rs_in = self.rs_out = None
            prefill = buffering_delay(self.block, self.model_bs)
        self.buffering = prefill
        self.in_fifo = _Fifo(self.in_ch)
        self.out_fifo = _Fifo(self.n_ch)
        self.out_fifo.push(np.zeros((self.n_ch, prefill), dtype=np.float32))
        self.starved = 0

    @property
    def latency(self) -> int:
        model_delay = self.model_delay
        if self.resampling:
            model_delay = int(round(model_delay * self.rack_sr / self.model_sr))
        return int(self.buffering + model_delay)

    def reset(self) -> None:
        self.w.reset()
        self.set_block(self.block)

    # -- processing ---------------------------------------------------------

    def _to_in_channels(self, x: np.ndarray) -> np.ndarray:
        if x.shape[0] == self.in_ch:
            return x
        if self.in_ch == 1:
            return x.mean(axis=0, keepdims=True)
        return np.repeat(x[:1], 2, axis=0)

    def _to_rack_channels(self, y: np.ndarray) -> np.ndarray:
        if y.shape[0] == self.n_ch:
            return y
        if self.n_ch == 1:
            return y.mean(axis=0, keepdims=True)
        return np.repeat(y[:1], self.n_ch, axis=0)

    def forward(self, x: np.ndarray, params: np.ndarray) -> np.ndarray:
        """One rack block in, one rack block out, shaped (channels, block)."""
        torch = self.torch
        x = self._to_in_channels(x)
        if self.rs_in is not None:
            x = self.rs_in.process(x)
        self.in_fifo.push(x)

        if len(self.in_fifo) >= self.model_bs:
            # Parameters are the same for every native buffer this block, so
            # they are uploaded once rather than once per buffer.
            self._params.copy_(torch.from_numpy(params).unsqueeze(1))
            outs = []
            while len(self.in_fifo) >= self.model_bs:
                chunk = self.in_fifo.pop(self.model_bs)
                self._in.copy_(torch.from_numpy(np.ascontiguousarray(chunk)))
                with torch.no_grad():
                    y = self.w.forward(self._in, self._params)
                outs.append(y)
            # One transfer back, however many buffers ran. Each .cpu() waits
            # for the GPU, so this is the only synchronisation per block.
            y = torch.cat(outs, dim=1).to("cpu").numpy()
            if self.rs_out is not None:
                y = self.rs_out.process(y)
            self.out_fifo.push(self._to_rack_channels(y).astype(np.float32, copy=False))

        if len(self.out_fifo) < self.block:
            self.starved += 1
            have = self.out_fifo.pop(len(self.out_fifo))
            pad = np.zeros((self.n_ch, self.block - have.shape[1]), dtype=np.float32)
            return np.concatenate((have, pad), axis=1)
        return self.out_fifo.pop(self.block).copy()


def load_direct(path, rack_sr: int, block: int, n_ch: int, device: str,
                param_rows: int, defaults: np.ndarray):
    """Load a model onto `device` and prove it runs there.

    Returns a DirectRunner, or raises with the reason it cannot, so the caller
    can fall back to the CPU wrapper.
    """
    import torch

    scripted = torch.jit.load(str(path), map_location=device)
    runner = DirectRunner(scripted, rack_sr, block, n_ch, device, param_rows)
    probe = np.zeros((n_ch, block), dtype=np.float32)
    probe[:, ::97] = 0.01
    # Enough blocks to force at least two native forward passes.
    for _ in range(max(3, 2 * runner.model_bs // max(block, 1) + 2)):
        out = runner.forward(probe, defaults)
    if not np.isfinite(out).all():
        raise RuntimeError("non-finite output on the device")
    runner.reset()
    return runner
