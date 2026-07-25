#!/usr/bin/env bash
# KidGuard backend contract check (parity with scripts/check_contract.ps1).
#
# Verifies that teammate A's backend speaks exactly the contract the Chrome
# extension consumes. The backend is a black box: this script only sends HTTP.
#
#   POST /decide  (one call per fixture in scripts/fixtures/*.json)
#   POST /coach
#   GET  /events  + CORS for http://127.0.0.1:8765 (frontend/parent.html)
#
#   FAIL = the extension breaks.  WARN = off-contract but survivable.
#
# Usage:
#   ./scripts/check_contract.sh [--base-url URL] [--origin URL]
#                               [--timeout SECONDS] [--fixtures DIR] [--strict]
#
# Exit codes: 0 pass, 1 contract failure, 2 backend not running, 3 setup problem.
#
# Implementation note: the HTTP + JSON work is done by python3 (stdlib only) so
# that no jq / curl version differences can change the verdict.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_URL="http://127.0.0.1:8000"
ORIGIN="http://127.0.0.1:8765"
TIMEOUT="60"
FIXTURE_DIR="$SCRIPT_DIR/fixtures"
STRICT="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --origin)   ORIGIN="${2:-}";   shift 2 ;;
    --timeout)  TIMEOUT="${2:-}";  shift 2 ;;
    --fixtures) FIXTURE_DIR="${2:-}"; shift 2 ;;
    --strict)   STRICT="1"; shift ;;
    -h|--help)  sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 3 ;;
  esac
done

PYTHON=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
done
if [ -z "$PYTHON" ]; then
  echo "ERROR: python3 was not found on PATH; this checker needs it (stdlib only)." >&2
  exit 3
fi

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "ERROR: fixture folder not found: $FIXTURE_DIR" >&2
  echo "Expected JSON files like scripts/fixtures/03_phishing.json" >&2
  exit 3
fi

KG_BASE_URL="$BASE_URL" KG_ORIGIN="$ORIGIN" KG_TIMEOUT="$TIMEOUT" \
KG_FIXTURES="$FIXTURE_DIR" KG_STRICT="$STRICT" "$PYTHON" - <<'PYCODE'
import glob
import json
import os
import socket
import sys
import urllib.error
import urllib.request

BASE = os.environ["KG_BASE_URL"].rstrip("/")
ORIGIN = os.environ["KG_ORIGIN"]
TIMEOUT = float(os.environ.get("KG_TIMEOUT") or 60)
FIXTURES = os.environ["KG_FIXTURES"]
STRICT = os.environ.get("KG_STRICT") == "1"

USE_COLOUR = sys.stdout.isatty()
def paint(code, text):
    return "\033[%sm%s\033[0m" % (code, text) if USE_COLOUR else text

STATE = {"fail": 0, "warn": 0, "checks": 0}

def head(text):
    print("")
    print(paint("36", text))
    print(paint("90", "-" * len(text)))

def ok(text):
    STATE["checks"] += 1
    print("  " + paint("32", "[PASS] ") + text)

def fail(text, fix=""):
    STATE["checks"] += 1
    STATE["fail"] += 1
    print("  " + paint("31", "[FAIL] ") + text)
    if fix:
        print("         " + paint("33", "fix: " + fix))

def warn(text, fix=""):
    STATE["checks"] += 1
    STATE["warn"] += 1
    print("  " + paint("33", "[WARN] ") + text)
    if fix:
        print("         " + paint("33", "fix: " + fix))

def note(text):
    print("  " + paint("90", "[INFO] " + text))

def soft(text, fix=""):
    (fail if STRICT else warn)(text, fix)

# ------------------------------------------------------------------ contract

TOOL_REQUIRED = {
    "allow_page": [],
    "warn_kid": ["message"],
    "block_page": ["reason", "safer_alternative"],
    "pause_session": ["reason"],
    "highlight_element": ["text_or_css"],
    "move_mascot": [],
    "notify_parent": ["summary"],
    "suggest_alternative": ["label", "url"],
    "navigate_hint": ["url"],
}
TOOL_ALIASES = {"text_or_css": ["selector", "text"]}
TOOL_NICE = {"warn_kid": ["reason"], "move_mascot": ["mood"]}
KNOWN_TOOLS = sorted(TOOL_REQUIRED)
MOODS = ["idle", "worry", "happy", "point"]

def prop(obj, name):
    if isinstance(obj, dict):
        return obj.get(name)
    return None

def first_prop(obj, names):
    for name in names:
        value = prop(obj, name)
        if value is not None:
            return name, value
    return None

