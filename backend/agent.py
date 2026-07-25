"""Ollama chat client and bounded tool loop for KidGuard."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from backend.demo_fast import fast_coach_plan, fast_demo_tool_calls, fast_risk_tool_calls
from backend.policy import GUARD_SYSTEM_PROMPT, coach_system_prompt
from backend.store import GuardStore
from backend.tools_schema import TOOLS
from config.allowlist import SAFER_ALTERNATIVES, is_allowlisted

# One Ollama round: multi-round tool loops made the live demo feel stuck (2–3× latency).
MAX_TOOL_ROUNDS = 1
PAGE_TEXT_LIMIT = 900
TOOL_NAMES = {tool["function"]["name"] for tool in TOOLS}
CLASSROOM_URL = "http://127.0.0.1:8765/demo_sites/classroom.html"


class OllamaUnavailableError(RuntimeError):
    """Ollama could not be reached."""


class OllamaResponseError(RuntimeError):
    """Ollama returned an invalid or unsuccessful response."""


def _ollama_url() -> str:
    return f"{os.getenv('OLLAMA_HOST', 'http://127.0.0.1:11434').rstrip('/')}/api/chat"


def _model() -> str:
    return os.getenv("MODEL", "gemma4")


def _normalise_tool_call(call: dict[str, Any]) -> dict[str, Any] | None:
    function = call.get("function", call)
    name = function.get("name")
    arguments = function.get("arguments", {})
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = {}
    if not isinstance(name, str) or name not in TOOL_NAMES:
        return None
    return {"name": name, "arguments": arguments if isinstance(arguments, dict) else {}}


def _fallback_tool_call(*, coach_mode: bool = False) -> dict[str, Any]:
    if coach_mode:
        return {
            "name": "suggest_alternative",
            "arguments": {"label": "Go to Classroom", "url": CLASSROOM_URL},
        }
    return {
        "name": "warn_kid",
        "arguments": {
            "message": "Let’s check this page with a grown-up first.",
            "reason": "KidGuard did not receive a clear safety decision.",
        },
    }


def _coach_safe_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Prevent an untrusted model response from navigating outside the coach allowlist."""
    if name not in {"navigate_hint", "suggest_alternative"}:
        return arguments
    url = str(arguments.get("url", ""))
    if is_allowlisted(url):
        return arguments
    alternative = SAFER_ALTERNATIVES[0]
    if name == "navigate_hint":
        return {"url": alternative["url"]}
    return alternative.copy()


