"""The quiz bank, pre-generated multiple-choice questions over the study corpus.

Questions are written OFFLINE by scripts/gen_quiz.py (prompts.build_quiz_prompt),
validated there, and shipped as data/quiz_bank.json. Serving is a file read: no
model call, no key, no per-question cost. That is the whole point of the design,
a student can quiz for an hour without spending a token of anyone's allowance,
which is what lets the quiz stay open to signed-out visitors while Blitz cannot be.

The trade-off it buys: because the bank is static, the answer key ships with the
question. The client grades the answer itself and shows the rationale the instant
you pick. A determined student could read the key out of the network response, but
the same student can already flip the flashcard over, and the honest study loop is
worth more than a defence that only inconveniences the honest.

Each question carries `term_ids`, which is the join to everything else: it is how a
deck quiz gets deck questions, how a weak-terms quiz gets weak-term questions, and
how a result folds back into study progress (app/study.py).

Nothing here reads DECA's PI list; questions are authored blind from our own study
cards (see data/framework-notes.md and scripts/gen_quiz.py).
"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "quiz_bank.json"

LEVELS = ("district", "state", "icdc")


@lru_cache(maxsize=1)
def all_questions() -> list[dict]:
    """Every question in the bank, in file order (cached)."""
    if not _PATH.exists():  # the bank is generated; an empty app should still boot
        return []
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f).get("questions", [])


@lru_cache(maxsize=1)
def _index() -> dict[str, dict]:
    return {q["id"]: q for q in all_questions()}


def get_question(question_id: str) -> dict | None:
    """One question by id, or None."""
    return _index().get(question_id)


@lru_cache(maxsize=1)
def counts() -> dict[str, int]:
    """How many questions exist per level, plus the total. Used by the UI to hide a
    level that has not been generated yet rather than offering an empty quiz."""
    out = {lvl: 0 for lvl in LEVELS}
    for q in all_questions():
        if q["level"] in out:
            out[q["level"]] += 1
    out["total"] = len(all_questions())
    return out


def select(
    *,
    level: str = "",
    domain_ids: list[str] | None = None,
    term_ids: list[str] | None = None,
    count: int = 10,
    rng: random.Random | None = None) -> list[dict]:
    """Pick up to `count` questions matching the filters, in random order.

    `term_ids` (a deck, a course unit, a student's weak terms) matches a question
    when ANY of its terms is in the set, then sorts fully-covered questions first.
    Requiring every term would be the tidier rule and it quietly breaks the feature:
    a five-card weak-term deck would drop every icdc question, which draws on two or
    three cards at once, leaving exactly the students who need synthesis practice
    with none of it. Partial matches are still fair game, because the concept being
    tested is one the student is studying.

    Returns questions as stored, answer key included (see the module docstring).
    """
    rng = rng or random.Random()
    wanted_terms = set(term_ids or [])
    wanted_domains = set(domain_ids or [])

    pool = []
    for q in all_questions():
        if level and q["level"] != level:
            continue
        if wanted_domains and q.get("domain_id") not in wanted_domains:
            continue
        qt = set(q.get("term_ids") or [])
        if wanted_terms:
            hits = len(qt & wanted_terms)
            if not hits:
                continue
            covered = hits == len(qt)
        else:
            covered = True
        pool.append((0 if covered else 1, q))

    rng.shuffle(pool)
    pool.sort(key=lambda p: p[0])  # stable: full matches first, random within tier
    return [q for _, q in pool[: max(0, count)]]
