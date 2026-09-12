#!/usr/bin/env python3
"""
hive_vision.py — HIVE (camera)

The room as the camera sees it, for the swarm.

Two layers. The *field*: dense optical flow on a tiny grey copy of the frame,
averaged into an 8×6 grid — where the crowd moves, how hard, how alike — which
works for a hundred people at once, in the dark, overlapping, no model needed.
And the *people*: YOLO11n-pose (boxes + 17 keypoints, tracked with BoT-SORT
in people mode), a tiny DBSCAN for groups, a density grid, and a few
room-level numbers. In field mode (the default, for a full room) the model
runs at a few frames per second for the front rows only; in people mode
(small rounds) at full rate with tracking. Every processed frame goes to the HIVE backend as one
JSON message over a WebSocket (`ws://<mac>:8080/vision`), plus — when the
dashboard wants it — a small annotated JPEG as a binary message so the
dashboard can show what the camera sees. The backend does the rest: OSC
fan-out (`/hive/cam/*`), the wall, the phones' maps. Settings that matter here
(cluster radius, mirror, preview on/off) arrive back down the same socket.

People here are anonymous tracker ids. They are never matched to phones: the
camera is a field, the phones are the agents.

    python hive_vision.py                 # FaceTime camera, connect to localhost
    python hive_vision.py --show          # …with a preview window
    python hive_vision.py --source clip.mp4 --server ws://192.168.2.1:8080/vision

`--osc host:port` additionally sends /hive/cam/* straight to one target — for
running this alone, without the backend. The model (~6 MB) downloads on the
first run; do that once with internet before the venue.

Dependencies: ultralytics, opencv-python, numpy, websockets (requirements.txt).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import socket
import struct
import sys
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")
MODEL_NAME = "yolo11n-pose.pt"

# COCO keypoint indices (ultralytics pose)
L_SHOULDER, R_SHOULDER = 5, 6
L_WRIST, R_WRIST = 9, 10
L_HIP, R_HIP = 11, 12
L_KNEE, R_KNEE = 13, 14


# --- tiny DBSCAN ---------------------------------------------------------------

def dbscan(points: np.ndarray, eps: float) -> np.ndarray:
    """Cluster labels for 2-D points. DBSCAN with min_samples=1, which is the
    connected components of the graph "closer than eps" — a chain of people
    each within eps of the next is one group. No scikit-learn needed."""
    n = len(points)
    labels = -np.ones(n, dtype=int)
    if n == 0:
        return labels
    d = np.linalg.norm(points[:, None, :] - points[None, :, :], axis=2)
    cluster = 0
    for i in range(n):
        if labels[i] != -1:
            continue
        labels[i] = cluster
        stack = [i]
        while stack:
            j = stack.pop()
            for k in np.flatnonzero(d[j] <= eps):
                if labels[k] == -1:
                    labels[k] = cluster
                    stack.append(int(k))
        cluster += 1
    return labels


# --- the field: dense optical flow on an 8×6 grid ---------------------------------

GRID_W, GRID_H = 8, 6
FLOW_W, FLOW_H = 160, 90
FLOW_FULL = 0.5          # frame widths per second that count as full energy


class FlowField:
    """Farneback optical flow between consecutive tiny grey frames, averaged per
    cell. Cheap (~1 ms) and indifferent to how many people there are."""

    def __init__(self):
        self.prev: np.ndarray | None = None
        self.grid = np.zeros((GRID_H, GRID_W, 3), dtype=float)   # vx, vy (frame widths/s), energy 0..1

    def update(self, frame: np.ndarray, dt: float) -> dict:
        grey = cv2.cvtColor(cv2.resize(frame, (FLOW_W, FLOW_H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if self.prev is None or dt <= 0:
            self.prev = grey
            return self.summary()
        flow = cv2.calcOpticalFlowFarneback(self.prev, grey, None, 0.5, 2, 9, 2, 5, 1.1, 0)
        self.prev = grey
        # pixels per frame → frame widths per second
        v = flow / (FLOW_W * dt)
        ch, cw = FLOW_H // GRID_H, FLOW_W // GRID_W
        cells = v[: ch * GRID_H, : cw * GRID_W].reshape(GRID_H, ch, GRID_W, cw, 2).mean(axis=(1, 3))
        mag = np.linalg.norm(v[: ch * GRID_H, : cw * GRID_W], axis=2).reshape(GRID_H, ch, GRID_W, cw).mean(axis=(1, 3))
        energy = np.clip(mag / FLOW_FULL, 0, 1)
        # a little memory so the picture does not flicker with the camera's noise
        target = np.dstack([cells[..., 0], cells[..., 1], energy])
        self.grid += (target - self.grid) * min(1.0, dt / 0.15)
        return self.summary()

    def summary(self) -> dict:
        g = self.grid
        e = g[..., 2]
        total = float(e.sum())
        if total > 1e-6:
            vx = float((g[..., 0] * e).sum() / total)
            vy = float((g[..., 1] * e).sum() / total)
            mean_mag = float((np.hypot(g[..., 0], g[..., 1]) * e).sum() / total)
            coherence = float(math.hypot(vx, vy) / mean_mag) if mean_mag > 1e-6 else 0.0
            ys, xs = np.mgrid[0:GRID_H, 0:GRID_W]
            cx = float(((xs + 0.5) / GRID_W * e).sum() / total)
            cy = float(((ys + 0.5) / GRID_H * e).sum() / total)
        else:
            coherence, cx, cy = 0.0, 0.5, 0.5
        return {
            "flow": [[round(float(c[0]), 3), round(float(c[1]), 3), round(float(c[2]), 3)] for row in g for c in row],
            "flowEnergy": round(float(e.mean()), 4),
            "flowCoherence": round(coherence, 4),
            "flowCx": round(cx, 4),
            "flowCy": round(cy, 4),
        }

    def draw(self, img: np.ndarray) -> None:
        """Short arrows per cell on the preview, length with energy."""
        h, w = img.shape[:2]
        cw, ch = w / GRID_W, h / GRID_H
        for j in range(GRID_H):
            for i in range(GRID_W):
                vx, vy, e = self.grid[j, i]
                if e < 0.03:
                    continue
                cx, cy = int((i + 0.5) * cw), int((j + 0.5) * ch)
                mag = math.hypot(vx, vy)
                if mag > 1e-6:
                    L = min(cw, ch) * 0.45 * e
                    tip = (int(cx + vx / mag * L), int(cy + vy / mag * L))
                    cv2.arrowedLine(img, (cx, cy), tip, (180, 184, 242), 1, cv2.LINE_AA, tipLength=0.4)
                cv2.circle(img, (cx, cy), int(2 + 6 * e), (180, 184, 242), 1, cv2.LINE_AA)


class Density:
    """Where the detected people are, on the same 8×6 grid, with memory."""

    def __init__(self):
        self.grid = np.zeros((GRID_H, GRID_W), dtype=float)

    def update(self, people: list[dict]) -> None:
        hit = np.zeros_like(self.grid)
        for p in people:
            i = min(GRID_W - 1, int(p["x"] * GRID_W))
            j = min(GRID_H - 1, int(p["y"] * GRID_H))
            hit[j, i] += 1
        self.grid += (hit - self.grid) * 0.2

    def summary(self) -> dict:
        m = float(self.grid.max())
        norm = self.grid / m if m > 1e-6 else self.grid
        return {"density": [round(float(v), 3) for v in norm.ravel()], "densityMean": round(float(norm.mean()), 4)}


# --- per-person state -----------------------------------------------------------

@dataclass
class Person:
    id: int
    x: float = 0.5
    y: float = 0.5
    depth: float = 0.0
    arms_up: int = 0
    crouch: float = 0.0
    energy: float = 0.0
    last_xy: tuple[float, float] | None = None
    seen: float = field(default_factory=time.time)


class Tracker:
    """Turns YOLO results into people, clusters and room numbers."""

    def __init__(self, eps: float):
        self.eps = eps
        self.people: dict[int, Person] = {}

    def update(self, result, frame_w: int, frame_h: int, dt: float) -> dict:
        now = time.time()
        boxes = result.boxes
        kps = result.keypoints
        seen: set[int] = set()
        if boxes is not None and len(boxes):
            ids = boxes.id.int().tolist() if boxes.id is not None else list(range(1, len(boxes) + 1))
            xyxy = boxes.xyxy.tolist()
            kxy = kps.xy.tolist() if kps is not None else [None] * len(ids)
            kconf = kps.conf.tolist() if (kps is not None and kps.conf is not None) else [None] * len(ids)
            for pid, (x1, y1, x2, y2), pts, conf in zip(ids, xyxy, kxy, kconf):
                p = self.people.get(pid) or Person(id=pid)
                self.people[pid] = p
                seen.add(pid)
                cx = ((x1 + x2) / 2) / frame_w
                cy = ((y1 + y2) / 2) / frame_h
                p.depth = min(1.0, (y2 - y1) / frame_h)
                # energy: centroid speed in frame widths per second, smoothed
                if p.last_xy is not None and dt > 0:
                    v = math.hypot(cx - p.last_xy[0], cy - p.last_xy[1]) / dt
                    p.energy += (min(1.0, v / 1.5) - p.energy) * min(1.0, dt / 0.3)
                p.last_xy = (cx, cy)
                p.x, p.y = cx, cy
                p.arms_up, p.crouch = self.pose_features(pts, conf, y1, y2)
                p.seen = now
        # forget people the tracker dropped
        for pid in [k for k, v in self.people.items() if now - v.seen > 1.0]:
            del self.people[pid]

        live = [self.people[i] for i in seen]
        pts = np.array([[p.x, p.y] for p in live], dtype=float) if live else np.zeros((0, 2))
        clusters = []
        if len(live):
            labels = dbscan(pts, self.eps)
            for lab in sorted(set(labels.tolist())):
                members = pts[labels == lab]
                centre = members.mean(axis=0)
                radius = float(np.max(np.linalg.norm(members - centre, axis=1))) if len(members) > 1 else 0.0
                clusters.append({"n": int(len(members)), "x": float(centre[0]), "y": float(centre[1]), "r": radius})
            clusters.sort(key=lambda c: -c["n"])
        spread = 0.0
        if len(live) > 1:
            d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=2)
            spread = float(d[np.triu_indices(len(live), 1)].mean())
        return {
            "type": "frame",
            "count": len(live),
            "people": [
                {"id": p.id, "x": round(p.x, 4), "y": round(p.y, 4), "depth": round(p.depth, 3),
                 "armsUp": p.arms_up, "crouch": round(p.crouch, 3), "energy": round(p.energy, 3)}
                for p in live
            ],
            "clusters": clusters,
            "spread": round(spread, 4),
            "energy": round(float(np.mean([p.energy for p in live])) if live else 0.0, 4),
            "cx": round(float(pts[:, 0].mean()) if len(live) else 0.5, 4),
            "cy": round(float(pts[:, 1].mean()) if len(live) else 0.5, 4),
            "armsUp": round(float(np.mean([p.arms_up for p in live])) if live else 0.0, 3),
        }

    @staticmethod
    def pose_features(pts, conf, y1: float, y2: float) -> tuple[int, float]:
        """Raised arms (wrists above shoulders) and a crouch measure from the keypoints."""
        if pts is None:
            return 0, 0.0
        ok = lambda i: conf is None or conf[i] > 0.3  # noqa: E731
        arms = 0
        for wrist, shoulder in ((L_WRIST, L_SHOULDER), (R_WRIST, R_SHOULDER)):
            if ok(wrist) and ok(shoulder) and pts[wrist][1] > 0 and pts[shoulder][1] > 0 and pts[wrist][1] < pts[shoulder][1]:
                arms += 1
        crouch = 0.0
        h = max(1.0, y2 - y1)
        if all(ok(i) and pts[i][1] > 0 for i in (L_HIP, R_HIP, L_KNEE, R_KNEE, L_SHOULDER, R_SHOULDER)):
            hip = (pts[L_HIP][1] + pts[R_HIP][1]) / 2
            knee = (pts[L_KNEE][1] + pts[R_KNEE][1]) / 2
            shoulder = (pts[L_SHOULDER][1] + pts[R_SHOULDER][1]) / 2
            torso = max(1.0, hip - shoulder)
            thigh = knee - hip
            # standing: thigh ≈ 0.8 torso; squatting: thigh → small
            crouch = float(min(1.0, max(0.0, 1 - (thigh / torso) / 0.8)))
        return arms, crouch


# --- OSC, standalone ------------------------------------------------------------

def osc_message(address: str, args: list) -> bytes:
    def pad(b: bytes) -> bytes:
        return b + b"\0" * (4 - len(b) % 4)
    tags = ","
    body = b""
    for a in args:
        if isinstance(a, bool) or isinstance(a, int):
            tags += "i"; body += struct.pack(">i", int(a))
        elif isinstance(a, float):
            tags += "f"; body += struct.pack(">f", a)
        else:
            tags += "s"; body += pad(str(a).encode())
    return pad(address.encode()) + pad(tags.encode()) + body


class OscOut:
    def __init__(self, spec: str):
        host, port = spec.rsplit(":", 1)
        self.addr = (host, int(port))
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.t0 = time.time()

    def send(self, frame: dict) -> None:
        t = time.time() - self.t0
        self.sock.sendto(osc_message("/hive/cam", [t, frame["count"], len(frame["clusters"]), frame["spread"], frame["energy"], frame["cx"], frame["cy"], frame["armsUp"]]), self.addr)
        self.sock.sendto(osc_message("/hive/cam/grid", [c[2] for c in frame["flow"]]), self.addr)
        for i, c in enumerate(frame["clusters"]):
            self.sock.sendto(osc_message("/hive/cam/cluster", [i, c["n"], c["x"], c["y"], c["r"]]), self.addr)
        for p in frame["people"]:
            self.sock.sendto(osc_message("/hive/cam/person", [p["id"], p["x"], p["y"], p["depth"], float(p["armsUp"]), p["crouch"], p["energy"]]), self.addr)


# --- camera ------------------------------------------------------------------------

def list_cameras() -> list[str]:
    """Camera names in AVFoundation order (macOS), so the dashboard can offer them by name."""
    if sys.platform != "darwin":
        return []
    try:
        import subprocess
        out = subprocess.run(["system_profiler", "SPCameraDataType", "-json"], capture_output=True, text=True, timeout=10).stdout
        return [c.get("_name", f"camera {i}") for i, c in enumerate(json.loads(out).get("SPCameraDataType", []))]
    except Exception:  # noqa: BLE001
        return []


def open_capture(args: argparse.Namespace):
    """The video file, or the first camera that opens. On a Mac the indices are
    not stable — a paired iPhone (Continuity Camera) can sit at 0 while the
    built-in one is 1 — so unless an index was given explicitly we try a few."""
    if args.source is not None:
        cap = cv2.VideoCapture(args.source)
        if cap.isOpened():
            return cap
        print(f"[vision] cannot open {args.source!r}", file=sys.stderr)
        return None
    explicit = args.camera is not None and int(args.camera) >= 0
    indices = [int(args.camera)] if explicit else [0, 1, 2, 3]
    for i in indices:
        cap = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION) if sys.platform == "darwin" else cv2.VideoCapture(i)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(args.width * 9 / 16))
        # AVFoundation needs a moment after opening before the first frame arrives
        ok = False
        if cap.isOpened():
            for _ in range(15):
                ok, _ = cap.read()
                if ok:
                    break
                time.sleep(0.1)
        if ok:
            print(f"[vision] camera {i} open", flush=True)
            return cap
        cap.release()
    if getattr(open_capture, "warned", False):
        return None
    open_capture.warned = True   # type: ignore[attr-defined]
    print(
        "[vision] no camera could be opened.\n"
        "  - macOS must allow the app you started this from to use the camera:\n"
        "    System Settings → Privacy & Security → Camera → switch on Terminal (or iTerm, VS Code, …).\n"
        "    If it is not listed, run:  tccutil reset Camera com.apple.Terminal   and start again — the prompt appears.\n"
        "  - A paired iPhone can take index 0 while it is away; try  --camera 1\n"
        "  - Or use a video:  --source clip.mp4",
        file=sys.stderr,
    )
    return None


# --- main loop -------------------------------------------------------------------

async def run(args: argparse.Namespace) -> None:
    from ultralytics import YOLO
    import websockets

    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = os.path.join(MODEL_DIR, MODEL_NAME)
    if not os.path.exists(model_path):
        print(f"[vision] downloading {MODEL_NAME} (once, needs internet)…", flush=True)
        YOLO(MODEL_NAME)  # downloads into the cwd
        if os.path.exists(MODEL_NAME):
            os.replace(MODEL_NAME, model_path)
    if args.backend == "coreml":
        # Core ML runs on the Neural Engine and leaves the GPU to the wall. The
        # package is exported once from the .pt (a minute, no internet needed).
        pkg = model_path.replace(".pt", ".mlpackage")
        if not os.path.isdir(pkg):
            print("[vision] exporting the model to Core ML (once)…", flush=True)
            YOLO(model_path).export(format="coreml", imgsz=args.imgsz, nms=False)
        model = YOLO(pkg)
        device = None
    else:
        model = YOLO(model_path)
        device = args.backend
    print(f"[vision] model {MODEL_NAME} via {args.backend}", flush=True)

    cameras = list_cameras()
    if cameras:
        print("[vision] cameras: " + " · ".join(f"{i}: {n}" for i, n in enumerate(cameras)), flush=True)
    # The camera is not touched until the dashboard's main switch says so (its
    # LED stays dark); standalone, without a backend, it starts right away.
    cap = None
    print("[vision] waiting for the dashboard's main switch before opening the camera" if not args.osc else "[vision] standalone: opening the camera", flush=True)

    tracker = Tracker(eps=args.eps)
    settings = {"preview": True, "mirror": bool(args.mirror), "camera": -1 if args.camera is None else int(args.camera), "reopen": False,
                "mode": args.mode, "detectFps": args.detect_fps, "enabled": bool(args.osc)}
    field = FlowField()
    density = Density()
    osc = OscOut(args.osc) if args.osc else None
    ws = None
    ws_lock = asyncio.Lock()

    async def connect_forever():
        nonlocal ws
        delay = 1.0
        while True:
            try:
                async with websockets.connect(args.server, max_size=None) as conn:
                    ws = conn
                    delay = 1.0
                    print(f"[vision] connected to {args.server}", flush=True)
                    await conn.send(json.dumps({"type": "hello", "cameras": cameras, "backend": args.backend}))
                    async for message in conn:
                        if isinstance(message, bytes):
                            continue
                        try:
                            msg = json.loads(message)
                        except json.JSONDecodeError:
                            continue
                        if msg.get("type") == "settings":
                            tracker.eps = float(msg.get("eps", tracker.eps))
                            settings["mirror"] = bool(msg.get("mirror", settings["mirror"]))
                            settings["preview"] = bool(msg.get("preview", True))
                            settings["mode"] = msg.get("mode", settings["mode"]) if msg.get("mode") in ("field", "people") else settings["mode"]
                            settings["detectFps"] = float(msg.get("detectFps", settings["detectFps"]))
                            settings["enabled"] = bool(msg.get("enabled", True))
                            wanted = int(msg.get("camera", -1))
                            if args.source is None and wanted != settings["camera"]:
                                settings["camera"] = wanted
                                settings["reopen"] = True
                            print(f"[vision] settings: mode={settings['mode']} detect={settings['detectFps']}fps eps={tracker.eps} mirror={settings['mirror']} preview={settings['preview']} camera={settings['camera']}", flush=True)
            except Exception as err:  # noqa: BLE001 — any network trouble: wait and retry
                code = getattr(getattr(err, "rcvd", None), "code", None) or getattr(err, "code", None)
                if code == 4409 or "4409" in str(err):
                    print("[vision] another camera process is attached to the server — waiting (stop the other one, or this one)", flush=True)
                    ws = None
                    await asyncio.sleep(10)
                    continue
                if ws is not None:
                    print(f"[vision] backend lost ({err.__class__.__name__}); retrying", flush=True)
                ws = None
            await asyncio.sleep(delay)
            delay = min(5.0, delay * 1.5)

    asyncio.create_task(connect_forever())

    period = 1.0 / args.fps
    preview_period = 1.0 / 8
    last_t = time.time()
    last_detect = 0.0
    read_failures = 0
    frame_index = 0
    last_people_t = time.time()
    last_result = None
    last_people: dict = {"type": "frame", "count": 0, "people": [], "clusters": [], "spread": 0.0, "energy": 0.0, "cx": 0.5, "cy": 0.5, "armsUp": 0.0}
    last_preview = 0.0
    fps_ema = 0.0
    n = 0
    loop = asyncio.get_running_loop()

    while True:
        t0 = time.time()
        if not settings["enabled"]:
            # switched off on the dashboard: let the camera go — the LED goes
            # dark, other apps can have it — keep the socket, and wait
            if cap is not None:
                await loop.run_in_executor(None, cap.release)
                cap = None
                print("[vision] camera off (dashboard) — released", flush=True)
            await asyncio.sleep(0.5)
            continue
        if cap is None or not cap.isOpened():
            cap = await loop.run_in_executor(None, open_capture, args)
            if cap is None:
                await asyncio.sleep(3)
                continue
            print("[vision] camera on", flush=True)
            field.prev = None
            last_t = time.time()
        if settings["reopen"]:
            # the dashboard picked another camera
            settings["reopen"] = False
            cap.release()
            args.camera = settings["camera"]
            cap = open_capture(args) or cap
            tracker.people.clear()
        ok, frame = await loop.run_in_executor(None, cap.read)
        if not ok:
            if args.source is not None:  # a clip: loop it
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            # A camera that stops delivering — an iPhone (Continuity Camera)
            # renegotiating, locking, or wandering off — is not the end: wait,
            # then reopen, and only give up after a long silence.
            read_failures += 1
            if read_failures == 1:
                print("[vision] camera stopped delivering frames — waiting (an iPhone camera needs to be unlocked and nearby)", flush=True)
            if read_failures % 40 == 0:
                print("[vision] reopening the camera…", flush=True)
                cap.release()
                cap = open_capture(args) or cap
            if read_failures > 400:   # ~ a minute
                print("[vision] no frames for a minute — giving up", file=sys.stderr)
                break
            await asyncio.sleep(0.15)
            continue
        read_failures = 0
        if settings["mirror"]:   # flip the picture itself: coordinates, preview and skeletons all agree
            frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]

        now = time.time()
        dt = now - last_t
        last_t = now
        fps_ema = fps_ema * 0.9 + (1 / max(1e-3, dt)) * 0.1 if fps_ema else 1 / max(1e-3, dt)

        # the field: every frame. A video file has its own clock — its frames
        # are consecutive whatever our loop does — so use the file's frame time.
        flow_dt = (1.0 / (cap.get(cv2.CAP_PROP_FPS) or 25.0)) if args.source is not None else dt
        field_out = await loop.run_in_executor(None, field.update, frame, flow_dt)

        # the people: every frame with tracking in people mode; at detectFps
        # without tracking in field mode (ids are not the point with a crowd)
        people_mode = settings["mode"] == "people"
        due = people_mode or now - last_detect >= 1.0 / max(0.5, settings["detectFps"])
        if due:
            last_detect = now

            def infer():
                kw = {"device": device} if device else {}
                if people_mode:
                    return model.track(frame, persist=True, classes=[0], verbose=False, imgsz=args.imgsz, conf=0.35, tracker="botsort.yaml", **kw)
                return model.predict(frame, classes=[0], verbose=False, imgsz=max(args.imgsz, 960), conf=0.3, **kw)
            results = await loop.run_in_executor(None, infer)
            result = results[0]
            last_result = result
            out = tracker.update(result, w, h, now - last_people_t)
            last_people_t = now
            density.update(out["people"])
            last_people = out
        else:
            out = dict(last_people)
        out.update(field_out)
        out.update(density.summary())
        out["mode"] = settings["mode"]
        out["fps"] = round(fps_ema, 1)
        # the frame's own time, for rhythm on the server: a file's frames are
        # evenly spaced in *its* clock, a camera's in wall-clock time
        frame_index += 1
        out["ft"] = round(frame_index / (cap.get(cv2.CAP_PROP_FPS) or 25.0), 4) if args.source is not None else round(now, 4)
        n += 1

        want_preview = (args.show or (ws is not None and settings["preview"])) and now - last_preview >= preview_period
        annotated = None
        if want_preview:
            annotated = last_result.plot(img=frame.copy(), line_width=2, font_size=6) if last_result is not None else frame.copy()
            field.draw(annotated)
            # groups: circle, threads from the centre to each member, size
            for c in out["clusters"]:
                if c["n"] > 1:
                    cx, cy = int(c["x"] * w), int(c["y"] * h)
                    rr = int(max(c["r"], 0.04) * w * 1.15)
                    for p in out["people"]:
                        px, py = int(p["x"] * w), int(p["y"] * h)
                        if math.hypot(px - cx, py - cy) <= rr:
                            cv2.line(annotated, (cx, cy), (px, py), (180, 184, 242), 1, cv2.LINE_AA)
                    cv2.circle(annotated, (cx, cy), rr, (180, 184, 242), 2, cv2.LINE_AA)
                    cv2.putText(annotated, str(c["n"]), (cx - 6, cy + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 184, 242), 2, cv2.LINE_AA)
            cv2.putText(annotated, f"{settings['mode']}  {out['count']} people  flow {out['flowEnergy']:.2f}  coherence {out['flowCoherence']:.2f}  {fps_ema:.0f} fps",
                        (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
            last_preview = now

        if ws is not None:
            try:
                async with ws_lock:
                    await ws.send(json.dumps(out, separators=(",", ":")))
                    if annotated is not None and settings["preview"]:
                        small = cv2.resize(annotated, (480, int(480 * h / w)))
                        ok_jpg, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 60])
                        if ok_jpg:
                            await ws.send(jpg.tobytes())
            except Exception:  # noqa: BLE001 — the connect loop notices and reconnects
                pass
        if osc is not None:
            osc.send(out)

        if args.show and annotated is not None:
            cv2.imshow("HIVE camera", annotated)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        if n % 250 == 0:
            # cameras come and go (an iPhone as Continuity Camera appears only while
            # it is nearby, unlocked and not sharing its connection): re-list and tell the dashboard
            fresh = await loop.run_in_executor(None, list_cameras)
            if fresh != cameras:
                cameras[:] = fresh
                print("[vision] cameras now: " + (" · ".join(f"{i}: {c}" for i, c in enumerate(cameras)) or "none"), flush=True)
                if ws is not None:
                    try:
                        async with ws_lock:
                            await ws.send(json.dumps({"type": "hello", "cameras": cameras, "backend": args.backend}))
                    except Exception:  # noqa: BLE001
                        pass
        if n % 100 == 0:
            print(f"[vision] {fps_ema:.0f} fps · {settings['mode']} · {out['count']} people · flow {out['flowEnergy']:.2f} · {'backend' if ws else 'no backend'}", flush=True)

        # keep to the requested rate
        elapsed = time.time() - t0
        if elapsed < period:
            await asyncio.sleep(period - elapsed)

    cap.release()
    cv2.destroyAllWindows()


def main() -> None:
    ap = argparse.ArgumentParser(description="HIVE camera: people, poses, clusters → backend / OSC")
    ap.add_argument("--camera", default=None, help="camera index; default: try 0, 1, 2, 3 and take the first that works")
    ap.add_argument("--source", default=None, help="video file instead of a camera (loops)")
    ap.add_argument("--server", default="ws://localhost:8080/vision", help="HIVE backend vision socket")
    ap.add_argument("--osc", default=None, help="host:port — also send /hive/cam/* straight there (standalone use)")
    ap.add_argument("--show", action="store_true", help="preview window (q quits)")
    ap.add_argument("--fps", type=float, default=25, help="max processed frames per second")
    ap.add_argument("--width", type=int, default=640, help="capture width")
    ap.add_argument("--imgsz", type=int, default=640, help="model input size")
    ap.add_argument("--eps", type=float, default=0.12, help="cluster radius, fraction of frame width (the dashboard overrides)")
    ap.add_argument("--mirror", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--backend", default="mps", choices=["mps", "coreml", "cpu", "cuda"],
                    help="mps = Apple GPU (fastest here), coreml = Neural Engine (leaves the GPU to the wall), cpu, cuda")
    ap.add_argument("--list-cameras", action="store_true", help="print the cameras and exit")
    ap.add_argument("--mode", default="field", choices=["field", "people"],
                    help="field: optical-flow grid for a whole room, people detected a few times a second; people: full-rate tracking (small rounds)")
    ap.add_argument("--detect-fps", type=float, default=5, help="field mode: how often the model looks for people")
    args = ap.parse_args()
    if args.list_cameras:
        for i, n in enumerate(list_cameras()):
            print(f"{i}: {n}")
        return
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