def non_empty(value):
    return isinstance(value, str) and value.strip() != ""

# ---------------------------------------------------------------------- http

def request(method, path, body=None, headers=None, timeout=None):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return {"status": resp.getcode(), "raw": raw, "headers": dict(resp.headers), "error": ""}
    except urllib.error.HTTPError as err:
        raw = ""
        try:
            raw = err.read().decode("utf-8", "replace")
        except Exception:
            pass
        return {"status": err.code, "raw": raw, "headers": dict(err.headers or {}), "error": str(err)}
    except Exception as err:
        return {"status": 0, "raw": "", "headers": {}, "error": str(err)}

def header_value(headers, name):
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value
    return None

def backend_reachable():
    host = BASE.split("//", 1)[-1].split("/", 1)[0]
    port = 8000
    if ":" in host:
        host, port_text = host.rsplit(":", 1)
        try:
            port = int(port_text)
        except ValueError:
            port = 8000
    sock = socket.socket()
    sock.settimeout(1.5)
    try:
        sock.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass

# ------------------------------------------------------------------- checks

def resolve_tool_call(entry):
    notes = []
    if isinstance(entry, str):
        return {"tool": entry, "args": None, "notes": ["tool call given as a bare string"]}
    if not isinstance(entry, dict):
        return None

    fn = entry.get("function") if isinstance(entry.get("function"), dict) else {}
    name_hit = first_prop(entry, ["tool", "name", "action"])
    if not name_hit and fn.get("name"):
        name_hit = ("function.name", fn["name"])
    if not name_hit:
        return None
    if name_hit[0] != "tool":
        notes.append("tool name sent as '%s' (canonical: 'tool')" % name_hit[0])

    args_hit = first_prop(entry, ["args", "arguments", "params", "parameters"])
    if not args_hit and fn.get("arguments") is not None:
        args_hit = ("function.arguments", fn["arguments"])

    if args_hit:
        if args_hit[0] != "args":
            notes.append("args sent as '%s' (canonical: 'args')" % args_hit[0])
        value = args_hit[1]
        if isinstance(value, str):
            notes.append("args sent as a JSON string instead of an object")
            try:
                value = json.loads(value)
            except Exception:
                value = None
        args = value
    else:
        notes.append('args flattened onto the tool-call object (no "args" key)')
        args = entry

    return {"tool": str(name_hit[1]), "args": args, "notes": notes}

def check_tool_calls(data, where):
    list_hit = first_prop(data, ["tool_calls", "toolCalls", "actions", "tools"])
    if not list_hit:
        if prop(data, "action"):
            warn("%s : no 'tool_calls' - single flat {action:...} object" % where,
                 "return tool_calls: [{tool, args}] so every tool call survives, not just one")
            list_hit = ("action", [data])
        else:
            fail("%s : field 'tool_calls' is missing" % where,
                 'respond with {"kid_message": "...", "tool_calls": [{"tool": "...", "args": {...}}]}')
            return []
    elif list_hit[0] != "tool_calls":
        warn("%s : tool calls sent as '%s'" % (where, list_hit[0]),
             "rename the field to 'tool_calls' (the extension only tolerates '%s' by accident)" % list_hit[0])

    entries = list_hit[1]
    if not isinstance(entries, list):
        fail("%s : field '%s' is not a list (got %s)" % (where, list_hit[0], type(entries).__name__),
             "tool_calls must be a JSON array, even when there is a single tool call")
        return []
    if not entries:
        fail("%s : tool_calls is empty - the extension would paint nothing" % where,
             "always emit at least one tool (allow_page for a safe page)")
        return []

    resolved = []
    for index, entry in enumerate(entries):
        slot = "%s tool_calls[%d]" % (where, index)
        call = resolve_tool_call(entry)
        if not call:
            fail("%s : no tool name (looked for tool / name / action / function.name)" % slot,
                 'each entry needs {"tool": "<one of the frozen tool names>", "args": {...}}')
            continue
        for text in call["notes"]:
            warn("%s : %s" % (slot, text), "the extension normalizer copes, but send the canonical shape")
        if call["tool"] not in TOOL_REQUIRED:
            fail("%s : unknown tool '%s' - the extension silently drops it" % (slot, call["tool"]),
                 "use only: " + ", ".join(KNOWN_TOOLS))
            continue

        failures_before = STATE["fail"]

        for field in TOOL_REQUIRED[call["tool"]]:
            if non_empty(prop(call["args"], field)):
                continue
            alias_used = None
            for alias in TOOL_ALIASES.get(field, []):
                if non_empty(prop(call["args"], alias)):
                    alias_used = alias
                    break
            if alias_used:
                warn("%s (%s) : uses args.%s instead of args.%s" % (slot, call["tool"], alias_used, field),
                     "rename it to '%s' - that is the frozen arg name" % field)
            else:
                fail("%s (%s) : args.%s is missing or empty" % (slot, call["tool"], field),
                     "%s needs: %s" % (call["tool"], ", ".join(TOOL_REQUIRED[call["tool"]])))

        for field in TOOL_NICE.get(call["tool"], []):
            if not non_empty(prop(call["args"], field)):
                warn("%s (%s) : args.%s missing (optional, the UI falls back)" % (slot, call["tool"], field))

        if call["tool"] == "move_mascot":
            mood = prop(call["args"], "mood")
            if non_empty(mood) and mood.lower() not in MOODS:
                warn("%s (move_mascot) : mood '%s' unknown, the mascot falls back to idle" % (slot, mood),
                     "use one of: " + ", ".join(MOODS))

        resolved.append(call)
        if STATE["fail"] == failures_before:
            ok("%s : %s OK" % (slot, call["tool"]))
    return resolved

