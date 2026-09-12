#!/usr/bin/env python3
"""
morpho_rack.py -- four Neutone models in parallel on one input signal.

Why this exists
---------------
The collective layer of the piece is several tone-morph models fed from the same
source and mixed afterwards (CLAUDE.md section 9). In a DAW that is one plugin
instance per track: four latency figures, four mixers, and nothing the swarm can
reach. Here it is one process, so the four models share a clock, a reported
latency and a mixer, and every knob in the rack can be driven by the OSC the
backend already sends.

What it is made of
------------------
    rack.py      the engine: slots, mixing, audio I/O, the parameter registry
    synth.py     one sine voice per client, as an alternative to a microphone
    dsp.py       the conditioning around each model, matching the plugin's
    library.py   the official Neutone model index, and downloading from it
    oscmap.py    OSC in, and the table saying what drives what
    gui.py       the window

The Neutone SDK is `neutone_sdk`; Morpho itself is a plugin with no Python API.
Its models are `.nm` files, which is what this loads, so a model exported for
Morpho runs here too.

Usage
-----
    python morpho_rack.py                        # the window
    python morpho_rack.py --input test           # no audio input needed
    python morpho_rack.py --input file --file loop.wav
    python morpho_rack.py --input synth          # a sine voice per client
    python morpho_rack.py --models a.nm b.nm     # preload slots
    python morpho_rack.py --osc-port 9001        # listen for the swarm
    python morpho_rack.py --default-routing      # swarm and client routes
    python morpho_rack.py --chain voice          # a conditioning setup
    python morpho_rack.py --no-gui --preset live.json --routing live.json
    python morpho_rack.py --refresh-library      # re-scrape the model list
    python morpho_rack.py --list-models
    python morpho_rack.py --list-devices
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import dsp  # noqa: E402
import library as library_mod  # noqa: E402
import oscmap  # noqa: E402
import synth  # noqa: E402
from rack import N_SLOTS, Rack, _require, db_to_gain  # noqa: E402

log = logging.getLogger("morpho_rack")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Run four Neutone (.nm) models in parallel on one input signal."
    )
    ap.add_argument("--models", nargs="*", default=None, help="up to four .nm files")
    ap.add_argument("--model-dir", type=Path, default=HERE / "models",
                    help="where downloaded models live")
    ap.add_argument("--input", choices=["device", "mic", "synth", "both",
                                        "file", "test"], default="device",
                    help="what feeds the models. device and mic are the same "
                         "thing; both is mic plus synth")
    ap.add_argument("--voices", type=int, default=8,
                    help="synth voices, one per client (max 16)")
    ap.add_argument("--chain", default=None,
                    help="conditioning setup applied to every slot at startup: "
                         + ", ".join(dsp.CHAIN_PRESETS))
    ap.add_argument("--default-routing", action="store_true",
                    help="start with the built-in swarm and per-client routes")
    ap.add_argument("--scale", default=None,
                    help="synth scale, or 'free' for no quantising at all: "
                         + ", ".join(n for n, _ in synth.SCALES))
    ap.add_argument("--queen-mode", default=None,
                    help="how the queen takes precedence: "
                         + ", ".join(synth.queen_mode_names()))
    ap.add_argument("--file", type=Path, default=None, help="wav to loop")
    ap.add_argument("--sr", type=int, default=48000)
    ap.add_argument("--block", type=int, default=1024,
                    help="audio block size. 1024 is the default because four "
                         "models plus their conditioning will not fit in 512 "
                         "with every effect switched on; drop it if you need "
                         "the latency and are running a light chain")
    ap.add_argument("--channels", type=int, choices=[1, 2], default=1,
                    help="processing width; output is always stereo")
    ap.add_argument("--in-device", default=None)
    ap.add_argument("--out-device", default=None)
    ap.add_argument("--prime", type=int, default=3,
                    help="output blocks buffered ahead; raise on underruns")
    ap.add_argument("--master", type=float, default=-6.0,
                    help="master level in dB; four summed voices need headroom")
    ap.add_argument("--torch-threads", type=int, default=1,
                    help="intra-op threads per model. 1 is the default and is "
                         "measurably the best: the four slots already run in "
                         "parallel, so intra-op threads only add "
                         "synchronisation. Measured here, going from 1 to 5 "
                         "made the audio work nearly twice as slow and used "
                         "six times the CPU.")
    ap.add_argument("--osc-port", type=int, default=9001,
                    help="udp port to receive HIVE's OSC on")
    ap.add_argument("--no-osc", action="store_true", help="do not listen for OSC")
    ap.add_argument("--routing", type=Path, default=None,
                    help="OSC routing table to load at startup")
    ap.add_argument("--preset", type=Path, default=None,
                    help="rack preset to load at startup")
    ap.add_argument("--validate", action="store_true",
                    help="use the SDK's validating loader, which does network checks")
    ap.add_argument("--refresh-library", action="store_true",
                    help="re-scrape the official model list, then carry on")
    ap.add_argument("--list-models", action="store_true")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--no-gui", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    lib = library_mod.Library(args.model_dir)
    if args.refresh_library or (args.list_models and not lib.entries):
        try:
            lib.refresh()
        except Exception as exc:
            log.error("could not refresh the model list: %s", exc)

    if args.list_models:
        if not lib.entries:
            print("no model list; run with --refresh-library while online")
            return
        for e in lib.entries:
            mark = "*" if lib.have(e) else " "
            line = f"{mark} {e.name:34} {e.size_mb:6.0f} MB  {e.description[:60]}"
            sys.stdout.buffer.write(line.encode("utf-8", "replace") + b"\n")
        print(f"\n{len(lib.downloaded())} of {len(lib.entries)} downloaded (*)")
        return

    if args.list_devices:
        sd = _require("sounddevice", "sounddevice")
        print(sd.query_devices())
        return

    _require("sounddevice", "sounddevice")  # fail here, not from a GUI button
    torch = _require("torch", "torch")
    # One thread per model. The four slots already overlap on the pool, and
    # letting torch fan out inside each one costs more in synchronisation than
    # it saves: on this laptop 5 threads took 35% of the block budget and 89%
    # of the machine, while 1 took 18% and 15%. The spare cores matter -- the
    # backend, the camera and the projector share this machine.
    threads = max(1, args.torch_threads)
    torch.set_num_threads(threads)
    log.info("torch %s, CPU, %d intra-op thread(s) per model",
             torch.__version__, threads)

    def parse_device(v):
        if v is None:
            return None
        try:
            return int(v)
        except ValueError:
            return v

    # "device" is the historical spelling of "mic"
    source = "mic" if args.input == "device" else args.input
    rack = Rack(
        sr=args.sr, block=args.block, n_ch=args.channels,
        source="device" if source in ("mic", "both") else source,
        wav=args.file, in_device=parse_device(args.in_device),
        out_device=parse_device(args.out_device), prime=args.prime,
        validate=args.validate, voices=args.voices,
    )
    rack.select_input(source)
    rack.master_gain = db_to_gain(args.master)

    receiver = oscmap.Receiver(rack.set_param)
    receiver.port = args.osc_port
    # /hive/queen and /hive/leave are identities, not values, so they are
    # handled directly rather than through the routing table.
    rack.bind_osc(receiver)

    # models: explicit paths win, then a preset, then whatever is in the cache
    paths = [Path(p) for p in args.models] if args.models else []
    if not paths and not args.preset:
        paths = lib.local_files()
        if paths:
            log.info("found %d model(s) in %s", len(paths), args.model_dir)
    for i, path in enumerate(paths[:N_SLOTS]):
        try:
            rack.load_slot(i, path)
            log.info("slot %d: %s (%s)", i + 1, rack.slots[i].name, Path(path).name)
        except Exception:
            pass  # already logged; the slot stays empty and the rack still runs

    if args.scale:
        try:
            rack.synth.set_scale_by_name(args.scale)
        except KeyError:
            log.error("no such scale %r; try one of: %s", args.scale,
                      ", ".join(n for n, _ in synth.SCALES))
    if args.queen_mode:
        try:
            rack.synth.set_queen_mode_by_name(args.queen_mode)
        except KeyError:
            log.error("no such queen mode %r; try one of: %s", args.queen_mode,
                      ", ".join(synth.queen_mode_names()))
    if args.chain:
        try:
            rack.apply_chain_preset(args.chain)
        except KeyError:
            log.error("no such chain setup %r; try one of: %s",
                      args.chain, ", ".join(dsp.CHAIN_PRESETS))
    if args.default_routing:
        receiver.mappings = oscmap.default_mappings(rack.synth.n_voices, N_SLOTS)
        log.info("osc: %d default routes", len(receiver.mappings))
        for note in oscmap.DEFAULT_NOTES:
            log.info("  %s", note)

    if args.preset:
        try:
            rack.load_preset(args.preset)
        except Exception as exc:
            log.error("could not load preset %s: %s", args.preset, exc)
    if args.routing:
        try:
            receiver.load(args.routing)
        except Exception as exc:
            log.error("could not load routing %s: %s", args.routing, exc)

    if not args.no_osc:
        try:
            receiver.start(receiver.port)
        except Exception as exc:
            log.error("could not listen on udp %d: %s", receiver.port, exc)

    if args.no_gui:
        rack.start()
        print("running; ctrl-c to stop")
        try:
            while True:
                time.sleep(2.0)
                log.info(
                    "load %.0f%%  underruns %d  clips %d  peak %.2f  osc %d  "
                    "voices %d",
                    rack.load_pct, rack.underruns, rack.clips,
                    rack.master_peak, receiver.packets,
                    rack.synth.active_count(),
                )
        except KeyboardInterrupt:
            pass
        finally:
            receiver.stop()
            rack.stop()
        return

    import gui  # imported late so --list-* work without a display

    app = gui.App(rack, lib, receiver, preset_dir=HERE / "presets")
    app.run()


if __name__ == "__main__":
    main()
