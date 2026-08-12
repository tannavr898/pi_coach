"""The study-term corpus — the single source of flashcard and course content.

A **term** is what a student studies; a **criterion** (framework.py) is what the
app grades. Those were the same object while the corpus matched the framework
1-to-1, which is exactly what capped the library at 282 cards. Splitting them
lets the study corpus grow past the framework without touching grading:

- `criterion_id` is set when a term corresponds to a graded framework criterion,
  and null for study-only terms. It is the join behind weak-term highlighting,
  the Section 2 depth award, and the core tier.
- `tier` is "core" (a skill we actually grade you on) or "extended" (worth
  knowing, never graded directly).

Ids: the 282 terms that predate the split keep their `FW-*` id, so saved ★ flags,
dashboard deep links, and Blitz all keep resolving. Study-only terms are `T-*`.
Ids are opaque — nothing derives meaning from the prefix; use `criterion_id`.

Grading never reads this file. Nothing here reads DECA's PI list; terms stand on
public-domain business concepts in our own wording, structure, and id scheme —
see data/framework-notes.md.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_TERMS_PATH = Path(__file__).parent / "data" / "terms.json"

BEATS = ("define", "explain", "connect", "above")


@lru_cache(maxsize=1)
def load_terms() -> dict:
    """Return the whole terms document (cached)."""
    with _TERMS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def all_terms() -> list[dict]:
    """Every term in file order (domain, then topic, then authored order)."""
    return load_terms()["terms"]


@lru_cache(maxsize=1)
def _index() -> dict[str, dict]:
    return {t["id"]: t for t in all_terms()}


@lru_cache(maxsize=1)
def _by_criterion() -> dict[str, dict]:
    return {t["criterion_id"]: t for t in all_terms() if t.get("criterion_id")}


def get_terms(ids: list[str]) -> list[dict]:
    """Resolve term ids, preserving the caller's order and skipping unknowns.

    This is the authoritative text — never trust the client (or the model) for a
    term's wording; always re-pin from here.
    """
    idx = _index()
    return [idx[i] for i in ids if i in idx]


def get_term(term_id: str) -> dict | None:
    """One term by id, or None."""
    return _index().get(term_id)


def term_for_criterion(criterion_id: str) -> dict | None:
    """The study term for a graded criterion, or None if it has no card yet."""
    return _by_criterion().get(criterion_id)


def terms_for_domains(domain_ids_wanted: list[str]) -> list[dict]:
    """Every term belonging to any of the given domains (file order)."""
    wanted = set(domain_ids_wanted)
    return [t for t in all_terms() if t["domain_id"] in wanted]


def terms_for_topics(topics_wanted: list[tuple[str, str]]) -> list[dict]:
    """Every term in any of the given (domain_id, topic) pairs (file order)."""
    wanted = set(topics_wanted)
    return [t for t in all_terms() if (t["domain_id"], t["topic"]) in wanted]


def depth_vocab_for(criteria: list[dict], limit: int = 16) -> list[dict]:
    """Terms related to the criteria being graded — the pool a competitor can earn
    Section 2's depth bonus from by bringing one in and actually applying it.

    Widening rings, nearest first:
      1. the graded criteria's own TOPICS — the most obviously related terms;
      2. then the rest of those DOMAINS, to fill out to `limit`.

    The second ring is load-bearing, not padding. Topic-only was the first cut and it
    was too narrow to work: four criteria that all sit in "Target Market" offered just
    five terms from one topic, so a competitor who reached for a perfectly relevant
    promotion idea got nothing, because we never offered it. A marketing role-play can
    fairly reward any marketing term the participant actually applies.

    Terms whose criterion is graded in THIS role-play are excluded — those are scored
    in Section 1, and paying again here would count the same knowledge twice.
    Study-only terms sort first within each ring: they're what the course teaches
    beyond what we grade, which is the reach this bonus exists to reward.

    Bounded by `limit` because it rides along in every scoring prompt.
    """
    graded = {c["id"] for c in criteria}
    topics = {(c["domain_id"], c["topic"]) for c in criteria if c.get("domain_id")}
    domain_ids = list(dict.fromkeys(c["domain_id"] for c in criteria if c.get("domain_id")))

    def usable(t: dict) -> bool:
        return t.get("criterion_id") not in graded

    # Stable sort: study-only first, file order (domain -> topic) preserved within.
    by_tier = lambda t: 0 if t["tier"] == "extended" else 1  # noqa: E731

    near = sorted([t for t in terms_for_topics(list(topics)) if usable(t)], key=by_tier)
    wider = sorted(
        [t for t in terms_for_domains(domain_ids)
         if usable(t) and (t["domain_id"], t["topic"]) not in topics],
        key=by_tier,
    )
    return (near + wider)[:limit]
