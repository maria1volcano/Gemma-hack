"""Instant decisions for known local demo pages (hackathon pitch speed).

Also provides a shared fast-risk heuristic for self-harm / suicide signals on
real sites (YouTube, Dailymotion, Google, …) so we never wait on slow Gemma.

Set KIDGUARD_FAST_DEMO=0 to force every page through live Gemma
(except hard self-harm blocks, which always take the fast path).
"""

from __future__ import annotations

import os
import re
from urllib.parse import unquote, urlparse

CLASSROOM_URL = "http://127.0.0.1:8765/demo_sites/classroom.html"
RESOURCES_URL = "http://127.0.0.1:8765/demo_sites/ok_school.html"
CLASSROOM_HINT = {
    "name": "suggest_alternative",
    "arguments": {"label": "Go to Classroom", "url": CLASSROOM_URL},
}
RESOURCES_HINT = {
    "name": "suggest_alternative",
    "arguments": {"label": "School Resources", "url": RESOURCES_URL},
}

# Kid-facing copy stays calm; never echo graphic labels back to the child.
SELF_HARM_BLOCK_REASON = (
    "This page talks about really hard feelings in a way that is not okay for you. "
    "Let's go somewhere kinder together."
)
SELF_HARM_WARN_MESSAGE = "Let's step away from this page and pick something safer."
SELF_HARM_WARN_REASON = "This topic needs a grown-up, not the internet."
SELF_HARM_PARENT_SUMMARY = (
    "KidGuard hard-blocked a page with self-harm / suicide search or content signals."
)

# Word-ish patterns that fire on URL, title, or scraped text (real search pages).
_SELF_HARM_PATTERNS = (
    re.compile(r"\bsuicid(?:e|al)\b", re.I),
    re.compile(r"\bself[-\s]?harm(?:ing)?\b", re.I),
    re.compile(r"\bkill\s+(?:my|your)self\b", re.I),
    re.compile(r"\bend\s+(?:my|your)\s+life\b", re.I),
    re.compile(r"\bwant(?:s|ed|ing)?\s+to\s+die\b", re.I),
    re.compile(r"\bhow\s+to\s+(?:die|kill\s+(?:my|your)self)\b", re.I),
)


def _enabled() -> bool:
    return (os.getenv("KIDGUARD_FAST_DEMO", "1") or "1").strip() not in {"0", "false", "False", "no"}


def _haystack(url: str, title: str, text: str) -> str:
    """Flatten URL (decoded), title, and page text for heuristic matching."""
    raw_url = unquote(str(url or ""))
    parts = [raw_url, str(title or ""), str(text or "")[:4000]]
    return " \n ".join(parts)


def has_self_harm_signal(url: str = "", title: str = "", text: str = "") -> bool:
    """True when URL/title/text look like self-harm or suicide content."""
    blob = _haystack(url, title, text)
    if not blob.strip():
        return False
    return any(pat.search(blob) for pat in _SELF_HARM_PATTERNS)


def fast_risk_tool_calls(url: str = "", title: str = "", text: str = "") -> list[dict] | None:
    """Immediate hard block for self-harm / suicide signals (any site).

    Always on — not gated by KIDGUARD_FAST_DEMO — so live Gemma never delays
    a safety-critical block.
    """
    if not has_self_harm_signal(url, title, text):
        return None
    return [
        {
            "name": "warn_kid",
            "arguments": {
                "message": SELF_HARM_WARN_MESSAGE,
                "reason": SELF_HARM_WARN_REASON,
            },
        },
        {"name": "move_mascot", "arguments": {"x_hint": "left", "mood": "worry"}},
        {
            "name": "suggest_alternative",
            "arguments": {"label": "Go to Classroom", "url": CLASSROOM_URL},
        },
        {
            "name": "block_page",
            "arguments": {
                "reason": SELF_HARM_BLOCK_REASON,
                "safer_alternative": CLASSROOM_URL,
            },
        },
        # After block_page so the extension skips the kid-facing notify toast.
        {"name": "notify_parent", "arguments": {"summary": SELF_HARM_PARENT_SUMMARY}},
    ]


def _highlight(text_or_css: str, message: str, *, safe: bool = True) -> dict:
    args: dict = {"text_or_css": text_or_css, "message": message}
    if safe:
        args["safe"] = True
    return {"name": "highlight_element", "arguments": args}


