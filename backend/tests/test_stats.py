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
    assert r.json() == {"roleplays": 0, "blitzes": 0, "scenarios": 0, "show": False}


def test_landing_line_needs_enough_roleplays():
    assert not stats.public({"roleplay": stats.PUBLIC_MIN_ROLEPLAYS - 1})["show"]
    assert stats.public({"roleplay": stats.PUBLIC_MIN_ROLEPLAYS, "blitz": 3})["show"]


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
    assert first == again == {"roleplays": 500, "blitzes": 20, "scenarios": 90, "show": True}
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

    async def record(kind):
        called.append(kind)

    monkeypatch.setattr(db, "bump_stat", record)
    asyncio.run(stats.bump("roleplay"))  # accounts not configured
    assert called == []

    monkeypatch.setattr(config, "has_supabase", lambda: True)
    asyncio.run(stats.bump("not-a-kind"))
    assert called == []

    async def broken(kind):
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
