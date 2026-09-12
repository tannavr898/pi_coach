"""Site-wide usage counters — role-plays graded, Blitz drills, scenarios written.

Three running totals, for two readers: the owner (is anyone using this?) and a
signed-out visitor on the landing page (is anyone using this?). Nothing here is
per-user, nothing identifies anyone, and nothing records WHAT was practiced — a
count is all either reader needs, the same posture as usage_counter.

WHAT COUNTS
  roleplay  a response that was actually graded (/api/score-content succeeded).
            Anonymous reps count too; the sessions table only sees signed-in ones.
  blitz     a drill that was actually graded (/api/blitz-score succeeded).
  scenario  a scenario the model freshly wrote. A cache hit is a scenario being
            REUSED, so it doesn't count — "unique scenarios" has to mean unique.

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

KINDS = ("roleplay", "blitz", "scenario")
CACHE_SECONDS = 300.0


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# The landing page shows the numbers only once there are enough to be worth
# saying. "7 role-plays graded" argues against signing up, not for it.
PUBLIC_MIN_ROLEPLAYS = _int_env("PUBLIC_STATS_MIN_ROLEPLAYS", 100)

_cache: dict = {"at": 0.0, "counts": None}


def reset_cache() -> None:
    _cache["at"] = 0.0
    _cache["counts"] = None


async def bump(kind: str) -> None:
    """Add one to a counter. Best-effort: logs and moves on if the store is down."""
    if kind not in KINDS or not config.has_supabase():
        return
    try:
        await db.bump_stat(kind)
    except httpx.HTTPError as exc:
        log.warning("stat bump failed for %s: %s", kind, exc)


def public(counts: dict[str, int]) -> dict:
    """The response shape, plus whether the landing page should show it."""
    c = {k: int(counts.get(k, 0) or 0) for k in KINDS}
    return {
        "roleplays": c["roleplay"],
        "blitzes": c["blitz"],
        "scenarios": c["scenario"],
        "show": c["roleplay"] >= PUBLIC_MIN_ROLEPLAYS,
    }


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
