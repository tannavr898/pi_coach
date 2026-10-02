"""Chapters: the pure rules behind the club features (pure, no I/O).

A chapter is a school club. Its managers (an advisor, officers) follow their
members' practice, post announcements and assignments, and message students one
thread at a time. Everything here is a decision that main.py makes before it
touches the database, kept free of I/O so the access rules can be tested directly:

- who may do what (``require_manager`` / ``require_student``), from membership rows
- join and manager codes
- whether an assignment is done, from the student's real activity, never a
  self-reported checkbox
- unread counts for the Chapter tab badge

Membership rows look like the ``chapter_member`` table: ``{chapter_id, user_id,
role, status}``. Only ``status == "active"`` grants anything; a pending request is
a request, not access.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import HTTPException

# No 0/O, 1/I/L: these get read off a whiteboard and typed on a phone.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
JOIN_CODE_LEN = 6
MANAGER_CODE_LEN = 8

ROLES = ("manager", "student")
ASSIGNMENT_KINDS = ("roleplay", "quiz", "blitz", "flashcards")
ACTIVITY_KINDS = ("quiz", "blitz", "flashcards")

# Upper bounds that keep one assignment from being a typo away from impossible.
MAX_COUNT = {"roleplay": 20, "quiz": 20, "blitz": 20, "flashcards": 500}


def new_code(length: int = JOIN_CODE_LEN) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def normalize_code(raw: str) -> str:
    """What a student typed, as the code it was meant to be: case, spaces and
    dashes forgiven, since codes get read aloud and copied off slides."""
    return "".join(ch for ch in (raw or "").upper() if ch.isalnum())


# --- access ------------------------------------------------------------------


def membership(rows: list[dict], chapter_id: str) -> dict | None:
    """The caller's ACTIVE membership in one chapter, or None."""
    for r in rows:
        if str(r.get("chapter_id")) == str(chapter_id) and r.get("status") == "active":
            return r
    return None


def require_manager(rows: list[dict], chapter_id: str) -> dict:
    m = membership(rows, chapter_id)
    if not m or m.get("role") != "manager":
        raise HTTPException(status_code=403, detail="Only this chapter's managers can do that.")
    return m


def require_member(rows: list[dict], chapter_id: str) -> dict:
    m = membership(rows, chapter_id)
    if not m:
        raise HTTPException(status_code=403, detail="You're not a member of this chapter.")
    return m


def require_student_in(members: list[dict], student_id: str) -> dict:
    """A manager can only look at ACTIVE students of their own chapter. `members`
    is that chapter's roster, so a student from another chapter, a pending
    request, or a fellow manager all read as not found."""
    for r in members:
        if str(r.get("user_id")) == str(student_id) and r.get("role") == "student" and r.get("status") == "active":
            return r
    raise HTTPException(status_code=404, detail="That student isn't in this chapter.")


def thread_access(rows: list[dict], chapter_id: str, user_id: str, student_id: str | None) -> str:
    """Which message thread a caller may open. Managers pick any student's thread
    (still checked against the roster by the caller); a student only ever gets
    their own, whatever they asked for."""
    m = require_member(rows, chapter_id)
    if m.get("role") == "manager":
        if not student_id:
            raise HTTPException(status_code=422, detail="Pick a student.")
        return student_id
    return user_id


def visible_to(post: dict, user_id: str, role: str) -> bool:
    """Managers see every post; a student sees chapter-wide posts and the ones
    assigned to them."""
    if role == "manager":
        return True
    aud = post.get("audience")
    return not aud or str(user_id) in {str(a) for a in aud}


# --- assignments -------------------------------------------------------------


def validate_assignment(kind: str, target: dict) -> str | None:
    """None when the target is something a student could actually complete."""
    if kind not in ASSIGNMENT_KINDS:
        return "Unknown assignment type."
    count = target.get("count")
    if not isinstance(count, int) or count < 1 or count > MAX_COUNT[kind]:
        return f"Pick a count between 1 and {MAX_COUNT[kind]}."
    if kind == "roleplay":
        ms = target.get("min_score")
        if ms is not None and (not isinstance(ms, int) or not 0 <= ms <= 100):
            return "Minimum score must be between 0 and 100."
    if kind in ("quiz", "blitz"):
        mp = target.get("min_pct")
        if mp is not None and (not isinstance(mp, int) or not 0 <= mp <= 100):
            return "Minimum percent must be between 0 and 100."
    return None


def _ts(raw) -> datetime | None:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def assignment_progress(post: dict, sessions: list[dict], activities: list[dict]) -> int:
    """How much of an assignment a student has done since it was posted.

    Only work AFTER the post counts: an assignment is a request to do something
    new, and a quiz taken last month is not the one being asked for.

    - roleplay: sessions scoring at least min_score (any event when none is set)
    - quiz / blitz: runs on the target domain at or above min_pct
    - flashcards: cards flipped in the target domain, summed across sets
    """
    kind = post.get("assignment_kind")
    target = post.get("target") or {}
    since = _ts(post.get("created_at"))
    domain = target.get("domain_id")

    def after(row: dict) -> bool:
        t = _ts(row.get("created_at"))
        return bool(t and (since is None or t >= since))

    if kind == "roleplay":
        floor = target.get("min_score") or 0
        return sum(1 for s in sessions if after(s) and int(s.get("content_score") or 0) >= floor)

    matching = [
        a for a in activities
        if a.get("kind") == kind and after(a) and (not domain or domain in (a.get("domain_ids") or []))
    ]
    if kind == "flashcards":
        return sum(int(a.get("score") or 0) for a in matching)
    floor = target.get("min_pct") or 0
    return sum(
        1 for a in matching
        if int(a.get("total") or 0) > 0 and 100 * int(a.get("score") or 0) >= floor * int(a["total"])
    )


def assignment_status(post: dict, sessions: list[dict], activities: list[dict], now: datetime) -> dict:
    """{done, count, status} where status is done | in_progress | not_started | overdue."""
    count = int((post.get("target") or {}).get("count") or 1)
    done = assignment_progress(post, sessions, activities)
    if done >= count:
        status = "done"
    else:
        due = _ts(post.get("due_at"))
        if due and now > due:
            status = "overdue"
        else:
            status = "in_progress" if done > 0 else "not_started"
    return {"done": min(done, count), "count": count, "status": status}


def assignees(post: dict, student_ids: list[str]) -> list[str]:
    aud = post.get("audience")
    if not aud:
        return list(student_ids)
    wanted = {str(a) for a in aud}
    return [s for s in student_ids if str(s) in wanted]


# --- unread ------------------------------------------------------------------


def unread_count(items: list[dict], seen_at, *, exclude_author: str | None = None, author_key: str = "author_id") -> int:
    """Items newer than the last time this person looked. Your own posts and
    messages never count as unread to you."""
    seen = _ts(seen_at)
    n = 0
    for it in items:
        if exclude_author and str(it.get(author_key)) == str(exclude_author):
            continue
        t = _ts(it.get("created_at"))
        if t and (seen is None or t > seen):
            n += 1
    return n


# --- roster ------------------------------------------------------------------


def last_active(sessions: list[dict], activities: list[dict]) -> str | None:
    """The newest of a student's role-plays and study runs, as an ISO string."""
    times = [t for t in (_ts(r.get("created_at")) for r in [*sessions, *activities]) if t]
    return max(times).isoformat() if times else None


def recent_count(rows: list[dict], now: datetime, days: int = 7) -> int:
    n = 0
    for r in rows:
        t = _ts(r.get("created_at"))
        if t and (now - t).days < days:
            n += 1
    return n
