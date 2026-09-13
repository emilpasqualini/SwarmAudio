"""Audio devices: listing, labelling, remembering the choice.

Windows shows every piece of hardware several times over, once per host API
(MME, DirectSound, WASAPI, WDM-KS, and ASIO when a driver is installed). They
behave differently: MME and DirectSound resample anything and add latency,
WASAPI runs at the device's own rate with less latency, WDM-KS and ASIO talk to
the driver directly. Only ASIO and WASAPI are offered, each device once; every
entry is labelled with its host API, and marked when it cannot run at the rack's
sample rate -- opening one of those is what fails with an unhelpful PortAudio
error.

A device's index changes whenever something is plugged in or unplugged, so the
choice is remembered by name and host API instead, in presets/audio.json.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("morpho_rack.devices")

SHORT_API = {
    "MME": "MME",
    "Windows DirectSound": "DirectSound",
    "Windows WASAPI": "WASAPI",
    "Windows WDM-KS": "WDM-KS",
    "ASIO": "ASIO",
    "Core Audio": "CoreAudio",
    "ALSA": "ALSA",
    "JACK Audio Connection Kit": "JACK",
    "PulseAudio": "Pulse",
}

# Listed in this order, lowest latency first, so the usual right answer is near
# the top of the list.
API_ORDER = ("ASIO", "WASAPI", "WDM-KS", "CoreAudio", "JACK", "ALSA", "Pulse",
             "DirectSound", "MME")

# Only these are offered on Windows. MME and DirectSound add latency and cut
# names short, and WDM-KS lists every endpoint of a codec separately, so between
# them the same microphone showed up five times. WASAPI covers every device
# Windows knows; ASIO is there for interfaces that ship a driver. Elsewhere, where
# neither exists, every host API is offered.
PREFERRED_APIS = ("ASIO", "WASAPI")


@dataclass
class Device:
    index: int
    name: str
    api: str
    max_in: int
    max_out: int
    default_sr: float
    ok_in: bool = True
    ok_out: bool = True

    def label(self, kind: str) -> str:
        ok = self.ok_in if kind == "in" else self.ok_out
        ch = self.max_in if kind == "in" else self.max_out
        mark = "" if ok else "   (not at this sample rate)"
        return f"{self.name}  ·  {self.api}  ·  {ch} ch{mark}"


def rescan() -> None:
    """Make PortAudio look again, for an interface plugged in after start."""
    import sounddevice as sd

    try:
        sd._terminate()
    finally:
        sd._initialize()
        use_preferred_defaults()


def api_of(index) -> str:
    import sounddevice as sd

    try:
        d = sd.query_devices(index)
        name = sd.query_hostapis(d["hostapi"])["name"]
        return SHORT_API.get(name, name)
    except Exception:
        return ""


def extra_settings(index, kind: str):
    """Host-API options for opening a device.

    WASAPI in shared mode only opens at the rate Windows has set for the device,
    so a 44.1 kHz microphone refused the rack's 48 kHz. With auto_convert
    Windows resamples instead, which is what MME always did silently."""
    import sounddevice as sd

    if index is None:
        index = sd.default.device[0 if kind == "in" else 1]
    if api_of(index) == "WASAPI":
        return sd.WasapiSettings(auto_convert=True)
    return None


def use_preferred_defaults() -> None:
    """Point "the system default" at the WASAPI endpoints Windows has chosen.

    PortAudio's own default is the MME one, the host API this rack no longer
    offers, so the default device would otherwise be the one device in the rack
    not on the list."""
    import sounddevice as sd

    for api in sd.query_hostapis():
        if SHORT_API.get(api["name"]) == "WASAPI":
            d_in, d_out = api["default_input_device"], api["default_output_device"]
            cur_in, cur_out = sd.default.device
            sd.default.device = (d_in if d_in >= 0 else cur_in,
                                 d_out if d_out >= 0 else cur_out)
            return


def scan(samplerate: int):
    """Return (inputs, outputs, default input index, default output index)."""
    import sounddevice as sd

    use_preferred_defaults()
    apis = sd.query_hostapis()
    devices = []
    for i, d in enumerate(sd.query_devices()):
        api = SHORT_API.get(apis[d["hostapi"]]["name"], apis[d["hostapi"]]["name"])
        devices.append(Device(i, str(d["name"]).strip(), api,
                              int(d["max_input_channels"]),
                              int(d["max_output_channels"]),
                              float(d["default_samplerate"])))
    if any(d.api in PREFERRED_APIS for d in devices):
        devices = [d for d in devices if d.api in PREFERRED_APIS]

    for dev in devices:
        if dev.max_in > 0:
            try:
                sd.check_input_settings(device=dev.index, channels=1,
                                        samplerate=samplerate, dtype="float32",
                                        extra_settings=extra_settings(dev.index, "in"))
            except Exception:
                dev.ok_in = False
        if dev.max_out > 0:
            try:
                sd.check_output_settings(device=dev.index, channels=1,
                                         samplerate=samplerate, dtype="float32",
                                         extra_settings=extra_settings(dev.index, "out"))
            except Exception:
                dev.ok_out = False

    def order(dev):
        rank = API_ORDER.index(dev.api) if dev.api in API_ORDER else len(API_ORDER)
        return (rank, dev.name.lower())

    def unique(pool):
        # A device with an ASIO driver is also on WASAPI; ASIO sorts first and
        # wins. Two identical interfaces have the same name too, though, so only
        # a repeat on a different host API counts as a double.
        seen, out = {}, []
        for d in sorted(pool, key=order):
            key = d.name.lower()
            if key in seen and seen[key] != d.api:
                continue
            seen.setdefault(key, d.api)
            out.append(d)
        return out

    inputs = unique(d for d in devices if d.max_in > 0)
    outputs = unique(d for d in devices if d.max_out > 0)
    default_in, default_out = sd.default.device
    return inputs, outputs, default_in, default_out


def describe(index, kind: str) -> str:
    """"name · API" for a device index, or for the system default when None."""
    import sounddevice as sd

    try:
        d = sd.query_devices(index, "input" if kind == "in" else "output")
        api = sd.query_hostapis(d["hostapi"])["name"]
        return f"{str(d['name']).strip()} · {SHORT_API.get(api, api)}"
    except Exception:
        return "unavailable"


def channel_choices(max_channels: int, width: int, kind: str) -> list:
    """Labels for the channel dropdown.

    Input: "mix" (average every channel) then each single channel for a mono
    rack, or each pair for a stereo one. Output: each pair, or "1" for a device
    with a single output.
    """
    labels = []
    if kind == "in":
        labels.append("mix")
        if width == 1:
            labels += [str(c + 1) for c in range(max_channels)]
        else:
            labels += [f"{c + 1}-{c + 2}" for c in range(0, max(max_channels - 1, 0))]
    else:
        if max_channels <= 1:
            labels.append("1")
        else:
            labels += [f"{c + 1}-{c + 2}" for c in range(0, max_channels - 1, 2)]
    return labels


def parse_channel(label: str) -> int:
    """First channel, 0-based, from a dropdown label; -1 means mix."""
    if not label or label == "mix":
        return -1
    return int(label.split("-")[0]) - 1


def channel_label(index: int, width: int, kind: str) -> str:
    if index < 0:
        return "mix"
    if kind == "in" and width == 1:
        return str(index + 1)
    return f"{index + 1}-{index + 2}"


# ---------------------------------------------------------------------------
# remembering the choice
# ---------------------------------------------------------------------------

def identity(index, kind) -> Optional[dict]:
    """{"name", "api"} for a device index or name; None for the system default."""
    if index is None:
        return None
    import sounddevice as sd

    try:
        d = sd.query_devices(index)
        api = sd.query_hostapis(d["hostapi"])["name"]
        return {"name": str(d["name"]).strip(), "api": SHORT_API.get(api, api)}
    except Exception:
        return None


def find(identity: Optional[dict], kind: str, samplerate: int):
    """The current index of a remembered device, or None if it is not here."""
    if not identity:
        return None
    inputs, outputs, _, _ = scan(samplerate)
    pool = inputs if kind == "in" else outputs
    for d in pool:
        if d.name == identity.get("name") and d.api == identity.get("api"):
            return d.index
    return None


def save(path: Path, rack) -> None:
    data = {
        "input": identity(rack.in_device, "in"),
        "output": identity(rack.out_device, "out"),
        "input_enabled": bool(rack.duplex),
        "in_channel": rack.in_channel,
        "out_channel": rack.out_channel,
    }
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(data, indent=1), encoding="utf-8")
    except OSError as exc:
        log.warning("could not remember the audio devices: %s", exc)


def load(path: Path, samplerate: int) -> Optional[dict]:
    """The remembered settings with devices resolved to today's indices.

    A remembered device that is not plugged in comes back as None, meaning the
    system default, and is reported in "missing"."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    out = {
        "in_device": find(data.get("input"), "in", samplerate),
        "out_device": find(data.get("output"), "out", samplerate),
        "input_enabled": bool(data.get("input_enabled", True)),
        "in_channel": int(data.get("in_channel", 0)),
        "out_channel": int(data.get("out_channel", 0)),
        "missing": [],
    }
    for key, kind in (("input", "in_device"), ("output", "out_device")):
        if data.get(key) and out[kind] is None:
            out["missing"].append(f"{data[key]['name']} · {data[key]['api']}")
    return out
