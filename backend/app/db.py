"""Persistence for logged-in users — a thin async wrapper over Supabase's REST
(PostgREST) API, using the SECRET service-role key (backend-only).

We deliberately avoid an ORM/DB driver: httpx is already a dependency (it talks
to AssemblyAI), and the data shape is a single flat table. Every query is scoped
by ``user_id`` here in code; Row-Level Security on the table is a second line of
defense. Only completed sessions for signed-in users are ever written — the
anonymous practice loop never touches this module.
"""

from __future__ import annotations

import httpx

from . import config

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
    async with httpx.AsyncClient(timeout=15.0) as client:
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
    async with httpx.AsyncClient(timeout=20.0) as client:
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
    async with httpx.AsyncClient(timeout=20.0) as client:
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
    async with httpx.AsyncClient(timeout=15.0) as client:
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
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{_base()}/sessions", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


# --- study courses ---------------------------------------------------------

STUDY_SELECT = "term_id,status,best_evidence,seen_count,correct_count,last_seen_at"


async def get_study_profile(user_id: str) -> dict | None:
    """Which event this user is studying for, or None if they haven't picked."""
    params = {"user_id": f"eq.{user_id}", "limit": "1", "select": "event_id,started_at"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{_base()}/study_profile", headers=_headers(), params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


async def set_study_profile(user_id: str, event_id: str) -> dict:
    """Enroll (or re-enroll) a user in an event's course."""
    async with httpx.AsyncClient(timeout=15.0) as client:
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
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{_base()}/study_progress", headers=_headers(), params=params)
    resp.raise_for_status()
    return resp.json()


async def upsert_study_progress(user_id: str, rows: list[dict]) -> int:
    """Upsert study rows for one user. Rows come from study.apply(); we stamp the
    user and timestamp here so callers can't write to somebody else's map."""
    if not rows:
        return 0
    payload = [{**r, "user_id": user_id, "last_seen_at": "now()"} for r in rows]
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            f"{_base()}/study_progress",
            headers={**_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"},
            params={"on_conflict": "user_id,term_id"},
            json=payload,
        )
    resp.raise_for_status()
    return len(payload)
