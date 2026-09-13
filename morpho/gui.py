"""The window: input, synth voices, rack, conditioning, OSC routing, library.

Five tabs, because there is far too much here for one pane:

  rack     the four slots -- model, level, dry/wet, the model's own parameters
  synth    one sine voice per client, which can feed the models instead of a mic
  chain    one slot's pre- and post-conditioning, and the named setups
  osc      the receive port, what is arriving, and what it drives
  library  the official Neutone models, and downloading them

Everything on screen is driven by `Rack.registry()`, so a knob added in dsp.py
or synth.py appears here and becomes OSC-routable without this file knowing
about it.

The routing editor is built around one distinction: swarm addresses describe the
crowd and belong on the collective layer, client addresses describe one phone
and belong on that phone's voice. Both the source list and the target list are
grouped that way, and picking a client pre-selects its voice.

Sliders show values that OSC is changing underneath you, which is the point of
the osc tab: you want to see the swarm moving a fader. A row being dragged is
left alone until the mouse comes up, or the two fight.
"""

from __future__ import annotations

import logging
import queue
import socket
import threading
import time
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np

import devices as devices_mod
import dsp
import oscmap
import synth as synth_mod
from rack import N_SLOTS, SOURCES, gain_to_db, probe_pitch
import personal as personal_mod
import zones as zones_mod

log = logging.getLogger("morpho_rack.gui")


class ParamRow:
    """A label, a slider and a readout, bound to one ParamRef."""

    def __init__(self, parent, ref, width=200, label_width=24):
        self.ref = ref
        self.dragging = False
        self.frame = ttk.Frame(parent)
        self.frame.pack(fill="x", pady=1)

        self.text = tk.StringVar()
        ttk.Label(self.frame, textvariable=self.text, width=label_width,
                  anchor="w").pack(side="left")
        self.var = tk.DoubleVar(value=ref.spec.to_norm(ref.get()))
        self.scale = ttk.Scale(self.frame, from_=0.0, to=1.0, variable=self.var,
                               command=self._changed, length=width)
        self.scale.pack(side="left", fill="x", expand=True)
        self.scale.bind("<ButtonPress-1>", self._grab)
        self.scale.bind("<ButtonRelease-1>", self._release)
        self._label()

    def _grab(self, _e=None):
        self.dragging = True

    def _release(self, _e=None):
        self.dragging = False

    def _changed(self, _v=None):
        self.ref.set(self.ref.spec.from_norm(float(self.var.get())))
        self._label()

    def _label(self):
        # Setting a Tk variable redraws the widget even when nothing changed,
        # and with forty rows at 10 Hz that is measurable; compare first.
        text = f"{self.ref.label}  {self.ref.text()}"
        if text != getattr(self, "_last_text", None):
            self._last_text = text
            self.text.set(text)

    def refresh(self):
        """Pull the value back in, for knobs OSC or a preset moved."""
        if self.dragging:
            return
        pos = self.ref.spec.to_norm(self.ref.get())
        if abs(pos - float(self.var.get())) > 1e-4:
            self.var.set(pos)
        self._label()

    def destroy(self):
        self.frame.destroy()


class SwitchRow:
    """A checkbox bound to a 0/1 ParamRef."""

    def __init__(self, parent, ref, text=None):
        self.ref = ref
        self.var = tk.BooleanVar(value=ref.get() >= 0.5)
        self.widget = ttk.Checkbutton(parent, text=text or ref.label,
                                      variable=self.var, command=self._changed)
        self.dragging = False

    def _changed(self):
        self.ref.set(1.0 if self.var.get() else 0.0)

    def refresh(self):
        on = self.ref.get() >= 0.5
        if on != self.var.get():
            self.var.set(on)

    def destroy(self):
        self.widget.destroy()


class LoadGraph:
    """Two traces: how much of a block's budget the audio work takes, and how
    much of the machine the whole process takes.

    They answer different questions. The budget trace says whether the stream
    is about to break up; the CPU trace says whether there is room for anything
    else, which matters when the camera and the backend share the laptop.
    """

    def __init__(self, parent, width=230, height=46, span=180):
        self.width, self.height = width, height
        self.budget = deque([0.0] * span, maxlen=span)
        self.cpu = deque([0.0] * span, maxlen=span)
        self.canvas = tk.Canvas(parent, width=width, height=height,
                                bg="#f4f4f4", highlightthickness=1,
                                highlightbackground="#ccc")
        self.text = tk.StringVar()

    def push(self, budget_pct, cpu_pct):
        self.budget.append(max(0.0, min(float(budget_pct), 150.0)))
        self.cpu.append(max(0.0, min(float(cpu_pct), 150.0)))

    def draw(self):
        c = self.canvas
        c.delete("all")
        h, w = self.height, self.width
        # 100% of the budget is the line the stream breaks above
        for frac, colour in ((0.7, "#e0e0e0"), (1.0, "#f0c0c0")):
            y = h - h * frac / 1.5
            c.create_line(0, y, w, y, fill=colour)
        n = len(self.budget)
        step = w / max(n - 1, 1)
        for series, colour in ((self.cpu, "#6aa0d8"), (self.budget, "#d86a6a")):
            pts = []
            for i, v in enumerate(series):
                pts += [i * step, h - h * (v / 150.0)]
            if len(pts) >= 4:
                c.create_line(*pts, fill=colour, width=1)


