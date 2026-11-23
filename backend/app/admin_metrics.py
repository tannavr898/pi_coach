"""The owner dashboard's numbers: how many people, how much practice, and when.

Everything here is counts. No emails, no names, no content: the dashboard answers
"is anyone using this, and did something spike", not "who did what".

WHERE EACH SERIES COMES FROM
  signups        Supabase Auth account creation times
  active_users   distinct signed-in people with a role-play or a study activity that day
  roleplays      the daily counter (every graded rep, signed out too), floored at the
                 saved sessions, which is all that survives from before the counter
  scenarios      the daily counter, floored at scenarios cached that day
  blitzes        the daily counter, floored at saved Blitz activity
  quizzes        the daily counter, floored at saved quiz activity
  questions      the daily counter (browser reported)
  cards          the daily counter (browser reported)
  diagnostics    finished starting-point quizzes (signed in)
  chapters       chapters registered
  chapter_joins  students and managers who asked to join a chapter
  avg_score      mean content score of that day's saved role-plays

The counter table starts the day the owner runs its SQL, so older days are
rebuilt from the timestamped tables instead; taking the larger of the two keeps a
day from being counted twice while never reporting less than what is on record.

Days are UTC, matching how the counter buckets them.
"""

from __future__ import annotations

import logging
import statistics
import time
from datetime import date, datetime, timedelta, timezone

import httpx

from . import admin_samples, config, db, scenario_cache

log = logging.getLogger("uvicorn.error")

RANGES = (7, 30, 90, 180, 365)
CACHE_SECONDS = 60.0

# key -> (label, how a day's value combines). "sum" series add up; "avg" series
# average, so a day with no data is a gap (None) rather than a zero.
SERIES: dict[str, tuple[str, str]] = {
    "signups": ("New accounts", "sum"),
    "active_users": ("Active signed-in users", "sum"),
    "roleplays": ("Role-plays graded", "sum"),
    "scenarios": ("Scenarios written", "sum"),
    "blitzes": ("Blitz drills", "sum"),
    "quizzes": ("Quizzes finished", "sum"),
    "questions": ("Quiz questions answered", "sum"),
    "cards": ("Flashcards flipped", "sum"),
    "diagnostics": ("Diagnostics finished", "sum"),
    "chapters": ("Chapters registered", "sum"),
    "chapter_joins": ("Chapter join requests", "sum"),
    "avg_score": ("Average role-play score", "avg"),
}

_cache: dict[int, tuple[float, dict]] = {}


def _day(ts: str | None) -> str | None:
    """The UTC calendar day of an ISO timestamp, or None if it is not one."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).date().isoformat()


def _days(start: date, end: date) -> list[str]:
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def spikes(values: list[float | None]) -> list[int]:
    """Indexes of days well above this series' own normal: at least two standard
    deviations over the mean, and at least 3 so a quiet series isn't all spikes."""
    nums = [v for v in values if v is not None]
    if len(nums) < 5:
        return []
    mean = statistics.fmean(nums)
    sd = statistics.pstdev(nums)
    if sd == 0:
        return []
    return [i for i, v in enumerate(values) if v is not None and v >= 3 and v >= mean + 2 * sd]


