# HIVE camera

`hive_vision.py` watches a webcam with YOLO11n-pose, tracks people (BoT-SORT),
groups them (a tiny DBSCAN) and sends one JSON message per frame — plus a small
annotated JPEG for the dashboard — to the HIVE server at `ws://<mac>:8080/vision`.
Everything downstream (OSC `/hive/cam*`, `/hive/mix`, the wall, the dashboard)
happens on the server. See `../README.md` → *The camera* and `../docs/OSC.md`.

```bash
../start.sh --vision                 # from backend/: venv + deps on first use, then run
./start.sh --show                    # same, with a preview window (q quits)
./start.sh --source clip.mp4         # a video instead of the camera
./start.sh --osc 192.168.2.14:8000   # additionally send /hive/cam/* straight to one target
```

The model downloads once into `models/` (needs internet). macOS asks the
terminal for camera access the first time — allow it.
