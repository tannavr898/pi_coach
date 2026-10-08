"""Site-wide usage counters: role-plays, Blitz drills, scenarios, quizzes,
questions answered, flashcards flipped.

Running totals, for two readers: the owner (is anyone using this?) and a
signed-out visitor on the landing page (is anyone using this?). Nothing here is
per-user, nothing identifies anyone, and nothing records WHAT was practiced, a
count is all either reader needs, the same posture as usage_counter.

WHAT COUNTS
  roleplay  a response that was actually graded (/api/score-content succeeded).
            Anonymous reps count too; the sessions table only sees signed-in ones.
  blitz     a drill that was actually graded (/api/blitz-score succeeded).
  scenario  a scenario the model freshly wrote. A cache hit is a scenario being
            REUSED, so it doesn't count, "unique scenarios" has to mean unique.
  quiz      a Knowledge Check round that was finished.
  question  a quiz question that was answered, within a finished round.
  card      a flashcard that was turned over.

The first three are counted where the server did the work, so they can't be
inflated. The last three happen entirely in the browser (the quiz bank and the
cards are served once and graded locally, signed in or not), so the browser
reports them to POST /api/stats/report. That makes them softer numbers: the
route is rate limited and each report is capped at what one real round or deck
could be, but it takes the client's word. They are also the only way a
signed-out student's studying is counted at all.

Only successes count, so a failed grade followed by "try again" is one rep, not two.

Increments run as a background task after the response is sent: a counter must
never slow down or fail a student's rep. Reads are cached in-process for a few
minutes, because every landing-page view reads them and none of them needs the
number to the second.
"""

from __future__ import annotations

import logging
import os
import time

import httpx

from . import config, db

log = logging.getLogger("uvicorn.error")

KINDS = ("roleplay", "blitz", "scenario", "quiz", "question", "card")
CACHE_SECONDS = 300.0

# The most one report may add: a quiz round is at most 40 questions (the server's
# own cap on a served round), and nobody flips more than a full course deck in a
# sitting.
MAX_QUESTIONS_PER_REPORT = 40
MAX_CARDS_PER_REPORT = 250


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# The landing page shows a number only once it is worth saying. "7 role-plays
# graded" argues against signing up, not for it. Each counter clears its own
# bar, so a busy one is not held back by a quiet one, and a quiet one is never
# printed next to it. Keyed by the name the response uses; the list is also the
# order the landing page prefers them in.
PUBLIC_MIN: dict[str, int] = {
    "roleplays": _int_env("PUBLIC_STATS_MIN_ROLEPLAYS", 100),
    "questions": _int_env("PUBLIC_STATS_MIN_QUESTIONS", 1000),
    "cards": _int_env("PUBLIC_STATS_MIN_CARDS", 1000),
    "scenarios": _int_env("PUBLIC_STATS_MIN_SCENARIOS", 100),
    "quizzes": _int_env("PUBLIC_STATS_MIN_QUIZZES", 100),
    "blitzes": _int_env("PUBLIC_STATS_MIN_BLITZES", 100),
}
_FIELD = {"roleplay": "roleplays", "blitz": "blitzes", "scenario": "scenarios",
          "quiz": "quizzes", "question": "questions", "card": "cards"}

_cache: dict = {"at": 0.0, "counts": None}


def reset_cache() -> None:
    _cache["at"] = 0.0
    _cache["counts"] = None


async def bump(kind: str, n: int = 1) -> None:
    """Add `n` to a counter. Best-effort: logs and moves on if the store is down."""
    if kind not in KINDS or n < 1 or not config.has_supabase():
        return
    try:
        await db.bump_stat(kind, n)
    except httpx.HTTPError as exc:
        log.warning("stat bump failed for %s: %s", kind, exc)


async def report(kind: str, count: int) -> None:
    """Count study the browser did on its own: a finished quiz round of `count`
    questions, or `count` flashcards turned over. Clamped, never trusted."""
    if kind == "quiz":
        n = max(0, min(count, MAX_QUESTIONS_PER_REPORT))
        if n:
            await bump("quiz")
            await bump("question", n)
    elif kind == "flashcards":
        await bump("card", max(0, min(count, MAX_CARDS_PER_REPORT)))


def public(counts: dict[str, int]) -> dict:
    """The response shape, plus which totals have cleared their bar. `visible` is
    in the order the landing page should prefer them; `show` is just "any"."""
    out: dict = {field: int(counts.get(kind, 0) or 0) for kind, field in _FIELD.items()}
    visible = [field for field, floor in PUBLIC_MIN.items() if out[field] >= floor]
    return {**out, "visible": visible, "show": bool(visible)}


async def snapshot(now: float | None = None) -> dict:
    """Current totals, cached for CACHE_SECONDS. A failed read is never cached, so
    one blip doesn't hide the numbers for five minutes."""
    now = time.monotonic() if now is None else now
    cached = _cache["counts"]
    if cached is not None and now - _cache["at"] < CACHE_SECONDS:
        return public(cached)
    if not config.has_supabase():
        return public({})
    try:
        counts = await db.get_stats()
    except httpx.HTTPError as exc:
        log.warning("stats read failed: %s", exc)
        return public(cached or {})
    _cache["counts"] = counts
    _cache["at"] = now
    return public(counts)
