#!/usr/bin/env bash
#
#  vision/start.sh — the camera side of HIVE
#
#  Makes a Python virtualenv on first use, installs the pipeline's dependencies,
#  and runs hive_vision.py against the HIVE server on this Mac. Any arguments go
#  through, e.g.  ./start.sh --show   or   ./start.sh --server ws://192.168.2.1:8080/vision
#
#  The model (~6 MB) downloads on the first run — do that once with internet.
#

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not installed (brew install python)"; exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "▸ creating the Python environment (once)"
  python3 -m venv .venv
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "▸ installing ultralytics, opencv, numpy, websockets (a few minutes the first time)"
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
  touch .venv/.installed
fi
# A broken environment (a half-finished pip run, an auto-update) must not look
# like a missing camera: check the imports and repair before running.
if ! .venv/bin/python -c "import numpy, cv2, torch, ultralytics, websockets" >/dev/null 2>&1; then
  echo "▸ repairing the Python environment"
  .venv/bin/pip install -q --force-reinstall -r requirements.txt
fi
exec .venv/bin/python hive_vision.py "$@"
