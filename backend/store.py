"""Tiny JSON-backed event and session-state store for the hackathon demo."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

DEFAULT_STATE = {
    "paused": False,
    "last_warning": None,
    "last_block": None,
    "last_kid_message": None,
    "high_risk_count": 0,
}


class GuardStore:
    def __init__(self, events_path: Path | None = None) -> None:
        self.events_path = events_path or Path(__file__).resolve().parent.parent / "data" / "events.json"
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._state: dict[str, Any] = DEFAULT_STATE.copy()
        self._events: list[dict[str, Any]] = self._load_events()

    def _load_events(self) -> list[dict[str, Any]]:
        if not self.events_path.exists():
            return []
        try:
            content = json.loads(self.events_path.read_text(encoding="utf-8"))
            return content if isinstance(content, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _save_events(self) -> None:
        self.events_path.write_text(
            json.dumps(self._events, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events)

    def recent_events(self, limit: int = 3) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events[-limit:])

    def state(self) -> dict[str, Any]:
        with self._lock:
            return self._state.copy()

    def resume(self) -> dict[str, Any]:
        with self._lock:
            self._state["paused"] = False
            self._state["high_risk_count"] = 0
            self._state["last_warning"] = None
            return self._state.copy()

    def _append_event(self, event_type: str, summary: str) -> dict[str, Any]:
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "summary": summary,
        }
        self._events.append(event)
        self._save_events()
        return event

    def execute_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Apply backend-only tool effects; browser actions remain for the extension."""
        with self._lock:
            if name == "allow_page":
                self._state["last_warning"] = None
            elif name == "warn_kid":
                message = str(arguments.get("message", "Let's be careful on this page."))
                reason = str(arguments.get("reason", "Potentially unsafe content"))
                self._state["last_warning"] = {"message": message, "reason": reason}
                self._state["last_kid_message"] = message
                self._state["high_risk_count"] += 1
                self._append_event("warning", f"{message} ({reason})")
            elif name == "block_page":
                reason = str(arguments.get("reason", "This page is not safe right now."))
                alternative = str(arguments.get("safer_alternative", "Try a kid-safe site instead."))
                self._state["last_block"] = {
                    "reason": reason,
                    "safer_alternative": alternative,
                }
                self._state["last_kid_message"] = alternative
                self._state["high_risk_count"] += 1
                self._append_event("block", f"Blocked page: {reason}. Safer alternative: {alternative}")
            elif name == "notify_parent":
                self._append_event("parent_notification", str(arguments.get("summary", "KidGuard update")))
            elif name == "highlight_element":
                self._state["last_kid_message"] = arguments.get("message")
            elif name in {"suggest_alternative", "navigate_hint"}:
                self._state["last_kid_message"] = arguments.get("label") or arguments.get("url")

            # Auto-pause off by default (KIDGUARD_AUTO_PAUSE_AFTER=0).
            # Set e.g. 5 to re-enable after N warn/block events.
            threshold = int(os.getenv("KIDGUARD_AUTO_PAUSE_AFTER", "0") or "0")
            if threshold > 0 and self._state["high_risk_count"] >= threshold:
                self._state["paused"] = True

            return {
                "ok": True,
                "tool": name,
                "state": self._state.copy(),
            }
