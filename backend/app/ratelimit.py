"""Minimal per-IP rate limit for the paid LLM endpoints.

Roadmap §9 says install rate limiting *before* wiring up a paid API — a runaway
loop or abuse is the real cost risk, not normal use. This is a small in-memory
fixed-window limiter, enough for a single-process MVP. (The hard spend cap lives
in the provider console; this is the second layer.)
"""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from fastapi import HTTPException, Request

# Per-IP burst limit (fixed window). Tunable via env for a public deployment.
_WINDOW_SECONDS = 60
_MAX_PER_WINDOW = int(os.getenv("RATE_LIMIT_PER_MIN", "20"))

# App-level daily budget guard. A public URL means anyone can spend your provider
# credits; the provider spend cap is a hard stop, but this degrades gracefully
# *before* that — returning a friendly message once the day's paid-call ceiling
# is reached. 0 disables it (e.g. local dev). Resets at UTC midnight.
_DAILY_CAP = int(os.getenv("DAILY_REQUEST_CAP", "0"))

_hits: dict[str, deque[float]] = defaultdict(deque)
_day = {"date": None, "count": 0}


def rate_limit(request: Request) -> None:
    """FastAPI dependency: raise 429 if this client is over the window limit."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    dq = _hits[ip]
    while dq and dq[0] <= now - _WINDOW_SECONDS:
        dq.popleft()
    if len(dq) >= _MAX_PER_WINDOW:
        raise HTTPException(
            status_code=429,
            detail="You're going a bit fast — wait a moment and try again.",
        )
    dq.append(now)


def daily_cap(request: Request) -> None:
    """FastAPI dependency: cap total paid calls per UTC day (wallet protection).

    Layered with the provider spend cap (the hard stop) and the per-IP limiter
    (burst control). Disabled when DAILY_REQUEST_CAP is 0/unset.
    """
    if _DAILY_CAP <= 0:
        return
    today = datetime.now(timezone.utc).date()
    if _day["date"] != today:
        _day["date"] = today
        _day["count"] = 0
    if _day["count"] >= _DAILY_CAP:
        raise HTTPException(
            status_code=503,
            detail="PI Coach has hit today's practice limit. Please try again tomorrow.",
        )
    _day["count"] += 1
