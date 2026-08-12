"""Course path assembly + the study-progress state machine (both pure)."""

import pytest

from app import courses, events, study, terms


# --- course assembly -------------------------------------------------------


def test_course_covers_exactly_the_events_domains():
    for e in events.all_events():
        course = courses.course_for(e["id"])
        assert course, e["id"]
        got = {u["domain_id"] for u in course["units"]}
        assert got == set(e["domain_ids"]), f"{e['id']}: {got} != {e['domain_ids']}"


def test_course_units_follow_event_domain_priority():
    """Domains must appear in the event's own order — the primary discipline first,
    not alphabetically — since that's the order a student studies in."""
    e = events.all_events()[0]
    course = courses.course_for(e["id"])
    seen: list[str] = []
    for u in course["units"]:
        if u["domain_id"] not in seen:
            seen.append(u["domain_id"])
    assert seen == list(e["domain_ids"])


def test_course_counts_add_up_and_units_are_non_empty():
    course = courses.course_for("principles-marketing")
    assert course["total"] == course["core_count"] + course["extended_count"]
    assert course["total"] == sum(len(u["core_ids"]) + len(u["extended_ids"]) for u in course["units"])
    for u in course["units"]:
        assert u["core_ids"] or u["extended_ids"], f"empty unit {u['id']}"


def test_core_tier_is_exactly_the_graded_terms():
    """The Core path's promise is "every skill we grade you on for this event" —
    if that drifts, the promise is a lie."""
    course = courses.course_for("human-resources-management")
    for u in course["units"]:
        for tid in u["core_ids"]:
            assert terms.get_term(tid)["criterion_id"], f"{tid} is core but ungraded"
        for tid in u["extended_ids"]:
            assert not terms.get_term(tid)["criterion_id"], f"{tid} is extended but graded"


def test_unknown_event_has_no_course():
    assert courses.course_for("not-an-event") is None
    assert courses.course_term_ids("not-an-event") == []


def test_course_term_ids_filters_by_tier():
    both = courses.course_term_ids("principles-marketing")
    core = courses.course_term_ids("principles-marketing", "core")
    ext = courses.course_term_ids("principles-marketing", "extended")
    assert len(both) == len(core) + len(ext)
    assert set(both) == set(core) | set(ext)
    assert not (set(core) & set(ext))


# --- progress overlay ------------------------------------------------------


def test_summarize_with_no_progress_reads_as_all_new():
    """The path has to render for a logged-out visitor, so "no account" and "brand
    new account" must look identical here."""
    course = courses.summarize(courses.course_for("principles-marketing"), {})
    assert course["percent"] == 0 and course["core_percent"] == 0
    assert course["known_count"] == 0
    assert not any(u["done"] for u in course["units"])


def test_summarize_counts_core_separately_from_the_whole_corpus():
    course = courses.course_for("principles-marketing")
    core_ids = courses.course_term_ids("principles-marketing", "core")
    out = courses.summarize(course, {tid: "known" for tid in core_ids})
    assert out["core_percent"] == 100                 # the promise is kept...
    assert out["core_known"] == out["core_count"]
    assert out["known_count"] == len(core_ids)        # ...and counted independently
    # Guarded, not assumed: this only says something once study-only terms exist.
    if out["extended_count"]:
        assert out["percent"] < 100                   # finishing Core != finishing all


def test_units_count_core_progress_separately_from_total():
    """The UI shows one tier at a time. If a unit only reported known/total over ALL
    its terms, a Core-path unit with 4 core and 4 extended terms would show "0/8" and
    could never reach 100% — the promised path would be unfinishable by construction.
    """
    course = courses.course_for("principles-marketing")
    mixed = next(u for u in course["units"] if u["core_ids"] and u["extended_ids"])
    out = courses.summarize(course, {tid: "known" for tid in mixed["core_ids"]})
    u = next(x for x in out["units"] if x["id"] == mixed["id"])

    assert u["core_total"] == len(mixed["core_ids"])
    assert u["core_known"] == u["core_total"]      # core finished...
    assert u["known"] < u["total"]                 # ...while the full unit isn't
    assert not u["done"]                           # `done` spans the whole unit


def test_summarize_marks_a_unit_done_only_when_every_term_is_known():
    course = courses.course_for("principles-marketing")
    unit = course["units"][0]
    ids = unit["core_ids"] + unit["extended_ids"]
    partial = courses.summarize(course, {tid: "known" for tid in ids[:-1]})
    assert not partial["units"][0]["done"]
    full = courses.summarize(courses.course_for("principles-marketing"), {tid: "known" for tid in ids})
    assert full["units"][0]["done"]


# --- the study state machine ----------------------------------------------


def test_flipping_a_card_can_start_a_term_but_never_finishes_it():
    """Otherwise tapping Next through the library would complete a course."""
    assert study.next_status("new", "flip") == "learning"
    assert study.next_status("learning", "flip") == "learning"
    # ...and it must not un-prove something already demonstrated under pressure.
    assert study.next_status("known", "flip") == "known"


@pytest.mark.parametrize("evidence", ["blitz", "roleplay"])
def test_a_correct_answer_proves_a_term(evidence):
    assert study.next_status("new", evidence, "correct") == "known"


@pytest.mark.parametrize("verdict", ["partial", "missed"])
def test_mastery_can_go_down(verdict):
    """A term you just missed is not "known". The rest of the app refuses to flatter
    a student; the study path must not either."""
    assert study.next_status("known", "blitz", verdict) == "learning"


def test_only_a_correct_answer_raises_the_evidence_bar():
    # A failed drill is not evidence of mastery.
    assert study.next_evidence("flip", "blitz", "missed") == "flip"
    assert study.next_evidence("flip", "blitz", "correct") == "blitz"
    # Evidence is a high-water mark: a later flip doesn't downgrade a proven term.
    assert study.next_evidence("roleplay", "flip", "") == "roleplay"
    assert study.next_evidence("blitz", "roleplay", "correct") == "roleplay"


def test_apply_folds_a_result_onto_a_fresh_row():
    row = study.apply(None, "FW-151", "blitz", "correct")
    assert row == {
        "term_id": "FW-151",
        "status": "known",
        "best_evidence": "blitz",
        "seen_count": 1,
        "correct_count": 1,
    }


def test_apply_accumulates_and_does_not_mutate_its_input():
    before = {"status": "learning", "best_evidence": "flip", "seen_count": 2, "correct_count": 1}
    snapshot = dict(before)
    after = study.apply(before, "FW-151", "roleplay", "correct")
    assert before == snapshot, "apply() must not mutate the caller's row"
    assert after["seen_count"] == 3 and after["correct_count"] == 2
    assert after["status"] == "known" and after["best_evidence"] == "roleplay"


def test_apply_counts_a_miss_as_seen_but_not_correct():
    after = study.apply({"status": "known", "best_evidence": "blitz", "seen_count": 5, "correct_count": 5},
                        "FW-151", "blitz", "missed")
    assert after["seen_count"] == 6 and after["correct_count"] == 5
    assert after["status"] == "learning"
