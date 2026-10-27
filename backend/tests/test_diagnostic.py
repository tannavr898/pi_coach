"""The diagnostic: a balanced fixed-length test, scored by domain with a "not sure".

The bands are the claim the product makes to a student ("you have this", "work on
this"), so the thresholds and the gap/misconception split are tested directly.
"""

from __future__ import annotations

import random

from fastapi.testclient import TestClient

from app import courses, diagnostic, events, plan
from app.main import app

EVENT = "principles-marketing"


def _answer(q: dict, how: str) -> dict:
    right = next(o["id"] for o in q["options"] if o["correct"])
    wrong = next(o["id"] for o in q["options"] if not o["correct"])
    return {"question_id": q["id"], "choice": {"right": right, "wrong": wrong, "unsure": "unsure"}[how]}


def _built(level: str = "district", **kw) -> list[dict]:
    return diagnostic.build(EVENT, level, rng=random.Random(1), **kw)


def test_test_is_fixed_length_and_balanced_across_the_exam_domains():
    qs = _built()
    domains, _ = diagnostic.domains_for_event(EVENT)
    assert len(qs) == diagnostic.TEST_LENGTH
    counts = {d: sum(q["domain_id"] == d for q in qs) for d in domains}
    assert set(counts) == set(domains)
    assert max(counts.values()) - min(counts.values()) <= 1
    assert min(counts.values()) >= diagnostic.MIN_PER_DOMAIN


def test_no_two_questions_share_a_study_card():
    seen: set[str] = set()
    for q in _built():
        t = set(q["term_ids"])
        assert not t & seen
        seen |= t


def test_retake_avoids_the_previous_questions():
    first = {q["id"] for q in _built()}
    second = {q["id"] for q in _built(exclude=first)}
    assert not first & second


def test_every_event_and_level_yields_a_full_test():
    for ev in events.all_events():
        for level in ("district", "state", "icdc"):
            assert len(diagnostic.build(ev["id"], level)) == diagnostic.TEST_LENGTH, (ev["id"], level)


def test_quotas_spread_spare_questions_to_the_earliest_domains():
    assert diagnostic.quotas(["a", "b", "c", "d"], 30) == {"a": 8, "b": 8, "c": 7, "d": 7}
    assert diagnostic.quotas([], 30) == {}


def test_bands():
    assert diagnostic._band(4, 4, 0) == "mastered"
    assert diagnostic._band(4, 3, 0) == "mastered"       # one not-sure, nothing wrong
    assert diagnostic._band(4, 3, 1) == "developing"     # a wrong answer blocks mastery
    assert diagnostic._band(4, 2, 1) == "developing"
    assert diagnostic._band(4, 1, 2) == "needs_work"
    assert diagnostic._band(3, 0, 0) == "needs_work"
    assert diagnostic._band(0, 0, 0) == "developing"


def test_pattern_separates_gaps_from_misconceptions():
    assert diagnostic._pattern(0, 0) == ""
    assert diagnostic._pattern(0, 2) == "gaps"
    assert diagnostic._pattern(2, 0) == "misconceptions"
    assert diagnostic._pattern(3, 1) == "misconceptions"
    assert diagnostic._pattern(1, 3) == "gaps"
    assert diagnostic._pattern(2, 2) == "mixed"


def test_grade_counts_unsure_apart_from_wrong_and_never_credits_it():
    qs = _built()
    answers = [_answer(q, "right") for q in qs[:10]] + [_answer(q, "wrong") for q in qs[10:15]] \
        + [_answer(q, "unsure") for q in qs[15:]]
    g = diagnostic.grade(answers)
    assert (g["total"], g["correct"], g["unsure"]) == (30, 10, 15)
    assert sum(d["wrong"] for d in g["domains"]) == 5
    assert g["question_ids"] == [q["id"] for q in qs]


def test_grade_ignores_unknown_ids_dupes_and_junk_choices():
    q = _built()[0]
    g = diagnostic.grade([
        {"question_id": "nope", "choice": "a"},
        {"question_id": q["id"], "choice": "zzz"},      # not an option: counts as not sure
        {"question_id": q["id"], "choice": "a"},        # duplicate: first one wins
    ])
    assert g["total"] == 1 and g["unsure"] == 1 and g["correct"] == 0


