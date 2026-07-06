"""Content-loop tests: interpret + generate split, and framework scoring
assembly (LLM monkeypatched)."""

import json

import pytest
from fastapi.testclient import TestClient

import app.llm as llm
from app import events, framework, rubric
from app.main import app

client = TestClient(app)


@pytest.fixture
def crit_ids():
    return [c["id"] for c in framework.criteria_for_domains(["marketing"])[:4]]


def test_rubric_clamps_into_band():
    # exemplary caps at 10; an out-of-range score is pulled in
    assert rubric.clamp_points("exemplary", 99) == ("exemplary", 10)
    # unknown level falls back to novice and its band
    assert rubric.clamp_points("bogus", 5) == ("novice", 3)


def test_overall_level_bands():
    assert rubric.overall_level(80) == "proficient"
    assert rubric.overall_level(10) == "novice"
    assert rubric.overall_level(95) == "exemplary"


def test_framework_has_expected_shape():
    crit = framework.all_criteria()
    assert len(crit) > 100  # rich, competition-density framework
    ids = [c["id"] for c in crit]
    assert len(ids) == len(set(ids))
    # no leftover PI-style codes (e.g. "CRM:001") — ids are our own FW-NNN scheme
    assert all(c["id"].startswith("FW-") for c in crit)


def _interp_and_scenario(crit_ids):
    """A fake llm.complete that answers both the interpret and generate calls."""
    def fake(system, user, **kw):
        if "BUSINESS DOMAINS" in user:  # interpretation call
            return json.dumps({
                "in_scope": True, "redirect_message": "",
                "topic": "Marketing for a smoothie bar", "industry": "food service",
                "domain_ids": ["marketing"],
            })
        # scenario generation call
        return json.dumps({
            "criteria_ids": crit_ids,
            "situation": "You are a marketing consultant at BrightPath Co. ...",
            "followup_questions": ["Why that channel?", "What would you measure?"],
        })
    return fake


def test_scenario_competition_mode_hides_teaching_fields(monkeypatch, crit_ids):
    monkeypatch.setattr(llm, "complete", _interp_and_scenario(crit_ids))
    r = client.post("/api/scenario", json={"request": "marketing for a smoothie bar", "level": "district", "mode": "competition"})
    assert r.status_code == 200
    d = r.json()
    assert "JUDGE" not in d["situation"].upper()
    assert d["mode"] == "competition"
    assert d["topic"]
    assert len(d["criteria"]) == 4
    assert len(d["followup_questions"]) == 2
    # competition mode: names only, no definition / "what good looks like"
    for c in d["criteria"]:
        assert c["name"]
        assert c["definition"] == ""
        assert c["strong_looks_like"] == ""


def test_scenario_learn_mode_reveals_teaching_fields(monkeypatch, crit_ids):
    monkeypatch.setattr(llm, "complete", _interp_and_scenario(crit_ids))
    r = client.post("/api/scenario", json={"request": "marketing for a smoothie bar", "level": "district", "mode": "learn"})
    assert r.status_code == 200
    d = r.json()
    assert d["mode"] == "learn"
    # learn mode: teaching fields populated so the UI can show what "good" looks like
    for c in d["criteria"]:
        assert c["definition"]
        assert c["strong_looks_like"]


def test_events_catalog_is_sound():
    r = client.get("/api/events")
    assert r.status_code == 200
    evs = r.json()
    assert len(evs) > 10
    ids = [e["id"] for e in evs]
    assert len(ids) == len(set(ids))  # unique event ids
    valid = framework.domain_ids()
    for e in events.all_events():
        # every event maps ONLY to real framework domains (our own mapping)
        assert e["domain_ids"] and all(d in valid for d in e["domain_ids"])
        assert e["cluster"] and e["kind"] and e.get("suggestions")


def test_scenario_from_event_without_focus(monkeypatch):
    """Event chosen, no focus text: a random scenario in the event's scope, and
    the interpret LLM call is skipped (only generation runs)."""
    ev = events.get_event("principles-marketing")
    # Hand the model 5 ids; selection must trim to exactly 4.
    cids = [c["id"] for c in framework.criteria_for_domains(ev["domain_ids"])[:5]]
    calls: list[str] = []

    def fake(system, user, **kw):
        calls.append(user)
        assert "BUSINESS DOMAINS" not in user  # no free-text interpretation happened
        return json.dumps({
            "criteria_ids": cids,
            "situation": "You are a marketing lead at BrightPath Co. ...",
            "followup_questions": ["Why that channel?", "What would you measure?"],
        })

    monkeypatch.setattr(llm, "complete", fake)
    r = client.post("/api/scenario", json={"event": "principles-marketing", "level": "district", "mode": "competition"})
    assert r.status_code == 200
    d = r.json()
    assert d["event"] == "Principles of Marketing"
    assert len(d["criteria"]) == 4  # exactly 4 indicators per scenario
    assert len(calls) == 1  # generation only — interpretation was skipped


