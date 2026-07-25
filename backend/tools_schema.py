"""Frozen tool definitions sent to Ollama's OpenAI-compatible tool interface."""

from __future__ import annotations

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "allow_page",
            "description": "Allow the current page when it is appropriate for the child.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "warn_kid",
            "description": "Give a short, calm warning when the page may be unsuitable or risky.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Kid-friendly warning."},
                    "reason": {"type": "string", "description": "Brief parent-facing reason."},
                },
                "required": ["message", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "block_page",
            "description": "Block a page that is unsafe or clearly inappropriate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type": "string"},
                    "safer_alternative": {"type": "string"},
                },
                "required": ["reason", "safer_alternative"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "highlight_element",
            "description": "Highlight a useful on-page element by visible text or CSS selector.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text_or_css": {"type": "string"},
                    "message": {"type": "string"},
                },
                "required": ["text_or_css", "message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_mascot",
            "description": "Move the on-page mascot and choose its mood.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x_hint": {"type": "string"},
                    "mood": {
                        "type": "string",
                        "enum": ["idle", "worry", "happy", "point"],
                    },
                },
                "required": ["x_hint", "mood"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notify_parent",
            "description": "Add a concise safety update to the parent feed.",
            "parameters": {
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_alternative",
            "description": "Suggest a safe alternative resource to the child.",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["label", "url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "navigate_hint",
            "description": "Tell the extension about an allowlisted URL the child can open.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
]
