"""Authentication — identify the user behind a Supabase access token.

The frontend signs in with Supabase's managed email/password auth and sends the
resulting access token as ``Authorization: Bearer <jwt>``. We verify it by asking
Supabase's Auth API who it belongs to (``GET /auth/v1/user``). That avoids having
to manage JWT secrets/algorithms ourselves and is always correct even as Supabase
rotates signing keys. The account endpoints are low-volume (save/list history),
so the extra round-trip is a non-issue.

Anonymous practice never calls anything that depends on this — login is additive.
"""

from __future__ import annotations

import httpx
from fastapi import Header, HTTPException

from . import config


async def current_user(authorization: str = Header(default="")) -> dict[str, str]:
    """FastAPI dependency: resolve the signed-in user, or 401.

    Returns ``{"id": <uuid>, "email": <str>}``.
    """
    if not config.has_supabase():
        # Accounts aren't configured on this deployment.
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")

    prefix = "bearer "
    token = authorization[len(prefix):].strip() if authorization.lower().startswith(prefix) else ""
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{config.SUPABASE_URL}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": config.SUPABASE_ANON_KEY},
            )
    except httpx.HTTPError as exc:  # network/timeout talking to Supabase
        raise HTTPException(status_code=503, detail="Couldn't reach the auth service.") from exc

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Your session expired — sign in again.")

    data = resp.json()
    uid = data.get("id")
    if not uid:
        raise HTTPException(status_code=401, detail="Your session expired — sign in again.")
    return {"id": uid, "email": data.get("email") or ""}


async def optional_user(authorization: str = Header(default="")) -> dict[str, str] | None:
    """FastAPI dependency: the signed-in user, or None if there isn't one.

    For endpoints that work logged-out but get richer with an account — the study
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
