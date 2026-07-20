"""Tier definitions and monthly allowances.

DESIGN INTENT (worth stating, because it explains every number below): the goal
right now is COST PROTECTION, not revenue. A hard usage cap protects margin just
as well as a paywall and is a fraction of the work, so billing is deliberately
not built. What ships now is the tier STRUCTURE and the messaging, so that paid
tiers are never a surprise to someone who has been using the product for months.

Everything is env-overridable and nothing is hardcoded at a call site, because
these numbers are guesses until there is real usage data to price against. Tuning
them must not require a deploy.

WHAT GETS CAPPED, AND WHY IT'S VIDEO
Measured per-session cost splits three ways:
  - typed practice      ~free      -> unlimited on every tier, forever
  - voice (transcribe)  ~$0.13-.26 -> generously capped
  - video (vision)      ~2-3x voice -> tightly capped, beta-gated
Video is the cost driver, so video is what carries the tightest cap. Typed
practice is never capped at all: a student who hits a limit must always still
have a way to keep practicing, and the free path is the honest one to leave open.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from typing import Literal

Tier = Literal["anonymous", "free", "pro"]

# Sentinel for "no cap". Kept explicit rather than using None so the comparison
# at the enforcement site stays a plain `used >= limit` with no special cases.
UNLIMITED = -1


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# Monthly allowances per tier. Typed practice is absent from this table on
# purpose — it is unlimited everywhere and has nothing to look up.
LIMITS: dict[str, dict[str, int]] = {
    # Signed out. A real taste of the voice loop, then a reason to make an
    # account. NOTE: anonymous limits are enforced CLIENT-side (see usage.py) —
    # this entry exists so the UI can show the same numbers the client enforces.
    "anonymous": {
        "voice": _int_env("CAP_ANON_VOICE", 2),
        "video": _int_env("CAP_ANON_VIDEO", 0),  # video always requires an account
    },
    # Free account. Enough voice reps to actually prepare for a competition, plus
    # a real (if small) taste of video while it's in beta.
    "free": {
        "voice": _int_env("CAP_FREE_VOICE", 8),
        "video": _int_env("CAP_FREE_VIDEO", 3),
    },
    # Announced, not purchasable. No checkout, no Stripe, no subscription
    # management — see the module docstring.
    "pro": {
        "voice": _int_env("CAP_PRO_VOICE", UNLIMITED),
        "video": _int_env("CAP_PRO_VIDEO", UNLIMITED),
    },
}

# --- founding-user reward --------------------------------------------------
# Rewards the people who used the product before it had paid tiers. Two gates,
# both cheap to check and both honest: they signed up before the cutoff, AND they
# actually used it. "Signed up early" alone would reward a dormant account.

FOUNDER_CUTOFF = os.getenv("FOUNDER_CUTOFF", "2026-12-31")
FOUNDER_MIN_ROLEPLAYS = _int_env("FOUNDER_MIN_ROLEPLAYS", 5)
FOUNDER_REWARD = os.getenv("FOUNDER_REWARD", "first month of Pro free")


def period_key(now: datetime | None = None) -> str:
    """The usage bucket a request counts against: a UTC calendar month.

    Calendar months (not rolling 30-day windows) because "resets on the 1st" is a
    promise a student can hold in their head, and the reset date we show them has
    to be a date they can actually plan a practice week around.
    """
    n = now or datetime.now(timezone.utc)
    return f"{n.year:04d}-{n.month:02d}"


def resets_on(now: datetime | None = None) -> str:
    """ISO date the current period rolls over — shown with every cap message, so
    hitting a limit always comes with a "you're back on ___" rather than a wall."""
    n = now or datetime.now(timezone.utc)
    y, m = (n.year + 1, 1) if n.month == 12 else (n.year, n.month + 1)
    return date(y, m, 1).isoformat()


def limit_for(tier: str, kind: str) -> int:
    """This tier's monthly allowance for a session kind, or UNLIMITED."""
    return LIMITS.get(tier, LIMITS["anonymous"]).get(kind, 0)


def remaining(tier: str, kind: str, used: int) -> int:
    """Sessions left this month. UNLIMITED passes straight through so the UI can
    render "Unlimited" rather than a number."""
    cap = limit_for(tier, kind)
    if cap == UNLIMITED:
        return UNLIMITED
    return max(0, cap - used)


def founder_eligible(created_at: str | None, roleplay_count: int) -> bool:
    """Whether this account has earned the founding-user reward.

    Both gates must pass: signed up before the cutoff, and completed enough
    role-plays to have genuinely used the thing. Loyalty, not just timing.
    """
    if roleplay_count < FOUNDER_MIN_ROLEPLAYS:
        return False
    if not created_at:
        return False
    try:
        # Supabase returns ISO-8601 with a trailing Z; fromisoformat wants +00:00.
        signed_up = datetime.fromisoformat(created_at.replace("Z", "+00:00")).date()
    except ValueError:
        return False
    try:
        cutoff = date.fromisoformat(FOUNDER_CUTOFF)
    except ValueError:
        return False
    return signed_up <= cutoff