async def _chat(messages: list[dict[str, Any]]) -> dict[str, Any]:
    payload = {
        "model": _model(),
        "messages": messages,
        "tools": TOOLS,
        "stream": False,
        # Keep completions short so the L4 Gemma demo is usable live.
        "options": {
            "temperature": 0,
            "num_predict": 320,
            "num_ctx": 4096,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(_ollama_url(), json=payload)
    except httpx.RequestError as exc:
        raise OllamaUnavailableError(
            f"Cannot reach Ollama at {os.getenv('OLLAMA_HOST', 'http://127.0.0.1:11434')}."
        ) from exc
    if response.status_code >= 400:
        raise OllamaResponseError(f"Ollama returned HTTP {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
        message = body["message"]
    except (ValueError, KeyError, TypeError) as exc:
        raise OllamaResponseError("Ollama returned a response without a message.") from exc
    if not isinstance(message, dict):
        raise OllamaResponseError("Ollama returned an invalid message.")
    return message


async def _run_tool_loop(
    *,
    system_prompt: str,
    user_prompt: str,
    store: GuardStore,
    coach_mode: bool = False,
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    executed_calls: list[dict[str, Any]] = []

    for _ in range(MAX_TOOL_ROUNDS):
        assistant_message = await _chat(messages)
        messages.append({"role": "assistant", **assistant_message})
        raw_calls = assistant_message.get("tool_calls") or []
        calls = [
            normalized
            for raw_call in raw_calls
            if isinstance(raw_call, dict)
            if (normalized := _normalise_tool_call(raw_call)) is not None
        ]
        if not calls:
            break

        for call in calls:
            if coach_mode:
                call["arguments"] = _coach_safe_arguments(call["name"], call["arguments"])
            print(
                f"[KidGuard] tool call: {call['name']} "
                f"{json.dumps(call['arguments'], ensure_ascii=False)}",
                flush=True,
            )
            result = store.execute_tool(call["name"], call["arguments"])
            executed_calls.append(call)
            messages.append(
                {
                    "role": "tool",
                    "tool_name": call["name"],
                    "content": json.dumps(result),
                }
            )

    if not executed_calls:
        fallback = _fallback_tool_call(coach_mode=coach_mode)
        print(f"[KidGuard] tool fallback: {fallback['name']}", flush=True)
        store.execute_tool(fallback["name"], fallback["arguments"])
        executed_calls.append(fallback)

    reply = ""
    if coach_mode and executed_calls:
        # Prefer a kid-facing sentence over a raw chip label.
        for call in executed_calls:
            if call["name"] == "suggest_alternative":
                reply = "Tap the button below and I will take you somewhere safer."
                break
        if not reply:
            reply = str(store.state().get("last_kid_message") or "I am here to help you stay safe.")

    return {
        "tool_calls": executed_calls,
        "message": messages[-1].get("content", ""),
        "reply": reply,
    }


def _action_from_calls(tool_calls: list[dict[str, Any]]) -> str:
    for name in ("block_page", "warn_kid", "allow_page"):
        if any(call["name"] == name for call in tool_calls):
            return name
    return tool_calls[0]["name"] if tool_calls else "warn_kid"


def _apply_fast_calls(
    calls: list[dict[str, Any]],
    *,
    store: GuardStore,
    source: str,
    log_label: str,
) -> dict[str, Any]:
    executed: list[dict[str, Any]] = []
    for call in calls:
        print(f"[KidGuard] {log_label} tool call: {call['name']}", flush=True)
        store.execute_tool(call["name"], call["arguments"])
        executed.append(call)
    return {
        "tool_calls": executed,
        "message": "",
        "action": _action_from_calls(executed),
        "source": source,
    }


async def run_guard(
    *,
    url: str,
    title: str,
    text: str,
    age: int | None,
    store: GuardStore,
) -> dict[str, Any]:
    # Hard self-harm / suicide signals: never wait on live Gemma.
    risk_calls = fast_risk_tool_calls(url=url, title=title, text=text)
    if risk_calls is not None:
        return _apply_fast_calls(
            risk_calls, store=store, source="fast_risk", log_label="fast-risk"
        )

    fast_calls = fast_demo_tool_calls(url)
    if fast_calls is not None:
        return _apply_fast_calls(
            fast_calls, store=store, source="fast_demo", log_label="fast-demo"
        )

    page_text = text[:PAGE_TEXT_LIMIT]
    user_prompt = (
        f"URL: {url}\nTitle: {title}\nChild age: {age or 'unknown'}\n\n"
        f"Page text (truncated):\n{page_text}\n\n"
        "Emit EVERY tool you need in ONE response (warn/block/allow, mascot, highlight, notify)."
    )
    result = await _run_tool_loop(
        system_prompt=GUARD_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        store=store,
    )
    result["action"] = _action_from_calls(result["tool_calls"])
    result["source"] = "ollama"
    return result


async def run_coach(*, message: str, store: GuardStore) -> dict[str, Any]:
    fast = fast_coach_plan(message)
    if fast is not None:
        executed: list[dict[str, Any]] = []
        for call in fast["tool_calls"]:
            call = {
                "name": call["name"],
                "arguments": _coach_safe_arguments(call["name"], dict(call["arguments"])),
            }
            print(f"[KidGuard] fast-coach tool call: {call['name']}", flush=True)
            store.execute_tool(call["name"], call["arguments"])
            executed.append(call)
        return {
            "tool_calls": executed,
            "message": "",
            "reply": fast["reply"],
            "action": _action_from_calls(executed),
            "source": "fast_demo",
        }

    result = await _run_tool_loop(
        system_prompt=coach_system_prompt(),
        user_prompt=(
            f"Child message: {message[:800]}\n\n"
            "If they want to leave a bad page, call suggest_alternative to Classroom. "
            "Emit every tool you need in ONE response."
        ),
        store=store,
        coach_mode=True,
    )
    result["action"] = _action_from_calls(result["tool_calls"])
    result["source"] = "ollama"
    if not result.get("reply"):
        result["reply"] = store.state().get("last_kid_message") or "I am here to help."
    return result


async def warmup_model() -> dict[str, Any]:
    """Cheap ping so the first live Gemma call is less cold."""
    message = await _chat(
        [
            {"role": "system", "content": "Reply with a single short tool call if tools are offered."},
            {"role": "user", "content": "Warmup ping. Call allow_page with message ok."},
        ]
    )
    return {"ok": True, "model": _model(), "got_message": bool(message)}
