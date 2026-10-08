"""Study plans, turn an event's course into a dated, daily schedule.

The course (courses.py) answers WHAT to study. It can't answer the question a
student with nine weeks until District actually has: "am I on track, and what do I
do today?" This module answers that from four inputs, the event, the competition
dates, the minutes they have on each weekday, and whether they're aiming for the
Core path or everything.

THE PLAN IS RECOMPUTED, NOT STORED. Only the inputs (plus a frozen copy of today's
tasks) live in the database. Every load re-runs `build_plan` over the student's
current progress, which is what makes three of the features free:

  - A missed day reschedules itself. Skipped work is still "remaining", so it
    spreads over the days that are left instead of piling up as a backlog.
  - Spaced review falls out of `last_seen_at` / `correct_count`, which study.py
    already records.
  - A skill a role-play graded low moves to the front of the queue the next time
    the plan loads.

TODAY IS FROZEN. If today were recomputed too, finishing a unit would slide the
next one into today while the student was still working, a checklist that grows
as you tick it. main.py stores today's tasks on first load of the day and passes
them back in as `frozen_today`.

Pure functions only: no DB, no clock, no user. main.py reads rows, converts
timestamps to the student's local dates, and calls in. Same split as progress.py
and study.py, and it keeps the scheduling rules unit-testable.

The time costs below are ESTIMATES, not measurements. They're deliberately round
so the plan reads as a plan, and they live here as named constants so there is
exactly one place to recalibrate them.
"""

from __future__ import annotations

import hashlib
import math
import re
from datetime import date, datetime, timedelta, timezone

from . import courses, terms

# --- time costs (estimates; see module docstring) ---------------------------
LEARN_MIN_PER_TERM = 1.5   # flip a card, read the example
BLITZ_MIN = 5              # one Mastery Blitz round
TERMS_PER_BLITZ = 5        # matches blitz.tsx: a drill takes a random 5 of what it's given
ROLEPLAY_MIN = 20          # prep + present + read the feedback
QUIZ_MIN = 8               # one Knowledge Check round at its default ten questions, no clock

# --- scheduling rules ---------------------------------------------------------
# Review is capped during the learn phase so it can never crowd out new material;
# once the queue is empty ("sharpen") it may take whatever time is left.
REVIEW_SHARE = 0.25
MIN_BUDGET_FOR_REVIEW = 15
# The last days before a competition carry no new terms: new material the night
# before a role-play is noise, and a mock run is worth more.
TAPER_DAYS = 4
TAPER_DAYS_SHORT = 2       # when the whole runway is under SHORT_RUNWAY_DAYS
SHORT_RUNWAY_DAYS = 21
ROLEPLAY_EVERY = {"learn": 7, "sharpen": 2}
FIRST_ROLEPLAY_AFTER = 3   # a brand-new plan leads with learning, not a cold rep
# Written exam rehearsal, on its own cadence. More often than a role-play because
# it costs nothing to serve (the bank is pre-generated, app/quiz.py) and because
# the cluster exam is a separate skill from the role-play: a competitor who has
# only ever practiced presenting walks into the written half cold. Tightens as the
# date approaches, which is when knowing where the gaps are is worth most.
QUIZ_EVERY = {"learn": 5, "sharpen": 3}
FIRST_QUIZ_AFTER = 2       # early enough to expose gaps while there is time to fix them
# Role-plays with a real person: a teammate, an advisor, a parent playing the
# judge. The app can rehearse the content, but not the room: eye contact, a
# handshake, a human who interrupts. The plan aims for six to eight of them
# before the first competition and spreads them over the days that are left, so
# skipping one pulls the rest closer together instead of dropping it.
LIVE_MIN = 20
LIVE_TARGET_RANGE = (6, 8)
LIVE_FULL_TARGET_DAYS = 42   # six weeks or more of runway: aim for the top of the range
LIVE_MIN_GAP = 2             # never two days running; it takes another person's time
FIRST_LIVE_AFTER = 4         # a few days' notice to line someone up
LIVE_EVERY_AFTER_FIRST = 7   # between later stages (State to ICDC): keep one a week
KEEP_SHARP_BATCHES = 2     # sharpen-phase filler, so free days aren't empty
DETAIL_DAYS = 14
HISTORY_KEEP = 60
MAX_HORIZON_DAYS = 400
MAX_DAY_MINUTES = 240
WEAK_LEVELS = ("novice", "developing")
# "Tight" = the core path finishes in the last 15% of the learning runway.
TIGHT_FRACTION = 0.85


