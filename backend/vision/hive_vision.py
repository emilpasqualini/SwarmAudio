#!/usr/bin/env python3
"""
hive_vision.py — HIVE (camera)

The room as the camera sees it, for the swarm.

A webcam, YOLO11n-pose (people + 17 keypoints, tracked with BoT-SORT so an id
stays with a person while they are in view), a tiny DBSCAN for groups, and a
few room-level numbers. Every processed frame goes to the HIVE backend as one
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
        if boxes is not None and boxes.id is not None:
            ids = boxes.id.int().tolist()
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
    cap = open_capture(args)
    if cap is None:
        sys.exit(1)

    tracker = Tracker(eps=args.eps)
    settings = {"preview": True, "mirror": bool(args.mirror), "camera": -1 if args.camera is None else int(args.camera), "reopen": False}
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
                            wanted = int(msg.get("camera", -1))
                            if args.source is None and wanted != settings["camera"]:
                                settings["camera"] = wanted
                                settings["reopen"] = True
                            print(f"[vision] settings: eps={tracker.eps} mirror={settings['mirror']} preview={settings['preview']} camera={settings['camera']}", flush=True)
            except Exception as err:  # noqa: BLE001 — any network trouble: wait and retry
                if ws is not None:
                    print(f"[vision] backend lost ({err.__class__.__name__}); retrying", flush=True)
                ws = None
            await asyncio.sleep(delay)
            delay = min(5.0, delay * 1.5)

    asyncio.create_task(connect_forever())

    period = 1.0 / args.fps
    preview_period = 1.0 / 8
    last_t = time.time()
    last_preview = 0.0
    fps_ema = 0.0
    n = 0
    loop = asyncio.get_running_loop()

    while True:
        t0 = time.time()
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
            print("[vision] camera read failed", file=sys.stderr)
            break
        if settings["mirror"]:   # flip the picture itself: coordinates, preview and skeletons all agree
            frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]

        def infer():
            kw = {"device": device} if device else {}
            return model.track(frame, persist=True, classes=[0], verbose=False, imgsz=args.imgsz, conf=0.35, tracker="botsort.yaml", **kw)
        results = await loop.run_in_executor(None, infer)
        result = results[0]

        now = time.time()
        dt = now - last_t
        last_t = now
        fps_ema = fps_ema * 0.9 + (1 / max(1e-3, dt)) * 0.1 if fps_ema else 1 / max(1e-3, dt)

        out = tracker.update(result, w, h, dt)
        out["fps"] = round(fps_ema, 1)
        n += 1

        want_preview = (args.show or (ws is not None and settings["preview"])) and now - last_preview >= preview_period
        annotated = None
        if want_preview:
            annotated = result.plot(line_width=2, font_size=6)
            for c in out["clusters"]:
                if c["n"] > 1:
                    cv2.circle(annotated, (int(c["x"] * w), int(c["y"] * h)), int(max(c["r"], 0.04) * w), (180, 184, 242), 1, cv2.LINE_AA)
            cv2.putText(annotated, f"{out['count']} people  {len(out['clusters'])} clusters  spread {out['spread']:.2f}  {fps_ema:.0f} fps",
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
        if n % 100 == 0:
            print(f"[vision] {fps_ema:.0f} fps · {out['count']} people · {len(out['clusters'])} clusters · {'backend' if ws else 'no backend'}", flush=True)

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