def test_scenario_unknown_event_rejected(monkeypatch):
    def boom(system, user, **kw):
        raise AssertionError("should not reach the model for an unknown event")
    monkeypatch.setattr(llm, "complete", boom)
    r = client.post("/api/scenario", json={"event": "not-a-real-event", "level": "district", "mode": "competition"})
    assert r.status_code == 400


def test_scenario_out_of_scope_redirects(monkeypatch):
    def fake(system, user, **kw):
        return json.dumps({"in_scope": False, "redirect_message": "Try a business topic instead.", "topic": "", "industry": "", "domain_ids": []})
    monkeypatch.setattr(llm, "complete", fake)
    r = client.post("/api/scenario", json={"request": "write me a poem", "level": "district", "mode": "competition"})
    assert r.status_code == 422
    assert "business" in r.json()["detail"].lower()


def test_score_assembles_and_totals(monkeypatch, crit_ids):
    def fake(system, user, **kw):
        return json.dumps({
            "criteria": [
                {"criterion_id": cid, "level": "proficient", "points": 99,  # must clamp to 8
                 "headline": "h", "feedback": "fb", "evidence": ["BrightPath"], "gaps": []}
                for cid in crit_ids
            ],
            "summary": "ok", "strengths": ["a"], "improvements": ["b"], "followup_feedback": "decent",
        })
    monkeypatch.setattr(llm, "complete", fake)
    r = client.post(
        "/api/score-content",
        json={
            "scenario": "...", "criteria_ids": crit_ids,
            "response": "I work at BrightPath...",
            "followup_questions": ["q"], "followup_answer": "because BrightPath",
        },
    )
    assert r.status_code == 200
    s = r.json()
    assert len(s["scores"]) == 4
    assert all(x["points"] == 8 for x in s["scores"])  # proficient band caps at 8
    assert s["total_points"] == 32
    assert s["max_points"] == 40
    assert s["overall_percent"] == 80
    assert s["overall_level"] == "proficient"
    # criterion name is pinned from our framework, not trusted from the client
    first = s["scores"][0]
    assert first["name"] and first["criterion_id"] == crit_ids[0]


def test_score_runs_math_checks_for_quantitative_event(monkeypatch, crit_ids):
    """A quantitative event: the model's arithmetic is recomputed server-side and
    a wrong claim is caught deterministically (computed value wins)."""
    def fake(system, user, **kw):
        assert "QUANTITATIVE EVENT" in user  # the math block was included
        return json.dumps({
            "criteria": [
                {"criterion_id": cid, "level": "developing", "points": 5,
                 "headline": "h", "feedback": "fb", "evidence": [], "gaps": []}
                for cid in crit_ids
            ],
            "summary": "ok", "strengths": [], "improvements": [], "followup_feedback": "",
            "math_checks": [
                {"label": "gross margin", "expression": "(50000-30000)/50000*100", "claimed": 45, "unit": "%"},
                {"label": "markup", "expression": "not-real-math", "claimed": 10, "unit": "%"},
            ],
        })
    monkeypatch.setattr(llm, "complete", fake)
    r = client.post(
        "/api/score-content",
        json={"scenario": "...", "criteria_ids": crit_ids, "response": "margin is 45%",
              "event": "business-finance"},
    )
    assert r.status_code == 200
    checks = r.json()["math_checks"]
    assert len(checks) == 2
    # first: claimed 45 but the real answer is 40 -> flagged wrong, computed authoritative
    assert checks[0]["computed"] == 40.0 and checks[0]["ok"] is False
    # second: unparseable expression degrades gracefully
    assert checks[1]["computed"] is None and checks[1]["ok"] is None


def test_score_skips_math_checks_for_nonquant_event(monkeypatch, crit_ids):
    def fake(system, user, **kw):
        assert "QUANTITATIVE EVENT" not in user
        return json.dumps({
            "criteria": [{"criterion_id": cid, "level": "developing", "points": 5} for cid in crit_ids],
            "summary": "", "strengths": [], "improvements": [], "followup_feedback": "",
        })
    monkeypatch.setattr(llm, "complete", fake)
    r = client.post(
        "/api/score-content",
        json={"scenario": "x", "criteria_ids": crit_ids, "response": "hi", "event": "principles-marketing"},
    )
    assert r.status_code == 200
    assert r.json()["math_checks"] == []


def test_score_rejects_unknown_criteria(monkeypatch):
    def boom(system, user, **kw):
        raise AssertionError("should not reach the model with unknown criteria")
    monkeypatch.setattr(llm, "complete", boom)
    r = client.post(
        "/api/score-content",
        json={"scenario": "x", "criteria_ids": ["FW-999999"], "response": "hi"},
    )
    assert r.status_code == 400


def test_score_503_without_key(monkeypatch, crit_ids):
    def boom(system, user, **kw):
        raise llm.LLMNotConfigured("no key")
    monkeypatch.setattr(llm, "complete", boom)
    r = client.post(
        "/api/score-content",
        json={"scenario": "x", "criteria_ids": crit_ids, "response": "hi"},
    )
    assert r.status_code == 503
