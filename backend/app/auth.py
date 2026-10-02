"""Authentication, identify the user behind a Supabase access token.

The frontend signs in with Supabase's managed email/password auth and sends the
resulting access token as ``Authorization: Bearer <jwt>``. We verify it by asking
Supabase's Auth API who it belongs to (``GET /auth/v1/user``). That avoids having
to manage JWT secrets/algorithms ourselves and is always correct even as Supabase
rotates signing keys. The account endpoints are low-volume (save/list history),
so the extra round-trip is a non-issue.

Anonymous practice never calls anything that depends on this, login is additive.
"""

from __future__ import annotations

import hashlib
import time

import httpx
from fastapi import Header, HTTPException

from . import config, db

# Verified tokens, remembered briefly. Every account request used to start with a
# round trip to Supabase Auth before doing any work; a page that fires four
# requests paid it four times. A minute is short enough that a signed-out or
# revoked session stops working almost immediately, and the token's own expiry is
# still enforced by Supabase on the first check. Keyed by a hash, never the token.
_TOKEN_TTL = 60.0
_TOKEN_MAX = 5000
_verified: dict[str, tuple[float, dict]] = {}


async def current_user(authorization: str = Header(default="")) -> dict[str, str]:
    """FastAPI dependency: resolve the signed-in user, or 401.

    Returns ``{"id", "email", "created_at", "meta"}``.
    """
    if not config.has_supabase():
        # Accounts aren't configured on this deployment.
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")

    prefix = "bearer "
    token = authorization[len(prefix):].strip() if authorization.lower().startswith(prefix) else ""
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")

    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _verified.get(key)
    now = time.monotonic()
    if hit and hit[0] > now:
        return hit[1]

    try:
        async with db.conn() as client:
            resp = await client.get(
                f"{config.SUPABASE_URL}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": config.SUPABASE_ANON_KEY},
            )
    except httpx.HTTPError as exc:  # network/timeout talking to Supabase
        raise HTTPException(status_code=503, detail="Couldn't reach the auth service.") from exc

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Your session expired, sign in again.")

    data = resp.json()
    uid = data.get("id")
    if not uid:
        raise HTTPException(status_code=401, detail="Your session expired, sign in again.")
    # `created_at` is carried through for the founding-user reward: "signed up
    # before the cutoff" is one of its two gates, and Supabase already hands it to
    # us here, so there is no extra round-trip to pay for it.
    # `meta` is the user_metadata set at sign-up (first and last name, and a
    # chapter to register when they signed up as one); /api/me turns it into rows
    # once, see main.get_me.
    user = {
        "id": uid,
        "email": data.get("email") or "",
        "created_at": data.get("created_at") or "",
        "meta": data.get("user_metadata") or {},
    }
    if len(_verified) >= _TOKEN_MAX:
        _verified.clear()  # crude, but bounded; a miss only costs one round trip
    _verified[key] = (now + _TOKEN_TTL, user)
    return user


async def optional_user(authorization: str = Header(default="")) -> dict[str, str] | None:
    """FastAPI dependency: the signed-in user, or None if there isn't one.

    For endpoints that work logged-out but get richer with an account, the study
    course renders its path for anyone, and only overlays progress when we know who
    is asking. Deliberately never raises: on these paths a missing, expired, or
    unverifiable token just means "anonymous", because there is nothing here to
    protect, only something to add. Anything that reads or writes a user's rows must
    use ``current_user`` instead, so a bad token fails loudly rather than silently
    reading as a different (empty) user.
    """
    if not config.has_supabase() or not authorization.lower().startswith("bearer "):
        return None
    try:
        return await current_user(authorization)
    except HTTPException:
        return None
