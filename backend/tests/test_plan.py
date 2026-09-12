"""Study plan scheduling (pure)."""

from datetime import date, timedelta

from app import courses, plan, terms

TODAY = date(2026, 9, 14)  # a Monday
EVENT = "principles-marketing"


def inputs(days_out=90, minutes=30, goal="core", day_minutes=None, stages=None):
    return {
        "event_id": EVENT,
        "stages": stages or [{"name": "District", "date": (TODAY + timedelta(days=days_out)).isoformat()}],
        "day_minutes": day_minutes or [minutes] * 7,
        "goal": goal,
    }


def full_days(inp, progress=None, weak=None, today=TODAY, **kw):
    course = courses.course_for(inp["event_id"])
    return plan._simulate(course, inp, progress or {}, weak or [], today, **kw)["days"]


def all_tasks(days):
    return [t for d in days for t in d["tasks"]]


def test_no_day_exceeds_its_minutes():
    for minutes in (10, 15, 30, 45, 90):
        for d in full_days(inputs(minutes=minutes)):
            assert d["planned"] <= d["budget"], (minutes, d["date"], d["planned"])


def test_zero_minute_days_stay_empty():
    inp = inputs(day_minutes=[0, 30, 30, 30, 30, 30, 0])
    for d in full_days(inp):
        if d["weekday"] in (0, 6):
            assert d["tasks"] == [], d["date"]


def test_feasible_plan_schedules_every_core_term_before_the_competition():
    inp = inputs(days_out=120, minutes=60)
    p = plan.build_plan(inp, {}, [], TODAY)
    assert p["feasibility"]["status"] == "on_track"
    stage = TODAY + timedelta(days=120)
    learned = [t for d in full_days(inp) if d["date"] < stage for task in d["tasks"]
               if task["kind"] in ("learn", "weak") for t in task["term_ids"]]
    core = courses.course_term_ids(EVENT, "core")
    assert sorted(learned) == sorted(core)  # each exactly once


def test_learning_follows_course_order():
    learned = [t for task in all_tasks(full_days(inputs(days_out=120, minutes=60)))
               if task["kind"] == "learn" for t in task["term_ids"]]
    assert learned == courses.course_term_ids(EVENT, "core")


def test_infeasible_plan_is_honest_about_it():
    p = plan.build_plan(inputs(days_out=20, minutes=10), {}, [], TODAY)
    f = p["feasibility"]
    assert f["status"] == "behind"
    assert f["core_by_first_stage"] < f["core_remaining"]
    assert f["needed_minutes_per_day"] is None or f["needed_minutes_per_day"] > 10


def test_needed_minutes_actually_finishes_in_time():
    p = plan.build_plan(inputs(days_out=40, minutes=10), {}, [], TODAY)
    needed = p["feasibility"]["needed_minutes_per_day"]
    assert needed
    again = plan.build_plan(inputs(days_out=40, minutes=needed), {}, [], TODAY)
    assert again["feasibility"]["status"] in ("on_track", "tight")


def test_taper_days_have_no_new_material_and_a_mock():
    stage = TODAY + timedelta(days=60)
    for d in full_days(inputs(days_out=60, minutes=45)):
        if 0 < (stage - d["date"]).days <= plan.TAPER_DAYS:
            kinds = {t["kind"] for t in d["tasks"]}
            assert d["phase"] == "taper"
            assert not kinds & {"learn", "weak"}
            assert "mock" in kinds


def test_competition_day_is_empty():
    stage = TODAY + timedelta(days=30)
    day = next(d for d in full_days(inputs(days_out=30)) if d["date"] == stage)
    assert day["phase"] == "competition" and day["tasks"] == [] and day["stage"] == "District"


def test_review_waits_for_its_interval():
    core = courses.course_term_ids(EVENT, "core")
    due, not_due = core[0], core[1]
    progress = {
        due: {"status": "known", "correct_count": 1, "last_seen": TODAY - timedelta(days=3)},
        not_due: {"status": "known", "correct_count": 1, "last_seen": TODAY - timedelta(days=2)},
    }
    p = plan.build_plan(inputs(minutes=60), progress, [], TODAY)
    reviewed = {t for task in p["today"]["tasks"] if task["kind"] == "review" for t in task["term_ids"]}
    assert due in reviewed and not_due not in reviewed


def test_review_interval_widens():
    assert plan.review_interval(1) < plan.review_interval(2) < plan.review_interval(5)


def test_weak_skills_jump_the_queue():
    core = courses.course_term_ids(EVENT, "core")
    late = core[-1]
    crit = terms.get_term(late)["criterion_id"]
    weak = [{"criterion_id": crit, "name": "Late skill"}]
    p = plan.build_plan(inputs(minutes=30), {}, weak, TODAY)
    first = next(t for t in p["today"]["tasks"] if t["kind"] in ("learn", "weak"))
    assert first["kind"] == "weak" and late in first["term_ids"]


def test_missed_days_reschedule_instead_of_vanishing():
    inp = inputs(days_out=150, minutes=45)
    later = TODAY + timedelta(days=10)
    stage = TODAY + timedelta(days=150)
    learned = {t for d in full_days(inp, today=later) if d["date"] < stage
               for task in d["tasks"] if task["kind"] == "learn" for t in task["term_ids"]}
    assert learned == set(courses.course_term_ids(EVENT, "core"))


