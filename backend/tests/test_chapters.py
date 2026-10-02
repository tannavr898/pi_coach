"""Chapters: access rules, assignment completion, and the endpoints' gates.

The pure rules are tested directly. The endpoint tests swap the database module
for an in-memory fake so they can prove the thing that matters most here, that
nobody reads a student's data without being an active manager of that student's
chapter, without any network."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import chapters, config, db, main
from app.auth import current_user

NOW = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
CH = "c1"


def m(uid, role="student", status="active", chapter=CH):
    return {"chapter_id": chapter, "user_id": uid, "role": role, "status": status}


# --- pure rules -------------------------------------------------------------


def test_codes_are_unambiguous_and_normalized():
    for _ in range(50):
        code = chapters.new_code(8)
        assert len(code) == 8 and not set(code) & set("01OIL")
    assert chapters.normalize_code(" ab-c2 3d ") == "ABC23D"


def test_only_active_managers_pass_require_manager():
    chapters.require_manager([m("u", "manager")], CH)
    for rows in ([m("u", "student")], [m("u", "manager", "pending")], [m("u", "manager", chapter="other")], []):
        with pytest.raises(HTTPException) as e:
            chapters.require_manager(rows, CH)
        assert e.value.status_code == 403


def test_require_student_in_rejects_pending_managers_and_strangers():
    roster = [m("s1"), m("s2", status="pending"), m("mgr", "manager")]
    chapters.require_student_in(roster, "s1")
    for uid in ("s2", "mgr", "nobody"):
        with pytest.raises(HTTPException):
            chapters.require_student_in(roster, uid)


def test_a_student_only_ever_gets_their_own_thread():
    assert chapters.thread_access([m("s1")], CH, "s1", "s2") == "s1"
    assert chapters.thread_access([m("mgr", "manager")], CH, "mgr", "s2") == "s2"


def test_students_only_see_posts_meant_for_them():
    everyone = {"audience": None}
    targeted = {"audience": ["s2"]}
    assert chapters.visible_to(everyone, "s1", "student")
    assert not chapters.visible_to(targeted, "s1", "student")
    assert chapters.visible_to(targeted, "s2", "student")
    assert chapters.visible_to(targeted, "mgr", "manager")


def test_validate_assignment_bounds():
    assert chapters.validate_assignment("quiz", {"count": 2, "min_pct": 70}) is None
    assert chapters.validate_assignment("quiz", {"count": 0})
    assert chapters.validate_assignment("roleplay", {"count": 1, "min_score": 140})
    assert chapters.validate_assignment("essay", {"count": 1})


def _post(kind, target, created=NOW - timedelta(days=2), due=None):
    return {"assignment_kind": kind, "target": target, "created_at": created.isoformat(),
            "due_at": due.isoformat() if due else None}


def test_only_work_after_the_post_counts():
    post = _post("roleplay", {"count": 2, "min_score": 70})
    sessions = [
        {"created_at": (NOW - timedelta(days=5)).isoformat(), "content_score": 90},  # before: ignored
        {"created_at": (NOW - timedelta(days=1)).isoformat(), "content_score": 60},  # below floor
        {"created_at": (NOW - timedelta(hours=3)).isoformat(), "content_score": 80},
    ]
    st = chapters.assignment_status(post, sessions, [], NOW)
    assert st == {"done": 1, "count": 2, "status": "in_progress"}


def test_quiz_needs_the_domain_and_the_score():
    post = _post("quiz", {"count": 1, "min_pct": 70, "domain_id": "marketing"})
    t = (NOW - timedelta(hours=1)).isoformat()
    acts = [
        {"kind": "quiz", "domain_ids": ["finance"], "score": 10, "total": 10, "created_at": t},
        {"kind": "quiz", "domain_ids": ["marketing"], "score": 6, "total": 10, "created_at": t},
        {"kind": "blitz", "domain_ids": ["marketing"], "score": 10, "total": 10, "created_at": t},
    ]
    assert chapters.assignment_status(post, [], acts, NOW)["status"] == "not_started"
    acts.append({"kind": "quiz", "domain_ids": ["marketing"], "score": 7, "total": 10, "created_at": t})
    assert chapters.assignment_status(post, [], acts, NOW)["status"] == "done"


def test_flashcards_sum_cards_across_sets():
    post = _post("flashcards", {"count": 20})
    t = (NOW - timedelta(hours=1)).isoformat()
    acts = [{"kind": "flashcards", "domain_ids": [], "score": 12, "total": 30, "created_at": t},
            {"kind": "flashcards", "domain_ids": [], "score": 9, "total": 30, "created_at": t}]
    assert chapters.assignment_status(post, [], acts, NOW) == {"done": 20, "count": 20, "status": "done"}


def test_unfinished_past_due_is_overdue():
    post = _post("blitz", {"count": 1}, due=NOW - timedelta(hours=1))
    assert chapters.assignment_status(post, [], [], NOW)["status"] == "overdue"


def test_unread_skips_your_own_items():
    seen = (NOW - timedelta(days=1)).isoformat()
    items = [
        {"created_at": NOW.isoformat(), "author_id": "me"},
        {"created_at": NOW.isoformat(), "author_id": "them"},
        {"created_at": (NOW - timedelta(days=2)).isoformat(), "author_id": "them"},
    ]
    assert chapters.unread_count(items, seen, exclude_author="me") == 1
    assert chapters.unread_count(items, None) == 3


# --- endpoint gates ----------------------------------------------------------


class FakeDB:
    """Just enough of app.db for the chapter endpoints."""

    def __init__(self):
        self.members = [m("mgr", "manager"), m("s1"), m("s2", status="pending"),
                        m("other-mgr", "manager", chapter="c2"), m("s9", chapter="c2")]
        self.chapter = {"id": CH, "name": "North High", "school_name": "North", "contact_email": "a@b.co",
                        "join_code": "ABC234", "manager_code": "MGRCODE2", "status": "active",
                        "created_by": "mgr", "created_at": NOW.isoformat()}
        self.messages = []

    async def list_memberships(self, uid):
        return [r for r in self.members if r["user_id"] == uid]

    async def list_chapter_members(self, cid):
        return [r for r in self.members if r["chapter_id"] == cid]

    async def get_chapter(self, cid):
        return self.chapter if cid == CH else None

    async def find_chapter_by_code(self, code):
        if code == self.chapter["join_code"]:
            return self.chapter, "student"
        if code == self.chapter["manager_code"]:
            return self.chapter, "manager"
        return None, ""

    async def get_profile(self, uid):
        return {"first_name": "Sam", "last_name": uid}

    async def list_profiles(self, ids):
        return {i: {"user_id": i, "first_name": "Sam", "last_name": i} for i in ids}

    async def insert_member(self, row):
        self.members.append({**row, "status": row.get("status", "pending")})
        return row

    async def update_member(self, cid, uid, fields):
        hit = [r for r in self.members if r["chapter_id"] == cid and r["user_id"] == uid]
        for r in hit:
            r.update(fields)
        return hit

    async def delete_member(self, cid, uid):
        before = len(self.members)
        self.members = [r for r in self.members if not (r["chapter_id"] == cid and r["user_id"] == uid)]
        return before - len(self.members)

    async def list_messages(self, cid, sid=None):
        return [x for x in self.messages if x["chapter_id"] == cid and (sid is None or x["student_id"] == sid)]

    async def insert_message(self, row):
        self.messages.append({**row, "id": str(len(self.messages)), "created_at": NOW.isoformat()})
        return row

    async def mark_read(self, *a):
        return None

    async def list_reads(self, *a):
        return {}


@pytest.fixture
def client(monkeypatch):
    fake = FakeDB()
    for name in dir(fake):
        if not name.startswith("_"):
            monkeypatch.setattr(db, name, getattr(fake, name), raising=False)
    monkeypatch.setattr(config, "SUPABASE_URL", "http://fake", raising=False)
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "k", raising=False)
    who = {"id": "mgr"}
    main.app.dependency_overrides[current_user] = lambda: {"id": who["id"], "email": "", "created_at": "", "meta": {}}
    c = TestClient(main.app)
    c.who = who  # type: ignore[attr-defined]
    c.fake = fake  # type: ignore[attr-defined]
    yield c
    main.app.dependency_overrides.clear()


def test_non_managers_cannot_open_the_roster_or_a_profile(client):
    for uid in ("s1", "s2", "other-mgr", "stranger"):
        client.who["id"] = uid
        assert client.get(f"/api/chapters/{CH}/roster").status_code == 403
        assert client.get(f"/api/chapters/{CH}/students/s1").status_code == 403
        assert client.post(f"/api/chapters/{CH}/members/s2/approve").status_code == 403
        assert client.post(f"/api/chapters/{CH}/posts", json={"kind": "announcement", "title": "x"}).status_code == 403


def test_a_manager_cannot_open_a_student_from_another_chapter(client):
    client.who["id"] = "mgr"
    assert client.get(f"/api/chapters/{CH}/students/s9").status_code == 404
    assert client.get(f"/api/chapters/{CH}/students/s2").status_code == 404  # pending isn't in yet


def test_a_student_reads_only_their_own_thread(client):
    client.fake.messages = [
        {"id": "1", "chapter_id": CH, "student_id": "s1", "sender_id": "mgr", "body": "for s1", "created_at": NOW.isoformat()},
        {"id": "2", "chapter_id": CH, "student_id": "s3", "sender_id": "mgr", "body": "for s3", "created_at": NOW.isoformat()},
    ]
    client.who["id"] = "s1"
    r = client.get(f"/api/chapters/{CH}/messages", params={"student": "s3"})
    assert r.status_code == 200
    assert [x["body"] for x in r.json()] == ["for s1"]


def test_a_student_reply_lands_in_their_own_thread(client):
    client.who["id"] = "s1"
    r = client.post(f"/api/chapters/{CH}/messages", json={"body": "done!", "student_ids": ["s9"]})
    assert r.status_code == 200
    assert client.fake.messages[-1]["student_id"] == "s1"


def test_join_needs_consent_then_files_a_pending_request(client):
    client.who["id"] = "newbie"
    assert client.post("/api/chapters/join", json={"code": "abc-234"}).status_code == 422
    r = client.post("/api/chapters/join", json={"code": "abc-234", "consent": True})
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert r.json()["chapter"]["join_code"] is None  # codes are managers-only
    # A pending request opens nothing.
    assert client.get(f"/api/chapters/{CH}/posts").status_code == 403


def test_one_student_chapter_at_a_time(client):
    client.who["id"] = "s9"  # already a student in c2
    r = client.post("/api/chapters/join", json={"code": "ABC234", "consent": True})
    assert r.status_code == 409


def test_last_manager_cannot_leave(client):
    client.who["id"] = "mgr"
    assert client.post(f"/api/chapters/{CH}/leave").status_code == 409


def test_removed_student_loses_access(client):
    client.who["id"] = "mgr"
    assert client.delete(f"/api/chapters/{CH}/members/s1").status_code == 200
    client.who["id"] = "s1"
    assert client.get(f"/api/chapters/{CH}/messages").status_code == 403


def test_admin_chapter_review_needs_the_passphrase(client, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_PASSPHRASE", "letmein", raising=False)
    assert client.post(f"/api/admin/chapters/{CH}/status", json={"status": "active"}).status_code == 403
    assert client.get("/api/admin/chapters", headers={"X-Admin-Passphrase": "nope"}).status_code == 403
