"""Scenario caching — serve an already-generated role-play instead of paying to
write a new one.

Two things motivated this, and they pull in the same direction:

  - COST. A fresh scenario is a paid generation call on top of the interpretation
    call. Reuse removes it entirely on a hit.
  - ACTIVATION. Generation is several seconds of loader before a first-time
    visitor has seen anything worth waiting for. A cache hit makes the scenario
    appear immediately, which is the difference between "this is a real product"
    and "this is slow".

Nothing here is allowed to break the practice loop. Every call site treats the
cache as advisory: any failure (Supabase down, malformed row, no pool yet) falls
through to normal generation. That is why the helpers below swallow their own
errors rather than raising — a caching problem must never become a user problem.

--------------------------------------------------------------------------
THE CACHE KEY
--------------------------------------------------------------------------
The user's request is free text, so the raw string is a useless key: "marketing
for a restaurant", "restaurant marketing", and "how do I market a restaurant"
are the same request and would be three different keys with zero hits between
them.

So we key on the INTERPRETED result — but only on the parts that exist BEFORE
generation runs:

    level | sorted(domain_ids) | event_id

Two notes on what is deliberately absent:

  - CRITERIA are not in the key. The brief calls for them, but the criteria are
    selected by the model as PART of generation — at lookup time we have not run
    generation yet, so they cannot be known. What we do know is the candidate
    POOL the criteria will be drawn from, which is exactly `domain_ids`. Two
    requests with the same domains at the same level draw from the same pool and
    are genuinely interchangeable, so the pool is the honest key. The realized
    criteria are stored on the row as an attribute for auditing and invalidation.

  - INDUSTRY / TOPIC are not in the key either, because they are model-authored
    free text ("Marketing strategy", "restaurant marketing", "marketing for a
    QSR") and would re-fragment the key space we just finished collapsing.
    Industry is stored as a normalized secondary attribute and used by the
    serving gate below.

--------------------------------------------------------------------------
THE SERVING GATE
--------------------------------------------------------------------------
Reuse is only free if the reused scenario still answers the question that was
asked. That is true in one case and conditional in the other:

  - NO FREE-TEXT FOCUS ("just give me a Marketing rep"). The user expressed no
    preference beyond the event, so any scenario under the key is a correct
    answer. Serve any unseen one. This is also the prefetch path — by far the
    most common — so it is where the savings actually land.

  - WITH FREE-TEXT FOCUS ("marketing for a restaurant"). They asked for
    something specific. Handing back a gym scenario because it shares a domain
    would be a visible quality regression, so we only serve a cached scenario
    whose `industry_hint` matches what we interpreted. No match means we
    generate fresh — and that fresh scenario joins the pool tagged with its
    industry, so the NEXT restaurant request hits.

Cost control that degrades the product isn't cost control, it's just a worse
product with a smaller bill.
"""

from __future__ import annotations

import logging
import re

import httpx

from . import config, db

log = logging.getLogger("uvicorn.error")

# Cap the pool per key. Past this, a key is deep enough that a user will exhaust
# their own `seen` list long before they exhaust the pool, and further generation
# is spend with no variety left to buy.
MAX_PER_KEY = 25

# Words that carry no distinguishing signal in an industry phrase — dropping them
# is what makes "a restaurant", "restaurants", and "the restaurant business" all
# normalize to the same token.
_STOPWORDS = {"a", "an", "the", "business", "businesses", "company", "companies",
              "industry", "general", "shop", "store", "brand", "of", "for", "in"}


# Hit-rate counters. In-process and reset on restart, which is fine for what
# they're for: answering "is the cache actually earning its complexity?" during
# a deploy's lifetime. A savings claim nobody can check is just a hope, and this
# is the number that decides whether the warmer below is ever worth building.
_STATS = {"hits": 0, "misses": 0, "stored": 0}


