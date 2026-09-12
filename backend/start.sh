#!/usr/bin/env bash
#
#  start.sh — HIVE backend
#
#  One command at the venue: checks Node, installs what is missing, builds the
#  phone app, starts the server, opens the dashboard. Everything else is
#  configured on the dashboard once it is up.
#
#    ./start.sh              start
#    ./start.sh --sim 3      start with three fake phones (also settable on the dashboard)
#    ./start.sh --dev        rebuild the client on every save (for working on it)
#    ./start.sh --no-open    do not open the dashboard in a browser
#    ./start.sh --no-vision  do not start the camera process alongside the server
#    ./start.sh --vision     the camera only (for a second terminal or another machine;
#                            any extra args go to hive_vision.py)
#    ./start.sh --help
#
#  The camera process starts with the server by default (it needs the Python
#  environment, made on first use) and can be switched on and off on the
#  dashboard — "camera" at the top of its card.
#
#  Ports: HIVE_HTTPS_PORT (8443, phones) and HIVE_HTTP_PORT (8080, dashboard),
#  e.g.  HIVE_HTTP_PORT=8090 ./start.sh
#

set -euo pipefail
cd "$(dirname "$0")"

DEV=0
OPEN=1
VISION=1
while [ $# -gt 0 ]; do
  case "$1" in
    --sim)      export HIVE_SIMULATE="${2:-3}"; shift ;;
    --sim=*)    export HIVE_SIMULATE="${1#--sim=}" ;;
    --dev)      DEV=1 ;;
    --vision)   shift; exec "$(dirname "$0")/vision/start.sh" "$@" ;;
    --no-open)  OPEN=0 ;;
    --no-vision) VISION=0 ;;
    -h|--help)  sed -n '3,16p' "$0" | sed -e 's/^#  \{0,1\}//' -e 's/^#$//'; exit 0 ;;
    *)          echo "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

# --- node ---------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it with:  brew install node   (or from https://nodejs.org)"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $(node -v) is too old; 20 or newer is needed."
  exit 1
fi

# --- dependencies -------------------------------------------------------------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "▸ installing dependencies"
  npm install --no-audit --no-fund
fi

# --- client -------------------------------------------------------------------
if [ "$DEV" = 0 ]; then
  echo "▸ building the phone app"
  npx vite build --logLevel warn
fi

# --- open the dashboard once the server answers --------------------------------
HTTP_PORT="${HIVE_HTTP_PORT:-8080}"
if [ "$OPEN" = 1 ] && command -v open >/dev/null 2>&1; then
  (
    for _ in $(seq 1 40); do
      if curl -sf "http://localhost:${HTTP_PORT}/api/health" >/dev/null 2>&1; then
        open "http://localhost:${HTTP_PORT}/monitor"
        exit 0
      fi
      sleep 0.25
    done
  ) &
fi

# --- the camera, alongside ------------------------------------------------------
# Started here rather than by the server so it inherits this terminal's camera
# permission. It reconnects to the server on its own and idles while the
# dashboard has the camera switched off.
if [ "$VISION" = 1 ]; then
  if command -v python3 >/dev/null 2>&1; then
    (sleep 2; exec bash vision/start.sh 2>&1 | sed -u 's/^/[camera] /') &
    VISION_PID=$!
    trap 'kill "$VISION_PID" 2>/dev/null; pkill -f "hive_vision.py" 2>/dev/null || true' EXIT INT TERM
  else
    echo "▸ python3 not found — no camera process (install python, or run ./start.sh --vision elsewhere)"
  fi
fi

# --- run ------------------------------------------------------------------------
if [ "$DEV" = 1 ]; then
  npm run dev
else
  npx tsx server/index.ts
fi
