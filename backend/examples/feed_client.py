#!/usr/bin/env python3
"""Subscribe to HIVE's raw feed and get every sample as a dict — for anyone who
would rather process the swarm in Python than parse OSC.

    pip install websockets
    python3 examples/feed_client.py ws://192.168.2.1:8080/feed

Messages (same quantities as the OSC protocol, docs/OSC.md):
    {"type": "join",   "slot": 1, "uid": "a1b2c3d4", "platform": "ios", "name": "Emil"}
    {"type": "sample", "slot": 1, "uid": "a1b2c3d4", "t": 1757674000000,
                       "acc": [x, y, z], "rel": [x, y, z], "gyro": [x, y, z], "activity": 0.3, "idle": 0}
    {"type": "swarm",  "t": ..., "count": 3, "energy": 0.4, "motion": 120.0, "sync": 0.8}
    {"type": "leave",  "slot": 1, "uid": "a1b2c3d4"}

acc: m/s² incl. gravity (flat ≈ [0, 0, 9.81]); rel: relative to the adaptive zero;
gyro: °/s; activity 0..1; t: epoch ms.
"""
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    sys.exit("pip install websockets")


async def main(url):
    async with websockets.connect(url, max_queue=8) as ws:
        print(f"connected to {url}")
        n = 0
        last = time.time()
        async for text in ws:
            msg = json.loads(text)
            if msg["type"] == "sample":
                n += 1
                # --- your code here: msg["slot"], msg["acc"], msg["gyro"] ---
            else:
                print(msg)
            now = time.time()
            if now - last > 1:
                print(f"{n} samples/s")
                n, last = 0, now


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8080/feed"))