def test_known_terms_are_not_relearned():
    core = courses.course_term_ids(EVENT, "core")
    progress = {t: {"status": "known", "correct_count": 3, "last_seen": TODAY} for t in core[:20]}
    learned = {t for task in all_tasks(full_days(inputs(days_out=120, minutes=60), progress))
               if task["kind"] == "learn" for t in task["term_ids"]}
    assert not learned & set(core[:20])


def test_past_stages_are_skipped():
    stages = [
        {"name": "District", "date": (TODAY - timedelta(days=10)).isoformat()},
        {"name": "State", "date": (TODAY + timedelta(days=60)).isoformat()},
    ]
    p = plan.build_plan(inputs(stages=stages), {}, [], TODAY)
    assert p["stages"][0]["past"] and not p["stages"][1]["past"]
    assert p["today"]["phase"] == "learn"
    assert "State" in p["feasibility"]["message"]


def test_goal_all_adds_the_extended_tier_after_core():
    learned = [t for task in all_tasks(full_days(inputs(days_out=300, minutes=90, goal="all")))
               if task["kind"] == "learn" for t in task["term_ids"]]
    core = courses.course_term_ids(EVENT, "core")
    ext = courses.course_term_ids(EVENT, "extended")
    assert learned[: len(core)] == core
    assert set(learned[len(core):]) == set(ext)


def test_plan_is_deterministic():
    assert plan.build_plan(inputs(), {}, [], TODAY) == plan.build_plan(inputs(), {}, [], TODAY)


def test_every_drill_fits_one_blitz():
    for task in all_tasks(full_days(inputs(days_out=200, minutes=120))):
        assert len(task["term_ids"]) <= plan.TERMS_PER_BLITZ


def test_short_days_still_get_roleplays():
    kinds = [t["kind"] for t in all_tasks(full_days(inputs(days_out=90, minutes=15)))]
    assert "roleplay" in kinds


def test_frozen_today_is_kept():
    p = plan.build_plan(inputs(), {}, [], TODAY)
    frozen = p["today"]["tasks"]
    # Finishing a task must not pull the next unit into today.
    done = {t: {"status": "known", "correct_count": 1, "last_seen": TODAY} for t in frozen[0]["term_ids"]}
    again = plan.build_plan(inputs(), done, [], TODAY, frozen_today=frozen)
    assert [t["id"] for t in again["today"]["tasks"]] == [t["id"] for t in frozen]
    assert not set(frozen[0]["term_ids"]) & {x for d in again["days"][1:] for t in d["tasks"]
                                               if t["kind"] == "learn" for x in t["term_ids"]}


def test_learn_task_needs_proof_not_flips():
    task = {"id": "x", "kind": "learn", "term_ids": ["a", "b"]}
    flipped = {"a": {"status": "learning"}, "b": {"status": "learning"}}
    s = plan.task_status(task, flipped, 0, TODAY)
    assert not s["done"] and s["seen"] == 2
    proven = {"a": {"status": "known"}, "b": {"status": "known"}}
    assert plan.task_status(task, proven, 0, TODAY)["done"]


def test_rollover_scores_yesterday():
    yesterday = TODAY - timedelta(days=1)
    p = plan.build_plan(inputs(), {}, [], yesterday)
    tasks = p["today"]["tasks"]
    learn = next(t for t in tasks if t["kind"] in ("learn", "weak"))
    progress = {t: {"status": "known", "correct_count": 1, "last_seen": yesterday} for t in learn["term_ids"]}
    hist = plan.rollover([], yesterday, tasks, progress, [])
    assert hist == [{"date": yesterday.isoformat(), "planned": len(tasks), "done": 1}]
    # Rolling the same day twice doesn't double-count it.
    assert plan.rollover(hist, yesterday, tasks, progress, []) == hist


def test_local_date_uses_the_browser_offset():
    # 02:00 UTC is still the previous evening in UTC-5 (getTimezoneOffset = 300).
    assert plan.local_date_of("2026-09-13T02:00:00.123456+00:00", 300) == date(2026, 9, 12)
    assert plan.local_date_of("2026-09-13T02:00:00Z", -60) == date(2026, 9, 13)
    assert plan.local_date_of("garbage", 0) is None


def test_runway_phases_and_calendar_cover_the_horizon():
    p = plan.build_plan(inputs(days_out=60, minutes=30), {}, [], TODAY)
    runs = p["phases"]
    assert runs[0]["start_day"] == 0 and runs[-1]["end_day"] == 61
    assert all(a["end_day"] == b["start_day"] for a, b in zip(runs, runs[1:]))
    assert runs[-1]["phase"] == "taper"
    comp = [c for c in p["calendar"] if c["kind"] == "competition"]
    assert comp == [{"date": (TODAY + timedelta(days=60)).isoformat(), "kind": "competition",
                     "minutes": 0, "summary": "District competition"}]
    assert all(c["minutes"] > 0 for c in p["calendar"] if c["kind"] == "study")


def test_validation_messages():
    assert plan.validate_inputs(inputs(), TODAY) is None
    assert "after today" in plan.validate_inputs(inputs(days_out=0), TODAY)
    assert "at least one day" in plan.validate_inputs(inputs(minutes=0), TODAY)
    assert "within about a year" in plan.validate_inputs(inputs(days_out=500), TODAY)
    assert plan.validate_inputs({**inputs(), "event_id": "nope"}, TODAY)
