#!/usr/bin/env bash
# Serves the KidGuard repo root over HTTP on port 8765 so the demo pages and
# the parent dashboard are both reachable from the extension.
set -euo pipefail

PORT="${PORT:-8765}"
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

if port_in_use "$PORT"; then
  echo "ERROR: port $PORT is already in use." >&2
  echo "Another static server is probably already running. Either use it, or free the port:" >&2
  echo "  lsof -ti tcp:$PORT | xargs kill" >&2
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
echo "Serving $REPO_ROOT on $BASE"
echo ""
echo "KidGuard demo URLs:"
echo "  $BASE/demo_sites/index.html"
echo "  $BASE/demo_sites/ok_school.html"
echo "  $BASE/demo_sites/clickbait.html"
echo "  $BASE/demo_sites/phishing.html"
echo "  $BASE/demo_sites/classroom.html"
echo "  $BASE/frontend/parent.html"
echo ""
echo "Press Ctrl+C to stop."

exec "$PYTHON" -m http.server "$PORT" --bind 127.0.0.1 --directory "$REPO_ROOT"
