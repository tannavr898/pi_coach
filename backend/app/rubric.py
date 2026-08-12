"""Scoring scale for the independent framework.

Every selected criterion is graded on the same four quality levels
(Novice / Developing / Proficient / Exemplary) against its own
strong_looks_like / weak_looks_like bar, on a 0-10 band. The model picks a level
and a score; we clamp the score into that level's band so every result is valid
and the total stays honest. These are generic rubric quality levels — not any
organization's proprietary rubric (see rubric.json).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_RUBRIC_PATH = Path(__file__).parent / "data" / "rubric.json"

LEVELS = ("novice", "developing", "proficient", "exemplary")


@lru_cache(maxsize=1)
def load_rubric() -> dict:
    return json.loads(_RUBRIC_PATH.read_text(encoding="utf-8"))


def criterion_max() -> int:
    return int(load_rubric()["criterion_max_points"])


def level_labels() -> dict[str, str]:
    return load_rubric()["level_labels"]


def level_descriptions() -> dict[str, str]:
    return load_rubric()["level_descriptions"]


def clamp_points(level: str, points: int) -> tuple[str, int]:
    """Coerce (level, points) to a valid pair: a known level with a score inside
    its band. Returns the (possibly corrected) level and the clamped score."""
    if level not in LEVELS:
        level = "novice"
    lo, hi = load_rubric()["bands"][level]
    try:
        p = int(round(float(points)))
    except (TypeError, ValueError):
        p = lo
    return level, max(lo, min(hi, p))


def overall_level(percent: float) -> str:
    """Map an overall percentage to a level for the summary meter."""
    bands = load_rubric()["overall_bands"]
    for lv in LEVELS:
        lo, hi = bands[lv]
        if lo <= percent <= hi:
            return lv
    return "exemplary" if percent > 100 else "novice"
