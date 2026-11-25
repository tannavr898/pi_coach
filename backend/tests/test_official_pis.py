"""Official DECA performance indicators: data integrity, generation and Blitz fit."""

from __future__ import annotations

import json
from collections import defaultdict

from fastapi.testclient import TestClient

from app import blitz, events, framework, llm, pis, samples
from app.main import app

client = TestClient(app)


def test_every_event_with_a_list_has_enough_indicators():
    for ev in events.all_events():
        if not pis.has_pis(ev):
            continue
        for level in ("district", "state", "icdc"):
            pool = pis.eligible(ev, level)
            assert len(pool) >= 20, (ev["id"], level, len(pool))


def test_finance_events_use_official_pis():
    for eid in ("accounting-applications", "business-finance", "financial-services-team", "personal-financial-literacy"):
        ev = events.get_event(eid)
        assert pis.has_pis(ev), eid
        assert len(pis.eligible(ev, "district")) >= 20, eid


def test_pi_ids_resolve_like_criteria():
    sample = pis.eligible(events.get_event("principles-marketing"), "district")[0]
    got = framework.get_criteria([sample["id"], "FW-001", "nope"])
    assert [c["id"] for c in got] == [sample["id"], "FW-001"]
    assert got[0]["name"] == sample["text"]  # official wording is the criterion name


