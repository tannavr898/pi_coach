"""Flashcard display content (Phase 4).

Loads flashcard_content.json — a plain definition, a term-specific worked example
run through the four beats (Define -> Explain -> Connect -> Above & Beyond), and one
term-specific common mistake, per framework criterion. This is DISPLAY-ONLY content;
grading still reads framework.json. Keeping it in a separate file lets us regenerate
and review the cards without touching the grading source of truth.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "flashcard_content.json"


@lru_cache(maxsize=1)
def _cards() -> dict[str, dict]:
    try:
        with _PATH.open(encoding="utf-8") as f:
            return json.load(f).get("cards", {})
    except FileNotFoundError:
        return {}


def content_for(criterion_id: str) -> dict | None:
    """The flashcard content for a criterion, or None if not authored yet."""
    return _cards().get(criterion_id)