def stats() -> dict:
    """Cache effectiveness, for the admin QA page and the logs."""
    total = _STATS["hits"] + _STATS["misses"]
    return {
        **_STATS,
        "lookups": total,
        "hit_rate_percent": round(_STATS["hits"] / total * 100, 1) if total else 0.0,
    }


def enabled() -> bool:
    """The cache needs Supabase. Without it we simply always generate fresh."""
    return config.has_supabase()


def build_key(level: str, domain_ids: list[str], event_id: str) -> str:
    """The cache key: level | sorted domains | event.

    Sorting the domains is the load-bearing part — the interpreter returns them in
    whatever order the model emitted, so two identical requests would otherwise
    produce two different keys and never collide.
    """
    domains = "+".join(sorted(d.strip().lower() for d in domain_ids if d.strip()))
    return f"{level.strip().lower()}|{domains}|{(event_id or '').strip().lower()}"


def normalize_context(industry: str) -> str:
    """Reduce a free-text industry to a comparable token.

    "a fast-casual Restaurant" / "restaurants" / "the restaurant business" all
    become "fast-casual restaurant" / "restaurant" / "restaurant". Crude stemming
    (trailing "s") is deliberate: over-matching here costs a slightly-off industry
    flavor, while under-matching costs a cache miss, and the first is much cheaper
    than the second.
    """
    words = re.findall(r"[a-z0-9-]+", (industry or "").lower())
    kept = [w.rstrip("s") if len(w) > 3 and w.endswith("s") else w
            for w in words if w not in _STOPWORDS]
    return " ".join(kept[:4])


async def lookup(
    *,
    cache_key: str,
    seen_ids: list[str],
    user_id: str | None,
    want_context: str,
    strict_context: bool,
) -> dict | None:
    """Find a servable cached scenario, or None to fall through to generation.

    `strict_context` is the serving gate described in the module docstring: True
    when the user typed a free-text focus (only an industry-matching scenario will
    do), False when they didn't (anything under the key is a correct answer).

    Returns ``{"id": ..., "scenario": {...}}`` on a hit.
    """
    if not enabled():
        return None
    try:
        rows = await db.list_cached_scenarios(cache_key, limit=MAX_PER_KEY)
        if not rows:
            _STATS["misses"] += 1
            return None

        # A user must never see the same scenario twice. Anonymous users carry
        # their own history from localStorage; signed-in users get theirs joined
        # from the server, so it survives a new browser or a cleared cache.
        blocked = {str(s) for s in seen_ids}
        if user_id:
            try:
                blocked.update(str(s) for s in await db.list_seen_scenarios(user_id))
            except httpx.HTTPError as exc:
                # Can't prove what they've seen -> don't risk a repeat. Generating
                # fresh costs money; serving a duplicate costs trust.
                log.warning("seen lookup failed, skipping cache: %s", exc)
                _STATS["misses"] += 1
                return None

        available = [r for r in rows if str(r.get("id")) not in blocked]
        if not available:
            _STATS["misses"] += 1
            return None

        if strict_context:
            available = [r for r in available if r.get("industry_hint") == want_context]
            if not available:
                _STATS["misses"] += 1
                return None
        elif want_context:
            # Not a requirement, just a preference: float an industry match to the
            # front if one happens to be there, otherwise take the least-served.
            available.sort(key=lambda r: r.get("industry_hint") != want_context)

        hit = available[0]
        scenario = hit.get("scenario_json")
        if not isinstance(scenario, dict) or not scenario.get("situation"):
            # A row that can't render is worse than no row — it would 500 the loop.
            # Drop it rather than serve it, and generate instead.
            log.warning("dropping malformed cached scenario %s", hit.get("id"))
            await _safe_delete(str(hit["id"]))
            _STATS["misses"] += 1
            return None
        _STATS["hits"] += 1
        return {"id": str(hit["id"]), "scenario": scenario}
    except httpx.HTTPError as exc:
        log.warning("scenario cache lookup failed: %s", exc)
        _STATS["misses"] += 1
        return None


