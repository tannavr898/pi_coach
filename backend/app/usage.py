"""Usage enforcement — claim a session against a tier cap before doing paid work.

Two rules shape everything here.

1. NEVER TRUST THE CLIENT. The cap check and the increment happen in one atomic
   SQL statement (see `claim_usage` in supabase/schema.sql). A read-then-write
   from Python would let two concurrent requests from the same user both read
   "2 used of 3" and both proceed — which is exactly the race a vision endpoint
   can't afford.

2. NEVER DEAD-END THE USER. Hitting a cap returns a friendly message with the
   reset date and a fallback that still works, because a student who came here to
   prepare for a competition should always leave with a rep. Typed practice is
   unlimited on every tier and is the fallback we can always offer honestly.

ANONYMOUS USERS, AND WHY THEIR CAP IS CLIENT-SIDE
Rule 1 has one documented exception. For a signed-out visitor the only
server-side identifier is the IP, and this product's users are high-school
students on school networks where an entire building shares one. A per-IP cap
would lock out a whole school the moment one class started practicing together —
it would punish exactly the usage pattern we want. So anonymous voice is capped
in the browser, with three things behind it: the per-IP RATE limiter still runs
as an abuse backstop, the app-wide daily spend cap is still the hard stop, and
video — the actual cost driver — requires an account, so it is always enforced
here. The expensive path is behind a login by design.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException

from . import config, db, tiers

log = logging.getLogger("uvicorn.error")

# What a student can still do after each cap. Never an empty "you're out".
_FALLBACK = {
    "voice": "You can still practice by typing — that's unlimited.",
    "video": "You can still record a voice rep or practice by typing.",
}


class CapReached(HTTPException):
    """402-ish, but deliberately 429: the user isn't forbidden, they're early.

    We use 429 rather than 402/403 because nothing is being sold yet and nothing
    is being denied on principle — the allowance simply refills. The payload
    carries the reset date and the fallback so the UI never has to invent either.
    """

    def __init__(self, kind: str, tier: str, limit: int):
        reset = tiers.resets_on()
        noun = "video sessions" if kind == "video" else "voice sessions"
        super().__init__(
            status_code=429,
            detail=(
                f"You've used your {limit} {noun} this month. "
                f"{_FALLBACK.get(kind, '')} Your allowance resets on {reset}."
            ),
        )
        self.kind = kind
        self.tier = tier
        self.reset = reset


def tier_for(user: dict | None) -> str:
    """Which tier a caller is on.

    Everyone with an account is "free" today — Pro is announced but not
    purchasable, so there is no entitlement to read and nothing to look up. When
    billing lands, this is the single function that changes.
    """
    return "free" if user else "anonymous"


async def claim(user: dict | None, kind: str) -> tuple[str, str] | None:
    """Spend one session of `kind` for this user, or raise CapReached.

    Returns a ``(user_id, period)`` receipt the caller passes to `release` if the
    work it guarded then fails. Returns None for callers we don't meter
    server-side (anonymous — see the module docstring), so the call site can stay
    a single unconditional line.
    """
    if user is None:
        return None  # anonymous: capped client-side, backstopped by the rate limiter
    if not config.has_supabase():
        return None  # accounts aren't configured; there is no tier to enforce

    tier = tier_for(user)
    limit = tiers.limit_for(tier, kind)
    if limit == 0:
        raise CapReached(kind, tier, 0)

    period = tiers.period_key()
    try:
        count = await db.claim_usage(user["id"], period, kind, limit)
    except httpx.HTTPError as exc:
        # FAIL OPEN, LOUDLY. If the counter store is unreachable we let the
        # session through rather than blocking a student mid-practice over our
        # own outage — the app-wide daily spend cap is still the hard stop, and
        # the log line is what tells us to go fix it.
        log.warning("usage claim failed (allowing through): %s", exc)
        return None

    if count is None:
        raise CapReached(kind, tier, limit)
    return user["id"], period


async def release(receipt: tuple[str, str] | None, kind: str) -> None:
    """Return a claimed session to the allowance when the guarded work failed.

    A cap should only ever be spent on a session the student actually received.
    Best-effort: if the refund itself fails, the student is down one session and
    we've logged it — never surface a second error on top of the first.
    """
    if not receipt:
        return
    user_id, period = receipt
    try:
        await db.release_usage(user_id, period, kind)
    except httpx.HTTPError as exc:
        log.warning("usage release failed for %s/%s: %s", user_id, kind, exc)


async def summary(user: dict | None) -> dict:
    """The allowance payload the UI shows BEFORE a session starts.

    Surfacing this up front is the point: nobody should discover a limit halfway
    through a rep they've already prepared for.
    """
    tier = tier_for(user)
    period = tiers.period_key()
    counts: dict[str, int] = {}

    if user and config.has_supabase():
        try:
            counts = await db.get_usage(user["id"], period)
        except httpx.HTTPError as exc:
            log.warning("usage summary failed: %s", exc)

    def block(kind: str) -> dict:
        used = counts.get(kind, 0)
        return {
            "used": used,
            "limit": tiers.limit_for(tier, kind),
            "remaining": tiers.remaining(tier, kind, used),
        }

    founder = False
    if user and config.has_supabase():
        try:
            founder = tiers.founder_eligible(
                user.get("created_at"), await db.count_sessions(user["id"])
            )
        except httpx.HTTPError:
            founder = False

    return {
        "tier": tier,
        "period": period,
        "resets_on": tiers.resets_on(),
        "voice": block("voice"),
        "video": block("video"),
        # Typed practice is unlimited on every tier and always will be — it costs
        # us essentially nothing, and it's the fallback every cap message points
        # at, so it has to be true.
        "typed_unlimited": True,
        "video_beta": True,
        "founder_eligible": founder,
        "founder_reward": tiers.FOUNDER_REWARD,
        "founder_min_roleplays": tiers.FOUNDER_MIN_ROLEPLAYS,
    }
