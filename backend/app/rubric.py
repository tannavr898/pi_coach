"""The DECA 2026 District role-play rubric, loaded from data + scoring helpers.

The numeric structure here mirrors DECA's official 2026 District evaluation form
(the point bands are factual scoring data, not copyrighted prose): four
Performance Indicators (0-12 each), three Solution criteria (0-8), three Career
Competencies (0-6), and an Overall Impression (0-10) — 100 points total, scored
on four levels (Novice / Developing / Proficient / Exemplary).

Selecting a *level* is the judgement call; the points just land inside that
level's band. So the model picks a level + a score, and we clamp the score into
the band to keep every result valid and the total honest.
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


def _section(category: str) -> dict:
    """Return the rubric section for a category (PI/solution/competency/overall)."""
    r = load_rubric()
    return {
        "performance_indicator": r["performance_indicator"],
        "solution": r["solution"],
        "career_competency": r["career_competency"],
        "overall_impression": r["overall_impression"],
    }[category]


def max_points(category: str) -> int:
    return int(_section(category)["max_points"])


def clamp_points(category: str, level: str, points: int) -> tuple[str, int]:
    """Coerce (level, points) to a valid pair: known level, score inside its band.

    Returns the (possibly corrected) level and the clamped integer score.
    """
    if level not in LEVELS:
        level = "novice"
    lo, hi = _section(category)["bands"][level]
    try:
        p = int(round(float(points)))
    except (TypeError, ValueError):
        p = lo
    return level, max(lo, min(hi, p))


def solution_items() -> list[dict]:
    return load_rubric()["solution"]["items"]


def competency_items() -> list[dict]:
    return load_rubric()["career_competency"]["items"]


def level_labels() -> dict[str, str]:
    return load_rubric()["level_labels"]


def total_max() -> int:
    return int(load_rubric()["total_points"])