def review_interval(correct_count: int) -> int:
    """Days until a proven term is due again. Widens as it keeps being right."""
    if correct_count <= 1:
        return 3
    if correct_count == 2:
        return 7
    return 14


# --- conversions main.py uses --------------------------------------------------

_FRACTION = re.compile(r"(\.\d{6})\d+")


def local_date_of(iso: str | None, tz_offset_min: int) -> date | None:
    """A stored UTC timestamp as a date on the student's own calendar.

    `tz_offset_min` is JavaScript's getTimezoneOffset(): minutes to ADD to local
    time to reach UTC (positive west of Greenwich). Taking the offset from the
    browser avoids a tzdata dependency on the server for a one-number job.
    """
    if not iso:
        return None
    s = _FRACTION.sub(r"\1", iso.strip().replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(timezone.utc) - timedelta(minutes=tz_offset_min)).date()


def progress_map(rows: list[dict], tz_offset_min: int) -> dict[str, dict]:
    """study_progress rows -> {term_id: {status, correct_count, last_seen}}."""
    return {
        r["term_id"]: {
            "status": r.get("status", "new"),
            "correct_count": int(r.get("correct_count") or 0),
            "last_seen": local_date_of(r.get("last_seen_at"), tz_offset_min),
        }
        for r in rows
        if r.get("term_id")
    }


def session_dates(rows: list[dict], tz_offset_min: int) -> list[date]:
    """Local dates of completed role-plays, oldest first."""
    out = [local_date_of(r.get("created_at"), tz_offset_min) for r in rows]
    return sorted(d for d in out if d)


def live_dates(rows: list[dict], tz_offset_min: int) -> list[date]:
    """Local dates of role-plays done with a real person, oldest first. These are
    activity rows of kind "live", the one thing in the plan a student reports
    themselves: there is no way for the app to see it happen."""
    out = [local_date_of(r.get("created_at"), tz_offset_min) for r in rows if r.get("kind") == "live"]
    return sorted(d for d in out if d)


def weak_criteria(mastery: list[dict]) -> list[dict]:
    """Criteria a student keeps landing low on, weakest first (mastery is pre-sorted)."""
    return [
        {"criterion_id": m["criterion_id"], "name": m.get("name", m["criterion_id"])}
        for m in mastery
        if m.get("consistent_level") in WEAK_LEVELS
    ]


# --- validation -------------------------------------------------------------------


def validate_inputs(inputs: dict, today: date) -> str | None:
    """A student-readable reason the inputs can't make a plan, or None if they can."""
    if not courses.course_for(inputs.get("event_id", "")):
        return "Pick an event first."
    stages = inputs.get("stages") or []
    dates = [_as_date(s["date"]) for s in stages]
    if not any(d > today for d in dates):
        return "Add at least one competition date after today."
    if any(d > today + timedelta(days=MAX_HORIZON_DAYS) for d in dates):
        return "Competition dates need to be within about a year."
    minutes = inputs.get("day_minutes") or []
    if len(minutes) != 7 or any(m < 0 or m > MAX_DAY_MINUTES for m in minutes):
        return "Study time must be between 0 and 4 hours a day."
    if not any(minutes):
        return "Pick at least one day with study time."
    return None


# --- the planner ------------------------------------------------------------------


def _as_date(v: date | str) -> date:
    return v if isinstance(v, date) else date.fromisoformat(v)


def _weekday(d: date) -> int:
    """0 = Sunday, to match the day_minutes array (and JavaScript's getDay)."""
    return (d.weekday() + 1) % 7


def _task_id(kind: str, day: date, term_ids: list[str]) -> str:
    raw = f"{kind}|{day.isoformat()}|{','.join(term_ids)}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _task(kind: str, day: date, title: str, detail: str, minutes: int, *,
          term_ids: list[str] | None = None, unit_id: str = "", criterion_name: str = "",
          tier: str = "") -> dict:
    ids = list(term_ids or [])
    return {
        "id": _task_id(kind, day, ids),
        "kind": kind,
        "title": title,
        "detail": detail,
        "minutes": int(minutes),
        "term_ids": ids,
        "unit_id": unit_id,
        "criterion_name": criterion_name,
        "tier": tier,
    }