def _point(mood: str = "point") -> dict:
    return {"name": "move_mascot", "arguments": {"x_hint": "target", "mood": mood}}


def _plan(reply: str, *tools: dict) -> dict:
    return {"reply": reply, "tool_calls": list(tools)}


def fast_coach_plan(message: str) -> dict | None:
    """Return {reply, tool_calls} for common kid coach asks, else None.

    Intent → page-grounded visuals (demo strings on ok_school / classroom).
    Safer Classroom redirects only for leave / password / clear risk asks.
    """
    if not _enabled():
        return None
    text = re.sub(r"\s+", " ", str(message or "").lower()).strip()
    if not text:
        return None

    password = any(w in text for w in ("password", "login", "phish", "robux", "free coins"))
    leave = any(
        phrase in text
        for phrase in (
            "get out",
            "get me out",
            "leave",
            "exit",
            "escape",
            "stuck",
            "go away",
            "somewhere safe",
            "safe place",
            "take me somewhere",
            "go back",
            "help me out",
            "how do i leave",
            "out of this",
        )
    )
    want_classroom = any(w in text for w in ("classroom", "go to school", "go to class"))
    safety_check = any(
        phrase in text
        for phrase in ("is this safe", "is it safe", "safe?", "this feel weird", "feels weird")
    )

    # --- risky / leave first -------------------------------------------------
    if password:
        return _plan(
            "Do not type a password here — I marked the risky box in pink. Use the green safe path instead.",
            CLASSROOM_HINT,
            _highlight("password", "Do not type a password here.", safe=False),
            _point("worry"),
        )
    if leave or want_classroom or safety_check:
        return _plan(
            "Follow the glowing green button I am pointing at — that takes you somewhere safer.",
            CLASSROOM_HINT,
            _highlight("Classroom", "Tap here to go somewhere safer."),
            _point(),
        )

    # --- schedule / library (ok_school.html) ----------------------------------
    friday = "friday" in text or re.search(r"\bfri\b", text)
    scheduley = any(
        w in text
        for w in (
            "what on",
            "have on",
            "have what",
            "what do i have",
            "what have i",
            "timetable",
            "schedule",
            "opening hour",
            "open on",
            "library hour",
            "when is",
            "what time",
        )
    )
    library = any(w in text for w in ("library", "opening hour", "open hour", "hours"))

    if friday:
        # Any Friday ask → point at the Friday row (open 8:30–15:00 on the demo page).
        return _plan(
            "On Friday the library is open from 8:30 to 15:00 — I circled Friday for you. "
            "Remember to return your books before the weekend!",
            _highlight("Friday", "Friday library hours are right here."),
            _point("happy"),
        )
    if library or scheduley or any(w in text for w in ("opening hour", "open hour", "what time", "timetable")):
        return _plan(
            "Library times are in this table — I marked Library opening hours for you.",
            _highlight("Library opening hours", "Check the hours in this table."),
            _point("happy"),
        )

    # --- homework tips / reading list (ok_school.html) -----------------------
    homework_tips = any(
        phrase in text
        for phrase in (
            "homework tip",
            "study tip",
            "homework help",
            "how do i do homework",
            "help with homework",
            "tips for homework",
        )
    ) or ("homework" in text and "tip" in text) or ("study" in text and "tip" in text)
    if homework_tips or (re.search(r"\btips?\b", text) and "resource" not in text):
        return _plan(
            "Here are homework tips that actually help — I put a green ring on them!",
            _highlight("Homework tips that actually help", "Try these homework tips."),
            _point("happy"),
        )

    reading_list = any(
        phrase in text
        for phrase in (
            "reading list",
            "book list",
            "what should i read",
            "books to read",
            "term's reading",
            "this term",
        )
    ) or ("read" in text and any(w in text for w in ("book", "list", "suggest")))
    if reading_list:
        return _plan(
            "This term's reading list is up here — pick a book that looks fun!",
            _highlight("This term's reading list", "Books for this term live here."),
            _point("happy"),
        )

    book_swap = any(w in text for w in ("book swap", "coming up", "this month", "ms achebe"))
    if book_swap:
        return _plan(
            "The book swap is coming up this month — I marked that bit for you.",
            _highlight("Coming up this month", "Look at what is coming up."),
            _point("happy"),
        )

    # --- classroom assignments (classroom.html) ------------------------------
    maths = any(w in text for w in ("maths", "math", "fraction", "pizza"))
    reading_hw = any(
        phrase in text for phrase in ("reading assignment", "three pages", "reading homework")
    ) or ("reading" in text and any(w in text for w in ("assignment", "homework", "due")))
    science = any(w in text for w in ("science", "cloud", "clouds"))
    assignments = any(w in text for w in ("assignment", "assignments", "homework", "due tuesday", "due thursday"))

    if maths:
        return _plan(
            "Your maths job is Fraction Pizza — I circled it so you can start there!",
            _highlight("1. Maths: Fraction Pizza", "Start with this maths assignment."),
            _point("happy"),
        )
    if reading_hw:
        return _plan(
            "Your reading assignment is Three Pages and a Question — look, I marked it!",
            _highlight("2. Reading: Three Pages and a Question", "This is your reading assignment."),
            _point("happy"),
        )
    if science:
        return _plan(
            "Science is Cloud Watch — you already finished it. Nice work!",
            _highlight("3. Science: Cloud Watch", "Your science assignment is here."),
            _point("happy"),
        )
    if assignments:
        return _plan(
            "Your assignments are in this list — I put a green ring on them!",
            _highlight("Your assignments", "Your assignments are right here."),
            _point("happy"),
        )

    # --- navigate to school resources ----------------------------------------
    resources = any(
        phrase in text
        for phrase in (
            "resource",
            "resources",
            "school resource",
            "where can i get",
            "where do i find school",
            "assignment help",
        )
    )
    if resources:
        return _plan(
            "School resources are this way — tap the glowing green button I am pointing at.",
            RESOURCES_HINT,
            _highlight("School Resources", "Tap here for school resources."),
            _point(),
        )

    return None


