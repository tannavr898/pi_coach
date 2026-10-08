"""Persistence for logged-in users, a thin async wrapper over Supabase's REST
(PostgREST) API, using the SECRET service-role key (backend-only).

We deliberately avoid an ORM/DB driver: httpx is already a dependency (it talks
to AssemblyAI), and the data shape is a single flat table. Every query is scoped
by ``user_id`` here in code; Row-Level Security on the table is a second line of
defense. Only completed sessions for signed-in users are ever written, the
anonymous practice loop never touches this module.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

import httpx

from . import config

# One pooled connection to Supabase, reused by every query.
#
# Opening a fresh client per call meant a new TCP + TLS handshake every time:
# measured at ~440 ms a query against ~60 ms on a warm connection. A page that
# makes six queries in a row (the Chapter tab) paid that six times over. The
# client is per event loop because an httpx client is bound to the loop it was
# created on (tests run each request on a fresh loop).
_client: httpx.AsyncClient | None = None
_client_loop: asyncio.AbstractEventLoop | None = None


def _shared() -> httpx.AsyncClient:
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=20.0,
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20, keepalive_expiry=60.0),
        )
        _client_loop = loop
    return _client


@asynccontextmanager
async def conn() -> AsyncIterator[httpx.AsyncClient]:
    """The shared client, shaped like `async with httpx.AsyncClient() as c` so
    call sites read the same; leaving the block does NOT close it."""
    yield _shared()

# Columns needed to render the "recent sessions" list without shipping the big
# jsonb blobs. PostgREST lets us pull nested jsonb fields with an alias.
SUMMARY_SELECT = (
    "id,created_at,event,content_score,filler_per_min,pace_wpm,retry_of_session_id,"
    "criterion_results,topic:scenario->>topic,level:score->>overall_level,mode:scenario->>mode"
)

# Minimal columns for progress math (no jsonb blobs beyond criterion_results).
PROGRESS_SELECT = "created_at,content_score,criterion_results,filler_per_min,pace_wpm"


def _base() -> str:
    return f"{config.SUPABASE_URL}/rest/v1"


def _headers() -> dict[str, str]:
    key = config.SUPABASE_SERVICE_ROLE_KEY
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def insert_session(row: dict) -> dict:
    """Insert one session row; returns the created row (with its id)."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/sessions",
            headers={**_headers(), "Prefer": "return=representation"},
            json=row,
        )
    resp.raise_for_status()
    data = resp.json()
    return data[0] if isinstance(data, list) and data else data


async def insert_sessions(rows: list[dict]) -> int:
    """Bulk-insert rows (PostgREST accepts an array). Returns the count inserted."""
    if not rows:
        return 0
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/sessions",
            headers={**_headers(), "Prefer": "return=minimal"},
            json=rows,
        )
    resp.raise_for_status()
    return len(rows)


async def delete_where(user_id: str, event: str) -> int:
    """Delete a user's rows matching an `event` tag (used to clear sample data).
    Returns the number of rows removed."""
    params = {"user_id": f"eq.{user_id}", "event": f"eq.{event}"}
    async with conn() as client:
        resp = await client.delete(
            f"{_base()}/sessions",
            headers={**_headers(), "Prefer": "return=representation"},
            params=params,
        )
    resp.raise_for_status()
    data = resp.json()
    return len(data) if isinstance(data, list) else 0


async def list_sessions(user_id: str, *, limit: int = 50, select: str = SUMMARY_SELECT) -> list[dict]:
    """A user's sessions, newest first."""
    params = {
        "user_id": f"eq.{user_id}",
        "order": "created_at.desc",
        "limit": str(limit),
        "select": select,
    }
    async with conn() as client:
        resp = await client.get(f"{_base()}/sessions", headers=_headers(), params=params)
    resp.raise_for_status()
    return resp.json()


