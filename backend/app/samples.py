"""Official DECA sample role-plays, used ONLY as style guides in generation prompts.

They calibrate length, structure and tone of what the model writes. They are never
returned to a student as a role-play. Built offline by scripts/build_samples.py.
"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "sample_roleplays.json"

_CLUSTER_WORDS = {
    "Marketing": "market",
    "Finance": "financ",
    "Hospitality & Tourism": "hospital",
    "Business Management & Administration": "business manag",
    "Entrepreneurship": "entrepren",
}


@lru_cache(maxsize=1)
def _all() -> list[dict]:
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f)["samples"]


def pick(event: dict, count: int = 1) -> list[dict]:
    """Sample role-plays of the right format for this event (principles vs series),
    preferring ones from the same career cluster."""
    fmt = "principles" if event.get("kind") == "principles" else "series"
    pool = [s for s in _all() if s["format"] == fmt and s.get("situation")]
    word = _CLUSTER_WORDS.get(event.get("cluster", ""), "")
    same = [s for s in pool if word and word in (s.get("cluster", "") + " " + s.get("pathway", "")).lower()]
    random.shuffle(same)
    random.shuffle(pool)
    out: list[dict] = []
    for s in same + pool:
        if s not in out:
            out.append(s)
        if len(out) >= count:
            break
    return out


def words_for(event: dict, level: str) -> str:
    """Target length of the participant-facing situation, measured from the official
    samples (principles about 175-280 words, series about 335-455)."""
    kind = event.get("kind", "individual")
    if kind == "principles":
        return "190-260 words"
    base = {"district": (330, 400), "state": (380, 450), "icdc": (420, 500)}.get(level, (330, 400))
    if kind == "team":
        base = (base[0] + 60, base[1] + 70)
    return f"{base[0]}-{base[1]} words"