async def get_by_id(scenario_id: str) -> dict | None:
    """Fetch one pooled scenario by id for a shared challenge link.

    Unlike `lookup`, this bypasses the variety machinery entirely — no cache key,
    no least-served ordering, no `seen` filter. Someone following a friend's
    challenge must land on THAT role-play, even one they've already played.

    Returns ``{"id": ..., "scenario": {...}}`` or None.
    """
    if not enabled():
        return None
    try:
        row = await db.get_cached_scenario(scenario_id)
    except httpx.HTTPError as exc:
        log.warning("scenario by-id lookup failed: %s", exc)
        return None
    if not row:
        return None
    scenario = row.get("scenario_json")
    if not isinstance(scenario, dict) or not scenario.get("situation"):
        log.warning("challenge link hit a malformed scenario %s", scenario_id)
        return None
    return {"id": str(row["id"]), "scenario": scenario}


async def record_served(scenario_id: str) -> None:
    """Bump a cached scenario's serve counter.

    NOTE what this deliberately does NOT do: it does not mark the scenario as
    seen by the user. The client PREFETCHES a scenario the moment an event is
    picked, before the student has committed to it — so "served" and "seen" are
    genuinely different events. Marking seen here would burn a pool entry every
    time someone flipped between events, permanently, for a role-play they never
    laid eyes on. Seen is recorded by `mark_seen` when the client confirms it
    actually put the scenario on screen.

    Runs as a background task — the user already has their scenario, and this
    counter should never be able to delay or fail delivering it.
    """
    if not enabled():
        return
    try:
        await db.bump_scenario_served(scenario_id)
    except httpx.HTTPError as exc:
        log.warning("scenario cache serve counter failed: %s", exc)


async def mark_seen(scenario_id: str, user_id: str) -> None:
    """Record that a user actually SAW a scenario (client-confirmed on display).

    This is what makes "never the same role-play twice" survive a new device or a
    cleared browser. Anonymous users have no server-side history to write, so
    theirs lives in localStorage and this is simply never called for them.
    """
    if not enabled():
        return
    try:
        await db.mark_scenario_seen(user_id, scenario_id)
    except httpx.HTTPError as exc:
        log.warning("scenario seen marking failed: %s", exc)


async def store(
    *,
    cache_key: str,
    level: str,
    event_id: str,
    domain_ids: list[str],
    criteria_ids: list[str],
    industry_hint: str,
    sampling_signature: str,
    scenario_json: dict,
) -> str | None:
    """Add a freshly generated scenario to the pool, so the next user gets it free.

    QUALITY GUARD: a cached scenario is served to many people, so a bad one is
    amplified rather than absorbed. Only scenarios that already passed the
    caller's validation reach this function, and we re-check the two invariants
    that would break rendering or grading — a non-empty situation and the exact
    criteria count — before anything is written. This is also the reason the pool
    can only grow through this one door.

    Returns the new scenario's id (so the caller can attribute it to the user),
    or None if it wasn't cached.
    """
    if not enabled():
        return None
    if not scenario_json.get("situation") or not criteria_ids:
        return None
    try:
        if await db.count_cached_scenarios(cache_key) >= MAX_PER_KEY:
            return None  # pool is deep enough; stop spending to widen it
        row = await db.insert_cached_scenario({
            "cache_key": cache_key,
            "level": level,
            "event_id": event_id or "",
            "domain_ids": domain_ids,
            "criteria_ids": criteria_ids,
            "industry_hint": industry_hint,
            "sampling_signature": sampling_signature or "",
            "scenario_json": scenario_json,
            "times_served": 1,  # this generation IS its first serve
        })
        _STATS["stored"] += 1
        # Seen is NOT recorded here — same reason as in `record_served`: a
        # prefetched generation may never reach the screen.
        return str(row.get("id")) if row else None
    except httpx.HTTPError as exc:
        log.warning("scenario cache store failed: %s", exc)
        return None


async def _safe_delete(scenario_id: str) -> None:
    try:
        await db.delete_cached_scenario(scenario_id)
    except httpx.HTTPError:
        pass