def test_all_right_is_all_mastered_and_weakest_domains_sort_first():
    qs = _built()
    g = diagnostic.grade([_answer(q, "right") for q in qs])
    assert {d["band"] for d in g["domains"]} == {"mastered"}
    first_domain = qs[0]["domain_id"]
    answers = [_answer(q, "wrong" if q["domain_id"] == first_domain else "right") for q in qs]
    g = diagnostic.grade(answers)
    assert g["domains"][0]["domain_id"] == first_domain and g["domains"][0]["band"] == "needs_work"


def test_misses_carry_their_cards_but_correct_answers_do_not():
    qs = _built()
    g = diagnostic.grade([_answer(q, "right") for q in qs])
    assert all(d["term_ids"] == [] for d in g["domains"])
    g = diagnostic.grade([_answer(q, "wrong") for q in qs])
    assert all(d["term_ids"] for d in g["domains"])


def test_study_marks_skip_unsure():
    qs = _built()[:3]
    g = diagnostic.grade([_answer(qs[0], "right"), _answer(qs[1], "wrong"), _answer(qs[2], "unsure")])
    marks = diagnostic.study_marks(g["review"])
    assert {m["verdict"] for m in marks} == {"correct", "missed"}
    marked = {m["term_id"] for m in marks}
    assert set(qs[0]["term_ids"]) | set(qs[1]["term_ids"]) == marked


def test_compare_reports_change_per_shared_domain():
    prev = [{"domain_id": "a", "asked": 4, "correct": 1}, {"domain_id": "b", "asked": 4, "correct": 2}]
    cur = [{"domain_id": "a", "asked": 4, "correct": 3}, {"domain_id": "c", "asked": 4, "correct": 4}]
    assert diagnostic.compare(prev, cur) == {"a": 0.5}


# --- plan ordering ---------------------------------------------------------------

def test_plan_puts_weak_domains_first_and_mastered_last_without_dropping_any():
    course = courses.course_for(EVENT)
    domains = [u["domain_id"] for u in course["units"]]
    weak_d, strong_d = domains[-1], domains[0]
    assert weak_d != strong_d
    rank = {weak_d: "needs_work", strong_d: "mastered"}
    base = plan._queue(course, "core", {}, [])
    ordered = plan._queue(course, "core", {}, [], rank)
    assert sorted(g["unit_id"] for g in base) == sorted(g["unit_id"] for g in ordered)
    weak_name = next(u["domain"] for u in course["units"] if u["domain_id"] == weak_d)
    strong_name = next(u["domain"] for u in course["units"] if u["domain_id"] == strong_d)
    assert ordered[0]["domain"] == weak_name
    assert ordered[-1]["domain"] == strong_name


def test_plan_order_is_unchanged_without_a_diagnostic():
    course = courses.course_for(EVENT)
    assert plan._queue(course, "core", {}, []) == plan._queue(course, "core", {}, [], {})


# --- endpoints -------------------------------------------------------------------

client = TestClient(app)


def test_served_test_withholds_the_key_and_the_rationales():
    r = client.get("/api/diagnostic", params={"event_id": EVENT, "level": "district"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["questions"]) == diagnostic.TEST_LENGTH
    for q in body["questions"]:
        for o in q["options"]:
            assert set(o) == {"id", "text"}


def test_unknown_event_is_a_404():
    assert client.get("/api/diagnostic", params={"event_id": "nope"}).status_code == 404
    r = client.post("/api/diagnostic", json={"event_id": "nope", "answers": [{"question_id": "x"}]})
    assert r.status_code == 404


def test_signed_out_submit_scores_and_returns_the_review_unsaved():
    qs = diagnostic.build(EVENT, "district", rng=random.Random(2))
    answers = [_answer(q, "right") for q in qs[:20]] + [_answer(q, "unsure") for q in qs[20:]]
    r = client.post("/api/diagnostic", json={"event_id": EVENT, "level": "district", "answers": answers})
    assert r.status_code == 200
    body = r.json()
    assert body["saved"] is False
    assert (body["total"], body["correct"], body["unsure"]) == (30, 20, 10)
    assert len(body["review"]) == 30 and any(o["correct"] for o in body["review"][0]["options"])


def test_submit_with_nothing_gradable_is_422():
    r = client.post("/api/diagnostic", json={"event_id": EVENT, "answers": [{"question_id": "nope", "choice": "a"}]})
    assert r.status_code == 422


def test_history_needs_an_account():
    assert client.get("/api/diagnostic/history").status_code in (401, 403, 503)  # 503: no accounts configured under test