def local_addresses() -> list:
    """This machine's IPv4 addresses, the one that routes to the LAN first.

    Connecting a UDP socket sends nothing; it only asks the OS which interface
    it would use, which is the address the backend's dashboard needs. The rest
    come from the host name, minus loopback. CLAUDE.md warns the Mac's LAN IP
    changes; this laptop's can too, so it is re-read every few seconds.
    """
    ips = []
    for probe in ("10.255.255.255", "192.168.255.255"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
                sk.connect((probe, 1))
                ip = sk.getsockname()[0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
        except OSError:
            pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips or ["127.0.0.1"]


class HiddenAddress:
    """A label that shows this machine's OSC address only on request.

    Hidden by default because the window may be on a projector or in a
    screenshot. Hovering reveals it; clicking keeps it revealed until the next
    click; double-clicking copies it to the clipboard.
    """

    MASK = "osc address \u25b8 hover or click"

    def __init__(self, parent, root, port_fn, listening_fn) -> None:
        self.root = root
        self.port_fn = port_fn
        self.listening_fn = listening_fn
        self.pinned = False
        self.hovering = False
        self.ips = local_addresses()
        self._read_at = time.monotonic()
        self.var = tk.StringVar(value=self.MASK)
        self.label = ttk.Label(parent, textvariable=self.var, foreground="#666",
                               cursor="hand2")
        self.label.bind("<Enter>", self._enter)
        self.label.bind("<Leave>", self._leave)
        self.label.bind("<Button-1>", self._click)
        self.label.bind("<Double-Button-1>", self._copy)

    def text(self) -> str:
        port = self.port_fn()
        where = "   ".join(f"{ip}:{port}" for ip in self.ips)
        state = "" if self.listening_fn() else "   (not listening)"
        return f"osc to {where}{state}"

    def refresh(self) -> None:
        if time.monotonic() - self._read_at > 5.0:
            # Off the GUI thread: resolving the host name can stall for seconds
            # on a network with broken DNS, and this runs ten times a second.
            self._read_at = time.monotonic()
            threading.Thread(target=self._reread, daemon=True).start()
        want = self.text() if (self.pinned or self.hovering) else self.MASK
        if self.var.get() != want:
            self.var.set(want)

    def _reread(self) -> None:
        self.ips = local_addresses()

    def _enter(self, _e=None):
        self.hovering = True
        self.refresh()

    def _leave(self, _e=None):
        self.hovering = False
        self.refresh()

    def _click(self, _e=None):
        self.pinned = not self.pinned
        self.refresh()

    def _copy(self, _e=None):
        self.pinned = True
        self.root.clipboard_clear()
        self.root.clipboard_append(f"{self.ips[0]}:{self.port_fn()}")
        self.var.set(self.text() + "   copied")


class LevelMeter:
    """A peak meter in dB with a held peak and a clip light.

    It falls at a fixed rate rather than jumping to each new reading, so a
    transient stays on screen long enough to read. The peak line holds for a
    moment, and the clip light stays lit until clicked: a clip lasting one
    block is long over by the time anyone looks.
    """

    FLOOR = -60.0
    FALL_DB_PER_S = 24.0
    HOLD_S = 1.5
    ZONES = ((-60.0, -12.0, "#5cb85c"), (-12.0, -3.0, "#e0b030"), (-3.0, 0.0, "#d9534f"))

    def __init__(self, parent, width=120, height=12):
        self.width, self.height = width, height
        self.canvas = tk.Canvas(parent, width=width + height + 3, height=height,
                                highlightthickness=0, bg="#f4f4f4", cursor="hand2")
        c = self.canvas
        c.create_rectangle(0, 0, width, height, fill="#2b2b2b", outline="")
        for db in (-48, -36, -24, -12, -6):
            x = self._x(db)
            c.create_line(x, 0, x, height, fill="#4a4a4a")
        self.bars = [c.create_rectangle(self._x(lo), 1, self._x(lo), height - 1,
                                        fill=col, outline="")
                     for lo, _hi, col in self.ZONES]
        self.hold_line = c.create_line(0, 0, 0, height, fill="#e8e8e8", state="hidden")
        self.lamp = c.create_rectangle(width + 3, 0, width + 3 + height, height,
                                       fill="#555", outline="")
        c.bind("<Button-1>", self.clear_clip)
        self.level = self.FLOOR
        self.hold = self.FLOOR
        self.hold_until = 0.0
        self.clipped = False
        self._clips_seen = 0
        self._t = time.monotonic()
        self._drawn = None

    def _x(self, db: float) -> float:
        db = min(max(db, self.FLOOR), 0.0)
        return self.width * (db - self.FLOOR) / -self.FLOOR

    def push(self, peak, now=None) -> float:
        """Feed the loudest sample since the last call; None means no new audio,
        which lets the bar fall without pretending there was silence."""
        now = time.monotonic() if now is None else now
        dt = min(max(now - self._t, 0.0), 1.0)
        self._t = now
        fall = self.FALL_DB_PER_S * dt
        db = self.FLOOR
        if peak is not None and peak > 0.0:
            db = max(self.FLOOR, gain_to_db(peak))
        self.level = max(db if peak is not None else self.FLOOR, self.level - fall)
        if peak is not None and db >= self.hold:
            self.hold = db
            self.hold_until = now + self.HOLD_S
        elif now > self.hold_until:
            self.hold = max(self.level, self.hold - 2.0 * fall)
        self.draw()
        return db

    def idle(self) -> None:
        """Nothing to show: drop straight to the floor."""
        self.level = self.hold = self.FLOOR
        self.draw()

    def clips(self, count: int) -> None:
        """Latch the light when the owner's clip counter has moved on."""
        if count > self._clips_seen:
            self.clipped = True
        self._clips_seen = count

    def clear_clip(self, _e=None) -> None:
        self.clipped = False
        self.draw()

    def draw(self) -> None:
        state = (round(self._x(self.level)), round(self._x(self.hold)), self.clipped)
        if state == self._drawn:
            return
        self._drawn = state
        c, h = self.canvas, self.height
        for item, (lo, hi, _col) in zip(self.bars, self.ZONES):
            right = min(self.level, hi)
            c.coords(item, self._x(lo), 1, self._x(max(right, lo)), h - 1)
        if self.hold > self.FLOOR + 0.5:
            x = self._x(self.hold)
            c.coords(self.hold_line, x, 0, x, h)
            c.itemconfigure(self.hold_line, state="normal")
        else:
            c.itemconfigure(self.hold_line, state="hidden")
        c.itemconfigure(self.lamp, fill="#e02020" if self.clipped else "#555")


NO_INPUT = "(no input)"


def meter_value(peak: float) -> float:
    """dB over the top 60 dB; a linear meter shows almost nothing."""
    return float(np.clip((gain_to_db(peak) + 60.0) / 60.0, 0.0, 1.0) * 100.0)


def _target_sort_key(group: str) -> tuple:
    """Order target groups the way the signal flows."""
    order = ("input", "synth", "synth voice", "slot", "master")
    for i, prefix in enumerate(order):
        if group.startswith(prefix):
            return (i, group)
    return (len(order), group)


class App:
    def __init__(self, rack, library, receiver, preset_dir: Path):
        self.rack = rack
        self.library = library
        self.osc = receiver
        self.preset_dir = Path(preset_dir)

        self.root = tk.Tk()
        self.root.title("morpho rack -- four Neutone models, driven by the swarm")
        self.root.minsize(1120, 800)
        try:
            ttk.Style().theme_use("clam")
        except tk.TclError:
            pass

        self.reg = rack.registry()
        self._pending_after = None
        self._picker_entries = {}
        self._tick = 0
        # Work finished on background threads (loads, downloads) hands its
        # window updates over here instead of touching Tk itself. Tkinter is
        # not thread-safe: calling it from another thread works most of the
        # time and then fails with "main thread is not in main loop".
        self._ui_calls: queue.Queue = queue.Queue()

        self._build_transport()
        self.tabs = ttk.Notebook(self.root)
        self.tabs.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.tab_rack = ttk.Frame(self.tabs, padding=8)
        self.tab_synth = ttk.Frame(self.tabs, padding=8)
        self.tab_chain = ttk.Frame(self.tabs, padding=8)
        self.tab_osc = ttk.Frame(self.tabs, padding=8)
        self.tab_lib = ttk.Frame(self.tabs, padding=8)
        for frame, name in ((self.tab_rack, "rack"), (self.tab_synth, "synth"),
                            (self.tab_chain, "chain"), (self.tab_osc, "osc"),
                            (self.tab_lib, "library")):
            self.tabs.add(frame, text=f"  {name}  ")

        self._build_rack()
        self._build_synth()
        self._build_chain()
        self._build_osc()
        self._build_library()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._refresh()

    # -- transport ----------------------------------------------------------

    def _build_transport(self):
        bar = ttk.Frame(self.root, padding=8)
        bar.pack(fill="x")

        self.start_btn = ttk.Button(bar, text="start", command=self._toggle)
        self.start_btn.pack(side="left")
        ttk.Button(bar, text="reset", command=self.rack.reset_models).pack(
            side="left", padx=(6, 12))

        ttk.Label(bar, text="feed the models:").pack(side="left")
        self.input_var = tk.StringVar(value=self.rack.current_input())
        for name, label in (("mic", "mic"), ("synth", "synth"), ("both", "both"),
                            ("file", "file"), ("test", "test")):
            ttk.Radiobutton(bar, text=label, value=name, variable=self.input_var,
                            command=self._select_input).pack(side="left")

        ttk.Button(bar, text="save preset", command=self._save_preset).pack(
            side="left", padx=(12, 2))
        ttk.Button(bar, text="load preset", command=self._load_preset).pack(
            side="left", padx=(0, 12))
        self.status = tk.StringVar(value="stopped")
        ttk.Label(bar, textvariable=self.status).pack(side="left")

        row2 = ttk.Frame(self.root, padding=(8, 0, 8, 6))
        row2.pack(fill="x")
        ttk.Label(row2, text="block").pack(side="left")
        self.block_var = ttk.Combobox(
            row2, state="readonly", width=6,
            values=["128", "256", "512", "1024", "2048", "4096"])
        self.block_var.set(str(self.rack.block))
        self.block_var.pack(side="left", padx=(3, 2))
        self.block_var.bind("<<ComboboxSelected>>", self._change_block)
        self.block_note = tk.StringVar()
        ttk.Label(row2, textvariable=self.block_note, foreground="#666").pack(
            side="left", padx=(0, 14))
        self._block_note()

        self.device_note = tk.StringVar(value=f"networks on {self.rack.device}")
        ttk.Label(row2, textvariable=self.device_note, foreground="#666").pack(
            side="left", padx=(0, 14))

        self.address = HiddenAddress(
            row2, self.root,
            port_fn=lambda: self._current_port(),
            listening_fn=lambda: self.osc.running)
        self.address.label.pack(side="left", padx=(0, 14))

        self.graph = LoadGraph(row2)
        self.graph.canvas.pack(side="right")
        ttk.Label(row2, textvariable=self.graph.text, foreground="#666").pack(
            side="right", padx=6)

        self._build_audio_io()

    # -- audio devices ------------------------------------------------------

    def _build_audio_io(self):
        row = ttk.Frame(self.root, padding=(8, 0, 8, 6))
        row.pack(fill="x")
        # Device names run long ("Microphone Array (2- Intel® Smart Sound
        # Technology for Digital Microphones) · WASAPI · 4 ch") and the row has
        # no room for them, so the list that drops down is wider than the box.
        ttk.Style().configure("Device.TCombobox", postoffset=(0, 0, 390, 0))

        ttk.Label(row, text="in").pack(side="left")
        self.in_box = ttk.Combobox(row, state="readonly", width=30,
                                   style="Device.TCombobox")
        self.in_box.pack(side="left", padx=(3, 2))
        self.in_box.bind("<<ComboboxSelected>>", self._pick_in_device)
        self.in_ch = ttk.Combobox(row, state="readonly", width=5)
        self.in_ch.pack(side="left", padx=(0, 6))
        self.in_ch.bind("<<ComboboxSelected>>", self._pick_in_channel)
        self.in_meter = LevelMeter(row)
        self.in_meter.canvas.pack(side="left")
        self.in_level = tk.StringVar(value="-")
        ttk.Label(row, textvariable=self.in_level, width=15, foreground="#666").pack(
            side="left", padx=(4, 10))

        ttk.Label(row, text="out").pack(side="left")
        self.out_box = ttk.Combobox(row, state="readonly", width=30,
                                    style="Device.TCombobox")
        self.out_box.pack(side="left", padx=(3, 2))
        self.out_box.bind("<<ComboboxSelected>>", self._pick_out_device)
        self.out_ch = ttk.Combobox(row, state="readonly", width=5)
        self.out_ch.pack(side="left", padx=(0, 6))
        self.out_ch.bind("<<ComboboxSelected>>", self._pick_out_channel)
        self.out_meter = LevelMeter(row, width=90)
        self.out_meter.canvas.pack(side="left")

        ttk.Button(row, text="rescan", width=7, command=self._rescan_devices).pack(
            side="left", padx=(10, 6))
        self.io_note = tk.StringVar()
        ttk.Label(row, textvariable=self.io_note, foreground="#666").pack(side="left")

        self._in_zero_ticks = 0
        self._in_blocks_seen = 0
        self._fill_devices()

    def _fill_devices(self):
        """List what PortAudio can see, lowest-latency host API first."""
        try:
            inputs, outputs, d_in, d_out = devices_mod.scan(self.rack.sr)
        except Exception as exc:
            log.error("could not list audio devices: %s", exc)
            inputs, outputs, d_in, d_out = [], [], None, None
        self._default_in, self._default_out = d_in, d_out
        self._in_devs = {d.index: d for d in inputs}
        self._out_devs = {d.index: d for d in outputs}

        # No separate "system default" entry: it is one of the devices listed,
        # and showing it twice is what this list is meant to stop. A rack left
        # on the default shows that device selected instead.
        def choices(pool, kind, default):
            out = {}
            if kind == "in":
                out[NO_INPUT] = "off"
            for d in pool:
                label = d.label(kind)
                if label in out:           # two identical interfaces plugged in
                    label = f"{label}  #{d.index}"
                out[label] = d.index
            return out

        self._in_choices = choices(inputs, "in", d_in)
        self._out_choices = choices(outputs, "out", d_out)
        self.in_box["values"] = list(self._in_choices)
        self.out_box["values"] = list(self._out_choices)
        self._show_audio_choice()

    def _resolve(self, dev, kind):
        """A device as the rack holds it (None, an index, or a name from the
        command line) as an index into the scanned list, or None."""
        if dev is None or isinstance(dev, int):
            return dev
        try:
            import sounddevice as sd

            return int(sd.query_devices(dev, "input" if kind == "in" else "output")["index"])
        except Exception:
            return None

    def _show_audio_choice(self):
        """Make both rows say what the rack is actually using."""
        r = self.rack

        def label_for(choices, value, default, kind):
            if value is None:
                value = default
            for label, v in choices.items():
                if v == value and v != "off":
                    return label
            # a device given on the command line from a host API not listed
            return "" if value is None else devices_mod.describe(value, kind)

        in_idx = self._resolve(r.in_device, "in")
        self.in_box.set(NO_INPUT if not r.duplex
                        else label_for(self._in_choices, in_idx, self._default_in, "in"))
        dev = self._in_devs.get(in_idx if in_idx is not None else self._default_in)
        width = r.n_ch
        values = devices_mod.channel_choices(dev.max_in if dev else width, width, "in")
        self.in_ch["values"] = values
        self.in_ch.set(devices_mod.channel_label(r.in_channel, width, "in"))
        self.in_ch.config(state="readonly" if r.duplex else "disabled")

        out_idx = self._resolve(r.out_device, "out")
        self.out_box.set(label_for(self._out_choices, out_idx, self._default_out, "out"))
        dev = self._out_devs.get(out_idx if out_idx is not None else self._default_out)
        max_out = dev.max_out if dev else 2
        values = devices_mod.channel_choices(max_out, 2, "out")
        self.out_ch["values"] = values
        self.out_ch.set("1" if max_out <= 1 else
                        devices_mod.channel_label(r.out_channel, 2, "out"))

    def _apply_audio(self, **changes):
        """Hand a device change to the rack, which restarts the stream if it
        runs and puts the old devices back if the new ones will not open."""
        self.root.config(cursor="watch")
        self.root.update_idletasks()
        try:
            self.rack.set_audio(**changes)
        except Exception as exc:
            first = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
            messagebox.showerror(
                "audio device",
                f"that device would not open, so the previous one is still in use.\n\n"
                f"{first}")
        finally:
            self.root.config(cursor="")
        self.start_btn.config(text="stop" if self.rack.running else "start")
        self.in_meter.idle()
        self.out_meter.idle()
        self._in_zero_ticks = 0
        self._show_audio_choice()
        devices_mod.save(self.preset_dir / "audio.json", self.rack)

    def _pick_in_device(self, _e=None):
        value = self._in_choices.get(self.in_box.get())
        if value == "off":
            self._apply_audio(input_enabled=False)
            return
        dev = self._in_devs.get(value if value is not None else self._default_in)
        ch = self.rack.in_channel
        if dev is not None:
            if dev.max_in < self.rack.n_ch:
                ch = -1                    # a mono mic into a stereo rack
            elif ch + self.rack.n_ch > dev.max_in:
                ch = 0
        self._apply_audio(in_device=value, in_channel=ch, input_enabled=True)

    def _pick_in_channel(self, _e=None):
        ch = devices_mod.parse_channel(self.in_ch.get())
        if ch != self.rack.in_channel:
            self._apply_audio(in_channel=ch)

    def _pick_out_device(self, _e=None):
        value = self._out_choices.get(self.out_box.get())
        dev = self._out_devs.get(value if value is not None else self._default_out)
        ch = self.rack.out_channel
        if dev is not None and ch + 2 > max(dev.max_out, 2):
            ch = 0
        self._apply_audio(out_device=value, out_channel=ch)

    def _pick_out_channel(self, _e=None):
        ch = max(0, devices_mod.parse_channel(self.out_ch.get()))
        if ch != self.rack.out_channel:
            self._apply_audio(out_channel=ch)

    def _rescan_devices(self):
        """Look for hardware plugged in since start.

        PortAudio can only re-enumerate with every stream closed, and device
        indices shift when it does, so the rack is stopped, the devices it was
        using are found again by name, and it starts again."""
        r = self.rack
        was_running = r.running
        keep_in = devices_mod.identity(r.in_device, "in")
        keep_out = devices_mod.identity(r.out_device, "out")
        if was_running:
            r.stop()
        try:
            devices_mod.rescan()
        except Exception as exc:
            log.error("rescan failed: %s", exc)
        lost = []
        new_in = devices_mod.find(keep_in, "in", r.sr) if keep_in else None
        new_out = devices_mod.find(keep_out, "out", r.sr) if keep_out else None
        if keep_in and new_in is None:
            lost.append(f"{keep_in['name']} · {keep_in['api']}")
        if keep_out and new_out is None:
            lost.append(f"{keep_out['name']} · {keep_out['api']}")
        r.set_audio(in_device=new_in, out_device=new_out)
        if was_running:
            try:
                r.start()
            except Exception as exc:
                messagebox.showerror("audio device", str(exc))
        self.start_btn.config(text="stop" if r.running else "start")
        self._fill_devices()
        if lost:
            messagebox.showinfo(
                "audio device",
                "no longer plugged in, using the system default instead:\n\n"
                + "\n".join(lost))

    def _refresh_audio_io(self):
        r = self.rack
        mic, out = r.take_peaks()
        now = time.monotonic()
        self.in_meter.clips(r.mic_clips)
        self.out_meter.clips(r.clips)

        if not r.running:
            self.in_meter.idle()
            self.out_meter.idle()
            text = "input off" if not r.duplex else "stopped"
            note = "" if r.duplex else "no input device opened"
        elif not r.duplex_active:
            self.in_meter.idle()
            self.out_meter.push(out, now)
            text = "input off" if not r.duplex else "no input"
            note = ("output only" if not r.input_error
                    else f"input would not open: {r.input_error}")
        else:
            # No new block since the last look is not silence -- a 4096-sample
            # block arrives only every 85 ms, slower than this refresh.
            fresh = r.mic_blocks != self._in_blocks_seen
            self._in_blocks_seen = r.mic_blocks
            self.in_meter.push(mic if fresh else None, now)
            self.out_meter.push(out, now)
            if fresh:
                self._in_zero_ticks = self._in_zero_ticks + 1 if mic == 0.0 else 0
            level = self.in_meter.level
            if self._in_zero_ticks >= 10:
                # Exact zeros, not merely quiet: a real microphone always has
                # some noise, so this is a mute switch or a zeroed input level.
                text = "silent (muted?)"
            elif level <= LevelMeter.FLOOR:
                text = "below -60 dB"
            else:
                text = f"{level:.0f} dB"
            note = {"duplex": "in and out share one clock",
                    "separate": "in and out on separate clocks"}.get(r.io_mode, r.io_mode)
        if self.in_level.get() != text:
            self.in_level.set(text)
        if self.io_note.get() != note:
            self.io_note.set(note)

    def _current_port(self):
        if self.osc.running:
            return self.osc.port
        try:
            return int(self.port_var.get())
        except (AttributeError, ValueError):
            return self.osc.port

    def _block_note(self):
        ms = 1000.0 * self.rack.block / self.rack.sr
        self.block_note.set(f"{ms:.1f} ms per block")

    def _change_block(self, _e=None):
        try:
            want = int(self.block_var.get())
        except ValueError:
            return
        if want == self.rack.block:
            return
        try:
            # Restarts the stream and re-tells every model, so it takes a
            # moment and the button state has to follow.
            self.rack.set_block(want)
        except Exception as exc:
            messagebox.showerror("block size", str(exc))
            self.block_var.set(str(self.rack.block))
            return
        self._block_note()
        self.start_btn.config(text="stop" if self.rack.running else "start")
        self._rebuild_all()

    def _select_input(self):
        self.rack.select_input(self.input_var.get())

    def _toggle(self):
        try:
            if self.rack.running:
                self.rack.stop()
                self.start_btn.config(text="start")
            else:
                self.rack.start()
                self.start_btn.config(text="stop")
        except Exception as exc:
            messagebox.showerror("audio error", str(exc))

    def _save_preset(self):
        self.preset_dir.mkdir(parents=True, exist_ok=True)
        p = filedialog.asksaveasfilename(
            title="save preset", defaultextension=".json",
            initialdir=str(self.preset_dir), filetypes=[("preset", "*.json")])
        if p:
            self.rack.save_preset(p)

    def _load_preset(self):
        p = filedialog.askopenfilename(
            title="load preset", initialdir=str(self.preset_dir),
            filetypes=[("preset", "*.json")])
        if p:
            self.rack.load_preset(p)
            self._rebuild_all()

    # -- rack tab -----------------------------------------------------------

    def _build_rack(self):
        body = self.tab_rack
        for i in range(N_SLOTS):
            body.columnconfigure(i, weight=1, uniform="slot")
        body.rowconfigure(0, weight=1)
        self.slot_ui = [self._build_slot(body, i) for i in range(N_SLOTS)]

        routing = ttk.Frame(body)
        routing.grid(row=1, column=0, columnspan=N_SLOTS, sticky="ew", pady=(8, 0))
        ttk.Label(routing, text="routing").pack(side="left")
        self.routing_var = tk.StringVar(value=self.rack.routing)
        for mode, label in (("shared", "shared"), ("split", "queen split"),
                            ("personal", "one model per client")):
            ttk.Radiobutton(routing, text=label, value=mode,
                            variable=self.routing_var,
                            command=self._change_routing).pack(side="left", padx=2)
        self.routing_help = tk.StringVar()
        ttk.Label(routing, textvariable=self.routing_help,
                  foreground="#666").pack(side="left", padx=(10, 0))

        self.personal_row = ttk.Frame(body)
        self.personal_row.grid(row=4, column=0, columnspan=N_SLOTS, sticky="ew",
                               pady=(4, 0))
        ttk.Label(self.personal_row, text="clients get").pack(side="left")
        self.assign_box = ttk.Combobox(self.personal_row, state="readonly", width=12,
                                       values=list(personal_mod.ASSIGN_MODES))
        self.assign_box.set(self.rack.personal.assign)
        self.assign_box.pack(side="left", padx=4)
        self.assign_box.bind("<<ComboboxSelected>>",
                             lambda e: self.rack.personal.set_assign(self.assign_box.get()))
        self.personal_rows = [ParamRow(self.personal_row, self.reg["personal.max"],
                                       width=140, label_width=18)]
        self.personal_rows[0].frame.pack(side="left", padx=8)
        self.personal_status = tk.StringVar(value="")
        ttk.Label(self.personal_row, textvariable=self.personal_status,
                  foreground="#666").pack(side="left", padx=6)
        self._change_routing(apply=False)

        sections = ttk.Frame(body)
        sections.grid(row=2, column=0, columnspan=N_SLOTS, sticky="ew", pady=(4, 0))
        self.zones_var = tk.BooleanVar(value=self.rack.zones.get("on") >= 0.5)
        ttk.Checkbutton(sections, text="camera sections set slot levels",
                        variable=self.zones_var,
                        command=self._toggle_zones).pack(side="left")
        self.layout_box = ttk.Combobox(sections, state="readonly", width=10,
                                       values=list(zones_mod.LAYOUTS))
        self.layout_box.set(self.rack.zones.layout)
        self.layout_box.pack(side="left", padx=6)
        self.layout_box.bind("<<ComboboxSelected>>",
                             lambda e: self.rack.zones.set_layout(self.layout_box.get()))
        self.zone_rows = [ParamRow(sections, self.reg[k], width=110, label_width=18)
                          for k in ("zones.depth", "zones.floor")]
        for r in self.zone_rows:
            r.frame.pack(side="left", fill="x", expand=True, padx=4)
        self.zone_status = tk.StringVar(value="")
        ttk.Label(sections, textvariable=self.zone_status,
                  foreground="#666").pack(side="left", padx=6)

        bottom = ttk.Frame(body)
        bottom.grid(row=3, column=0, columnspan=N_SLOTS, sticky="ew", pady=(6, 0))
        self.master_rows = [ParamRow(bottom, self.reg["master.level"], width=240)]
        self.master_meter = ttk.Progressbar(bottom, maximum=100.0, length=200)
        self.master_meter.pack(side="left", padx=8)

    def _build_slot(self, body, i):
        n = i + 1
        slot = self.rack.slots[i]
        frame = ttk.LabelFrame(body, text=f"slot {n}", padding=6)
        frame.grid(row=0, column=i, sticky="nsew", padx=4)

        name = tk.StringVar(value=slot.name)
        ttk.Label(frame, textvariable=name, font=("", 10, "bold")).pack(anchor="w")
        info = tk.StringVar(value="no model")
        ttk.Label(frame, textvariable=info, foreground="#666",
                  wraplength=230).pack(anchor="w")

        picker = ttk.Combobox(frame, state="readonly", width=26)
        picker.pack(fill="x", pady=(6, 2))
        picker.bind("<<ComboboxSelected>>", lambda e, k=i: self._pick_model(k))

        btns = ttk.Frame(frame)
        btns.pack(fill="x")
        ttk.Button(btns, text="file...", width=7,
                   command=lambda k=i: self._load_file(k)).pack(side="left")
        ttk.Button(btns, text="clear", width=7,
                   command=lambda k=i: self._clear(k)).pack(side="left", padx=3)

        toggles = ttk.Frame(frame)
        toggles.pack(fill="x", pady=(4, 0))
        on = SwitchRow(toggles, self.reg[f"slot{n}.on"], "on")
        on.widget.pack(side="left")
        solo_var = tk.BooleanVar(value=slot.solo)
        ttk.Checkbutton(toggles, text="solo", variable=solo_var,
                        command=lambda s=slot, v=solo_var:
                        setattr(s, "solo", v.get())).pack(side="left", padx=6)

        src_row = ttk.Frame(frame)
        src_row.pack(fill="x", pady=(4, 0))
        ttk.Label(src_row, text="input").pack(side="left")
        source = ttk.Combobox(src_row, state="readonly", width=8, values=list(SOURCES))
        source.set(slot.source)
        source.pack(side="left", padx=4)
        source.bind("<<ComboboxSelected>>",
                    lambda e, k=i, box=None: self._change_source(k))
        section = ttk.Progressbar(src_row, maximum=100.0, length=70)
        section.pack(side="right")
        section_text = tk.StringVar(value="")
        ttk.Label(src_row, textvariable=section_text, foreground="#666").pack(
            side="right", padx=3)

        rows = [ParamRow(frame, self.reg[f"slot{n}.level"], width=110, label_width=16),
                ParamRow(frame, self.reg[f"slot{n}.mix"], width=110, label_width=16),
                # The input repitch, surfaced from the pre-chain: moving the
                # source into a model's register is the knob that decides
                # whether a model answers at all, so it lives here too.
                ParamRow(frame, self.reg[f"slot{n}.pre.pitch.semitones"],
                         width=110, label_width=16)]
        pitch_row = ttk.Frame(frame)
        pitch_row.pack(fill="x", pady=(1, 0))
        repitch = SwitchRow(pitch_row, self.reg[f"slot{n}.pre.pitch.on"], "repitch")
        repitch.widget.pack(side="left")
        auto_btn = ttk.Button(pitch_row, text="auto", width=5,
                              command=lambda k=i: self._auto_pitch(k))
        auto_btn.pack(side="left", padx=4)
        auto_status = tk.StringVar(value="")
        ttk.Label(pitch_row, textvariable=auto_status,
                  foreground="#666").pack(side="left")
        ttk.Separator(frame).pack(fill="x", pady=6)
        params_frame = ttk.Frame(frame)
        params_frame.pack(fill="x")

        meter = ttk.Progressbar(frame, maximum=100.0)
        meter.pack(fill="x", side="bottom", pady=(6, 0))

        ui = {"name": name, "info": info, "picker": picker, "meter": meter,
              "params_frame": params_frame, "rows": rows,
              "switches": [on, repitch],
              "param_rows": [], "source": source, "section": section,
              "section_text": section_text,
              "auto_btn": auto_btn, "auto_status": auto_status,
              "probing": False}
        self._refill_picker(ui, i)
        self._rebuild_slot_params(ui, i)
        return ui

    def _change_source(self, i):
        self.rack.set_slot_source(i, self.slot_ui[i]["source"].get())

    def _auto_pitch(self, i):
        """Probe which register slot i's model answers in, set its repitch."""
        slot = self.rack.slots[i]
        if slot.model is None or slot.path is None:
            messagebox.showinfo("auto pitch", "Load a model into this slot first.")
            return
        ui = self.slot_ui[i]
        if ui["probing"]:
            return
        ui["probing"] = True
        ui["auto_btn"].config(state="disabled")
        ui["auto_status"].set("probing...")

        def work():
            try:
                res = probe_pitch(
                    self.rack, i,
                    progress=lambda k, total: self._post(
                        ui["auto_status"].set, f"probing {k}/{total}"))
            except Exception as exc:
                self._post(lambda e=exc: messagebox.showerror("auto pitch", str(e)))
                res = None
            self._post(self._auto_done, i, res)

        threading.Thread(target=work, daemon=True, name=f"autopitch-{i + 1}").start()

    def _auto_done(self, i, res):
        ui = self.slot_ui[i]
        ui["probing"] = False
        ui["auto_btn"].config(state="normal")
        if res is None:
            ui["auto_status"].set("failed")
            return
        if res["confidence"] < 1.3:
            # The model answers everything about equally; moving the input
            # would change nothing, so nothing is changed.
            ui["auto_status"].set("flat response, left as is")
            return
        # Written straight at this slot's effect: the result belongs to this
        # model, so it deliberately ignores "link all slots".
        for eff in self.rack.slots[i].pre.effects:
            if eff.name == "pitch":
                eff.set("semitones", res["best"])
                eff.enabled = True
        ui["auto_status"].set(
            f"{res['best']:+.0f} st → {res['f_best']:.0f} Hz "
            f"({res['confidence']:.1f}×)")

    ROUTING_HELP = {'shared': 'every slot hears the input mixer (mic, synth, file, test)', 'split': "the queen's voice into slots 1 and 3, everyone else's into 2 and 4, levels matched -- let the room find her by timbre", 'personal': "every phone gets its own private copy of a model, fed only by that person's voice; the four slots become templates"}

    def _change_routing(self, apply=True):
        mode = self.routing_var.get()
        if apply:
            try:
                self.rack.set_routing(mode)
            except Exception as exc:
                messagebox.showerror("routing", str(exc))
                self.routing_var.set(self.rack.routing)
                mode = self.rack.routing
        self.routing_help.set(self.ROUTING_HELP.get(mode, ""))
        if mode == "personal":
            self.personal_row.grid()
        else:
            self.personal_row.grid_remove()
        for i, ui in enumerate(self.slot_ui):
            ui["source"].set(self.rack.slots[i].source)
            ui["source"].config(state="disabled" if mode == "personal" else "readonly")
        if hasattr(self, "input_var"):
            self.input_var.set(self.rack.current_input())

    def _toggle_zones(self):
        self.rack.zones.set("on", 1.0 if self.zones_var.get() else 0.0)

    def _refill_picker(self, ui, i):
        entries = self.library.downloaded()
        self._picker_entries[i] = entries
        ui["picker"]["values"] = ["(choose a model)"] + [e.name for e in entries]
        ui["picker"].current(0)

    def _pick_model(self, i):
        idx = self.slot_ui[i]["picker"].current()
        if idx > 0:
            self._load_path(i, self.library.path_for(self._picker_entries[i][idx - 1]))

    def _load_file(self, i):
        p = filedialog.askopenfilename(
            title=f"model for slot {i + 1}", initialdir=str(self.library.cache_dir),
            filetypes=[("Neutone model", "*.nm"), ("all files", "*.*")])
        if p:
            self._load_path(i, Path(p))

    def _load_path(self, i, path):
        self.slot_ui[i]["info"].set("loading...")

        def work():
            try:
                self.rack.load_slot(i, path)
            except Exception as exc:
                self._post(lambda e=exc:
                                messagebox.showerror("load failed", str(e)))
            self._post(self._after_model_change, i)

        threading.Thread(target=work, daemon=True).start()

    def _clear(self, i):
        self.rack.unload_slot(i)
        self._after_model_change(i)

    def _after_model_change(self, i):
        self.reg = self.rack.registry()
        self._rebuild_slot_params(self.slot_ui[i], i)
        self._rebuild_chain()
        self._refill_targets()

    def _rebuild_slot_params(self, ui, i):
        n = i + 1
        slot = self.rack.slots[i]
        for r in ui["param_rows"]:
            r.destroy()
        ui["param_rows"] = []
        for w in ui["params_frame"].winfo_children():
            w.destroy()

        ui["name"].set(slot.name)
        if slot.model is None:
            ui["info"].set(slot.status if slot.status.startswith("error")
                           else "no model")
            return
        ms = 1000.0 * slot.latency / self.rack.sr
        ui["info"].set(f"{'mono' if slot.input_mono else 'stereo'} in, "
                       f"{slot.latency} smp ({ms:.0f} ms), {slot.device}")
        if not slot.params:
            ttk.Label(ui["params_frame"], text="no parameters",
                      foreground="#666").pack(anchor="w")
            return
        for spec in slot.params:
            key = f"slot{n}.model.p{spec.row + 1}"
            if key in self.reg:
                ui["param_rows"].append(
                    ParamRow(ui["params_frame"], self.reg[key], width=110,
                             label_width=16))

    # -- synth tab ----------------------------------------------------------

    def _build_synth(self):
        top = ttk.Frame(self.tab_synth)
        top.pack(fill="x")
        ttk.Label(
            top,
            text="One voice per client. A voice is a sine; roughness is amplitude "
                 "modulation in the 20-70 Hz band, which the ear hears as grating "
                 "rather than as tremolo. Volume is meant to come from that "
                 "client's activity -- see the osc tab.",
            foreground="#666", wraplength=1040, justify="left").pack(anchor="w")

        globals_box = ttk.LabelFrame(self.tab_synth, text="bank", padding=6)
        globals_box.pack(fill="x", pady=6)
        inner = ttk.Frame(globals_box)
        inner.pack(fill="x")
        self.synth_rows = []
        left, right = ttk.Frame(inner), ttk.Frame(inner)
        left.pack(side="left", fill="x", expand=True, padx=(0, 12))
        right.pack(side="left", fill="x", expand=True)
        for i, p in enumerate(("level", "glide", "scale", "root", "spread", "timeout")):
            key = f"synth.{p}"
            if key in self.reg:
                self.synth_rows.append(
                    ParamRow(left if i < 3 else right, self.reg[key], width=180))
        picker = ttk.Frame(globals_box)
        picker.pack(fill="x", pady=(6, 0))
        ttk.Label(picker, text="scale").pack(side="left")
        self.scale_box = ttk.Combobox(
            picker, state="readonly", width=12,
            values=[n for n, _ in synth_mod.SCALES])
        self.scale_box.set(self.rack.synth.scale_name())
        self.scale_box.pack(side="left", padx=4)
        self.scale_box.bind("<<ComboboxSelected>>", self._change_scale)
        ttk.Label(picker,
                  text="free means no quantising at all: pitch follows the "
                       "sensor continuously, glissando rather than notes.",
                  foreground="#666").pack(side="left", padx=6)

        self.scale_label = tk.StringVar()
        ttk.Label(globals_box, textvariable=self.scale_label,
                  foreground="#666").pack(anchor="w", pady=(4, 0))

        queen_box = ttk.LabelFrame(self.tab_synth, text="the queen", padding=6)
        queen_box.pack(fill="x", pady=(6, 0))
        qrow = ttk.Frame(queen_box)
        qrow.pack(fill="x")
        ttk.Label(qrow, text="precedence").pack(side="left")
        self.queen_box = ttk.Combobox(qrow, state="readonly", width=10,
                                      values=synth_mod.queen_mode_names())
        self.queen_box.set(self.rack.synth.queen_mode_name())
        self.queen_box.pack(side="left", padx=4)
        self.queen_box.bind("<<ComboboxSelected>>", self._change_queen_mode)
        self.queen_who = tk.StringVar(value="no queen")
        ttk.Label(qrow, textvariable=self.queen_who).pack(side="left", padx=10)
        if "synth.queen_amount" in self.reg:
            self.synth_rows.append(
                ParamRow(queen_box, self.reg["synth.queen_amount"], width=200))
        self.queen_why = tk.StringVar()
        ttk.Label(queen_box, textvariable=self.queen_why, foreground="#666",
                  wraplength=1000, justify="left").pack(anchor="w", pady=(2, 0))
        self._queen_why()

        voices_box = ttk.LabelFrame(self.tab_synth, text="who is here", padding=6)
        voices_box.pack(fill="both", expand=True, pady=(6, 0))
        ttk.Label(
            voices_box,
            text="One row per connected phone. Voice N is whoever holds slot N on "
                 "the backend, so client 3 on the dashboard is voice 3 here; a new "
                 "person taking a freed slot starts from silence. Rows leave when "
                 "the phone does.",
            foreground="#666", wraplength=1040, justify="left").pack(anchor="w")
        cols = ("who", "platform", "level", "pitch", "rough", "bus", "model")
        self.voice_tree = ttk.Treeview(voices_box, columns=cols,
                                       show="tree headings", height=12)
        self.voice_tree.heading("#0", text="voice")
        for col, text, width, anchor in (("who", "who", 220, "w"),
                                         ("platform", "phone", 70, "center"),
                                         ("level", "level", 170, "w"),
                                         ("pitch", "pitch", 80, "e"),
                                         ("rough", "rough", 60, "e"),
                                         ("bus", "into", 70, "center"),
                                         ("model", "own model", 190, "w")):
            self.voice_tree.heading(col, text=text)
            self.voice_tree.column(col, width=width, anchor=anchor)
        self.voice_tree.column("#0", width=90)
        self.voice_tree.pack(fill="both", expand=True)
        self.voice_tree.tag_configure("queen", background="#fff3c4")
        self.voice_tree.tag_configure("leaving", foreground="#999")

    def _change_scale(self, _e=None):
        try:
            self.rack.synth.set_scale_by_name(self.scale_box.get())
        except KeyError:
            pass

    def _change_queen_mode(self, _e=None):
        try:
            self.rack.synth.set_queen_mode_by_name(self.queen_box.get())
        except KeyError:
            pass
        self._queen_why()

    def _queen_why(self):
        name = self.queen_box.get()
        for n, why in synth_mod.QUEEN_MODES:
            if n == name:
                self.queen_why.set(why)
                return
        self.queen_why.set("")

    # -- chain tab ----------------------------------------------------------

    def _build_chain(self):
        top = ttk.Frame(self.tab_chain)
        top.pack(fill="x")
        ttk.Label(top, text="slot:").pack(side="left")
        self.chain_slot = tk.IntVar(value=1)
        for i in range(N_SLOTS):
            ttk.Radiobutton(top, text=str(i + 1), value=i + 1,
                            variable=self.chain_slot,
                            command=self._rebuild_chain).pack(side="left")

        ttk.Label(top, text="   setup:").pack(side="left")
        self.preset_var = ttk.Combobox(top, state="readonly", width=12,
                                       values=list(dsp.CHAIN_PRESETS))
        self.preset_var.current(0)
        self.preset_var.pack(side="left", padx=3)
        self.preset_var.bind("<<ComboboxSelected>>", lambda e: self._preset_why())
        ttk.Button(top, text="this slot",
                   command=lambda: self._apply_preset(False)).pack(side="left")
        ttk.Button(top, text="all slots",
                   command=lambda: self._apply_preset(True)).pack(side="left", padx=3)

        self.link_var = tk.BooleanVar(value=self.rack.link_chains)
        ttk.Checkbutton(top, text="link all slots", variable=self.link_var,
                        command=self._toggle_link).pack(side="left", padx=(14, 4))
        ttk.Button(top, text="copy", width=6, command=self._copy_chain).pack(
            side="left")
        self.paste_btn = ttk.Button(top, text="paste", width=6,
                                    command=lambda: self._paste_chain(False),
                                    state="disabled")
        self.paste_btn.pack(side="left", padx=2)
        self.paste_all_btn = ttk.Button(top, text="paste to all", width=11,
                                        command=lambda: self._paste_chain(True),
                                        state="disabled")
        self.paste_all_btn.pack(side="left")
        self._clipboard = None

        self.preset_why = tk.StringVar()
        ttk.Label(self.tab_chain, textvariable=self.preset_why, foreground="#666",
                  wraplength=1040, justify="left").pack(anchor="w", pady=(4, 0))
        self._preset_why()

        self.chain_body = ttk.Frame(self.tab_chain)
        self.chain_body.pack(fill="both", expand=True, pady=(6, 0))
        self.chain_rows = []
        self._rebuild_chain()

    def _toggle_link(self):
        self.rack.link_chains = self.link_var.get()
        if self.rack.link_chains:
            # Linking without copying first would leave the four out of step
            # until every knob happened to be touched, so match them now.
            self.rack.paste_chain(self.rack.copy_chain(self.chain_slot.get() - 1))
            self._rebuild_chain()

    def _copy_chain(self):
        self._clipboard = self.rack.copy_chain(self.chain_slot.get() - 1)
        self.paste_btn.config(state="normal")
        self.paste_all_btn.config(state="normal")

    def _paste_chain(self, everywhere):
        if self._clipboard is None:
            return
        self.rack.paste_chain(
            self._clipboard, None if everywhere else self.chain_slot.get() - 1)
        self._rebuild_chain()

    def _preset_why(self):
        name = self.preset_var.get()
        self.preset_why.set(dsp.CHAIN_PRESETS.get(name, {}).get("why", ""))

    def _apply_preset(self, all_slots):
        name = self.preset_var.get()
        self.rack.apply_chain_preset(
            name, None if all_slots else self.chain_slot.get() - 1)
        self._rebuild_chain()

    def _rebuild_chain(self):
        for w in self.chain_body.winfo_children():
            w.destroy()
        self.chain_rows = []
        n = self.chain_slot.get()
        slot = self.rack.slots[n - 1]

        cols = ttk.Frame(self.chain_body)
        cols.pack(fill="both", expand=True)
        for c in range(3):
            cols.columnconfigure(c, weight=1, uniform="chain")

        stages = [("into the model", "pre", slot.pre.effects),
                  ("out of the model", "post", slot.post.effects),
                  ("master", None, (self.rack.master_reverb, self.rack.master_limiter))]
        for col, (title, stage, effects) in enumerate(stages):
            box = ttk.Frame(cols)
            box.grid(row=0, column=col, sticky="nsew", padx=6)
            ttk.Label(box, text=title, font=("", 10, "bold")).pack(anchor="w")
            for eff in effects:
                prefix = f"slot{n}.{stage}.{eff.name}" if stage else f"master.{eff.name}"
                if f"{prefix}.on" not in self.reg:
                    continue
                lf = ttk.LabelFrame(box, text=eff.name, padding=6)
                lf.pack(fill="x", pady=3)
                sw = SwitchRow(lf, self.reg[f"{prefix}.on"], "enabled")
                sw.widget.pack(anchor="w")
                self.chain_rows.append(sw)
                for p in eff.params:
                    key = f"{prefix}.{p.name}"
                    if key in self.reg:
                        self.chain_rows.append(ParamRow(lf, self.reg[key], width=140))

    # -- osc tab ------------------------------------------------------------

    def _build_osc(self):
        top = ttk.Frame(self.tab_osc)
        top.pack(fill="x")
        ttk.Label(top, text="receive port").pack(side="left")
        self.port_var = tk.StringVar(value=str(self.osc.port))
        ttk.Entry(top, textvariable=self.port_var, width=8).pack(side="left", padx=4)
        self.osc_btn = ttk.Button(top, text="listen", command=self._toggle_osc)
        self.osc_btn.pack(side="left")
        self.osc_status = tk.StringVar(value="not listening")
        ttk.Label(top, textvariable=self.osc_status, foreground="#666").pack(
            side="left", padx=10)
        ttk.Button(top, text="save routing", command=self._save_map).pack(side="right")
        ttk.Button(top, text="load routing", command=self._load_map).pack(
            side="right", padx=4)
        ttk.Button(top, text="load defaults", command=self._load_defaults).pack(
            side="right", padx=4)
        ttk.Button(top, text="what to send", command=self._show_send_list).pack(
            side="right", padx=4)

        panes = ttk.Frame(self.tab_osc)
        panes.pack(fill="both", expand=True, pady=(8, 0))
        panes.columnconfigure(0, weight=2)
        panes.columnconfigure(1, weight=3)
        panes.rowconfigure(0, weight=1)

        left = ttk.LabelFrame(panes, text="arriving", padding=6)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        self.seen_tree = ttk.Treeview(left, columns=("last",), show="tree headings",
                                      height=16)
        self.seen_tree.heading("#0", text="swarm / client")
        self.seen_tree.heading("last", text="values")
        self.seen_tree.column("#0", width=215)
        self.seen_tree.column("last", width=185)
        self.seen_tree.pack(fill="both", expand=True)
        self.seen_tree.bind("<<TreeviewSelect>>", self._pick_seen)
        self._seen_groups = set()

        right = ttk.LabelFrame(panes, text="routing", padding=6)
        right.grid(row=0, column=1, sticky="nsew")
        self.map_tree = ttk.Treeview(
            right, columns=("arg", "target", "range", "value"),
            show="tree headings", height=11)
        self.map_tree.heading("#0", text="from")
        self.map_tree.heading("arg", text="arg")
        self.map_tree.heading("target", text="controls")
        self.map_tree.heading("range", text="in -> out")
        self.map_tree.heading("value", text="now")
        self.map_tree.column("#0", width=150)
        self.map_tree.column("arg", width=34, anchor="center")
        self.map_tree.column("target", width=170)
        self.map_tree.column("range", width=135)
        self.map_tree.column("value", width=55, anchor="e")
        self.map_tree.pack(fill="both", expand=True)
        self.map_tree.bind("<<TreeviewSelect>>", self._pick_mapping)
        # Several at once: ctrl- or shift-click, or a group header for every
        # route in it; Delete removes, ctrl+A selects them all.
        self.map_tree.bind("<Delete>", lambda e: self._remove_mapping())
        self.map_tree.bind("<BackSpace>", lambda e: self._remove_mapping())
        self.map_tree.bind("<Control-a>", self._select_all_routes)
        self._map_iids = {}
        self._map_rows = {}
        self._build_map_editor(right)

    def _build_map_editor(self, parent):
        ed = ttk.Frame(parent)
        ed.pack(fill="x", pady=(6, 0))

        r1 = ttk.Frame(ed)
        r1.pack(fill="x", pady=2)
        ttk.Label(r1, text="from", width=7).pack(side="left")
        self.src_group = ttk.Combobox(r1, width=12, state="readonly")
        self.src_group.pack(side="left")
        self.src_group.bind("<<ComboboxSelected>>", self._src_group_changed)
        self.m_address = ttk.Combobox(r1, width=26)
        self.m_address.pack(side="left", padx=3)
        self.m_address.bind("<<ComboboxSelected>>", self._address_changed)
        ttk.Label(r1, text="arg").pack(side="left")
        self.m_arg = ttk.Spinbox(r1, from_=0, to=17, width=3)
        self.m_arg.set("0")
        self.m_arg.pack(side="left", padx=2)
        self.learn_btn = ttk.Button(r1, text="learn", width=7, command=self._learn)
        self.learn_btn.pack(side="left", padx=3)

        self.src_why = tk.StringVar()
        ttk.Label(ed, textvariable=self.src_why, foreground="#666").pack(anchor="w")

        r2 = ttk.Frame(ed)
        r2.pack(fill="x", pady=2)
        ttk.Label(r2, text="controls", width=7).pack(side="left")
        self.tgt_group = ttk.Combobox(r2, width=16, state="readonly")
        self.tgt_group.pack(side="left")
        self.tgt_group.bind("<<ComboboxSelected>>", self._tgt_group_changed)
        self.m_target = ttk.Combobox(r2, width=28, state="readonly")
        self.m_target.pack(side="left", padx=3)
        self.m_target.bind("<<ComboboxSelected>>", lambda e: self._full_range())

        r3 = ttk.Frame(ed)
        r3.pack(fill="x", pady=2)
        ttk.Label(r3, text="in", width=7).pack(side="left")
        self.m_in_lo = ttk.Entry(r3, width=8)
        self.m_in_lo.insert(0, "0")
        self.m_in_lo.pack(side="left")
        self.m_in_hi = ttk.Entry(r3, width=8)
        self.m_in_hi.insert(0, "1")
        self.m_in_hi.pack(side="left", padx=2)
        ttk.Button(r3, text="use seen", width=9, command=self._use_seen).pack(side="left")
        ttk.Label(r3, text=" out").pack(side="left")
        self.m_out_lo = ttk.Entry(r3, width=8)
        self.m_out_lo.pack(side="left")
        self.m_out_hi = ttk.Entry(r3, width=8)
        self.m_out_hi.pack(side="left", padx=2)
        ttk.Button(r3, text="full", width=5, command=self._full_range).pack(side="left")

        r4 = ttk.Frame(ed)
        r4.pack(fill="x", pady=2)
        self.m_invert = tk.BooleanVar(value=False)
        ttk.Checkbutton(r4, text="invert", variable=self.m_invert).pack(side="left")
        ttk.Label(r4, text="  slew s").pack(side="left")
        self.m_slew = ttk.Entry(r4, width=6)
        self.m_slew.insert(0, "0.0")
        self.m_slew.pack(side="left", padx=2)
        ttk.Button(r4, text="add / update", command=self._add_mapping).pack(
            side="left", padx=8)
        ttk.Button(r4, text="remove", command=self._remove_mapping).pack(side="left")

        self._refill_source_groups()
        self._refill_targets()

    # source pickers ........................................................

    def _source_catalogue(self):
        """group -> [(address, arg, in_lo, in_hi, why)], known plus seen.

        Every documented family is listed up front with its real ranges, so a
        routing can be built before the backend has sent a single packet;
        addresses seen on the wire are merged in on top."""
        cat = {kind: list(rows) for kind, rows in oscmap.FAMILIES.items()}
        for i in range(1, self.rack.synth.n_voices + 1):
            cat[f"client {i}"] = oscmap.client_sources(i)
        for address in self.osc.seen:
            group = oscmap.group_label(address)
            rows = cat.setdefault(group, [])
            if not any(r[0] == address for r in rows):
                rows.append((address, 0, 0.0, 1.0, "seen on the wire"))
        return cat

    def _refill_source_groups(self):
        cat = self._source_catalogue()
        groups = sorted(cat, key=lambda g: (
            0 if g == "swarm" else 1 if g.startswith("client") else 2,
            int(g.split()[1]) if g.startswith("client") and g.split()[1].isdigit() else 0,
            g))
        self._src_cat = cat
        self.src_group["values"] = groups
        if groups and not self.src_group.get():
            self.src_group.current(0)
            self._src_group_changed()

    def _src_group_changed(self, _e=None):
        group = self.src_group.get()
        rows = self._src_cat.get(group, [])
        self.m_address["values"] = [f"{a}   [{arg}]" for a, arg, *_ in rows]
        if rows:
            self.m_address.current(0)
            self._address_changed()
        # Client data is for that client's voice, so pre-select it. This is the
        # split the whole tab is organised around.
        if group.startswith("client"):
            n = group.split()[1]
            want = f"synth voice {n}"
            if want in self.tgt_group["values"]:
                self.tgt_group.set(want)
                self._tgt_group_changed()

    def _current_source_row(self):
        group = self.src_group.get()
        rows = self._src_cat.get(group, [])
        i = self.m_address.current()
        return rows[i] if 0 <= i < len(rows) else None

    def _address_changed(self, _e=None):
        row = self._current_source_row()
        if row is None:
            return
        address, arg, lo, hi, why = row
        self.m_address.set(address)
        self.m_arg.set(str(arg))
        self._set_entry(self.m_in_lo, lo)
        self._set_entry(self.m_in_hi, hi)
        self.src_why.set(f"   {why}")

    # target pickers ........................................................

    def _refill_targets(self):
        groups = {}
        for key, ref in self.reg.items():
            groups.setdefault(ref.group, []).append(key)
        self._tgt_groups = groups
        names = sorted(groups, key=_target_sort_key)
        self.tgt_group["values"] = names
        if names and self.tgt_group.get() not in names:
            self.tgt_group.current(0)
        self._tgt_group_changed()

    def _tgt_group_changed(self, _e=None):
        keys = sorted(self._tgt_groups.get(self.tgt_group.get(), []))
        self._target_keys = keys
        self.m_target["values"] = [
            f"{self.reg[k].label}   ({k.rsplit('.', 1)[-1]})" for k in keys]
        if keys:
            self.m_target.current(0)

    def _selected_target(self):
        i = self.m_target.current()
        return self._target_keys[i] if 0 <= i < len(self._target_keys) else None

    # actions ...............................................................

    def _toggle_osc(self):
        try:
            if self.osc.running:
                self.osc.stop()
                self.osc_btn.config(text="listen")
            else:
                self.osc.start(int(self.port_var.get()))
                self.osc_btn.config(text="stop")
        except Exception as exc:
            messagebox.showerror("osc error", str(exc))

    def _learn(self):
        self.osc.learned = None
        self.osc.learn_target = "pending"
        self.learn_btn.config(text="...")
        if not self.osc.running:
            messagebox.showinfo("learn", "Press listen first, then move a phone.")
            self.osc.learn_target = None
            self.learn_btn.config(text="learn")

    def _load_defaults(self):
        if self.osc.mappings and not messagebox.askyesno(
                "load defaults",
                f"Replace the {len(self.osc.mappings)} current routes with the "
                f"defaults?"):
            return
        rows = oscmap.default_mappings(self.rack.synth.n_voices, N_SLOTS)
        self.osc.mappings = rows
        self._refill_map_tree()
        messagebox.showinfo(
            "defaults loaded",
            f"{len(rows)} routes:\n\n" + "\n".join(oscmap.DEFAULT_NOTES))

    def _pick_seen(self, _e=None):
        sel = self.seen_tree.selection()
        if not sel or sel[0].startswith("group:"):
            return
        address = sel[0]
        group = oscmap.group_label(address)
        if group in self.src_group["values"]:
            self.src_group.set(group)
            self._src_group_changed()
        self.m_address.set(address)

    def _use_seen(self):
        """Fill the input range from what this address has actually sent.

        Guessing a sensor's range from the documentation is how you get a knob
        pinned at one end; the range it really produced in the room works.
        """
        address = self.m_address.get().strip()
        arg = int(self.m_arg.get() or 0)
        for m in self.osc.mappings:
            if m.address == address and m.arg == arg and m.hits:
                self._set_entry(self.m_in_lo, m.seen_lo)
                self._set_entry(self.m_in_hi, m.seen_hi)
                return
        info = self.osc.seen.get(address)
        if info and info[1] and arg < len(info[1]):
            v = float(info[1][arg])
            self._set_entry(self.m_in_lo, min(0.0, v))
            self._set_entry(self.m_in_hi, max(1.0, v))
        else:
            messagebox.showinfo("use seen", "Nothing has arrived there yet.")

    def _full_range(self):
        key = self._selected_target()
        if key:
            spec = self.reg[key].spec
            self._set_entry(self.m_out_lo, spec.lo)
            self._set_entry(self.m_out_hi, spec.hi)

    @staticmethod
    def _set_entry(entry, value):
        entry.delete(0, "end")
        entry.insert(0, f"{value:g}")

    def _add_mapping(self):
        address = self.m_address.get().strip()
        key = self._selected_target()
        if not address or not key:
            messagebox.showinfo("add", "Pick an address and something to control.")
            return
        try:
            arg = int(self.m_arg.get() or 0)
            in_lo, in_hi = float(self.m_in_lo.get()), float(self.m_in_hi.get())
            out_lo = float(self.m_out_lo.get() or self.reg[key].spec.lo)
            out_hi = float(self.m_out_hi.get() or self.reg[key].spec.hi)
            slew = float(self.m_slew.get() or 0.0)
        except ValueError:
            messagebox.showerror("add", "Ranges must be numbers.")
            return

        existing = next((m for m in self.osc.mappings
                         if m.address == address and m.arg == arg
                         and m.target == key), None)
        if existing is None:
            existing = oscmap.Mapping(address=address, arg=arg, target=key)
            self.osc.add(existing)
        existing.in_lo, existing.in_hi = in_lo, in_hi
        existing.out_lo, existing.out_hi = out_lo, out_hi
        existing.invert = self.m_invert.get()
        existing.slew = slew
        existing.enabled = True
        self._refill_map_tree()

    @staticmethod
    def _map_iid(m) -> str:
        # Keyed by the route itself rather than its position, so removing one
        # route does not silently shift which row means which route.
        return f"route:{id(m)}"

    def _selected_mappings(self):
        """Every route selected, a group header counting as all of its routes."""
        chosen, seen = [], set()
        for iid in self.map_tree.selection():
            if iid.startswith("group:"):
                kids = self.map_tree.get_children(iid)
            else:
                kids = (iid,)
            for kid in kids:
                m = self._map_iids.get(kid)
                if m is not None and id(m) not in seen:
                    seen.add(id(m))
                    chosen.append(m)
        return chosen

    def _select_all_routes(self, _e=None):
        self.map_tree.selection_set(list(self._map_iids))
        return "break"

    def _remove_mapping(self):
        doomed = self._selected_mappings()
        if not doomed:
            messagebox.showinfo("remove", "Select one or more routes, or a group "
                                          "header, in the routing list first.")
            return
        if len(doomed) > 1 and not messagebox.askyesno(
                "remove", f"Remove {len(doomed)} routes?"):
            return
        gone = {id(m) for m in doomed}
        # One assignment, so the receiver rebuilds its address index once.
        self.osc.mappings = [m for m in self.osc.mappings if id(m) not in gone]
        self._refill_map_tree()

    def _pick_mapping(self, _e=None):
        chosen = self._selected_mappings()
        if len(chosen) != 1 or len(self.map_tree.selection()) != 1:
            return  # several selected: that is for removing, not editing
        m = chosen[0]
        group = oscmap.group_label(m.address)
        if group in self.src_group["values"]:
            self.src_group.set(group)
            self._src_group_changed()
        self.m_address.set(m.address)
        self.m_arg.set(str(m.arg))
        ref = self.reg.get(m.target)
        if ref is not None and ref.group in self.tgt_group["values"]:
            self.tgt_group.set(ref.group)
            self._tgt_group_changed()
            if m.target in self._target_keys:
                self.m_target.current(self._target_keys.index(m.target))
        self._set_entry(self.m_in_lo, m.in_lo)
        self._set_entry(self.m_in_hi, m.in_hi)
        self._set_entry(self.m_out_lo, m.out_lo)
        self._set_entry(self.m_out_hi, m.out_hi)
        self.m_invert.set(m.invert)
        self._set_entry(self.m_slew, m.slew)

    def _map_row(self, m):
        return (m.arg, m.target,
                f"{m.in_lo:g}..{m.in_hi:g} -> {m.out_lo:g}..{m.out_hi:g}",
                f"{m.last_out:.2f}")

    def _refill_map_tree(self):
        keep = set(self.map_tree.selection())
        opened = {n for n in self.map_tree.get_children()
                  if not self.map_tree.item(n, "open")}
        self.map_tree.delete(*self.map_tree.get_children())
        self._map_iids, self._map_rows = {}, {}
        # grouped the same way as the sources, so a client's routes sit together
        by_group = {}
        for m in self.osc.mappings:
            by_group.setdefault(oscmap.group_label(m.address), []).append(m)
        for group in sorted(by_group, key=lambda g: (
                0 if g == "swarm" else 1, g)):
            node = f"group:{group}"
            self.map_tree.insert("", "end", iid=node,
                                 text=f"{group}  ({len(by_group[group])})",
                                 open=node not in opened)
            for m in by_group[group]:
                iid = self._map_iid(m)
                row = self._map_row(m)
                self._map_iids[iid] = m
                self._map_rows[iid] = row
                self.map_tree.insert(node, "end", iid=iid, text=m.address, values=row)
        still = [i for i in keep if self.map_tree.exists(i)]
        if still:
            self.map_tree.selection_set(still)

    def _save_map(self):
        self.preset_dir.mkdir(parents=True, exist_ok=True)
        p = filedialog.asksaveasfilename(
            title="save routing", defaultextension=".json",
            initialdir=str(self.preset_dir), filetypes=[("routing", "*.json")])
        if p:
            self.osc.save(Path(p))

    def _load_map(self):
        p = filedialog.askopenfilename(
            title="load routing", initialdir=str(self.preset_dir),
            filetypes=[("routing", "*.json")])
        if p:
            try:
                self.osc.load(Path(p))
                self.port_var.set(str(self.osc.port))
                self._refill_map_tree()
            except Exception as exc:
                messagebox.showerror("load routing", str(exc))

    # -- library tab --------------------------------------------------------

    def _build_library(self):
        top = ttk.Frame(self.tab_lib)
        top.pack(fill="x")
        ttk.Button(top, text="refresh list", command=self._refresh_library).pack(
            side="left")
        ttk.Button(top, text="download selected", command=self._download).pack(
            side="left", padx=4)
        self.cancel_btn = ttk.Button(top, text="cancel", command=self._cancel_downloads,
                                     state="disabled")
        self.cancel_btn.pack(side="left", padx=(0, 10))
        for i in range(N_SLOTS):
            ttk.Button(top, text=f"-> slot {i + 1}", width=8,
                       command=lambda k=i: self._library_to_slot(k)).pack(
                side="left", padx=2)
        self.lib_status = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.lib_status, foreground="#666").pack(
            side="left", padx=10)
        ttk.Label(self.tab_lib,
                  text="ctrl-click or shift-click to select several; ctrl+A selects "
                       "all. -> slot N with several selected fills slot N and the "
                       "slots after it, in list order.",
                  foreground="#666").pack(anchor="w")
        self._dl_queue = deque()     # (entry, then) waiting to download
        self._dl_busy = set()        # model ids queued or downloading
        self._dl_thread = None
        self._dl_cancel = threading.Event()
        self._dl_done = self._dl_total = 0

        self.lib_progress = ttk.Progressbar(self.tab_lib, maximum=100.0)
        self.lib_progress.pack(fill="x", pady=4)
        self.lib_tree = ttk.Treeview(
            self.tab_lib, columns=("size", "io", "have", "desc"),
            show="tree headings", height=18)
        for col, text, width, anchor in (("#0", "model", 210, "w"),
                                         ("size", "MB", 55, "e"),
                                         ("io", "i/o", 55, "center"),
                                         ("have", "local", 50, "center"),
                                         ("desc", "what it is", 520, "w")):
            self.lib_tree.heading(col, text=text)
            self.lib_tree.column(col, width=width, anchor=anchor)
        self.lib_tree.pack(fill="both", expand=True)
        self.lib_tree.bind("<Control-a>", lambda e: (
            self.lib_tree.selection_set(self.lib_tree.get_children()), "break")[1])
        self._refill_library()

    def _refill_library(self):
        self.lib_tree.delete(*self.lib_tree.get_children())
        for i, e in enumerate(self.library.entries):
            self.lib_tree.insert("", "end", iid=str(i), text=e.name,
                                 values=(f"{e.size_mb:.0f}",
                                         "mono" if e.mono else "stereo",
                                         "yes" if self.library.have(e) else "",
                                         e.description[:110]))
        have = len(self.library.downloaded())
        self.lib_status.set(f"{len(self.library.entries)} models, {have} downloaded")

    def _refresh_library(self):
        self.lib_status.set("fetching the model list...")

        def work():
            try:
                n = self.library.refresh()
                self._post(self._refill_library)
                self._post(lambda: self.lib_status.set(f"{n} models"))
            except Exception as exc:
                self._post(lambda e=exc:
                                messagebox.showerror("refresh failed", str(e)))
                self._post(lambda: self.lib_status.set("refresh failed"))

        threading.Thread(target=work, daemon=True).start()

    def _selected_entries(self):
        """The selected models, in the order they appear in the list."""
        order = {iid: n for n, iid in enumerate(self.lib_tree.get_children())}
        sel = sorted(self.lib_tree.selection(), key=lambda i: order.get(i, 0))
        return [self.library.entries[int(i)] for i in sel]

    def _set_local_cell(self, entry, text):
        for iid in self.lib_tree.get_children():
            if self.library.entries[int(iid)] is entry:
                self.lib_tree.set(iid, "have", text)
                return

    def _download(self, then_for=None):
        """Queue every selected model. `then_for(entry)` may return a callback
        to run with the file's path once that model is on disk."""
        entries = self._selected_entries()
        if not entries:
            messagebox.showinfo("download", "Select one or more models first.")
            return
        queued = 0
        for e in entries:
            then = then_for(e) if then_for else None
            if self.library.have(e):
                if then:
                    then(self.library.path_for(e))
                continue
            if e.model_id in self._dl_busy:
                continue  # already on its way; a second copy would just race it
            self._dl_busy.add(e.model_id)
            self._dl_queue.append((e, then))
            self._set_local_cell(e, "queued")
            queued += 1
        if queued:
            self._dl_total += queued
            self._start_downloads()
        elif not self._dl_busy:
            self.lib_status.set("already downloaded")

    def _start_downloads(self):
        if self._dl_thread is not None and self._dl_thread.is_alive():
            return
        self._dl_cancel.clear()
        self.cancel_btn.config(state="normal")
        self._dl_thread = threading.Thread(target=self._download_worker, daemon=True)
        self._dl_thread.start()

    def _cancel_downloads(self):
        self._dl_cancel.set()
        self.lib_status.set("cancelling...")

    def _download_worker(self):
        # One at a time: parallel downloads only split the bandwidth, make the
        # progress meaningless, and leave several half-written files when the
        # window is closed.
        while self._dl_queue and not self._dl_cancel.is_set():
            entry, then = self._dl_queue.popleft()
            n = self._dl_done + 1
            last = [0.0]

            def progress(got, total, entry=entry, n=n):
                now = time.monotonic()
                if now - last[0] < 0.1 and got < total:
                    return  # ten updates a second is plenty for a progress bar
                last[0] = now
                pct = 100.0 * got / total if total else 0.0
                text = (f"downloading {n} of {self._dl_total}: {entry.name}  "
                        f"{got / 1e6:.0f} of {total / 1e6:.0f} MB")
                self._post(lambda: (self.lib_progress.config(value=pct),
                                            self.lib_status.set(text),
                                            self._set_local_cell(entry, f"{pct:.0f}%")))

            try:
                path = self.library.fetch(entry, progress=progress,
                                          cancel=self._dl_cancel.is_set)
                self._dl_done += 1
                self._post(lambda e=entry: self._set_local_cell(e, "yes"))
                self._post(self._refill_all_pickers)
                if then:
                    self._post(lambda t=then, pth=path: t(pth))
            except Exception as exc:
                cancelled = self._dl_cancel.is_set()
                self._post(lambda e=entry: self._set_local_cell(e, ""))
                if not cancelled:
                    self._post(lambda e=exc, en=entry: messagebox.showerror(
                        "download failed", f"{en.name}: {e}"))
            finally:
                self._dl_busy.discard(entry.model_id)

        # whatever is left was cancelled
        while self._dl_queue:
            entry, _ = self._dl_queue.popleft()
            self._dl_busy.discard(entry.model_id)
            self._post(lambda e=entry: self._set_local_cell(e, ""))
        done, total = self._dl_done, self._dl_total
        self._dl_done = self._dl_total = 0
        cancelled = self._dl_cancel.is_set()

        def finish():
            self.lib_progress.config(value=0)
            self.cancel_btn.config(state="disabled")
            have = len(self.library.downloaded())
            what = "cancelled" if cancelled else "done"
            self.lib_status.set(f"{what}: {done} of {total} downloaded  |  "
                                f"{len(self.library.entries)} models, {have} local")

        self._post(finish)

    def _library_to_slot(self, i):
        """Download if needed, then load. With several selected, fill slot i
        and the ones after it in list order; models past slot 4 are only
        downloaded."""
        entries = self._selected_entries()
        if not entries:
            messagebox.showinfo("load", "Select one or more models first.")
            return
        targets = {id(e): i + n for n, e in enumerate(entries) if i + n < N_SLOTS}
        if len(entries) > N_SLOTS - i:
            self.lib_status.set(f"{len(entries) - (N_SLOTS - i)} model(s) past slot 4 "
                                f"will only be downloaded")

        def then_for(e):
            k = targets.get(id(e))
            return None if k is None else (lambda path, k=k: self._load_path(k, path))

        self._download(then_for=then_for)

    def _refill_all_pickers(self):
        for i, ui in enumerate(self.slot_ui):
            keep = ui["picker"].get()
            self._refill_picker(ui, i)
            if keep in ui["picker"]["values"]:
                ui["picker"].set(keep)

    # -- refresh ------------------------------------------------------------

    def _rebuild_all(self):
        self.reg = self.rack.registry()
        for i, ui in enumerate(self.slot_ui):
            self._rebuild_slot_params(ui, i)
        self._rebuild_chain()
        self._refill_targets()

    def _post(self, fn, *args) -> None:
        """Run `fn(*args)` on the window's own thread, at the next tick."""
        self._ui_calls.put((fn, args))

    def _drain_ui_calls(self) -> None:
        for _ in range(500):
            try:
                fn, args = self._ui_calls.get_nowait()
            except queue.Empty:
                return
            try:
                fn(*args)
            except Exception as exc:
                log.error("window update failed: %s", exc)

    def _refresh(self):
        self._drain_ui_calls()
        # Only the visible tab's sliders are pulled back in; refreshing every
        # row on every tick is what would make this window feel sticky.
        tab = self.tabs.index(self.tabs.select())
        if tab == 0:
            for ui in self.slot_ui:
                for r in ui["rows"] + ui["param_rows"] + ui["switches"]:
                    r.refresh()
            for r in self.master_rows:
                r.refresh()
        elif tab == 1:
            for r in self.synth_rows:
                r.refresh()
            if self._tick % 3 == 0:
                self._refresh_voices()
            self.scale_label.set(
                f"   {self.rack.synth.connected_count()} client(s) connected, "
                f"{self.rack.synth.active_count()} sounding")
            if self.scale_box.get() != self.rack.synth.scale_name():
                self.scale_box.set(self.rack.synth.scale_name())
            if self.queen_box.get() != self.rack.synth.queen_mode_name():
                self.queen_box.set(self.rack.synth.queen_mode_name())
                self._queen_why()
            qi = self.rack.synth.queen_index
            self.queen_who.set(
                f"voice {qi + 1}  (uid {self.rack.synth.queen_uid})"
                if qi >= 0 else "no queen")
        elif tab == 2:
            for r in self.chain_rows:
                r.refresh()

        for i, ui in enumerate(self.slot_ui):
            ui["meter"]["value"] = meter_value(self.rack.slots[i].peak)
        self.master_meter["value"] = meter_value(self.rack.master_peak)
        if tab == 0:
            z = self.rack.zones
            for i, ui in enumerate(self.slot_ui):
                g = z.gains[i]
                ui["section"]["value"] = float(np.clip((gain_to_db(g) + 30.0) / 36.0,
                                                       0.0, 1.0) * 100.0)
                txt = f"cam {gain_to_db(g):+.0f} dB" if z.source != "none" else "cam -"
                if ui["section_text"].get() != txt:
                    ui["section_text"].set(txt)
                if ui["source"].get() != self.rack.slots[i].source:
                    ui["source"].set(self.rack.slots[i].source)
            if self.rack.routing == "personal":
                pl = self.rack.personal
                spares = sum(len(v) for v in pl.spares.values())
                loading = sum(1 for k in pl.pending if k[0] != "spare")
                fail = "; ".join(f"slot {t + 1}: {e}" for t, e in pl.failures.items())
                self.personal_status.set(
                    f"{len(pl.instances)} private model(s) running, {loading} loading, "
                    f"{spares} spare" + (f"   FAILED {fail}" if fail else ""))
                for r in self.personal_rows:
                    r.refresh()
                if self.routing_var.get() != self.rack.routing:
                    self.routing_var.set(self.rack.routing)
                    self._change_routing(apply=False)
            counts = " ".join(f"{c:.0f}" for c in z.counts)
            self.zone_status.set(f"source: {z.source}   people per section: {counts}")

        if self.rack.running:
            src = self.rack.current_input()
            if src == "mic" and not self.rack.duplex_active:
                src = "mic (no input device)"
            self.status.set(
                f"running  |  {src}  |  {self.rack.block} smp  |  "
                f"latency {1000.0 * self.rack.latency / self.rack.sr:.0f} ms  |  "
                f"load {self.rack.load_pct:.0f}%  |  "
                f"underruns {self.rack.underruns}  clips {self.rack.clips}")
        else:
            self.status.set("stopped")

        if tab == 3:
            self._refresh_osc()

        self.address.refresh()
        self._refresh_audio_io()
        cpu = self.rack.cpu.sample() if self._tick % 5 == 0 else self.rack.cpu.machine
        if self._tick % 5 == 0:
            self.graph.push(self.rack.load_pct if self.rack.running else 0.0, cpu)
            self.graph.draw()
            self.graph.text.set(
                f"budget {self.rack.load_pct:.0f}%   cpu {cpu:.0f}%")
        self._tick += 1
        self._pending_after = self.root.after(100, self._refresh)

    def _refresh_voices(self):
        """Rebuild the who-is-here table. Rows are keyed by slot, so a voice
        keeps its row while it plays and loses it when its phone leaves."""
        sy = self.rack.synth
        qi = sy.queen_index
        wanted = {}
        for v in sy.connected():
            who = v.name or (v.uid if v.uid else "(no roster yet)")
            if v.uid and v.name:
                who = f"{v.name}  ({v.uid})"
            if v.index == qi:
                who = "\u265b " + who
            bars = int(round(min(max(v.level, 0.0), 1.0) * 20))
            level = "\u2588" * bars + "\u2591" * (20 - bars)
            bus = "-"
            if self.rack.split:
                bus = "queen" if v.queen_w >= 0.5 else "crowd"
            model = "-"
            if self.rack.routing == "personal":
                model = self.rack.personal.describe_voice(v.index)
                if (self.rack.personal.assign == "queen apart" and v.queen_w >= 0.5
                        and ("queen",) in self.rack.personal.instances):
                    model = "queen's model"
            tags = []
            if v.index == qi:
                tags.append("queen")
            if not v.connected:
                tags.append("leaving")
            wanted[str(v.slot)] = (f"voice {v.slot}",
                                   (who, v.platform or "", level,
                                    f"{v.pitch:.0f} Hz", f"{v.rough:.2f}", bus, model),
                                   tuple(tags))
        for iid in self.voice_tree.get_children():
            if iid not in wanted:
                self.voice_tree.delete(iid)
        for iid in sorted(wanted, key=int):
            text, values, tags = wanted[iid]
            if self.voice_tree.exists(iid):
                self.voice_tree.item(iid, values=values, tags=tags)
            else:
                self.voice_tree.insert("", "end", iid=iid, text=text,
                                       values=values, tags=tags)

    def _show_send_list(self):
        from morpho_rack import format_send_list

        text = format_send_list(self.osc.mappings, self.rack.zones.get("on") >= 0.5)
        win = tk.Toplevel(self.root)
        win.title("what the backend needs to send")
        box = tk.Text(win, width=90, height=40, font=("Consolas", 10))
        box.insert("1.0", text)
        box.config(state="disabled")
        box.pack(fill="both", expand=True)

    def _refresh_osc(self):
        if self.osc.running:
            self.osc_status.set(
                f"listening on {self.osc.port}  |  {self.osc.packets} packets  |  "
                f"{len(self.osc.seen)} addresses  |  {self.osc.errors} errors")
        else:
            self.osc_status.set("not listening")

        if self.osc.learned is not None:
            address, arg = self.osc.learned
            self.osc.learned = None
            group = oscmap.group_label(address)
            self._refill_source_groups()
            if group in self.src_group["values"]:
                self.src_group.set(group)
                self._src_group_changed()
            self.m_address.set(address)
            self.m_arg.set(str(arg))
            self.learn_btn.config(text="learn")

        for address in sorted(self.osc.seen):
            group = oscmap.group_label(address)
            node = f"group:{group}"
            if not self.seen_tree.exists(node):
                self.seen_tree.insert("", "end", iid=node, text=group, open=True)
                self._seen_groups.add(group)
                self._refill_source_groups()
            count, values, _ = self.osc.seen[address]
            shown = "  ".join(f"{v:.2f}" if isinstance(v, float) else str(v)
                              for v in values[:4])
            if self.seen_tree.exists(address):
                self.seen_tree.item(address, values=(shown,))
            else:
                self.seen_tree.insert(node, "end", iid=address, text=address,
                                      values=(shown,))

        if len(self._map_iids) != len(self.osc.mappings) or any(
                self._map_iid(m) not in self._map_iids for m in self.osc.mappings):
            self._refill_map_tree()
        else:
            # Only rows whose numbers moved are touched: seventy routes rewritten
            # ten times a second was enough to make the list lag under the mouse.
            for m in self.osc.mappings:
                iid = self._map_iid(m)
                row = self._map_row(m)
                if self._map_rows.get(iid) != row:
                    self._map_rows[iid] = row
                    self.map_tree.item(iid, values=row)

    def _on_close(self):
        if self._pending_after is not None:
            self.root.after_cancel(self._pending_after)
            self._pending_after = None
        self.osc.stop()
        self.rack.stop()
        self.root.destroy()

    def run(self):
        self.root.mainloop()
