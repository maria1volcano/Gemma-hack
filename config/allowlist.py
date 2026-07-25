"""Small allowlist used when the coach recommends a destination."""

from __future__ import annotations

from urllib.parse import urlparse

ALLOWED_DOMAINS = {
    "classroom.google.com",
    "kids.nationalgeographic.com",
    "www.pbskids.org",
    "www.khanacademy.org",
    "scratch.mit.edu",
    "127.0.0.1",
    "localhost",
}

SAFER_ALTERNATIVES = [
    {"label": "Classroom (demo)", "url": "http://127.0.0.1:8765/demo_sites/classroom.html"},
    {"label": "PBS Kids", "url": "https://www.pbskids.org/"},
    {"label": "Khan Academy Kids", "url": "https://www.khanacademy.org/kids/"},
    {"label": "National Geographic Kids", "url": "https://kids.nationalgeographic.com/"},
    {"label": "Scratch", "url": "https://scratch.mit.edu/"},
]


def is_allowlisted(url: str) -> bool:
    """Return whether a http(s) URL belongs to a known kid-safe destination."""
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if hostname in {"127.0.0.1", "localhost"}:
        return "/demo_sites/" in (parsed.path or "")
    return hostname in ALLOWED_DOMAINS or any(
        hostname.endswith(f".{domain}") for domain in ALLOWED_DOMAINS
    )


def safer_alternatives_text() -> str:
    """Format alternatives for inclusion in the coach system prompt."""
    return "; ".join(f"{item['label']}: {item['url']}" for item in SAFER_ALTERNATIVES)
