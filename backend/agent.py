"""Ollama chat client and bounded tool loop for KidGuard."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from backend.policy import GUARD_SYSTEM_PROMPT, coach_system_prompt
from backend.store import GuardStore
from backend.tools_schema import TOOLS
from config.allowlist import SAFER_ALTERNATIVES, is_allowlisted

MAX_TOOL_ROUNDS = 3
PAGE_TEXT_LIMIT = 1500
TOOL_NAMES = {tool["function"]["name"] for tool in TOOLS}


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


def _fallback_tool_call() -> dict[str, Any]:
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
    payload = {"model": _model(), "messages": messages, "tools": TOOLS, "stream": False}
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
        fallback = _fallback_tool_call()
        print(f"[KidGuard] tool fallback: {fallback['name']}", flush=True)
        store.execute_tool(fallback["name"], fallback["arguments"])
        executed_calls.append(fallback)

    return {"tool_calls": executed_calls, "message": messages[-1].get("content", "")}


def _action_from_calls(tool_calls: list[dict[str, Any]]) -> str:
    for name in ("block_page", "warn_kid", "allow_page"):
        if any(call["name"] == name for call in tool_calls):
            return name
    return tool_calls[0]["name"] if tool_calls else "warn_kid"


async def run_guard(
    *,
    url: str,
    title: str,
    text: str,
    age: int | None,
    store: GuardStore,
) -> dict[str, Any]:
    page_text = text[:PAGE_TEXT_LIMIT]
    recent_events = json.dumps(store.recent_events(), ensure_ascii=False)
    user_prompt = (
        f"URL: {url}\nTitle: {title}\nChild age: {age or 'unknown'}\n"
        f"Recent parent-feed events (last 3): {recent_events}\n\n"
        f"Page text (truncated to {PAGE_TEXT_LIMIT} characters):\n{page_text}"
    )
    result = await _run_tool_loop(
        system_prompt=GUARD_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        store=store,
    )
    result["action"] = _action_from_calls(result["tool_calls"])
    return result


async def run_coach(*, message: str, store: GuardStore) -> dict[str, Any]:
    result = await _run_tool_loop(
        system_prompt=coach_system_prompt(),
        user_prompt=f"Child message: {message[:1500]}",
        store=store,
        coach_mode=True,
    )
    result["action"] = _action_from_calls(result["tool_calls"])
    return result