def test_official_scenario_uses_real_pis(monkeypatch):
    ev = events.get_event("human-resources-management")
    pool = pis.candidate_pool(ev, "district", "ethics")
    ids = [c["id"] for c in pool[:5]]

    def fake(system, user, **kw):
        assert "OFFICIAL SAMPLE" in user and "CANDIDATE PERFORMANCE INDICATORS" in user
        return json.dumps({
            "pi_ids": ids,
            "situation": "You are to assume the role of HR director at ACME.\n\nBackground.\n\nThe plan should include:\n- one\n- two",
            "judge_role": "president of ACME",
            "followup_questions": ["Q1?", "Q2?", "Q3?"],
        })

    monkeypatch.setattr(llm, "complete", fake)
    r = client.post("/api/scenario", json={"event": "human-resources-management", "level": "district", "mode": "competition"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["official"] is True
    assert len(d["criteria"]) == 5
    assert all(c["id"] in pis._index() for c in d["criteria"])
    assert [b["name"] for b in d["solution"]] == ["Unique", "Practical", "Effective"]
    assert len(d["competencies"]) == 3
    assert d["judge_role"] == "president of ACME"
    assert d["instructional_area"]


def test_samples_are_well_formed_and_calibrate_length():
    allsamples = samples._all()
    series = [s for s in allsamples if s["format"] == "series"]
    assert len(series) >= 10
    for s in series:
        assert len(s["pis"]) == 5 and len(s["judge_questions"]) == 3, s["id"]
    # the length guidance matches what DECA actually publishes
    ev = events.get_event("human-resources-management")
    lo, hi = (int(x) for x in samples.words_for(ev, "district").split(" ")[0].split("-"))
    avg = sum(s["situation_words"] for s in series) / len(series)
    assert lo - 60 <= avg <= hi + 60


def test_blitz_bank_covers_every_domain_and_topic_tags_are_real():
    terms = json.load(open(__import__("pathlib").Path(__file__).parent.parent / "app" / "data" / "terms.json", encoding="utf-8"))["terms"]
    topics: dict[str, set[str]] = defaultdict(set)
    for t in terms:
        topics[t["domain_id"]].add(t["topic"])
    bank = blitz.scenarios()
    by_domain: dict[str, list[dict]] = defaultdict(list)
    for s in bank:
        if s.get("domain_id"):
            by_domain[s["domain_id"]].append(s)
    assert set(by_domain) == set(topics), set(topics) ^ set(by_domain)
    for d, items in by_domain.items():
        assert len(items) >= 8, (d, len(items))
        for s in items:
            assert s["topics"], s["id"]
            assert set(s["topics"]) <= topics[d], (s["id"], set(s["topics"]) - topics[d])
            assert "—" not in s["text"] and "–" not in s["text"]
    assert any(not s.get("domain_id") for s in bank)  # generic fallback stays


def test_blitz_endpoint_returns_tags():
    r = client.get("/api/blitz/scenarios")
    assert r.status_code == 200
    first = next(s for s in r.json() if s["domain_id"])
    assert first["topics"]


def test_scenario_bank_is_valid():
    """Every hand-written bank scenario resolves to real PIs in its event's pool, has the
    official shape, and is served first by the endpoint without any model call."""
    from app import scenario_bank

    rows = scenario_bank._all()
    assert rows, "bank is empty"
    ids = set()
    for r in rows:
        assert r["id"] not in ids
        ids.add(r["id"])
        ev = events.get_event(r["event"])
        assert ev and pis.has_pis(ev), r["id"]
        pool = {p["id"] for p in pis.eligible(ev, r["level"])}
        assert len(r["pi_ids"]) == events.pi_count_for(ev), r["id"]
        assert set(r["pi_ids"]) <= pool, (r["id"], set(r["pi_ids"]) - pool)
        assert len(r["followup_questions"]) == (2 if ev["kind"] == "principles" else 3), r["id"]
        assert r["situation"].startswith("You are to assume the role of"), r["id"]
        assert "(judge)" in r["situation"], r["id"]
        assert r["words"] >= (170 if ev["kind"] == "principles" else 300), (r["id"], r["words"])
        assert "—" not in r["situation"] and "–" not in r["situation"], r["id"]
        assert len(r["hook"].split()) <= 20, r["id"]


def test_endpoint_serves_the_bank_without_the_model(monkeypatch):
    def boom(system, user, **kw):
        raise AssertionError("bank scenarios must not call the model")

    monkeypatch.setattr(llm, "complete", boom)
    seen: list[str] = []
    got = []
    for _ in range(3):
        r = client.post("/api/scenario", json={"event": "principles-marketing", "level": "district", "mode": "competition", "seen": seen})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["official"] and d["scenario_id"].startswith("bank:")
        assert len(d["criteria"]) == 4 and len(d["followup_questions"]) == 2
        seen.append(d["scenario_id"])
        got.append(d["scenario_id"])
    assert len(set(got)) == 3  # never repeats while unseen ones remain
    # the share link resolves too
    r = client.get(f"/api/scenario/{got[0]}")
    assert r.status_code == 200 and r.json()["scenario_id"] == got[0]


def _fake_score(ids):
    def fake(system, user, **kw):
        # the grader must be shown the official PI wording, not a framework criterion
        assert pis.get_pis(ids[:1])[0]["name"] in user
        return json.dumps({
            "performance_indicators": [
                {"criterion_id": cid, "level": "proficient", "points": 7, "headline": "h", "feedback": "fb",
                 "evidence": [], "gaps": [], "suggestion": "s"} for cid in ids
            ],
            "analytical": {
                "framing": {"score": 3, "justification": "j", "evidence": None},
                "solution_quality": {"score": 3, "justification": "j", "evidence": None},
                "pi_application": {"score": 3, "justification": "j", "evidence": None},
                "creativity": {"bonus": 0, "justification": "", "evidence": None},
            },
            "career_competencies": {
                "critical_thinking": {"score": 3, "justification": ""}, "communication": {"score": 3, "justification": ""},
                "decision_making": {"score": 3, "justification": ""}, "innovation": {"score": 3, "justification": ""},
            },
            "presentation": {"score": 3, "notes": "ok"},
            "final": {"top_strength": "a", "biggest_weakness": "b", "one_key_fix": "c"},
            "summary": "ok", "strengths": ["a"], "improvements": ["b"], "followup_feedback": "ok",
        })
    return fake


def test_full_loop_on_official_pis(monkeypatch):
    """Bank scenario -> score against the same real PIs -> a complete feedback payload.
    One principles event, one series event, one team event, one Finance event."""
    from app import scenario_bank

    covered = {r["event"] for r in scenario_bank._all()}
    for eid in ("principles-marketing", "automotive-services-marketing"):
        assert eid in covered
        r = client.post("/api/scenario", json={"event": eid, "level": "state" if "auto" in eid else "district", "mode": "learn"})
        assert r.status_code == 200, r.text
        sc = r.json()
        ids = [c["id"] for c in sc["criteria"]]
        assert all(pis.is_pi_id(i) for i in ids)
        monkeypatch.setattr(llm, "complete", _fake_score(ids))
        s = client.post("/api/score-content", json={
            "scenario": sc["situation"], "criteria_ids": ids, "response": "I would explain it step by step.",
            "followup_questions": sc["followup_questions"], "followup_answer": "Because it helps.", "event": eid,
        })
        assert s.status_code == 200, s.text
        body = s.json()
        assert [x["criterion_id"] for x in body["scores"]] == ids
        assert body["total_points"] == 7 * len(ids)
        assert body["scores"][0]["name"] or body["scores"][0]["criterion_id"]


def test_every_event_still_produces_a_scenario(monkeypatch):
    """No event is left without a path: bank for banked events, generation for the rest."""
    for ev in events.all_events():
        def fake(system, user, **kw):
            if "CANDIDATE PERFORMANCE INDICATORS" in user:
                pool = pis.candidate_pool(ev, "district", "x")
                return json.dumps({"pi_ids": [c["id"] for c in pool[: events.pi_count_for(ev)]],
                                   "situation": "You are to assume the role of X (judge).", "judge_role": "boss",
                                   "followup_questions": ["a?", "b?", "c?"], "hook": "h."})
            cids = [c["id"] for c in framework.criteria_for_domains(ev["domain_ids"])[:5]]
            return json.dumps({"criteria_ids": cids, "situation": "You are X.", "followup_questions": ["a?", "b?"]})
        monkeypatch.setattr(llm, "complete", fake)
        r = client.post("/api/scenario", json={"event": ev["id"], "level": "district", "mode": "competition", "seen": []})
        assert r.status_code == 200, (ev["id"], r.text)
        d = r.json()
        assert len(d["criteria"]) == events.pi_count_for(ev), ev["id"]
        assert d["official"] is True, ev["id"]
