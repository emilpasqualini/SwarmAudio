# SwarmAudio — Team HIVE

*Music & AI Hackathon 2026, Uttendorf.*

Many phones, one swarm. Everyone in the room scans a QR code; their phone's
tilt and motion stream to a Mac, which turns the swarm into OSC for the sound
installation — and, later, lets us play recorded or external swarms (bee data)
through the same pipeline to hear how they differ.

```
phones ──sensors, 60 Hz──▶ backend on the Mac ──OSC/UDP──▶ Pd / Max / SC / REAPER / Python  (any laptop on the Wi-Fi)
webcam ──YOLO pose (Python)─▶        │            /hive/sample · swarm · global · cam · mix · queen
                                   ├──▶ /wall      projector: wi-fi + join QR codes, the swarm as bees, the queen, the crowd as shadows
                                   └──▶ /monitor   laptop: config, devices, what the camera sees, test tones
```

## Folders

| folder | what | owner |
|---|---|---|
| [`backend/`](backend/) | Node/TypeScript server, phone web app, wall and monitor pages, OSC output, examples | Emil |
| *(yours)* | Pd patches, SuperCollider, datasets, visuals — one folder per workstream | |

## Start here

```bash
cd backend && ./start.sh
```

Prints a QR code, opens the dashboard. Phones scan, tap through the
certificate warning once, tap **join**. Put `http://localhost:8080/wall` on the
projector: Wi-Fi and join QR codes, the swarm as bees, and the queen — the bee
that moved most, until someone flies into her. Full instructions, network
advice and the venue setup: [`backend/README.md`](backend/README.md).

## Receiving the swarm in your tool

Add your laptop's IP as an OSC target on the dashboard, press **Ping**, and read
the protocol: **[`backend/docs/OSC.md`](backend/docs/OSC.md)** — every message,
every field, with Pd / Max / SC / Python snippets. Ready-made:
[`backend/examples/hive-receive.pd`](backend/examples/hive-receive.pd),
[`osc_listen.py`](backend/examples/osc_listen.py),
[`feed_client.py`](backend/examples/feed_client.py).

The short version: `/hive/sample` carries, per phone and sample, a stable
`uid`, a session `slot`, raw acceleration, re-zeroed acceleration (`rel`, 0 at
rest at any angle, One-Euro smoothed), gyroscope, an `activity` level,
magnitudes and `turn` (rotation about the vertical, however the phone is held).
`/hive/queen` says who the queen bee is; `/hive/global` carries swarm
meta-parameters (coherence, phase sync, tempo, entropy …); `/hive/cam` what the
webcam sees (people, groups, gestures, crowd motion — anonymous, never matched
to phones); `/hive/mix` where bees and crowd meet. Fields are only ever appended, so
patches keep working as the server learns new tricks. All computation happens
on the server; phones send raw sensors only.

## Working in this repo

See [`CLAUDE.md`](CLAUDE.md) for the agreements (also read by AI assistants):
keep to your folder, do not rename OSC fields, English in code and comments.