def fast_demo_tool_calls(url: str) -> list[dict] | None:
    """Return canned {name, arguments} tool calls for demo_sites pages, else None."""
    if not _enabled():
        return None

    path = urlparse(url or "").path.lower().rstrip("/")
    name = path.rsplit("/", 1)[-1]

    if name in {"phishing.html", "phishing"}:
        return [
            {
                "name": "block_page",
                "arguments": {
                    "reason": "This page tries to steal your password with a scary countdown.",
                    "safer_alternative": "http://127.0.0.1:8765/demo_sites/classroom.html",
                },
            },
            {
                "name": "highlight_element",
                "arguments": {
                    "text_or_css": "password",
                    "message": "Never type a password here.",
                },
            },
            {"name": "move_mascot", "arguments": {"x_hint": "target", "mood": "point"}},
            {
                "name": "notify_parent",
                "arguments": {
                    "summary": "Blocked a phishing-style demo page asking for a password under urgency.",
                },
            },
        ]

    if name in {"clickbait.html", "clickbait"}:
        return [
            {
                "name": "warn_kid",
                "arguments": {
                    "message": "That prize looks too good to be true. Let's skip flashy giveaways and pick something safer.",
                    "reason": "Clickbait / fake prize pressure.",
                },
            },
            {
                "name": "notify_parent",
                "arguments": {"summary": "Warned on a clickbait / fake-prize demo page."},
            },
            {
                "name": "suggest_alternative",
                "arguments": {
                    "label": "Go to Classroom",
                    "url": "http://127.0.0.1:8765/demo_sites/classroom.html",
                },
            },
            {"name": "move_mascot", "arguments": {"x_hint": "right", "mood": "worry"}},
        ]

    if name in {"ok_school.html", "ok_school", "school.html"}:
        return [
            {
                "name": "allow_page",
                "arguments": {"message": "These study tips look helpful. Nice choice!"},
            },
            {
                "name": "highlight_element",
                "arguments": {
                    "text_or_css": "Homework tips that actually help",
                    "message": "Good tips live here.",
                },
            },
            {"name": "move_mascot", "arguments": {"x_hint": "right", "mood": "happy"}},
        ]

    if name in {"classroom.html", "classroom"}:
        return [
            {
                "name": "allow_page",
                "arguments": {"message": "Classroom looks like a good place to learn."},
            },
            {"name": "move_mascot", "arguments": {"x_hint": "right", "mood": "happy"}},
        ]

    return None
