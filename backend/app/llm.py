"""Thin Anthropic wrapper + defensive JSON parsing.

The frontend never calls Anthropic — only this backend does, with the key read
from the environment. Keep this module small: build a client lazily, make one
text completion, and parse model JSON defensively (the roadmap §7 rule).
"""

from __future__ import annotations

import json
import os
from typing import Any

import anthropic

from .config import MODEL


class LLMNotConfigured(RuntimeError):
    """Raised when no Anthropic API key is configured on the backend."""


class LLMError(RuntimeError):
    """Raised when the provider call or response parsing fails."""


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise LLMNotConfigured("ANTHROPIC_API_KEY is not set on the backend.")
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    return _client


def complete(system: str, user: str, *, max_tokens: int = 2048) -> str:
    """Run one non-streaming completion and return the concatenated text."""
    client = _get_client()
    try:
        msg = client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIError as e:  # network, rate-limit, 5xx, etc.
        raise LLMError(f"Anthropic API error: {e}") from e
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse the first JSON object out of model text.

    Defensive per roadmap §7: strip code fences, then slice from the first ``{``
    to the last ``}`` before json.loads. Raises LLMError on failure so callers
    can surface a clean 502 instead of leaking a stack trace.
    """
    t = text.strip()
    if t.startswith("```"):
        # drop a leading ```json / ``` fence and any trailing fence
        t = t.split("```", 2)[1] if t.count("```") >= 2 else t.strip("`")
        if t.lstrip().lower().startswith("json"):
            t = t.lstrip()[4:]
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise LLMError("Model did not return a JSON object.")
    try:
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"Could not parse model JSON: {e}") from e
