"""Official DECA performance indicators (PIs), used with DECA's permission.

Loads pis.json (built offline by scripts/build_pis.py from the official list) and
exposes pure, deterministic lookups. A PI is shaped like a framework criterion so
the existing scoring, caching and feedback code handles it unchanged: the PI's
official wording is `name`, its instructional area is `domain`, and its
performance element is `topic`.

Events with no official PI list on file (Finance, Personal Financial Literacy)
return no pool here and keep the framework path in main.py.
"""

from __future__ import annotations

import json
import random
import re
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "pis.json"

# Which indicator levels each kind of role-play draws from. Principles events are
# entry level; district series events sit at career-sustaining/specialist; state
# and ICDC move up to specialist/manager.
_LEVELS = {
    ("principles", "district"): {"PQ", "CS"},
    ("principles", "state"): {"PQ", "CS"},
    ("principles", "icdc"): {"PQ", "CS"},
    ("individual", "district"): {"CS", "SP"},
    ("individual", "state"): {"SP", "MN"},
    ("individual", "icdc"): {"SP", "MN"},
    ("team", "district"): {"CS", "SP"},
    ("team", "state"): {"SP", "MN"},
    ("team", "icdc"): {"SP", "MN"},
}

# The official "Solution" and "Career Competencies" sections printed on every
# 2026 role-play sheet (verbatim wording).
SOLUTION = [
    {"name": "Unique", "text": "Demonstrate original thinking, fresh perspectives and an insightful approach."},
    {"name": "Practical", "text": "Develop an actionable/viable solution in a real-world context."},
    {"name": "Effective", "text": "Develop a solution that achieves relevant outcomes."},
]
CAREER_COMPETENCIES = [
    {"name": "Critical Thinking", "text": "Think critically to understand and solve problems."},
    {"name": "Communication", "text": "Communicate clearly, effectively and with reason."},
    {"name": "Decision Making", "text": "Consider the impacts of decisions."},
]

_STRONG = (
    "Addresses the indicator directly with accurate, specific points, and ties them "
    "to the facts of this situation (the company, the numbers, the people involved)."
)
_WEAK = (
    "Names the topic in general terms or defines it, but never applies it to this "
    "situation or says what the business should actually do."
)


@lru_cache(maxsize=1)
def _doc() -> dict:
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _index() -> dict[str, dict]:
    return {p["id"]: p for p in _doc()["pis"]}


def area_name(area_id: str) -> str:
    return _doc()["areas"].get(area_id, area_id)


def _as_criterion(p: dict) -> dict:
    """A PI in the shape the rest of the app calls a criterion."""
    text = p["text"].rstrip(".")
    return {
        "id": p["id"],
        "domain_id": p["area"].lower(),
        "domain": area_name(p["area"]),
        "topic": p.get("element", "") or area_name(p["area"]),
        "name": p["text"],
        "definition": f"Does the response show the participant can do this: {text[:1].lower() + text[1:]}?",
        "strong_looks_like": _STRONG,
        "weak_looks_like": _WEAK,
        "coaches": "",
        "official": True,
    }


def is_pi_id(cid: str) -> bool:
    return cid in _index()


def get_pis(ids: list[str]) -> list[dict]:
    """Resolve PI ids to criterion-shaped dicts, preserving order, skipping unknowns."""
    idx = _index()
    return [_as_criterion(idx[i]) for i in ids if i in idx]


def has_pis(event: dict | None) -> bool:
    """True when we hold an official PI list for this event."""
    return bool(event) and event.get("id") in _doc()["event_tags"]


def eligible(event: dict, level: str) -> list[dict]:
    """Every PI this event/level may assess."""
    tags = set(_doc()["event_tags"].get(event["id"], []))
    levels = _LEVELS.get((event.get("kind", "individual"), level), {"CS", "SP"})
    return [p for p in _doc()["pis"] if p["level"] in levels and tags & set(p["tags"])]


_WORD = re.compile(r"[a-z]{4,}")


def _stems(text: str) -> set[str]:
    return {w[:5] for w in _WORD.findall(text.lower())}


def candidate_pool(event: dict, level: str, query: str, size: int = 60) -> list[dict]:
    """The PIs generation may choose from, as criterion-shaped dicts.

    The strongest lexical matches to the topic/focus come first so the model can
    build a coherent set; a random slice of everything else keeps variety and stops
    the same indicators dominating. Official role-plays draw their indicators from
    one instructional area, so the pool is also biased toward the best-matching one.
    """
    pool = eligible(event, level)
    if not pool:
        return []
    q = _stems(query)
    scored = []
    for p in pool:
        s = len(q & _stems(p["text"] + " " + p.get("element", ""))) + 0.3 * len(q & _stems(area_name(p["area"])))
        scored.append((s + random.random() * 0.5, p))
    scored.sort(key=lambda t: t[0], reverse=True)
    top_area = scored[0][1]["area"]
    same_area = [p for _, p in scored if p["area"] == top_area]
    picked: list[dict] = []
    seen: set[str] = set()

    def add(items: list[dict], limit: int) -> None:
        for p in items:
            if len(picked) >= limit:
                return
            if p["id"] not in seen:
                picked.append(p)
                seen.add(p["id"])

    add(same_area, int(size * 0.55))
    add([p for _, p in scored], int(size * 0.8))
    rest = [p for _, p in scored if p["id"] not in seen]
    random.shuffle(rest)
    add(rest, size)
    return [_as_criterion(p) for p in picked]
