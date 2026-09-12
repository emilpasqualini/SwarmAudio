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
import threading
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np

import dsp
import oscmap
import synth as synth_mod
from rack import N_SLOTS, gain_to_db

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
        self.text.set(f"{self.ref.label}  {self.ref.text()}")

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

        self.graph = LoadGraph(row2)
        self.graph.canvas.pack(side="right")
        ttk.Label(row2, textvariable=self.graph.text, foreground="#666").pack(
            side="right", padx=6)

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

        bottom = ttk.Frame(body)
        bottom.grid(row=1, column=0, columnspan=N_SLOTS, sticky="ew", pady=(8, 0))
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

        rows = [ParamRow(frame, self.reg[f"slot{n}.level"], width=110, label_width=16),
                ParamRow(frame, self.reg[f"slot{n}.mix"], width=110, label_width=16)]
        ttk.Separator(frame).pack(fill="x", pady=6)
        params_frame = ttk.Frame(frame)
        params_frame.pack(fill="x")

        meter = ttk.Progressbar(frame, maximum=100.0)
        meter.pack(fill="x", side="bottom", pady=(6, 0))

        ui = {"name": name, "info": info, "picker": picker, "meter": meter,
              "params_frame": params_frame, "rows": rows, "switches": [on],
              "param_rows": []}
        self._refill_picker(ui, i)
        self._rebuild_slot_params(ui, i)
        return ui

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
                self.root.after(0, lambda e=exc:
                                messagebox.showerror("load failed", str(e)))
            self.root.after(0, self._after_model_change, i)

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
        ui["info"].set(f"{'mono' if slot.model.is_input_mono() else 'stereo'} in, "
                       f"{slot.latency} smp ({ms:.0f} ms)")
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

        voices_box = ttk.LabelFrame(self.tab_synth, text="voices", padding=6)
        voices_box.pack(fill="both", expand=True)
        cols = ttk.Frame(voices_box)
        cols.pack(fill="both", expand=True)
        n_voices = self.rack.synth.n_voices
        per_col = 4
        self.voice_ui = []
        for v in range(n_voices):
            col = v // per_col
            if v % per_col == 0:
                cols.columnconfigure(col, weight=1, uniform="voice")
            box = ttk.LabelFrame(cols, text=f"voice {v + 1}  (client {v + 1})",
                                 padding=5)
            box.grid(row=v % per_col, column=col, sticky="ew", padx=4, pady=2)
            rows = []
            for p in ("pitch", "rough", "level"):
                key = f"synth.voice{v + 1}.{p}"
                if key in self.reg:
                    rows.append(ParamRow(box, self.reg[key], width=150,
                                         label_width=16))
            meter = ttk.Progressbar(box, maximum=100.0)
            meter.pack(fill="x", pady=(3, 0))
            self.voice_ui.append({"rows": rows, "meter": meter})

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
        """group -> [(address, arg, in_lo, in_hi, why)], known plus seen."""
        cat = {"swarm": list(oscmap.SWARM_SOURCES)}
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
        with self.osc._lock:
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

    def _remove_mapping(self):
        sel = self.map_tree.selection()
        if sel and sel[0].isdigit():
            i = int(sel[0])
            if 0 <= i < len(self.osc.mappings):
                self.osc.remove(self.osc.mappings[i])
        self._refill_map_tree()

    def _pick_mapping(self, _e=None):
        sel = self.map_tree.selection()
        if not sel or not sel[0].isdigit():
            return
        m = self.osc.mappings[int(sel[0])]
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
        self.map_tree.delete(*self.map_tree.get_children())
        # grouped the same way as the sources, so a client's routes sit together
        by_group = {}
        for i, m in enumerate(self.osc.mappings):
            by_group.setdefault(oscmap.group_label(m.address), []).append((i, m))
        for group in sorted(by_group, key=lambda g: (
                0 if g == "swarm" else 1, g)):
            node = f"group:{group}"
            self.map_tree.insert("", "end", iid=node, text=group, open=True)
            for i, m in by_group[group]:
                self.map_tree.insert(node, "end", iid=str(i),
                                     text=m.address, values=self._map_row(m))

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
        for i in range(N_SLOTS):
            ttk.Button(top, text=f"-> slot {i + 1}", width=8,
                       command=lambda k=i: self._library_to_slot(k)).pack(
                side="left", padx=2)
        self.lib_status = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.lib_status, foreground="#666").pack(
            side="left", padx=10)

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
                self.root.after(0, self._refill_library)
                self.root.after(0, lambda: self.lib_status.set(f"{n} models"))
            except Exception as exc:
                self.root.after(0, lambda e=exc:
                                messagebox.showerror("refresh failed", str(e)))
                self.root.after(0, lambda: self.lib_status.set("refresh failed"))

        threading.Thread(target=work, daemon=True).start()

    def _selected_entry(self):
        sel = self.lib_tree.selection()
        return self.library.entries[int(sel[0])] if sel else None

    def _download(self, then=None):
        entry = self._selected_entry()
        if entry is None:
            messagebox.showinfo("download", "Pick a model first.")
            return
        if self.library.have(entry):
            if then:
                then(self.library.path_for(entry))
            return

        def progress(got, total):
            pct = 100.0 * got / total if total else 0.0
            self.root.after(0, lambda: self.lib_progress.config(value=pct))
            self.root.after(0, lambda: self.lib_status.set(
                f"{entry.name}: {got / 1e6:.0f} of {total / 1e6:.0f} MB"))

        def work():
            try:
                path = self.library.fetch(entry, progress=progress)
                self.root.after(0, self._refill_library)
                self.root.after(0, self._refill_all_pickers)
                self.root.after(0, lambda: self.lib_status.set(f"{entry.name} ready"))
                self.root.after(0, lambda: self.lib_progress.config(value=0))
                if then:
                    self.root.after(0, lambda: then(path))
            except Exception as exc:
                self.root.after(0, lambda e=exc:
                                messagebox.showerror("download failed", str(e)))
                self.root.after(0, lambda: self.lib_status.set("download failed"))

        threading.Thread(target=work, daemon=True).start()

    def _library_to_slot(self, i):
        self._download(then=lambda path, k=i: self._load_path(k, path))

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

    def _refresh(self):
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
            for v in self.voice_ui:
                for r in v["rows"]:
                    r.refresh()
            self.scale_label.set(
                f"   {self.rack.synth.active_count()} voice(s) sounding")
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
        if tab == 1:
            for i, v in enumerate(self.voice_ui):
                v["meter"]["value"] = meter_value(self.rack.synth.voices[i].peak)

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

        cpu = self.rack.cpu.sample() if self._tick % 5 == 0 else self.rack.cpu.machine
        if self._tick % 5 == 0:
            self.graph.push(self.rack.load_pct if self.rack.running else 0.0, cpu)
            self.graph.draw()
            self.graph.text.set(
                f"budget {self.rack.load_pct:.0f}%   cpu {cpu:.0f}%")
        self._tick += 1
        self._pending_after = self.root.after(100, self._refresh)

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

        for i, m in enumerate(self.osc.mappings):
            if self.map_tree.exists(str(i)):
                self.map_tree.item(str(i), values=self._map_row(m))
        rows = sum(1 for n in self.map_tree.get_children()
                   for _ in self.map_tree.get_children(n))
        if rows != len(self.osc.mappings):
            self._refill_map_tree()

    def _on_close(self):
        if self._pending_after is not None:
            self.root.after_cancel(self._pending_after)
            self._pending_after = None
        self.osc.stop()
        self.rack.stop()
        self.root.destroy()

    def run(self):
        self.root.mainloop()
