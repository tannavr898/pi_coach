"""The diagnostic: a fixed-length quiz that maps what a student knows by domain.

It is built from the same offline quiz bank as every other quiz, so serving and
scoring cost nothing: no model call, no key, open to signed-out visitors.

Three choices shape it:

    Balanced, not random. A plain quiz draw is dominated by whichever domains have
    the most questions, so a diagnostic that sampled it would say a lot about
    Marketing and almost nothing about Law. Each domain on the student's written
    exam gets an equal share of the test.

    "Not sure" is an answer. A guess that lands is not knowledge, and a student who
    knows they don't know something is in a different place from one who is
    confidently wrong. Not sure earns no credit, and is kept apart from a wrong
    answer all the way to the result, because the fix differs: a gap needs the idea
    taught, a misconception needs the wrong idea unlearned.

    Coarse on purpose. Three to five questions per domain separate "solid" from
    "lost" and nothing finer. Bands are therefore only three, and the bar for
    "mastered" is a clean sheet, since claiming mastery on thin evidence is the one
    error that costs the student something.

Pure functions only (no DB, no user), like progress.py and study.py.
"""

from __future__ import annotations

import random

from . import events, quiz

TEST_LENGTH = 30
MIN_PER_DOMAIN = 3

UNSURE = "unsure"
BANDS = ("mastered", "developing", "needs_work")


def domains_for_event(event_id: str) -> tuple[list[str], str]:
    """(domain ids on the student's written exam, the exam's name). The event's own
    domains come first, so any spare questions go to what its role-play draws on."""
    ev = events.get_event(event_id)
    if not ev:
        return [], ""
    exam = ev.get("exam") or ev.get("cluster", "")
    all_domains = events.domains_for_exam(exam)
    own = [d for d in ev.get("domain_ids", []) if d in all_domains]
    return own + [d for d in all_domains if d not in own], exam


def quotas(domain_ids: list[str], total: int = TEST_LENGTH) -> dict[str, int]:
    """Questions per domain: an even split, spare ones to the earliest domains."""
    n = len(domain_ids)
    if n == 0:
        return {}
    base, extra = divmod(total, n)
    return {d: base + (1 if i < extra else 0) for i, d in enumerate(domain_ids)}