def check_decide(fixture, filename):
    name = fixture.get("name") or os.path.splitext(os.path.basename(filename))[0]
    label = fixture.get("label") or ""
    payload = fixture.get("payload") or fixture

    head("POST /decide  ->  %s%s" % (name, ("  (%s)" % label) if label else ""))
    res = request("POST", "/decide", payload)

    if res["status"] == 0:
        fail("%s : no HTTP response (%s)" % (name, res["error"]), "is the /decide route registered on this port?")
        return
    if res["status"] != 200:
        snippet = " ".join(res["raw"].split())[:200]
        fail("%s : HTTP %d from /decide" % (name, res["status"]),
             "the extension treats any non-200 as backend_unreachable. Body: " + snippet)
        return
    ok("%s : HTTP 200" % name)

    try:
        data = json.loads(res["raw"])
    except Exception:
        fail("%s : response body is not JSON" % name, "return application/json, not HTML or a bare string")
        return

    kid_hit = first_prop(data, ["kid_message", "message"])
    if not kid_hit:
        fail("%s : field 'kid_message' is missing" % name, "add kid_message: one short kid-friendly sentence")
    elif kid_hit[0] != "kid_message":
        warn("%s : kid message sent as '%s'" % (name, kid_hit[0]), "rename it to 'kid_message'")
    elif not non_empty(kid_hit[1]):
        fail("%s : 'kid_message' is empty" % name, "kid_message must be a non-empty string")
    else:
        ok("%s : kid_message present" % name)

    calls = check_tool_calls(data, name)
    tool_names = [c["tool"] for c in calls]

    expect = fixture.get("expect") or {}
    why = expect.get("why") or ""
    any_of = expect.get("tools_any") or []
    if any_of:
        matched = [t for t in any_of if t in tool_names]
        if matched:
            ok("%s : classified as %s as expected" % (name, "/".join(matched)))
        else:
            soft("%s : expected one of [%s] but got [%s]" % (name, ", ".join(any_of), ", ".join(tool_names)),
                 "%s - tune the prompt/policy in backend/policy.py" % why)
    for needed in expect.get("tools_all") or []:
        if needed not in tool_names:
            soft("%s : expected tool '%s' in the answer" % (name, needed), why)

def check_coach():
    head("POST /coach")
    res = request("POST", "/coach", {"message": "can I go to classroom?"})
    if res["status"] == 0:
        fail("/coach : no HTTP response (%s)" % res["error"], "register POST /coach")
        return
    if res["status"] != 200:
        fail("/coach : HTTP %d" % res["status"], 'the side-panel chat shows "my buddy is offline" on any non-200')
        return
    ok("/coach : HTTP 200")

    try:
        data = json.loads(res["raw"])
    except Exception:
        fail("/coach : response body is not JSON", "return application/json")
        return

    reply_hit = first_prop(data, ["reply", "kid_message", "message"])
    if not reply_hit:
        fail("/coach : field 'reply' is missing", 'respond with {"reply": "...", "tool_calls": []}')
    elif reply_hit[0] != "reply":
        warn("/coach : reply sent as '%s'" % reply_hit[0], "rename it to 'reply'")
    elif not non_empty(reply_hit[1]):
        fail("/coach : 'reply' is empty", "reply must be a non-empty string")
    else:
        ok("/coach : reply present")

    if not first_prop(data, ["tool_calls", "toolCalls", "actions", "tools"]):
        warn("/coach : no tool_calls field", "send tool_calls: [] when the coach has nothing to do")
    else:
        check_tool_calls(data, "/coach")

