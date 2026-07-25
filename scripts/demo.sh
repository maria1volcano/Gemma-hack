#!/usr/bin/env bash
# One-command KidGuard demo: static server on 8765 (demo pages + parent
# dashboard) plus the FastAPI backend on 8000 when it exists.
set -uo pipefail

STATIC_PORT="${STATIC_PORT:-8765}"
API_PORT="${API_PORT:-8000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
else
  echo "ERROR: Python 3 was not found on PATH (tried python3, python)." >&2
  exit 1
fi

PIDS=()

cleanup() {
  echo ""
  echo "Cleaning up..."
  for pid in "${PIDS[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Stopping PID $pid..."
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

port_in_use() {
  "$PYTHON" - "$1" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(0)   # in use
finally:
    s.close()
sys.exit(1)       # free
PY
}

echo ""
echo "=== KidGuard demo ==="
echo "Repo root: $REPO_ROOT"

if port_in_use "$STATIC_PORT"; then
  echo "NOTE: port $STATIC_PORT is already in use - assuming a static server is already running."
else
  "$PYTHON" -m http.server "$STATIC_PORT" --bind 127.0.0.1 --directory "$REPO_ROOT" >/dev/null 2>&1 &
  STATIC_PID=$!
  PIDS+=("$STATIC_PID")
  echo "Static server started on http://127.0.0.1:$STATIC_PORT (PID $STATIC_PID)"
fi

if [ -f "$REPO_ROOT/backend/main.py" ]; then
  if port_in_use "$API_PORT"; then
    echo "NOTE: port $API_PORT is already in use - assuming the backend is already running."
  else
    ( cd "$REPO_ROOT" && "$PYTHON" -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT" --reload ) &
    API_PID=$!
    PIDS+=("$API_PID")
    echo "Backend starting on http://127.0.0.1:$API_PORT (PID $API_PID)"
  fi
else
  echo "backend/main.py not found - running in extension MOCK mode"
fi

BASE="http://127.0.0.1:$STATIC_PORT"
echo ""
echo "Demo URLs:"
echo "  $BASE/demo_sites/index.html"
echo "  $BASE/demo_sites/ok_school.html"
echo "  $BASE/demo_sites/clickbait.html"
echo "  $BASE/demo_sites/phishing.html"
echo "  $BASE/demo_sites/classroom.html"
echo "  $BASE/frontend/parent.html"
echo ""
echo "Load the Chrome extension:"
echo "  1. Open chrome://extensions"
echo "  2. Turn on \"Developer mode\" (top right)"
echo "  3. Click \"Load unpacked\""
echo "  4. Select the folder: $REPO_ROOT/extension"
echo ""
echo "Press Ctrl+C to stop everything this script started."

wait
