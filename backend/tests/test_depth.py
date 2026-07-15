"""Section 2's depth bonus: credit for APPLYING a related term, never for saying one.

These tests exist because the depth award is the one feature that could quietly undo
the app's best property. framework-notes.md calls the strong/weak bar "the
anti-inflation bar" and the grader is told a name-drop is Developing, not Proficient.
Paying out for vocabulary would walk that back — so the guards are deterministic
(main.py), not merely requested in the prompt, and these tests pin them.
"""

from app import terms
from app.main import _build_analytical, _build_depth, _quoted

SAID = (
    "I'd target busy professionals within a mile of the gym. Break-even is 500 drinks "
    "a month, about 17 a day, and we already do 30 a day at the main counter, so the "
    "kiosk clears it."
)


def _offered(n: int = 3) -> dict[str, dict]:
    return {t["id"]: t for t in terms.all_terms()[:n]}


def _raw(**kw) -> dict:
    base = {"bonus": 0.5, "terms": [], "justification": "Applied it well.", "evidence": None}
    return {**base, **kw}


# --- the quote check -------------------------------------------------------


def test_quoted_finds_a_real_quote_ignoring_whitespace_and_case():
    assert _quoted("break-even is 500 drinks a month", SAID)
    assert _quoted("Break-even   is 500\n drinks a month", SAID)


def test_quoted_rejects_a_quote_the_participant_never_said():
    assert not _quoted("I'd run a SWOT analysis first", SAID)
    assert not _quoted("", SAID)
    assert not _quoted(None, SAID)


# --- the three gates -------------------------------------------------------


def test_no_bonus_without_a_findable_quote():
    """A hallucinated quote is the failure mode that would let mention pay."""
    ids = list(_offered())
    d = _build_depth(_raw(terms=ids[:1], evidence="something they never said"), SAID, _offered())
    assert d.bonus == 0.0
    assert d.evidence is None


def test_no_bonus_for_a_term_we_never_offered():
    d = _build_depth(_raw(terms=["T-9999"], evidence="break-even is 500 drinks a month"), SAID, _offered())
    assert d.bonus == 0.0
    assert d.terms == []


def test_no_bonus_when_the_model_cites_no_terms_at_all():
    d = _build_depth(_raw(terms=[], evidence="break-even is 500 drinks a month"), SAID, _offered())
    assert d.bonus == 0.0


def test_bonus_awarded_when_a_real_term_is_backed_by_a_real_quote():
    ids = list(_offered())
    d = _build_depth(_raw(terms=ids[:1], evidence="break-even is 500 drinks a month"), SAID, _offered())
    assert d.bonus == 0.5
    assert d.terms == ids[:1]
    assert d.evidence


def test_bonus_snaps_to_the_allowed_rungs():
    ids = list(_offered())
    ev = "break-even is 500 drinks a month"
    assert _build_depth(_raw(bonus=0.9, terms=ids[:1], evidence=ev), SAID, _offered()).bonus == 0.5
    assert _build_depth(_raw(bonus=0.3, terms=ids[:1], evidence=ev), SAID, _offered()).bonus == 0.25
    assert _build_depth(_raw(bonus=99, terms=ids[:1], evidence=ev), SAID, _offered()).bonus == 0.5
    assert _build_depth(_raw(bonus="junk", terms=ids[:1], evidence=ev), SAID, _offered()).bonus == 0.0


def test_offering_nothing_means_no_depth_at_all():
    """A scenario with no adjacent study terms can't award depth by accident."""
    d = _build_depth(_raw(terms=["FW-151"], evidence="break-even is 500 drinks a month"), SAID, {})
    assert d.bonus == 0.0 and d.terms == []


def test_unfiltered_terms_are_dropped_but_valid_ones_survive():
    ids = list(_offered())
    d = _build_depth(
        _raw(terms=[ids[0], "T-9999", "nonsense"], evidence="break-even is 500 drinks a month"),
        SAID, _offered(),
    )
    assert d.terms == [ids[0]]
    assert d.bonus == 0.5


