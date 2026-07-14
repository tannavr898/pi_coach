"""Mastery Blitz (Phase 5) — the drill's static scenario pool.

Short, predetermined scenarios (no LLM call) that the blitz picks from. The drill
loop stays model-free; the only model call is ONE batched scoring pass at the end.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "blitz_scenarios.json"


@lru_cache(maxsize=1)
def scenarios() -> list[dict]:
    """All blitz scenarios: [{id, text}, ...] (cached)."""
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f).get("scenarios", [])