def build(event_id: str, level: str, exclude: set[str] | None = None,
          rng: random.Random | None = None) -> list[dict]:
    """The test: balanced by domain, each question on a different study card, and
    skewed toward applied (scenario-style) questions over bare recognition.

    `exclude` is the previous attempt's questions. They are avoided while the bank
    has others, so a retake measures the topic and not the memory of last time.
    Returns the questions as stored (answer key included; main.py strips it).
    """
    rng = rng or random.Random()
    domains, _ = domains_for_event(event_id)
    exclude = exclude or set()
    used_terms: set[str] = set()
    out: list[dict] = []

    for domain, want in quotas(domains).items():
        pool = [q for q in quiz.all_questions() if q.get("domain_id") == domain and q["level"] == level]
        rng.shuffle(pool)
        fresh = [q for q in pool if q["id"] not in exclude]
        stale = [q for q in pool if q["id"] in exclude]
        applied = [q for q in fresh if q.get("format") != "recognition"]
        bare = [q for q in fresh if q.get("format") == "recognition"]
        # One in three is plain recall (at least one), the rest are applied.
        n_bare = min(len(bare), max(1, want // 3))
        order = bare[:n_bare] + applied + bare[n_bare:] + stale
        picked: list[dict] = []
        for q in order:
            qt = set(q.get("term_ids") or [])
            if qt & used_terms:
                continue
            picked.append(q)
            used_terms |= qt
            if len(picked) == want:
                break
        out.extend(picked)

    rng.shuffle(out)
    return out


def _band(asked: int, correct: int, wrong: int) -> str:
    if asked == 0:
        return "developing"
    ratio = correct / asked
    if ratio >= 0.75 and wrong == 0:
        return "mastered"
    if ratio < 0.5:
        return "needs_work"
    return "developing"


def _pattern(wrong: int, unsure: int) -> str:
    """What kind of weakness: ideas the student lacks, or ideas they have backwards."""
    if wrong == 0 and unsure == 0:
        return ""
    if wrong == 0:
        return "gaps"
    if unsure == 0:
        return "misconceptions"
    return "gaps" if unsure > wrong else "misconceptions" if wrong > unsure else "mixed"


def grade(answers: list[dict]) -> dict:
    """Score a finished test.

    `answers` is [{question_id, choice}] where choice is an option id or "unsure".
    An unknown question id is dropped (a stale client must not fail the whole
    test); a choice that is not one of the question's options counts as not sure.
    Returns the result shaped for storage and display.
    """
    per: dict[str, dict] = {}
    review: list[dict] = []
    seen: set[str] = set()
    for a in answers:
        qid = a.get("question_id", "")
        q = quiz.get_question(qid)
        if not q or qid in seen:
            continue
        seen.add(qid)
        options = {o["id"]: o for o in q.get("options", [])}
        choice = a.get("choice", UNSURE)
        if choice not in options:
            choice = UNSURE
        right = next((o for o in options.values() if o.get("correct")), None)
        outcome = UNSURE if choice == UNSURE else ("correct" if options[choice].get("correct") else "wrong")

        d = per.setdefault(q["domain_id"], {
            "domain_id": q["domain_id"], "name": q.get("domain", q["domain_id"]),
            "asked": 0, "correct": 0, "wrong": 0, "unsure": 0, "term_ids": []})
        d["asked"] += 1
        d[outcome] += 1
        if outcome != "correct":
            d["term_ids"] = sorted(set(d["term_ids"]) | set(q.get("term_ids") or []))
        review.append({
            "question_id": qid, "domain_id": q["domain_id"], "topic": q.get("topic", ""),
            "question": q["question"], "outcome": outcome, "choice": choice,
            "correct_id": right["id"] if right else "",
            "options": [{"id": o["id"], "text": o["text"], "correct": bool(o.get("correct")),
                         "rationale": o.get("rationale", "")} for o in q.get("options", [])],
            "term_ids": q.get("term_ids") or [],
        })

    domains = []
    for d in per.values():
        d["band"] = _band(d["asked"], d["correct"], d["wrong"])
        d["pattern"] = _pattern(d["wrong"], d["unsure"])
        domains.append(d)
    order = {b: i for i, b in enumerate(("needs_work", "developing", "mastered"))}
    domains.sort(key=lambda d: (order[d["band"]], d["correct"] / d["asked"] if d["asked"] else 0))

    return {
        "total": sum(d["asked"] for d in domains),
        "correct": sum(d["correct"] for d in domains),
        "unsure": sum(d["unsure"] for d in domains),
        "domains": domains,
        "question_ids": [r["question_id"] for r in review],
        "review": review,
    }


def study_marks(review: list[dict]) -> list[dict]:
    """The progress events a finished test is worth: one quiz mark per answered
    card. Not-sure answers are skipped, because 'I don't know' is not evidence the
    student has met the card, and marking it would put untouched terms in
    'learning'. Same evidence rank as any quiz (see study.py): it can start a term
    and demote one, never finish one."""
    out: list[dict] = []
    for r in review:
        if r["outcome"] == UNSURE:
            continue
        verdict = "correct" if r["outcome"] == "correct" else "missed"
        for tid in r["term_ids"]:
            out.append({"term_id": tid, "evidence": "quiz", "verdict": verdict})
    return out


def domain_rank(result_domains: list[dict]) -> dict[str, str]:
    """{domain_id: band} for the study plan to order units by."""
    return {d["domain_id"]: d["band"] for d in result_domains}


def compare(previous: list[dict], current: list[dict]) -> dict[str, float]:
    """Per-domain change in the share answered correctly, previous to current, for
    domains present in both. Positive is progress."""
    prev = {d["domain_id"]: d for d in previous}
    out: dict[str, float] = {}
    for d in current:
        p = prev.get(d["domain_id"])
        if p and p["asked"] and d["asked"]:
            out[d["domain_id"]] = round(d["correct"] / d["asked"] - p["correct"] / p["asked"], 2)
    return out
