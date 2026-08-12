"""Independence guards for the study corpus.

Two kinds of test live here:

- Structural checks that always run. They are cheap and catch the things that
  would embarrass us fastest (a stray PI code, a corrupted term).
- The real text audit against DECA's PI list, which can only run on a machine that
  has backend/reference/. That directory is git-ignored and docker-ignored on
  purpose, so in CI and in the image these SKIP rather than fail. A skip here is
  the designed outcome, not a gap — the audit is a dev-time gate, and shipping
  without the licensed reference present is exactly the point.

See scripts/check_independence.py for what the thresholds mean and why shared
vocabulary is not evidence of anything.
"""

from __future__ import annotations

import re

import pytest

from app import framework, terms

# A PI-style code, e.g. "CRM:001" / "MK:LAW:007". Our ids never look like this.
_PI_CODE = re.compile(r"\b[A-Z]{2,4}:\d{3}\b")


# --- always-on structural guards -------------------------------------------


def test_framework_and_corpus_agree():
    """Every graded criterion has a study term, and every term's criterion resolves."""
    crit_ids = {c["id"] for c in framework.all_criteria()}
    linked = {t["criterion_id"] for t in terms.all_terms() if t.get("criterion_id")}
    assert linked <= crit_ids, f"terms point at criteria that don't exist: {linked - crit_ids}"
    assert crit_ids <= linked, f"graded criteria with no study term: {crit_ids - linked}"


def test_terms_are_well_formed():
    all_terms = terms.all_terms()
    ids = [t["id"] for t in all_terms]
    assert len(ids) == len(set(ids)), "duplicate term ids"
    for t in all_terms:
        assert t["tier"] in ("core", "extended"), f"{t['id']}: bad tier {t['tier']!r}"
        # core means "we grade this" — the tier and the link must not drift apart.
        assert (t["tier"] == "core") == bool(t.get("criterion_id")), (
            f"{t['id']}: tier={t['tier']} but criterion_id={t.get('criterion_id')!r}"
        )
        assert t["name"] and t["definition"], f"{t['id']}: missing name/definition"
        assert t["example"] and all(t["example"][b] for b in terms.BEATS), f"{t['id']}: incomplete beats"
        assert t["mistake"], f"{t['id']}: missing mistake"


def test_no_pi_codes_anywhere_in_the_corpus():
    """No DECA-style PI code leaked into a term's text or id."""
    for t in terms.all_terms():
        blob = " ".join(str(v) for v in t.values() if isinstance(v, str))
        assert not _PI_CODE.search(blob), f"{t['id']}: PI-style code in text"
        assert t["id"].startswith(("FW-", "T-")), f"{t['id']}: unexpected id scheme"


def test_definitions_are_student_facing_not_grading_questions():
    """A term's definition teaches; a criterion's definition is a grading question.
    Keeping them distinct is a deliberate anti-PI structural choice (framework-notes)."""
    for t in terms.all_terms():
        assert not t["definition"].lower().startswith("does the "), f"{t['id']}: grading question on a card"


def test_no_dashes_in_anything_a_student_reads():
    """House style: no em/en dashes in shipped copy. Regenerating cards is the way
    this regresses, so gen_terms.py's prompt bans them and this catches a slip."""
    bad = []
    for t in terms.all_terms():
        for k, v in t.items():
            vals = v.values() if isinstance(v, dict) else ([v] if isinstance(v, str) else [])
            for s in vals:
                if "—" in s or "–" in s:
                    bad.append(f"{t['id']}.{k}")
    for c in framework.all_criteria():
        for k, v in c.items():
            if isinstance(v, str) and ("—" in v or "–" in v):
                bad.append(f"{c['id']}.{k}")
    assert not bad, f"em/en dashes in student-facing copy: {bad[:10]}"


# --- the real audit (dev machines only) ------------------------------------


def _load_checker():
    """Import the audit script, skipping the whole module if the licensed reference
    isn't on this machine (CI, Docker, a fresh clone)."""
    from scripts import check_independence as chk

    if not chk._REF.exists():
        pytest.skip("no backend/reference/ PI list on this machine — audit is dev-time only")
    return chk


def test_no_term_reuses_pi_phrasing():
    """The audit that framework-notes.md's 'Independence audit' section describes,
    made repeatable. Fails on shared PHRASING, not shared vocabulary."""
    chk = _load_checker()
    pis = chk._load_pis()
    offenders = []
    for t in terms.all_terms():
        toks = chk._tokens(f"{t['name']}. {t.get('definition', '')}")
        ours = {"term": t, "tokens": toks, "set": set(toks)}
        best = chk._best_match(ours, pis, prefilter=25)
        if best["flag"] == "FAIL":
            offenders.append(f"{t['id']} {t['name']} (run={best['run']}, ratio={best['ratio']:.2f})")
    assert not offenders, "terms reuse PI phrasing:\n  " + "\n  ".join(offenders)
