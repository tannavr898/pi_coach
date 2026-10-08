"""Site-wide stats counters (app/stats.py)."""

import asyncio

import httpx
from fastapi.testclient import TestClient

import app.llm as llm
from app import config, db, stats, terms
from app.main import app

client = TestClient(app)


def test_public_endpoint_without_accounts_is_zero_and_hidden():
    stats.reset_cache()
    r = client.get("/api/stats")
    assert r.status_code == 200
    assert r.json() == {"roleplays": 0, "blitzes": 0, "scenarios": 0, "quizzes": 0, "questions": 0,
                        "cards": 0, "visible": [], "show": False}


def test_each_counter_is_shown_only_past_its_own_threshold():
    floor = stats.PUBLIC_MIN
    under = stats.public({"roleplay": floor["roleplays"] - 1, "question": floor["questions"] - 1})
    assert under["visible"] == [] and not under["show"]
    # A busy counter is not held back by a quiet one, and the quiet one stays off.
    mixed = stats.public({"roleplay": floor["roleplays"], "blitz": 3, "question": floor["questions"] + 5})
    assert mixed["visible"] == ["roleplays", "questions"] and mixed["show"]
    assert mixed["blitzes"] == 3  # the number is still reported, just not listed as visible


def test_a_quiz_report_counts_the_round_and_its_questions(monkeypatch):
    bumped = []

    async def record(kind, n=1):
        bumped.append((kind, n))

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    monkeypatch.setattr(db, "bump_stat", record)
    asyncio.run(stats.report("quiz", 10))
    asyncio.run(stats.report("flashcards", 7))
    assert bumped == [("quiz", 1), ("question", 10), ("card", 7)]


def test_reports_are_clamped_to_what_one_sitting_could_be(monkeypatch):
    bumped = []

    async def record(kind, n=1):
        bumped.append((kind, n))

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    monkeypatch.setattr(db, "bump_stat", record)
    asyncio.run(stats.report("quiz", 999))
    asyncio.run(stats.report("flashcards", 999))
    assert bumped == [("quiz", 1), ("question", stats.MAX_QUESTIONS_PER_REPORT), ("card", stats.MAX_CARDS_PER_REPORT)]


def test_report_endpoint_is_anonymous_and_validates(monkeypatch):
    seen = []

    async def record(kind, count):
        seen.append((kind, count))

    monkeypatch.setattr(stats, "report", record)
    assert client.post("/api/stats/report", json={"kind": "quiz", "count": 10}).status_code == 200
    assert seen == [("quiz", 10)]
    assert client.post("/api/stats/report", json={"kind": "roleplay", "count": 1}).status_code == 422
    assert client.post("/api/stats/report", json={"kind": "quiz", "count": 0}).status_code == 422


def test_snapshot_is_cached(monkeypatch):
    calls = []

    async def fake():
        calls.append(1)
        return {"roleplay": 500, "blitz": 20, "scenario": 90}

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    monkeypatch.setattr(db, "get_stats", fake)
    stats.reset_cache()
    first = asyncio.run(stats.snapshot(now=1000.0))
    again = asyncio.run(stats.snapshot(now=1100.0))
    assert first == again == {"roleplays": 500, "blitzes": 20, "scenarios": 90, "quizzes": 0, "questions": 0,
                              "cards": 0, "visible": ["roleplays"], "show": True}
    assert len(calls) == 1
    asyncio.run(stats.snapshot(now=1000.0 + stats.CACHE_SECONDS + 1))
    assert len(calls) == 2
    stats.reset_cache()


def test_failed_read_is_not_cached(monkeypatch):
    results = [httpx.ConnectError("down"), {"roleplay": 7}]

    async def flaky():
        r = results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    monkeypatch.setattr(db, "get_stats", flaky)
    stats.reset_cache()
    assert asyncio.run(stats.snapshot(now=1.0))["roleplays"] == 0
    assert asyncio.run(stats.snapshot(now=2.0))["roleplays"] == 7
    stats.reset_cache()


def test_bump_is_quiet_when_it_cant_count(monkeypatch):
    called = []

    async def record(kind, n=1):
        called.append(kind)

    monkeypatch.setattr(db, "bump_stat", record)
    asyncio.run(stats.bump("roleplay"))  # accounts not configured
    assert called == []

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    asyncio.run(stats.bump("not-a-kind"))
    assert called == []

    async def broken(kind, n=1):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(db, "bump_stat", broken)
    asyncio.run(stats.bump("roleplay"))  # must not raise


def test_graded_blitz_counts_once(monkeypatch):
    bumped = []

    async def record(kind):
        bumped.append(kind)

    monkeypatch.setattr(stats, "bump", record)
    monkeypatch.setattr(llm, "complete_json", lambda *a, **k: {"results": [{"index": 0, "verdict": "correct"}]})
    tid = terms.all_terms()[0]["id"]
    r = client.post("/api/blitz-score", json={"scenario": "A shop.", "answers": [{"term_id": tid, "response": "x"}]})
    assert r.status_code == 200
    assert bumped == ["blitz"]


def test_failed_grade_does_not_count(monkeypatch):
    bumped = []

    async def record(kind):
        bumped.append(kind)

    def fail(*a, **k):
        raise llm.LLMError("nope")

    monkeypatch.setattr(stats, "bump", record)
    monkeypatch.setattr(llm, "complete_json", fail)
    tid = terms.all_terms()[0]["id"]
    r = client.post("/api/blitz-score", json={"scenario": "A shop.", "answers": [{"term_id": tid, "response": "x"}]})
    assert r.status_code == 502
    assert bumped == []


def test_blitz_verdicts_survive_one_based_indexes(monkeypatch):
    async def noop(kind):
        pass

    monkeypatch.setattr(stats, "bump", noop)
    monkeypatch.setattr(llm, "complete_json", lambda *a, **k: {"results": [
        {"index": 1, "verdict": "correct"}, {"index": 2, "verdict": "partial"}]})
    ids = [t["id"] for t in terms.all_terms()[:2]]
    r = client.post("/api/blitz-score", json={"scenario": "A shop.", "answers": [{"term_id": i, "response": "x"} for i in ids]})
    assert [x["verdict"] for x in r.json()["results"]] == ["correct", "partial"]
