"""Spend guards for the paid endpoints: a per-IP burst limit and an app-wide
daily ceiling.

Roadmap §9 says install rate limiting *before* wiring up a paid API — a runaway
loop or abuse is the real cost risk, not normal use. This is a small in-memory
fixed-window limiter, enough for a single-process MVP. (The hard spend cap lives
in the provider console; this is the second layer.)

TWO RULES SHAPE THE NUMBERS HERE, AND BOTH COME FROM WHO USES THIS APP.

1. CAP THE START OF WORK, NEVER THE FINISH. A role-play spends across three
   calls: generate the scenario, transcribe the recording, grade the content. A
   guard that fires on the first one costs a student nothing — they pick another
   moment and start over. A guard that fires on the *last* one destroys a rep
   they have already prepared for, recorded, and submitted, after we already paid
   for the expensive half. It also saves nothing: the tokens were spent two calls
   ago. So the guards below are deliberately asymmetric. New work is gated
   tightly; work already in flight is allowed to finish, and only a ceiling far
   above any legitimate session turns it away.

2. A SHARED SCHOOL IP IS NOT ABUSE. These are high-school students, and a class
   practicing together comes from one building on one NAT'd address. Thirty
   students starting a rep in the same minute is the usage pattern this product
   exists for, and at the old 20/min it read as a single abusive client — the
   whole classroom got "you're going a bit fast", mid-rep, at submit. The burst
   limit is now set for a classroom rather than for one person, which still stops
   a scripted loop (those run orders of magnitude faster) without punishing the
   room. The app-wide daily cap and the provider's own spend cap remain the
   actual wallet protection; per-IP is only burst smoothing.
"""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from fastapi import HTTPException, Request

# Per-IP burst limit (fixed window) for endpoints that START paid work.
# Sized for a shared classroom NAT, not a single browser — see rule 2 above.
_WINDOW_SECONDS = 60
_MAX_PER_WINDOW = int(os.getenv("RATE_LIMIT_PER_MIN", "120"))

# The ceiling for endpoints that FINISH work already paid for. Far enough above
# the start limit that no honest session can reach it, so a submit is never the
# call that gets refused, while a genuine runaway still terminates.
_COMPLETION_MULTIPLIER = 4

# App-level daily budget guard. A public URL means anyone can spend your provider
# credits; the provider spend cap is a hard stop, but this degrades gracefully
# *before* that — returning a friendly message once the day's paid-call ceiling
# is reached. 0 disables it (e.g. local dev). Resets at UTC midnight.
_DAILY_CAP = int(os.getenv("DAILY_REQUEST_CAP", "0"))

# How far past the daily cap a session already under way may go to finish. Reps
# in flight when the cap lands are allowed to complete rather than being thrown
# away — see rule 1. Sized to drain the in-flight work, not to extend the day.
_DAILY_GRACE = 1.25

_hits: dict[str, deque[float]] = defaultdict(deque)
_day = {"date": None, "count": 0}


def _record(request: Request, ceiling: int) -> None:
    """Shared fixed-window bookkeeping: prune, check against `ceiling`, record."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    dq = _hits[ip]
    while dq and dq[0] <= now - _WINDOW_SECONDS:
        dq.popleft()
    if len(dq) >= ceiling:
        raise HTTPException(
            status_code=429,
            detail="You're going a bit fast — wait a moment and try again.",
        )
    dq.append(now)

    # Drop IPs whose window has fully drained. Without this the dict grows one
    # entry per address forever, which on a long-lived instance is a slow leak
    # rather than a bounded cache.
    if len(_hits) > 512:
        for key in [k for k, v in _hits.items() if not v or v[-1] <= now - _WINDOW_SECONDS]:
            del _hits[key]


def rate_limit(request: Request) -> None:
    """FastAPI dependency for endpoints that START paid work: 429 over the limit."""
    _record(request, _MAX_PER_WINDOW)


def rate_limit_completion(request: Request) -> None:
    """FastAPI dependency for endpoints that FINISH work already paid for.

    Same window, much higher ceiling. This is the guard on transcription and
    grading — the two calls a student reaches only after recording a rep — so it
    exists to stop a runaway, not to decide whether a submitted rep gets graded.
    """
    _record(request, _MAX_PER_WINDOW * _COMPLETION_MULTIPLIER)


def _bump_day() -> int:
    """Roll the counter to today if needed, increment, and return the new count."""
    today = datetime.now(timezone.utc).date()
    if _day["date"] != today:
        _day["date"] = today
        _day["count"] = 0
    _day["count"] += 1
    return _day["count"]


def daily_cap(request: Request) -> None:
    """FastAPI dependency: cap total paid calls per UTC day (wallet protection).

    Layered with the provider spend cap (the hard stop) and the per-IP limiter
    (burst control). Disabled when DAILY_REQUEST_CAP is 0/unset.
    """
    if _DAILY_CAP <= 0:
        return
    if _day["date"] == datetime.now(timezone.utc).date() and _day["count"] >= _DAILY_CAP:
        raise HTTPException(
            status_code=503,
            detail=(
                "PI Coach has hit today's practice limit. Typed practice is "
                "unlimited — or try a role-play again tomorrow."
            ),
        )
    _bump_day()


def daily_cap_completion(request: Request) -> None:
    """Daily cap for endpoints that finish a session already under way.

    Still counted against the day — this is not a loophole around the budget —
    but allowed a grace band above the ceiling so that reps recorded just before
    the cap landed still get graded. Refusing here would throw away a student's
    recording to save money we have already spent.
    """
    if _DAILY_CAP <= 0:
        return
    ceiling = int(_DAILY_CAP * _DAILY_GRACE)
    if _day["date"] == datetime.now(timezone.utc).date() and _day["count"] >= ceiling:
        raise HTTPException(
            status_code=503,
            detail=(
                "PI Coach has hit today's practice limit, so we can't grade this "
                "one right now. Your recording is still on this page — try again "
                "tomorrow, or practice by typing, which is unlimited."
            ),
        )
    _bump_day()