def check_events():
    head("GET /events (+ CORS for frontend/parent.html)")
    res = request("GET", "/events", headers={"Origin": ORIGIN}, timeout=15)
    if res["status"] == 0:
        fail("/events : no HTTP response (%s)" % res["error"], "register GET /events")
        return
    if res["status"] != 200:
        fail("/events : HTTP %d" % res["status"], "the parent dashboard polls this route every few seconds")
        return
    ok("/events : HTTP 200")

    acao = header_value(res["headers"], "Access-Control-Allow-Origin")
    if not acao:
        fail("/events : no Access-Control-Allow-Origin for Origin %s" % ORIGIN,
             'add fastapi.middleware.cors.CORSMiddleware with allow_origins=["*"] - without it '
             "parent.html shows an empty feed and no error")
    elif acao == "*" or acao.rstrip("/") == ORIGIN.rstrip("/"):
        ok("/events : Access-Control-Allow-Origin = %s" % acao)
    else:
        fail("/events : Access-Control-Allow-Origin = %s (does not cover %s)" % (acao, ORIGIN),
             'allow_origins=["*"] is simplest for the demo')

    try:
        data = json.loads(res["raw"])
    except Exception:
        fail("/events : response body is not JSON", "return a JSON array of events")
        return

    if isinstance(data, list):
        items = data
        ok("/events : JSON array")
    elif isinstance(data, dict) and isinstance(data.get("events"), list):
        items = data["events"]
        warn('/events : array wrapped in {"events": [...]}', "parent.html accepts it, a bare array is the contract")
    else:
        fail('/events : neither a JSON array nor {"events": [...]}', "return [] when there is no event yet")
        return

    if not items:
        note("/events : empty list (fine before the first decision)")
        return

    first = items[0]
    action_hit = first_prop(first, ["action", "tool", "type", "event"])
    text_hit = first_prop(first, ["summary", "message", "detail", "kid_message", "reason", "text"])
    ts_hit = first_prop(first, ["ts", "time", "timestamp", "created_at"])
    if action_hit:
        ok("/events : item has '%s'" % action_hit[0])
    else:
        warn("/events : item has no action/tool field", 'the dashboard badge falls back to "event"')
    if text_hit:
        ok("/events : item has '%s'" % text_hit[0])
    else:
        warn("/events : item has no summary/message field", 'the row would read "(no details provided)"')
    if ts_hit:
        ok("/events : item has '%s'" % ts_hit[0])
    else:
        warn("/events : item has no timestamp field", "add ts (ISO string or epoch) so the feed can sort")

# ---------------------------------------------------------------------- main

print("")
print("KidGuard backend contract check")
print("  backend : %s" % BASE)
print("  fixtures: %s" % FIXTURES)
print("  origin  : %s (frontend/parent.html)" % ORIGIN)

files = sorted(glob.glob(os.path.join(FIXTURES, "*.json")))
if not files:
    print("")
    print(paint("31", "ERROR: no *.json fixtures in %s" % FIXTURES))
    sys.exit(3)

if not backend_reachable():
    print("")
    print(paint("33", "Backend not running yet on %s - nothing to check." % BASE))
    print("")
    print(paint("90", "Start it (teammate A / D), then run this script again:"))
    print("  python -m uvicorn backend.main:app --port 8000 --reload")
    print("")
    print(paint("90", "Meanwhile the extension demo still works: keep MOCK mode on."))
    sys.exit(2)

print("")
print(paint("32", "Backend is listening on %s" % BASE))

for path in files:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)
    except Exception as err:
        head("fixture %s" % os.path.basename(path))
        fail("%s : not valid JSON (%s)" % (os.path.basename(path), err), "fix the fixture file")
        continue
    check_decide(fixture, path)

check_coach()
check_events()

print("")
print(paint("90", "=" * 58))
if STATE["fail"]:
    print(paint("31", "RESULT: FAIL - %d failure(s), %d warning(s), %d checks"
                % (STATE["fail"], STATE["warn"], STATE["checks"])))
    print("Every [FAIL] above names the exact field the extension cannot work without.")
    sys.exit(1)
if STATE["warn"]:
    print(paint("33", "RESULT: PASS with %d warning(s) - %d checks" % (STATE["warn"], STATE["checks"])))
    print("Warnings are survivable: the extension normalizer or a UI fallback covers them.")
    sys.exit(0)
print(paint("32", "RESULT: PASS - %d checks, contract clean" % STATE["checks"]))
sys.exit(0)
PYCODE
exit $?