def build(days: int, *, today: date, sessions: list[dict], activity: list[dict], scenarios: list[dict],
          diagnostics: list[dict], chapters: list[dict], members: list[dict], daily: list[dict],
          users: list[dict] | None, cache: dict | None = None, pending_chapters: int = 0) -> dict:
    """Assemble the dashboard payload from raw rows. Pure, so it can be tested."""
    start = today - timedelta(days=days - 1)
    prev_start = start - timedelta(days=days)
    axis = _days(start, today)
    prev_axis = _days(prev_start, start - timedelta(days=1))
    both = set(axis) | set(prev_axis)

    def count_by_day(rows: list[dict], field: str = "created_at", pred=None) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in rows:
            if pred and not pred(r):
                continue
            d = _day(r.get(field))
            if d in both:
                out[d] = out.get(d, 0) + 1
        return out

    real_sessions = [s for s in sessions if (s.get("event") or "") != admin_samples.SAMPLE_EVENT]
    counter: dict[str, dict[str, int]] = {}
    for r in daily:
        counter.setdefault(r["kind"], {})[str(r["day"])] = int(r["count"] or 0)

    def floored(kind: str, recorded: dict[str, int]) -> dict[str, int]:
        have = counter.get(kind, {})
        return {d: max(have.get(d, 0), recorded.get(d, 0)) for d in both}

    active: dict[str, set] = {}
    for r in real_sessions + activity:
        d = _day(r.get("created_at"))
        if d in both and r.get("user_id"):
            active.setdefault(d, set()).add(str(r["user_id"]))

    score_sum: dict[str, float] = {}
    score_n: dict[str, int] = {}
    for s in real_sessions:
        d = _day(s.get("created_at"))
        if d in both and s.get("content_score") is not None:
            score_sum[d] = score_sum.get(d, 0.0) + float(s["content_score"])
            score_n[d] = score_n.get(d, 0) + 1

    by_kind = lambda k: (lambda r: r.get("kind") == k)  # noqa: E731
    per_day: dict[str, dict[str, float | int | None]] = {
        "signups": count_by_day(users or [], "created_at"),
        "active_users": {d: len(v) for d, v in active.items()},
        "roleplays": floored("roleplay", count_by_day(real_sessions)),
        "scenarios": floored("scenario", count_by_day(scenarios)),
        "blitzes": floored("blitz", count_by_day(activity, pred=by_kind("blitz"))),
        "quizzes": floored("quiz", count_by_day(activity, pred=by_kind("quiz"))),
        "questions": {d: counter.get("question", {}).get(d, 0) for d in both},
        "cards": {d: counter.get("card", {}).get(d, 0) for d in both},
        "diagnostics": count_by_day(diagnostics),
        "chapters": count_by_day(chapters),
        "chapter_joins": count_by_day(members, "requested_at"),
        "avg_score": {d: round(score_sum[d] / score_n[d], 1) for d in score_n},
    }

    series: dict[str, dict] = {}
    for key, (label, how) in SERIES.items():
        src = per_day[key]
        vals = [src.get(d) if how == "avg" else int(src.get(d, 0) or 0) for d in axis]
        prev_vals = [src.get(d) if how == "avg" else int(src.get(d, 0) or 0) for d in prev_axis]
        nums = [v for v in vals if v is not None]
        prev_nums = [v for v in prev_vals if v is not None]
        if how == "avg":
            total = round(statistics.fmean(nums), 1) if nums else None
            prev_total = round(statistics.fmean(prev_nums), 1) if prev_nums else None
        else:
            total, prev_total = sum(nums), sum(prev_nums)
        peak_i = max(range(len(vals)), key=lambda i: (vals[i] is not None, vals[i] or 0)) if nums else None
        series[key] = {
            "label": label, "kind": how, "values": vals, "total": total, "prev_total": prev_total,
            "peak": {"day": axis[peak_i], "n": vals[peak_i]} if peak_i is not None and vals[peak_i] else None,
            "spikes": spikes(vals),
        }

    # Total accounts over time: the count before the window, then each day's signups.
    created = [d for d in (_day(u.get("created_at")) for u in (users or [])) if d]
    running = sum(1 for d in created if d < axis[0])
    cumulative = []
    for i, d in enumerate(axis):
        running += int(series["signups"]["values"][i] or 0)
        cumulative.append(running)

    ago = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    seen_ever = {str(r["user_id"]) for r in real_sessions + activity if r.get("user_id")}
    last_active: dict[str, str] = {}
    for r in real_sessions + activity:
        d = _day(r.get("created_at"))
        if d and r.get("user_id"):
            u = str(r["user_id"])
            last_active[u] = max(last_active.get(u, ""), d)
    wau = sum(1 for d in last_active.values() if d > ago(7))
    mau = sum(1 for d in last_active.values() if d > ago(30))

    events: dict[str, int] = {}
    for s in real_sessions:
        d = _day(s.get("created_at"))
        if d in axis and s.get("event"):
            events[s["event"]] = events.get(s["event"], 0) + 1
    top_events = [{"event": e, "n": n} for e, n in sorted(events.items(), key=lambda kv: -kv[1])[:8]]

    lifetime = {k: sum(v.values()) for k, v in counter.items()}
    return {
        "days": days,
        "axis": axis,
        "series": series,
        "cumulative_users": cumulative,
        "totals": {
            "users": len(users) if users is not None else None,
            "ever_active": len(seen_ever),
            "wau": wau,
            "mau": mau,
            "pending_chapters": pending_chapters,
            "counter_since": min((r["day"] for r in daily), default=None),
            "lifetime_counted": lifetime,
        },
        "top_events": top_events,
        "cache": cache,
        "notes": ([] if users is not None else ["Account signups are unavailable: Supabase Auth did not answer."]),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


async def overview(days: int, *, fresh: bool = False) -> dict:
    """The dashboard payload for the last `days` days (and the same span before it,
    for the change-over-previous-period arrows). Cached for a minute."""
    days = max(1, min(days, 365))
    hit = _cache.get(days)
    if hit and not fresh and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    today = datetime.now(timezone.utc).date()
    since = (today - timedelta(days=days * 2)).isoformat()
    by = {"order": "created_at.asc"}

    async def users() -> list[dict] | None:
        try:
            return await db.list_auth_users()
        except httpx.HTTPError as exc:
            log.warning("admin overview: auth users unavailable: %s", exc)
            return None

    sessions = await db._get_all("sessions", {"select": "user_id,created_at,event,content_score",
                                              "created_at": f"gte.{since}", **by})
    activity = await db._get_all("activity_event", {"select": "user_id,kind,created_at", "created_at": f"gte.{since}", **by})
    scenarios = await db._get_all("cached_scenario", {"select": "created_at", "created_at": f"gte.{since}", **by})
    diagnostics = await db._get_all("diagnostic_result", {"select": "created_at", "created_at": f"gte.{since}", **by})
    chapters = await db._get_all("chapter", {"select": "created_at", "created_at": f"gte.{since}", **by})
    members = await db._get_all("chapter_member", {"select": "requested_at", "requested_at": f"gte.{since}",
                                                   "order": "requested_at.asc"})
    daily = await db.list_stat_daily(since)
    try:
        pending = len(await db.list_chapters_by_status("pending"))
    except httpx.HTTPError:
        pending = 0

    out = build(days, today=today, sessions=sessions, activity=activity, scenarios=scenarios,
                diagnostics=diagnostics, chapters=chapters, members=members, daily=daily,
                users=await users(), cache={**scenario_cache.stats(), "enabled": scenario_cache.enabled()},
                pending_chapters=pending)
    _cache[days] = (time.monotonic(), out)
    return out
