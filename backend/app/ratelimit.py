"""Minimal per-IP rate limit for the paid LLM endpoints.

Roadmap §9 says install rate limiting *before* wiring up a paid API — a runaway
loop or abuse is the real cost risk, not normal use. This is a small in-memory
fixed-window limiter, enough for a single-process MVP. (The hard spend cap lives
in the provider console; this is the second layer.)
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_WINDOW_SECONDS = 60
_MAX_PER_WINDOW = 20

_hits: dict[str, deque[float]] = defaultdict(deque)


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
