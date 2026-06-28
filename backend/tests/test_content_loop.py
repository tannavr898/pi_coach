"""Content-loop tests: scenario split + rubric scoring assembly (LLM monkeypatched)."""

import json

import pytest
from fastapi.testclient import TestClient

import app.llm as llm
from app import rubric
from app.main import app
from app.selection import select_pis

client = TestClient(app)


@pytest.fixture
def pi_ids():
    return [p["id"] for p in select_pis("PMK", seed=7)]


def test_rubric_clamps_into_band():
    # exemplary solution caps at 8; out-of-range score is pulled in
    assert rubric.clamp_points("solution", "exemplary", 99) == ("exemplary", 8)
    # unknown level falls back to novice and its band
    assert rubric.clamp_points("performance_indicator", "bogus", 5) == ("novice", 3)


def test_scenario_never_leaks_judge_text(monkeypatch, pi_ids):
    def fake(system, user, **kw):
        return json.dumps(
            {
                "situation": "You are a marketing assistant at BrightPath Co. ...",
                "followup_questions": ["Why?", "What next?"],
            }
        )

    monkeypatch.setattr(llm, "complete", fake)
    r = client.post("/api/scenario", json={"event_code": "PMK", "level": "district", "pi_ids": pi_ids})
    assert r.status_code == 200
    d = r.json()
    assert "JUDGE" not in d["situation"].upper()
    assert [c["key"] for c in d["solution_criteria"]] == ["unique", "practical", "effective"]
    assert len(d["career_competencies"]) == 3
    assert len(d["followup_questions"]) == 2
    assert d["instructional_area"]


def test_score_assembles_full_rubric_and_total(monkeypatch, pi_ids):
    def entry(level, pts):
        return {"level": level, "points": pts, "feedback": "fb", "evidence": ["BrightPath"]}

    def fake(system, user, **kw):
        return json.dumps(
            {
                "performance_indicators": [{"pi_id": pid, **entry("proficient", 9)} for pid in pi_ids],
                "solution": {
                    "unique": entry("developing", 4),
                    "practical": entry("proficient", 6),
                    "effective": entry("exemplary", 99),  # must clamp to 8
                },
                "career_competencies": {
                    "critical_thinking": entry("proficient", 5),
                    "communication": entry("developing", 3),
                    "decision_making": entry("novice", 1),
                },
                "overall_impression": entry("proficient", 8),
                "summary": "ok",
                "strengths": ["a"],
                "improvements": ["b"],
                "followup_feedback": "decent",
            }
        )

    monkeypatch.setattr(llm, "complete", fake)
    r = client.post(
        "/api/score-content",
        json={
            "event_code": "PMK",
            "scenario": "...",
            "pi_ids": pi_ids,
            "response": "I work at BrightPath...",
            "followup_questions": ["q"],
            "followup_answer": "because BrightPath",
        },
    )
    assert r.status_code == 200
    s = r.json()
    assert len(s["scores"]) == 11
    # 4*9 + (4+6+8) + (5+3+1) + 8 = 71
    assert s["total_points"] == 71
    eff = next(x for x in s["scores"] if x["key"] == "solution:effective")
    assert eff["points"] == 8  # clamped
    pi0 = next(x for x in s["scores"] if x["category"] == "performance_indicator")
    assert pi0["label"].startswith("Describe")  # pinned to official PI wording


def test_score_503_without_key(monkeypatch, pi_ids):
    def boom(system, user, **kw):
        raise llm.LLMNotConfigured("no key")

    monkeypatch.setattr(llm, "complete", boom)
    r = client.post(
        "/api/score-content",
        json={"event_code": "PMK", "scenario": "x", "pi_ids": pi_ids, "response": "hi"},
    )
    assert r.status_code == 503