def _live_plan(stages: list[dict], today: date, done: int) -> dict:
    """How many live role-plays to aim for before the first competition still
    ahead, and how far apart that puts them from here."""
    first = next((s for s in stages if s["date"] > today), None)
    if not first:
        return {"until": None, "target": 0, "left": 0, "gap": LIVE_EVERY_AFTER_FIRST}
    runway = (first["date"] - today).days
    taper = TAPER_DAYS_SHORT if runway < SHORT_RUNWAY_DAYS else TAPER_DAYS
    open_days = max(0, runway - taper)
    lo, hi = LIVE_TARGET_RANGE
    target = hi if open_days >= LIVE_FULL_TARGET_DAYS else lo + (hi - lo) * open_days // LIVE_FULL_TARGET_DAYS
    # A short runway can't hold six without doubling up; it gets what fits.
    left = min(max(0, target - done), open_days // LIVE_MIN_GAP)
    gap = max(LIVE_MIN_GAP, open_days // left) if left else LIVE_EVERY_AFTER_FIRST
    # The target shown is the one this runway can actually reach.
    return {"until": first["date"], "target": done + left, "left": left, "gap": gap}


def _learn_cost(n: int) -> int:
    return math.ceil(n * LEARN_MIN_PER_TERM) + BLITZ_MIN


def _stages(inputs: dict, today: date) -> list[dict]:
    out = [
        {"name": (s.get("name") or "Competition").strip()[:40], "date": _as_date(s["date"])}
        for s in inputs.get("stages") or []
    ]
    out.sort(key=lambda s: s["date"])
    for s in out:
        s["days_left"] = (s["date"] - today).days
        s["past"] = s["date"] <= today
    return out


def _queue(course: dict, goal: str, state: dict[str, dict], weak: list[dict]) -> list[dict]:
    """Remaining work as ordered groups. Weak skills first, then the core path in
    course order, then (goal "all") the extended tier. Never re-sorted beyond that:
    the course's own order is the order a student studies in."""
    def unproven(tid: str) -> bool:
        return state.get(tid, {}).get("status") != "known"

    in_course = {tid for u in course["units"] for tid in u["core_ids"]}
    weak_names: dict[str, str] = {}
    weak_terms: list[str] = []
    for w in weak:
        t = terms.term_for_criterion(w["criterion_id"])
        if t and t["id"] in in_course and unproven(t["id"]) and t["id"] not in weak_names:
            weak_names[t["id"]] = w["name"]
            weak_terms.append(t["id"])

    groups: list[dict] = []
    for i in range(0, len(weak_terms), TERMS_PER_BLITZ):
        ids = weak_terms[i : i + TERMS_PER_BLITZ]
        groups.append({"kind": "weak", "tier": "core", "unit_id": "", "topic": "", "domain": "",
                       "term_ids": ids, "names": [weak_names[t] for t in ids]})

    taken = set(weak_terms)
    tiers = ["core", "extended"] if goal == "all" else ["core"]
    for tier in tiers:
        for u in course["units"]:
            ids = [t for t in u[f"{tier}_ids"] if unproven(t) and t not in taken]
            if ids:
                groups.append({"kind": "learn", "tier": tier, "unit_id": u["id"], "topic": u["topic"],
                               "domain": u["domain"], "term_ids": ids, "names": []})
    return groups


def _phase(day: date, stages: list[dict], queue: list[dict], today: date) -> tuple[str, dict | None]:
    """(phase, target stage) for a day. Phases: competition | taper | learn | sharpen | done."""
    for s in stages:
        if s["date"] == day:
            return "competition", s
    target = next((s for s in stages if s["date"] > day), None)
    if target is None:
        return "done", None
    runway = (target["date"] - today).days
    taper = TAPER_DAYS_SHORT if runway < SHORT_RUNWAY_DAYS else TAPER_DAYS
    if (target["date"] - day).days <= taper:
        return "taper", target
    return ("learn" if queue else "sharpen"), target


def _apply_learn(state: dict[str, dict], ids: list[str], day: date) -> None:
    for tid in ids:
        st = state.setdefault(tid, {"status": "new", "correct_count": 0, "last_seen": None})
        st["status"] = "known"
        st["correct_count"] = st.get("correct_count", 0) + 1
        st["last_seen"] = day


def _due_reviews(state: dict[str, dict], day: date, course_ids: set[str]) -> list[str]:
    due = []
    for tid in course_ids:
        st = state.get(tid)
        if not st or st.get("status") != "known" or not st.get("last_seen"):
            continue
        overdue = (day - st["last_seen"]).days - review_interval(st.get("correct_count", 0))
        if overdue >= 0:
            due.append((-overdue, tid))
    return [tid for _, tid in sorted(due)]


def _sharpen_pool(state: dict[str, dict], day: date, course_ids: set[str], used: set[str]) -> list[str]:
    """Seen-but-unproven terms first (a Blitz proves them), then the proven terms
    that are weakest and longest-unseen."""
    learning = sorted(t for t in course_ids if state.get(t, {}).get("status") == "learning" and t not in used)
    known = [t for t in course_ids if state.get(t, {}).get("status") == "known" and t not in used]
    known.sort(key=lambda t: (state[t].get("correct_count", 0), state[t].get("last_seen") or date.min, t))
    return learning + known


def _remove_from_queue(queue: list[dict], ids: set[str]) -> None:
    for g in queue:
        g["term_ids"] = [t for t in g["term_ids"] if t not in ids]
    queue[:] = [g for g in queue if g["term_ids"]]


def _fill_day(day: date, budget: int, phase: str, target: dict | None, queue: list[dict],
              state: dict[str, dict], course_ids: set[str], ctx: dict) -> list[dict]:
    tasks: list[dict] = []
    if budget <= 0 or phase in ("competition", "done"):
        return tasks
    remaining = budget
    stage_name = target["name"] if target else "competition"

    if phase == "taper":
        mins = min(ROLEPLAY_MIN, remaining)
        tasks.append(_task("mock", day, "Mock competition run",
                           f"Full timing, as if it were {stage_name}. Present out loud if you can.", mins))
        remaining -= mins
        ctx["last_roleplay"] = day
        # A mock run rehearses the presentation. The written exam is the other
        # half of the day and nothing else in the taper touches it.
        if remaining >= QUIZ_MIN:
            tasks.append(_task("quiz", day, "Practice test",
                               f"Cluster-wide multiple choice, ICDC difficulty. The written half of {stage_name}.",
                               QUIZ_MIN, tier="icdc"))
            remaining -= QUIZ_MIN
            ctx["last_quiz"] = day
        used: set[str] = set()
        while remaining >= BLITZ_MIN:
            batch = _sharpen_pool(state, day, course_ids, used)[:TERMS_PER_BLITZ]
            if not batch:
                break
            used.update(batch)
            tasks.append(_task("review", day, "Final review",
                               f"{len(batch)} terms, one quick Blitz. Recall under pressure, not new material.",
                               BLITZ_MIN, term_ids=batch))
            _apply_learn(state, batch, day)
            remaining -= BLITZ_MIN
        return tasks

    # A role-play with a real person, on its own spacing. Before the first
    # competition that spacing is whatever fits the target into the days left;
    # after it, one a week. It stands in for the solo rep on the day it lands.
    had_live = False
    live = ctx["live"]
    before_first = bool(target and live["until"] and target["date"] == live["until"])
    due_gap = live["gap"] if before_first else LIVE_EVERY_AFTER_FIRST
    if (live["left"] > 0 or not before_first) and (day - ctx["last_live"]).days >= due_gap:
        mins = min(LIVE_MIN, remaining)
        if before_first:
            live["left"] -= 1
            live["n"] += 1
            count = f"Number {live['n']} of {live['target']} before {stage_name}."
        else:
            count = f"One a week keeps the room familiar before {stage_name}."
        tasks.append(_task("live", day, "Role-play with a real person",
                           "Ask a teammate, your advisor or a parent to play the judge. Present out loud, "
                           f"shake hands, take their questions. {count}", mins))
        remaining -= mins
        ctx["last_live"] = day
        had_live = True

    # Role-play on cadence. A day shorter than a full rep still gets one, it just
    # takes the whole day, or a 15-minutes-a-day student would never practice.
    last = ctx["last_roleplay"]
    if not had_live and remaining > 0 and (day - last).days >= ROLEPLAY_EVERY[phase]:
        mins = min(ROLEPLAY_MIN, remaining)
        focus = ctx["weak_names"][0] if ctx["weak_names"] else ""
        title = f"Role-play: {focus}" if focus else "Role-play"
        detail = ("Run a full rep and use the terms you've been proving. Typed reps are always unlimited."
                  if mins >= ROLEPLAY_MIN else
                  "Short on time today: skim the prep and present. Typed reps are always unlimited.")
        tasks.append(_task("roleplay", day, title, detail, mins, criterion_name=focus))
        remaining -= mins
        ctx["last_roleplay"] = day

    # Practice test on its own cadence. Placed before review and new material so a
    # short day still gets it: it is the cheapest task on the board and the only
    # one that rehearses the written exam.
    if (day - ctx["last_quiz"]).days >= QUIZ_EVERY[phase] and remaining >= QUIZ_MIN:
        level = "state" if phase == "learn" else "icdc"
        tasks.append(_task("quiz", day, "Practice test",
                           "Cluster-wide multiple choice, the written half of competing. "
                           "Every answer explains itself, so a miss tells you what to study next.",
                           QUIZ_MIN, tier=level))
        remaining -= QUIZ_MIN
        ctx["last_quiz"] = day

    # Spaced review.
    if phase == "sharpen":
        cap = remaining
    elif budget >= MIN_BUDGET_FOR_REVIEW:
        cap = max(BLITZ_MIN, int(budget * REVIEW_SHARE))
    else:
        cap = 0
    due = _due_reviews(state, day, course_ids)
    spent = 0
    while due and remaining >= BLITZ_MIN and spent + BLITZ_MIN <= cap:
        batch, due = due[:TERMS_PER_BLITZ], due[TERMS_PER_BLITZ:]
        tasks.append(_task("review", day, "Review: keep it fresh",
                           f"{len(batch)} terms you've proven, back for a quick Blitz so they stick.",
                           BLITZ_MIN, term_ids=batch))
        _apply_learn(state, batch, day)
        remaining -= BLITZ_MIN
        spent += BLITZ_MIN

    # New material, in chunks a single Blitz can prove.
    while queue and remaining > BLITZ_MIN:
        head = queue[0]
        n = min(TERMS_PER_BLITZ, len(head["term_ids"]))
        while n > 0 and _learn_cost(n) > remaining:
            n -= 1
        # No one-term slivers of a bigger unit; leave it for a day with room.
        if n < 1 or (n < 2 and len(head["term_ids"]) > 1):
            break
        ids = head["term_ids"][:n]
        head["term_ids"] = head["term_ids"][n:]
        if not head["term_ids"]:
            queue.pop(0)
        cost = _learn_cost(n)
        if head["kind"] == "weak":
            names = ", ".join(head["names"][:n])
            tasks.append(_task("weak", day, "Shore up what your role-plays flagged",
                               f"{names}. Study the cards, then Blitz them.", cost,
                               term_ids=ids, tier="core"))
        else:
            deeper = " (deeper pass)" if head["tier"] == "extended" else ""
            tasks.append(_task("learn", day, head["topic"],
                               f"{n} terms from {head['domain']}{deeper}. Flip through the cards, then Blitz them to prove it.",
                               cost, term_ids=ids, unit_id=head["unit_id"], tier=head["tier"]))
        _apply_learn(state, ids, day)
        ctx["proven_core" if head["tier"] == "core" else "proven_extended"].append((day, n))
        remaining -= cost

    if phase == "sharpen":
        used = set()
        for _ in range(KEEP_SHARP_BATCHES):
            if remaining < BLITZ_MIN:
                break
            batch = _sharpen_pool(state, day, course_ids, used)[:TERMS_PER_BLITZ]
            if not batch:
                break
            used.update(batch)
            tasks.append(_task("review", day, "Keep it sharp",
                               f"{len(batch)} terms that could use another rep. One quick Blitz.",
                               BLITZ_MIN, term_ids=batch))
            _apply_learn(state, batch, day)
            remaining -= BLITZ_MIN
    return tasks


def _simulate(course: dict, inputs: dict, progress: dict[str, dict], weak: list[dict], today: date, *,
              frozen_today: list[dict] | None = None, last_roleplay: date | None = None,
              live: list[date] | None = None, scale: float = 1.0, until: date | None = None) -> dict:
    stages = _stages(inputs, today)
    # Reps already reported, not counting today's: today's own task is either in
    # the frozen list or about to be planned, and must not count itself as done.
    live_before = [d for d in (live or []) if d < today]
    live_plan = {**_live_plan(stages, today, len(live_before)), "n": len(live_before)}
    state = {k: dict(v) for k, v in progress.items()}
    queue = _queue(course, inputs.get("goal", "core"), state, weak)
    core_remaining = sum(len(g["term_ids"]) for g in queue if g["tier"] == "core")
    tiers = ["core", "extended"] if inputs.get("goal") == "all" else ["core"]
    course_ids = {tid for u in course["units"] for t in tiers for tid in u[f"{t}_ids"]}
    ctx = {
        "last_roleplay": last_roleplay or today - timedelta(days=ROLEPLAY_EVERY["learn"] - FIRST_ROLEPLAY_AFTER),
        # Not persisted the way last_roleplay is. A role-play is expensive enough
        # that the cadence has to survive a reload; a practice test is free, so
        # starting every simulation from the same offset is both simpler and
        # harmless, the worst case is one extra test.
        "last_quiz": today - timedelta(days=QUIZ_EVERY["learn"] - FIRST_QUIZ_AFTER),
        "live": live_plan,
        # With none done yet, the first lands a few days out (or sooner, when the
        # spacing itself is shorter than that).
        "last_live": live_before[-1] if live_before
        else today - timedelta(days=max(0, live_plan["gap"] - FIRST_LIVE_AFTER)),
        "weak_names": [w["name"] for w in weak],
        "proven_core": [],
        "proven_extended": [],
    }
    minutes = inputs["day_minutes"]
    end = max((s["date"] for s in stages), default=today)
    if until:
        end = min(end, until)
    end = min(end, today + timedelta(days=MAX_HORIZON_DAYS))

    days: list[dict] = []
    day = today
    while day <= end:
        phase, target = _phase(day, stages, queue, today)
        if phase == "done":
            break
        budget = min(MAX_DAY_MINUTES, int(round(minutes[_weekday(day)] * scale)))
        if day == today and frozen_today is not None:
            tasks = frozen_today
            done_ids = {t for task in tasks if task["kind"] in ("learn", "weak") for t in task["term_ids"]}
            for task in tasks:
                if task["kind"] in ("learn", "weak"):
                    n = sum(1 for t in task["term_ids"] if t in {x for g in queue for x in g["term_ids"]})
                    ctx["proven_core" if task.get("tier", "core") == "core" else "proven_extended"].append((day, n))
                if task["term_ids"]:
                    _apply_learn(state, task["term_ids"], day)
                if task["kind"] in ("roleplay", "mock"):
                    ctx["last_roleplay"] = day
                if task["kind"] == "quiz":
                    ctx["last_quiz"] = day
                if task["kind"] == "live":
                    ctx["last_live"] = day
                    if ctx["live"]["left"] > 0:
                        ctx["live"]["left"] -= 1
                        ctx["live"]["n"] += 1
            _remove_from_queue(queue, done_ids)
        else:
            tasks = _fill_day(day, budget, phase, target, queue, state, course_ids, ctx)
        days.append({
            "date": day,
            "weekday": _weekday(day),
            "budget": budget if phase != "competition" else 0,
            "planned": sum(t["minutes"] for t in tasks),
            "phase": phase,
            "stage": target["name"] if phase == "competition" and target else "",
            "tasks": tasks,
        })
        day += timedelta(days=1)

    return {"stages": stages, "days": days, "core_remaining": core_remaining,
            "live_target": live_plan["target"],
            "proven_core": ctx["proven_core"], "proven_extended": ctx["proven_extended"],
            "extended_remaining": sum(len(g["term_ids"]) for g in _queue(course, "all", progress, weak) if g["tier"] == "extended")}


def _finish_date(proven: list[tuple[date, int]], total: int) -> date | None:
    count = 0
    for d, n in proven:
        count += n
        if count >= total:
            return d
    return None


def _fmt(d: date) -> str:
    return f"{d.strftime('%b')} {d.day}"


def _feasibility(course: dict, inputs: dict, progress: dict, weak: list[dict], today: date,
                 sim: dict, last_roleplay: date | None, frozen_today: list[dict] | None,
                 live: list[date] | None = None) -> dict:
    stages = [s for s in sim["stages"] if s["date"] > today]
    first = stages[0] if stages else None
    remaining = sim["core_remaining"]
    finish = _finish_date(sim["proven_core"], remaining) if remaining else today
    out = {
        "status": "done",
        "message": "",
        "core_remaining": remaining,
        "core_by_first_stage": 0,
        "core_finish_date": finish.isoformat() if finish else None,
        "needed_minutes_per_day": None,
        "full_finish_date": None,
    }
    if inputs.get("goal") == "all" and sim["extended_remaining"]:
        full = _finish_date(sim["proven_extended"], sim["extended_remaining"])
        out["full_finish_date"] = full.isoformat() if full else None
    if not first:
        return out
    out["core_by_first_stage"] = min(remaining, sum(n for d, n in sim["proven_core"] if d < first["date"]))

    if remaining == 0:
        out["message"] = (f"Your core path is already proven. The plan until {first['name']} is review "
                          "and role-plays, so it stays sharp.")
        return out

    runway = (first["date"] - today).days
    taper = TAPER_DAYS_SHORT if runway < SHORT_RUNWAY_DAYS else TAPER_DAYS
    learn_days = max(1, runway - taper)
    if finish and finish < first["date"]:
        used = (finish - today).days + 1
        if used / learn_days > TIGHT_FRACTION:
            out["status"] = "tight"
            out["message"] = (f"Tight but doable: you'll prove the core path by {_fmt(finish)}, just before "
                              f"{first['name']}. A missed day or two will push it close.")
        else:
            out["status"] = "on_track"
            out["message"] = (f"On track: you'll prove the core path by {_fmt(finish)}, "
                              f"{(first['date'] - finish).days} days before {first['name']}.")
        return out

    out["status"] = "behind"
    pct = round(100 * out["core_by_first_stage"] / remaining)
    needed = _needed_minutes(course, inputs, progress, weak, today, first["date"], remaining,
                             last_roleplay, frozen_today, live)
    if needed:
        out["needed_minutes_per_day"] = needed
        out["message"] = (f"At this pace you'll prove about {pct}% of the core path by {first['name']}. "
                          f"About {needed} minutes on each study day covers all of it.")
    else:
        out["message"] = (f"At this pace you'll prove about {pct}% of the core path by {first['name']}. "
                          "There aren't enough days left to cover all of it, so the plan starts with the "
                          "skills your role-plays flagged and your event's main discipline.")
    return out


def _needed_minutes(course: dict, inputs: dict, progress: dict, weak: list[dict], today: date,
                    stage_date: date, remaining: int, last_roleplay: date | None,
                    frozen_today: list[dict] | None, live: list[date] | None = None) -> int | None:
    """The per-study-day minutes that would finish the core path before the first
    competition, or None if no realistic amount would (runway too short)."""
    active = [m for m in inputs["day_minutes"] if m > 0]
    if not active:
        return None
    avg = sum(active) / len(active)

    def ok(scale: float) -> bool:
        sim = _simulate(course, inputs, progress, weak, today, frozen_today=frozen_today,
                        last_roleplay=last_roleplay, live=live, scale=scale, until=stage_date)
        f = _finish_date(sim["proven_core"], remaining)
        return bool(f and f < stage_date)

    hi = MAX_DAY_MINUTES / min(active)
    if not ok(hi):
        return None
    lo = 1.0
    for _ in range(14):
        mid = (lo + hi) / 2
        if ok(mid):
            hi = mid
        else:
            lo = mid
    return int(min(MAX_DAY_MINUTES, math.ceil(avg * hi / 5) * 5))


def _weeks(days: list[dict]) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(days), 7):
        chunk = days[i : i + 7]
        phases = [d["phase"] for d in chunk if d["phase"] != "competition"]
        if "taper" in phases:
            phase = "taper"
        elif phases:
            phase = max(set(phases), key=lambda p: (phases.count(p), p == "learn"))
        else:
            phase = "competition"
        tasks = [t for d in chunk for t in d["tasks"]]
        out.append({
            "start": chunk[0]["date"].isoformat(),
            "end": chunk[-1]["date"].isoformat(),
            "phase": phase,
            "new_terms": sum(len(t["term_ids"]) for t in tasks if t["kind"] in ("learn", "weak")),
            "reviews": sum(1 for t in tasks if t["kind"] == "review"),
            "roleplays": sum(1 for t in tasks if t["kind"] in ("roleplay", "mock")),
            "live": sum(1 for t in tasks if t["kind"] == "live"),
            "minutes": sum(d["planned"] for d in chunk),
            "stages": [d["stage"] for d in chunk if d["stage"]],
        })
    return out


def _phase_runs(days: list[dict], today: date) -> list[dict]:
    """Contiguous phases as day offsets from today (end exclusive), for the runway.
    A competition day extends the run it sits in rather than splitting it."""
    runs: list[dict] = []
    for d in days:
        offset = (d["date"] - today).days
        phase = d["phase"]
        if phase == "competition" and runs:
            runs[-1]["end_day"] = offset + 1
            continue
        if runs and runs[-1]["phase"] == phase and runs[-1]["end_day"] == offset:
            runs[-1]["end_day"] = offset + 1
        else:
            runs.append({"phase": phase, "start_day": offset, "end_day": offset + 1})
    return runs


_CALENDAR_LABEL = {
    "quiz": "Practice test",
    "weak": "Shore up flagged skills",
    "review": "Review Blitz",
    "roleplay": "Role-play",
    "live": "Role-play with a real person",
    "mock": "Mock competition run",
}


def _calendar(days: list[dict]) -> list[dict]:
    """One line per study day and competition, for the .ics export. A snapshot:
    the plan adapts, which the export tells the student."""
    out: list[dict] = []
    for d in days:
        if d["phase"] == "competition":
            out.append({"date": d["date"].isoformat(), "kind": "competition", "minutes": 0,
                        "summary": f"{d['stage']} competition"})
        elif d["tasks"]:
            parts: list[str] = []
            for t in d["tasks"]:
                label = f"Learn {t['title']}" if t["kind"] == "learn" else _CALENDAR_LABEL[t["kind"]]
                if label not in parts:
                    parts.append(label)
            out.append({"date": d["date"].isoformat(), "kind": "study", "minutes": d["planned"],
                        "summary": ", ".join(parts)})
    return out


def _day_out(d: dict) -> dict:
    return {**d, "date": d["date"].isoformat()}


def build_plan(inputs: dict, progress: dict[str, dict], weak: list[dict], today: date, *,
               frozen_today: list[dict] | None = None, last_roleplay: date | None = None,
               live: list[date] | None = None) -> dict | None:
    """The whole plan for a student, from today through their last competition.

    `progress` is `progress_map()` output; `weak` is `weak_criteria()` output;
    `live` is `live_dates()` output. Returns None for an unknown event.
    """
    course = courses.course_for(inputs.get("event_id", ""))
    if not course:
        return None
    sim = _simulate(course, inputs, progress, weak, today, frozen_today=frozen_today,
                    last_roleplay=last_roleplay, live=live)
    days = sim["days"]
    today_day = days[0] if days and days[0]["date"] == today else {
        "date": today, "weekday": _weekday(today), "budget": 0, "planned": 0,
        "phase": "done", "stage": "", "tasks": [],
    }
    return {
        "event_id": course["event_id"],
        "event": course["event"],
        "goal": inputs.get("goal", "core"),
        "day_minutes": list(inputs["day_minutes"]),
        "stages": [{**s, "date": s["date"].isoformat()} for s in sim["stages"]],
        "feasibility": _feasibility(course, inputs, progress, weak, today, sim, last_roleplay, frozen_today, live),
        "live_done": len(live or []),
        "live_target": sim["live_target"],
        "today": _day_out(today_day),
        "days": [_day_out(d) for d in days[:DETAIL_DAYS]],
        "weeks": _weeks(days),
        "phases": _phase_runs(days, today),
        "calendar": _calendar(days),
    }


# --- completion + the daily snapshot ---------------------------------------------


def task_status(task: dict, progress: dict[str, dict], sessions_on_day: int, day: date,
                roleplay_index: int = 0, live_on_day: int = 0) -> dict:
    """Overlay how far a student has got on one task. Derived from progress, never
    self-reported: a learn task is done when its terms are PROVEN (study.py's rule),
    not when the cards were flipped. The one exception is a role-play with a real
    person, which only the student can tell us happened."""
    ids = task.get("term_ids") or []
    kind = task["kind"]
    if kind in ("learn", "weak"):
        known = sum(1 for t in ids if progress.get(t, {}).get("status") == "known")
        seen = sum(1 for t in ids if progress.get(t, {}).get("status") == "learning")
        return {**task, "progress_done": known, "progress_total": len(ids), "seen": seen,
                "done": bool(ids) and known == len(ids)}
    if kind == "review":
        fresh = sum(1 for t in ids if (progress.get(t, {}).get("last_seen") or date.min) >= day)
        return {**task, "progress_done": fresh, "progress_total": len(ids), "seen": 0,
                "done": bool(ids) and fresh == len(ids)}
    done = live_on_day > 0 if kind == "live" else sessions_on_day > roleplay_index
    return {**task, "progress_done": int(done), "progress_total": 1, "seen": 0, "done": done}


def overlay_status(tasks: list[dict], progress: dict[str, dict], sessions: list[date], day: date,
                   live: list[date] | None = None) -> list[dict]:
    on_day = sum(1 for s in sessions if s == day)
    live_on_day = sum(1 for d in (live or []) if d == day)
    out, rp = [], 0
    for t in tasks:
        out.append(task_status(t, progress, on_day, day, rp, live_on_day))
        if t["kind"] in ("roleplay", "mock"):
            rp += 1
    return out


def rollover(history: list[dict], frozen_date: date | None, frozen_tasks: list[dict] | None,
             progress: dict[str, dict], sessions: list[date], live: list[date] | None = None) -> list[dict]:
    """Score the last frozen day into history before today's tasks replace it.

    Scored against CURRENT progress, so a unit finished a day late still counts as
    done for the day it was assigned. That is slightly generous, and deliberately so:
    the history is there to show a student they've been showing up, not to audit them.
    """
    hist = [h for h in (history or []) if h.get("date") != (frozen_date.isoformat() if frozen_date else None)]
    if frozen_date and frozen_tasks:
        scored = overlay_status(frozen_tasks, progress, sessions, frozen_date, live)
        hist.append({"date": frozen_date.isoformat(), "planned": len(scored),
                     "done": sum(1 for t in scored if t["done"])})
    hist.sort(key=lambda h: h["date"])
    return hist[-HISTORY_KEEP:]
