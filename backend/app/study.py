"""Study progress — the pure state machine behind one term's mastery.

Evidence is RANKED, because not all practice proves the same thing:

    flip      you looked at the card. Proves you saw it, nothing more.
    blitz     you used it under a 45-second clock and a model judged it.
    roleplay  you applied it inside a graded role-play. The strongest proof there is.

A term only reaches "known" on blitz-or-better, so clicking through the library at
speed cannot fake a finished course. That matters more here than it looks: the whole
promise of the Core path is "finish this and you know your event", and a path that
can be completed by tapping Next is not a promise, it's a progress bar.

Mastery can go DOWN. Missing a term you had known demotes it. This is the same value
the rest of the app already holds — progress.py breaks mastery ties toward the weaker
level, and the grader refuses to reward name-dropping — and a study path that only
ratchets upward would flatter a student in exactly the way we refuse to elsewhere.

Pure functions only: no DB, no user, no I/O. main.py reads the row, calls apply(),
writes it back. Same split as progress.py, and it keeps this unit-testable.
"""

from __future__ import annotations

Status = str      # new | learning | known
Evidence = str    # flip | blitz | roleplay
Verdict = str     # correct | partial | missed

STATUS_RANK = {"new": 0, "learning": 1, "known": 2}
EVIDENCE_RANK = {"flip": 0, "blitz": 1, "roleplay": 2}


def next_status(current: Status, evidence: Evidence, verdict: Verdict = "") -> Status:
    """The term's status after one study event."""
    if evidence == "flip":
        # Seeing a card can START a term moving but never finishes it, and never
        # un-proves something already demonstrated under pressure.
        return current if current in ("learning", "known") else "learning"
    if verdict == "correct":
        return "known"
    # partial / missed: honest demotion. A term you just missed is not "known".
    return "learning"


def next_evidence(current: Evidence, evidence: Evidence, verdict: Verdict = "") -> Evidence:
    """The strongest evidence that has actually PROVEN this term.

    A missed drill is not evidence of mastery, so only a correct verdict can raise
    this — otherwise a student who blitzed a term and failed would look, in the data,
    like a student who had demonstrated it.
    """
    if evidence != "flip" and verdict != "correct":
        return current or "flip"
    if not current:
        return evidence
    return evidence if EVIDENCE_RANK[evidence] > EVIDENCE_RANK.get(current, -1) else current


def apply(row: dict | None, term_id: str, evidence: Evidence, verdict: Verdict = "") -> dict:
    """Fold one study event into a term's row. `row` is None the first time.

    Returns the full row to upsert (never mutates the input).
    """
    current_status = (row or {}).get("status", "new")
    current_evidence = (row or {}).get("best_evidence", "")
    return {
        "term_id": term_id,
        "status": next_status(current_status, evidence, verdict),
        "best_evidence": next_evidence(current_evidence, evidence, verdict),
        "seen_count": (row or {}).get("seen_count", 0) + 1,
        "correct_count": (row or {}).get("correct_count", 0) + (1 if verdict == "correct" else 0),
    }