# --- the roll-up -----------------------------------------------------------


def _analytical(depth_raw: dict, score: int = 4) -> object:
    raw = {
        "framing": {"score": score}, "solution_quality": {"score": score}, "pi_application": {"score": score},
        "creativity": {"bonus": 0.0},
        "depth": depth_raw,
    }
    return _build_analytical(raw, SAID, _offered())


def test_depth_can_never_push_section_2_past_its_ceiling():
    """The cap is what makes a bonus safe: vocabulary lifts a good answer toward 4,
    it can't manufacture a score above it."""
    ids = list(_offered())
    a = _analytical({"bonus": 0.5, "terms": ids[:1], "evidence": "break-even is 500 drinks a month"}, score=4)
    assert a.core_score == 4.0
    assert a.section_score == 4.0        # 4.0 + 0.5 clamped
    assert a.section_percent == 100.0


def test_depth_lifts_a_mid_answer_but_only_by_the_bonus():
    ids = list(_offered())
    plain = _analytical({"bonus": 0.0, "terms": []}, score=3)
    deep = _analytical({"bonus": 0.5, "terms": ids[:1], "evidence": "break-even is 500 drinks a month"}, score=3)
    assert plain.section_score == 3.0
    assert deep.section_score == 3.5


def test_an_answer_that_reaches_for_nothing_loses_nothing():
    """Bonus-only, exactly like creativity: the depth award must be invisible to a
    student who simply answers the question well."""
    a = _analytical({"bonus": 0.0, "terms": []}, score=3)
    assert a.depth.bonus == 0.0
    assert a.section_score == a.core_score == 3.0


def test_old_sessions_without_depth_still_parse():
    """Sessions stored before this feature have no `depth` key in their jsonb."""
    a = _build_analytical(
        {"framing": {"score": 3}, "solution_quality": {"score": 3}, "pi_application": {"score": 3},
         "creativity": {"bonus": 0.0}},
        SAID, _offered(),
    )
    assert a.depth.bonus == 0.0 and a.depth.terms == []


# --- vocabulary selection --------------------------------------------------


def test_depth_vocab_never_offers_a_criterion_being_graded():
    """Those are scored in Section 1 — offering them here would pay twice."""
    from app import framework

    criteria = framework.criteria_for_domains(["marketing"])[:4]
    vocab = terms.depth_vocab_for(criteria)
    graded = {c["id"] for c in criteria}
    assert vocab, "expected some adjacent terms"
    assert not any(t.get("criterion_id") in graded for t in vocab)


def test_depth_vocab_stays_in_the_graded_domains_and_is_bounded():
    from app import framework

    criteria = framework.criteria_for_domains(["marketing"])[:4]
    vocab = terms.depth_vocab_for(criteria, limit=16)
    assert len(vocab) <= 16
    # In-domain, but NOT restricted to the criteria's own topics — see depth_vocab_for.
    assert all(t["domain_id"] == "marketing" for t in vocab)


def test_depth_vocab_offers_the_nearest_terms_first_then_widens():
    """Topic-only was too narrow to ever fire (four Target Market criteria offered
    five terms from one topic), so the pool widens to the domain. The nearest ring
    must still come first, and the wider ring must actually fill the gap."""
    from app import framework

    criteria = framework.criteria_for_domains(["marketing"])[:4]
    topics = {(c["domain_id"], c["topic"]) for c in criteria}
    vocab = terms.depth_vocab_for(criteria, limit=16)

    assert len(vocab) == 16, "the wider ring should fill out to the limit"
    on_topic = [i for i, t in enumerate(vocab) if (t["domain_id"], t["topic"]) in topics]
    off_topic = [i for i, t in enumerate(vocab) if (t["domain_id"], t["topic"]) not in topics]
    assert on_topic, "the nearest ring must be offered"
    assert off_topic, "the pool must widen past the criteria's own topics"
    assert max(on_topic) < min(off_topic), "nearest terms must come first"
