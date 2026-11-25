"""Ready-made official-format role-plays, authored by hand (no model call).

Built offline by scripts/build_scenario_bank.py. Serving one is free and instant, so the
endpoint tries the bank first for an event with no free-text focus, and only falls
through to generation once a student has seen everything for that event and level.
"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "scenario_bank.json"


@lru_cache(maxsize=1)
def _all() -> list[dict]:
    if not _PATH.exists():
        return []
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f).get("scenarios", [])


def count(event_id: str, level: str | None = None) -> int:
    return sum(1 for s in _all() if s["event"] == event_id and (level is None or s["level"] == level))


def pick(event_id: str, level: str, seen: list[str]) -> dict | None:
    """A random unseen scenario for this event and level, or None when all were seen."""
    seen_set = set(seen)
    pool = [s for s in _all() if s["event"] == event_id and s["level"] == level and s["id"] not in seen_set]
    return random.choice(pool) if pool else None


def get(scenario_id: str) -> dict | None:
    return next((s for s in _all() if s["id"] == scenario_id), None)