async def get_session(user_id: str, session_id: str) -> dict | None:
    """One full session (all columns), or None if it isn't the user's."""
    params = {
        "user_id": f"eq.{user_id}",
        "id": f"eq.{session_id}",
        "limit": "1",
        "select": "*",
    }
    async with conn() as client:
        resp = await client.get(f"{_base()}/sessions", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


# --- study courses ---------------------------------------------------------

STUDY_SELECT = "term_id,status,best_evidence,seen_count,correct_count,last_seen_at"


async def get_study_profile(user_id: str) -> dict | None:
    """Which event this user is studying for, or None if they haven't picked."""
    params = {"user_id": f"eq.{user_id}", "limit": "1", "select": "event_id,started_at"}
    async with conn() as client:
        resp = await client.get(f"{_base()}/study_profile", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


async def set_study_profile(user_id: str, event_id: str) -> dict:
    """Enroll (or re-enroll) a user in an event's course."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/study_profile",
            headers={**_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
            params={"on_conflict": "user_id"},
            json={"user_id": user_id, "event_id": event_id, "updated_at": "now()"},
        )
    resp.raise_for_status()
    data = resp.json()
    return data[0] if isinstance(data, list) and data else data


async def list_study_progress(user_id: str, term_ids: list[str] | None = None) -> list[dict]:
    """A user's per-term progress. `term_ids` narrows it to the terms we're about to
    fold a result into (a read-modify-write needs the current rows first)."""
    params = {"user_id": f"eq.{user_id}", "select": STUDY_SELECT, "limit": "5000"}
    if term_ids:
        # PostgREST `in` list: in.("a","b"). Quote to survive ids with punctuation.
        quoted = ",".join(f'"{t}"' for t in term_ids)
        params["term_id"] = f"in.({quoted})"
    async with conn() as client:
        resp = await client.get(f"{_base()}/study_progress", headers=_headers(), params=params)
    resp.raise_for_status()
    return resp.json()


async def upsert_study_progress(user_id: str, rows: list[dict]) -> int:
    """Upsert study rows for one user. Rows come from study.apply(); we stamp the
    user and timestamp here so callers can't write to somebody else's map."""
    if not rows:
        return 0
    payload = [{**r, "user_id": user_id, "last_seen_at": "now()"} for r in rows]
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/study_progress",
            headers={**_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": "user_id,term_id"},
            json=payload,
        )
    resp.raise_for_status()
    return len(payload)


# --- study plans -----------------------------------------------------------
# Only the inputs and today's frozen tasks are stored; app/plan.py recomputes the
# rest on every load.

PLAN_SELECT = "event_id,stages,day_minutes,goal,today_date,today_tasks,history"


async def get_study_plan(user_id: str) -> dict | None:
    params = {"user_id": f"eq.{user_id}", "limit": "1", "select": PLAN_SELECT}
    async with conn() as client:
        resp = await client.get(f"{_base()}/study_plan", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


async def upsert_study_plan(user_id: str, fields: dict) -> None:
    """Insert or merge columns into a user's plan. Merge-duplicates only touches the
    columns sent, so saving new inputs leaves `history` alone."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/study_plan",
            headers={**_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": "user_id"},
            json={**fields, "user_id": user_id, "updated_at": "now()"},
        )
    resp.raise_for_status()


async def delete_study_plan(user_id: str) -> None:
    async with conn() as client:
        resp = await client.delete(
            f"{_base()}/study_plan", headers=_headers(), params={"user_id": f"eq.{user_id}"}
        )
    resp.raise_for_status()


# --- scenario cache --------------------------------------------------------
# Shared inventory of already-generated scenarios, keyed by the interpreted
# request (see supabase/schema.sql for why the key is shaped the way it is).
# Every function here is best-effort at the CALLER's discretion: a cache that is
# down must degrade to "generate fresh", never to an error on the practice loop.

CACHED_SELECT = "id,scenario_json,industry_hint,sampling_signature,times_served"


async def list_cached_scenarios(cache_key: str, *, limit: int = 25) -> list[dict]:
    """Candidate scenarios for a cache key, least-served first.

    Least-served-first spreads reuse across the pool instead of hammering the
    oldest row, so two students on the same key are unlikely to get the same
    scenario even before the per-user `seen` filter runs."""
    params = {
        "cache_key": f"eq.{cache_key}",
        "order": "times_served.asc",
        "limit": str(limit),
        "select": CACHED_SELECT,
    }
    async with conn() as client:
        resp = await client.get(f"{_base()}/cached_scenario", headers=_headers(), params=params)
    resp.raise_for_status()
    return resp.json()


async def get_cached_scenario(scenario_id: str) -> dict | None:
    """One pooled scenario by id, for the shared-challenge deep link.

    Deliberately ignores cache_key, times_served and the per-user `seen` filter:
    the whole point of a challenge link is to serve THAT scenario to whoever
    opens it, including someone who has already played it.
    """
    params = {"id": f"eq.{scenario_id}", "select": CACHED_SELECT, "limit": "1"}
    async with conn() as client:
        resp = await client.get(f"{_base()}/cached_scenario", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


async def count_cached_scenarios(cache_key: str) -> int:
    """How many scenarios are already pooled under this key (for the per-key cap)."""
    params = {"cache_key": f"eq.{cache_key}", "select": "id", "limit": "1"}
    async with conn() as client:
        resp = await client.get(
            f"{_base()}/cached_scenario",
            headers={**_headers(), "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
            params=params,
        )
    resp.raise_for_status()
    # PostgREST reports the exact count in Content-Range as "0-0/N".
    total = resp.headers.get("content-range", "").split("/")[-1]
    return int(total) if total.isdigit() else 0


async def insert_cached_scenario(row: dict) -> dict:
    """Add one validated scenario to the shared pool."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/cached_scenario",
            headers={**_headers(), "Prefer": "return=representation"},
            json=row,
        )
    resp.raise_for_status()
    data = resp.json()
    return data[0] if isinstance(data, list) and data else data


async def delete_cached_scenario(scenario_id: str) -> None:
    """Remove a cached scenario (invalidation, a bad one gets amplified)."""
    async with conn() as client:
        resp = await client.delete(
            f"{_base()}/cached_scenario",
            headers=_headers(),
            params={"id": f"eq.{scenario_id}"},
        )
    resp.raise_for_status()


async def list_seen_scenarios(user_id: str) -> list[str]:
    """Scenario ids this signed-in user has already been served."""
    params = {"user_id": f"eq.{user_id}", "select": "scenario_id", "limit": "5000"}
    async with conn() as client:
        resp = await client.get(f"{_base()}/seen_scenario", headers=_headers(), params=params)
    resp.raise_for_status()
    return [r["scenario_id"] for r in resp.json()]


async def mark_scenario_seen(user_id: str, scenario_id: str) -> None:
    """Record that a user has seen a scenario. Idempotent (merge-duplicates), so a
    retry can never fail the request it was attached to."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/seen_scenario",
            headers={**_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": "user_id,scenario_id"},
            json={"user_id": user_id, "scenario_id": scenario_id},
        )
    resp.raise_for_status()


async def bump_scenario_served(scenario_id: str) -> None:
    """Atomically increment a cached scenario's serve counter (see schema.sql)."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/rpc/bump_scenario_served",
            headers=_headers(),
            json={"sid": scenario_id},
        )
    resp.raise_for_status()


# --- site-wide stats -------------------------------------------------------
# Three running totals (see app/stats.py). The increment is a SQL function so it's
# atomic under concurrent reps, same reason as bump_scenario_served.


async def bump_stat(kind: str, n: int = 1) -> None:
    """Add `n` to a counter. The SQL function adds one at a time, so a batch is
    that many calls over the one pooled connection: `n` is small (a quiz round, a
    deck) and this only ever runs after the response has gone out."""
    async with conn() as client:
        for _ in range(n):
            resp = await client.post(f"{_base()}/rpc/bump_stat", headers=_headers(), json={"p_kind": kind})
            resp.raise_for_status()


async def get_stats() -> dict[str, int]:
    async with conn() as client:
        resp = await client.get(f"{_base()}/app_stat", headers=_headers(), params={"select": "kind,count"})
    resp.raise_for_status()
    return {r["kind"]: int(r["count"]) for r in resp.json()}


# --- usage counters (tier caps) --------------------------------------------
# Enforcement is server-side and ATOMIC: the cap check lives inside the SQL
# statement that does the increment (see supabase/schema.sql), because a
# read-then-write from here would let two concurrent requests both slip past a
# limit they were each individually under.


async def claim_usage(user_id: str, period: str, kind: str, limit: int) -> int | None:
    """Claim one session against a monthly cap.

    Returns the new count, or None when the cap is already reached. `limit < 0`
    means unlimited. The decision and the write are one statement, so this is safe
    against concurrent requests from the same user.
    """
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/rpc/claim_usage",
            headers=_headers(),
            json={"p_user_id": user_id, "p_period": period, "p_kind": kind, "p_limit": limit},
        )
    resp.raise_for_status()
    return resp.json()


async def release_usage(user_id: str, period: str, kind: str) -> None:
    """Give a claimed session back (the work failed, so it shouldn't be charged)."""
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/rpc/release_usage",
            headers=_headers(),
            json={"p_user_id": user_id, "p_period": period, "p_kind": kind},
        )
    resp.raise_for_status()


async def get_usage(user_id: str, period: str) -> dict[str, int]:
    """This user's counts for a period, as ``{kind: count}``."""
    params = {
        "user_id": f"eq.{user_id}",
        "period": f"eq.{period}",
        "select": "kind,count",
        "limit": "20",
    }
    async with conn() as client:
        resp = await client.get(f"{_base()}/usage_counter", headers=_headers(), params=params)
    resp.raise_for_status()
    return {r["kind"]: int(r["count"]) for r in resp.json()}


async def count_sessions(user_id: str) -> int:
    """Total completed role-plays for a user (drives the founding-user reward)."""
    params = {"user_id": f"eq.{user_id}", "select": "id", "limit": "1"}
    async with conn() as client:
        resp = await client.get(
            f"{_base()}/sessions",
            headers={**_headers(), "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
            params=params,
        )
    resp.raise_for_status()
    total = resp.headers.get("content-range", "").split("/")[-1]
    return int(total) if total.isdigit() else 0


# --- chapters --------------------------------------------------------------
# Who may read what is decided in app/chapters.py before any of these run; these
# only fetch and write. Every chapter table is service-key-only (schema.sql).


def _in(ids: list[str]) -> str:
    """A PostgREST `in` filter value. Ids are quoted to survive punctuation."""
    return "in.(" + ",".join(f'"{i}"' for i in ids) + ")"


async def _get(table: str, params: dict, timeout: float = 15.0) -> list[dict]:
    async with conn() as client:
        resp = await client.get(f"{_base()}/{table}", headers=_headers(), params=params)
    resp.raise_for_status()
    return resp.json()


async def _insert(table: str, row: dict) -> dict:
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/{table}", headers={**_headers(), "Prefer": "return=representation"}, json=row
        )
    resp.raise_for_status()
    data = resp.json()
    return data[0] if isinstance(data, list) and data else data


async def _patch(table: str, params: dict, fields: dict) -> list[dict]:
    async with conn() as client:
        resp = await client.patch(
            f"{_base()}/{table}",
            headers={**_headers(), "Prefer": "return=representation"},
            params=params,
            json=fields,
        )
    resp.raise_for_status()
    return resp.json()


async def _delete(table: str, params: dict) -> int:
    async with conn() as client:
        resp = await client.delete(
            f"{_base()}/{table}", headers={**_headers(), "Prefer": "return=representation"}, params=params
        )
    resp.raise_for_status()
    data = resp.json()
    return len(data) if isinstance(data, list) else 0


async def _upsert(table: str, on_conflict: str, row: dict) -> None:
    async with conn() as client:
        resp = await client.post(
            f"{_base()}/{table}",
            headers={**_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": on_conflict},
            json=row,
        )
    resp.raise_for_status()


# profile (names)

async def get_profile(user_id: str) -> dict | None:
    rows = await _get("profile", {"user_id": f"eq.{user_id}", "select": "first_name,last_name", "limit": "1"})
    return rows[0] if rows else None


async def list_profiles(user_ids: list[str]) -> dict[str, dict]:
    if not user_ids:
        return {}
    rows = await _get("profile", {"user_id": _in(user_ids), "select": "user_id,first_name,last_name", "limit": "5000"})
    return {str(r["user_id"]): r for r in rows}


async def upsert_profile(user_id: str, first_name: str, last_name: str) -> None:
    await _upsert("profile", "user_id", {
        "user_id": user_id, "first_name": first_name, "last_name": last_name, "updated_at": "now()",
    })


# chapters

CHAPTER_SELECT = "id,name,school_name,contact_email,join_code,manager_code,status,created_by,created_at"


async def insert_chapter(row: dict) -> dict:
    return await _insert("chapter", row)


async def get_chapter(chapter_id: str) -> dict | None:
    rows = await _get("chapter", {"id": f"eq.{chapter_id}", "select": CHAPTER_SELECT, "limit": "1"})
    return rows[0] if rows else None


async def list_chapters(chapter_ids: list[str]) -> list[dict]:
    if not chapter_ids:
        return []
    return await _get("chapter", {"id": _in(chapter_ids), "select": CHAPTER_SELECT})


async def list_chapters_by_status(status: str) -> list[dict]:
    return await _get("chapter", {"status": f"eq.{status}", "select": CHAPTER_SELECT,
                                  "order": "created_at.desc", "limit": "200"})


async def list_chapters_created_by(user_id: str) -> list[dict]:
    return await _get("chapter", {"created_by": f"eq.{user_id}", "select": CHAPTER_SELECT})


async def find_chapter_by_code(code: str) -> tuple[dict | None, str]:
    """The chapter a code opens, and which kind of code it was: "student" for a
    join code, "manager" for a manager code, "" when it matches neither. The
    caller normalizes the code to [A-Z0-9] first, so it's safe in the filter."""
    rows = await _get("chapter", {"or": f"(join_code.eq.{code},manager_code.eq.{code})",
                                  "select": CHAPTER_SELECT, "limit": "1"})
    if not rows:
        return None, ""
    ch = rows[0]
    return ch, ("manager" if ch.get("manager_code") == code else "student")


async def update_chapter(chapter_id: str, fields: dict) -> dict | None:
    rows = await _patch("chapter", {"id": f"eq.{chapter_id}"}, fields)
    return rows[0] if rows else None


# members

MEMBER_SELECT = "chapter_id,user_id,role,status,requested_at,approved_at"


async def list_memberships(user_id: str) -> list[dict]:
    return await _get("chapter_member", {"user_id": f"eq.{user_id}", "select": MEMBER_SELECT})


async def list_chapter_members(chapter_id: str) -> list[dict]:
    return await _get("chapter_member", {"chapter_id": f"eq.{chapter_id}", "select": MEMBER_SELECT,
                                         "order": "requested_at.asc", "limit": "2000"})


async def insert_member(row: dict) -> dict:
    return await _insert("chapter_member", row)


async def update_member(chapter_id: str, user_id: str, fields: dict) -> list[dict]:
    return await _patch("chapter_member", {"chapter_id": f"eq.{chapter_id}", "user_id": f"eq.{user_id}"}, fields)


async def delete_member(chapter_id: str, user_id: str) -> int:
    return await _delete("chapter_member", {"chapter_id": f"eq.{chapter_id}", "user_id": f"eq.{user_id}"})


# feed

POST_SELECT = "id,chapter_id,author_id,kind,title,body,assignment_kind,target,due_at,audience,created_at"


async def list_posts(chapter_id: str, limit: int = 100) -> list[dict]:
    return await _get("chapter_post", {"chapter_id": f"eq.{chapter_id}", "select": POST_SELECT,
                                       "order": "created_at.desc", "limit": str(limit)})


async def insert_post(row: dict) -> dict:
    return await _insert("chapter_post", row)


async def delete_post(chapter_id: str, post_id: str) -> int:
    return await _delete("chapter_post", {"chapter_id": f"eq.{chapter_id}", "id": f"eq.{post_id}"})


# messages

MESSAGE_SELECT = "id,chapter_id,student_id,sender_id,body,created_at"


async def list_messages(chapter_id: str, student_id: str | None = None, limit: int = 500) -> list[dict]:
    """A chapter's messages, oldest first: one student's thread, or every thread
    (the managers' inbox)."""
    params = {"chapter_id": f"eq.{chapter_id}", "select": MESSAGE_SELECT,
              "order": "created_at.asc", "limit": str(limit)}
    if student_id:
        params["student_id"] = f"eq.{student_id}"
    return await _get("chapter_message", params)


async def insert_message(row: dict) -> dict:
    return await _insert("chapter_message", row)


# read markers

async def list_reads(user_id: str, chapter_id: str) -> dict[str, str]:
    rows = await _get("chapter_read", {"user_id": f"eq.{user_id}", "chapter_id": f"eq.{chapter_id}",
                                       "select": "scope,seen_at", "limit": "2000"})
    return {r["scope"]: r["seen_at"] for r in rows}


async def mark_read(user_id: str, chapter_id: str, scope: str) -> None:
    await _upsert("chapter_read", "user_id,chapter_id,scope", {
        "user_id": user_id, "chapter_id": chapter_id, "scope": scope, "seen_at": "now()",
    })


# activity (a finished quiz / Blitz / flashcard set) and multi-student reads

ACTIVITY_SELECT = "user_id,kind,domain_ids,score,total,created_at"


async def insert_activity(row: dict) -> None:
    async with conn() as client:
        resp = await client.post(f"{_base()}/activity_event", headers={**_headers(), "Prefer": "return=minimal"}, json=row)
    resp.raise_for_status()


async def list_activity(user_ids: list[str], since: str | None = None, limit: int = 5000) -> list[dict]:
    if not user_ids:
        return []
    params = {"user_id": _in(user_ids), "select": ACTIVITY_SELECT, "order": "created_at.desc", "limit": str(limit)}
    if since:
        params["created_at"] = f"gte.{since}"
    return await _get("activity_event", params)


async def list_sessions_for(user_ids: list[str], since: str | None = None, limit: int = 5000) -> list[dict]:
    """Compact session rows for several students at once (roster, assignments)."""
    if not user_ids:
        return []
    params = {"user_id": _in(user_ids), "select": "user_id," + PROGRESS_SELECT,
              "order": "created_at.desc", "limit": str(limit)}
    if since:
        params["created_at"] = f"gte.{since}"
    return await _get("sessions", params)


async def list_study_profiles(user_ids: list[str]) -> dict[str, str]:
    """user_id -> event_id, for the students who have picked an event."""
    if not user_ids:
        return {}
    rows = await _get("study_profile", {"user_id": _in(user_ids), "select": "user_id,event_id", "limit": "5000"})
    return {str(r["user_id"]): r["event_id"] for r in rows}


async def list_plan_history(user_ids: list[str]) -> dict[str, list[dict]]:
    """user_id -> the plan's scored past days, for the students who have a plan."""
    if not user_ids:
        return {}
    rows = await _get("study_plan", {"user_id": _in(user_ids), "select": "user_id,history", "limit": "5000"})
    return {str(r["user_id"]): r.get("history") or [] for r in rows}
