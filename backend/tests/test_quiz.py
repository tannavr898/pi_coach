"""The quiz bank: the prompt, the generator's validator, and serving.

The validator is the part worth testing hardest. A quiz is only as good as the
questions that get past it, and every rule in here exists because a model will
cheerfully produce the thing it forbids: two defensible answers, a giveaway-long
correct option, an "all of the above", a concept the student was never shown.
"""

from __future__ import annotations

import itertools
import json
import random
from types import SimpleNamespace

import pytest

from app import prompts, quiz, study, terms
from app.schemas import QuizQuestion
from scripts import gen_quiz


CARDS = terms.terms_for_topics([("marketing", terms.all_terms()[0]["topic"])]) or terms.all_terms()[:3]


def _card(i: int = 0) -> dict:
    return terms.all_terms()[i]


def _question(cards, **over) -> dict:
    """A clean district question over `cards[0]`, before validation."""
    q = {
        "domain": cards[0]["domain"],
        "level": "district",
        "concepts": [cards[0]["name"]],
        "source_cards": [cards[0]["name"]],
        "format": "recognition",
        "question": "A store manager is deciding what to do next. Which choice fits?",
        "options": [
            {"id": "a", "text": "The first plausible option here", "correct": True, "rationale": "right for r"},
            {"id": "b", "text": "A second plausible option here", "correct": False, "rationale": "confuses x"},
            {"id": "c", "text": "A third plausible option there", "correct": False, "rationale": "confuses y"},
            {"id": "d", "text": "A fourth plausible option here", "correct": False, "rationale": "confuses z"},
        ],
        "difficulty_justification": "one concept, one step",
        "synthesis_check": "",
        "review_flags": [],
    }
    q.update(over)
    return q


# --- the prompt ------------------------------------------------------------


def test_prompt_carries_every_beat_and_the_tier_rule():
    """The connect beat is what a state question imitates and the explain/above
    beats are where distractors come from, so all four have to reach the model."""
    card = _card()
    _, user = prompts.build_quiz_prompt([card], "state", 3)
    for beat in ("define", "explain", "connect", "above_beyond"):
        assert beat in user
    assert card["example"]["connect"] in user
    assert "TARGET_LEVEL: state" in user
    assert "ONE concept" in user


def test_icdc_prompt_demands_the_break_test():
    system, user = prompts.build_quiz_prompt(terms.all_terms()[:3], "icdc", 2)
    assert "BREAK TEST" in system
    assert "TWO or THREE concepts" in user


def test_count_is_a_ceiling_not_a_quota():
    _, user = prompts.build_quiz_prompt([_card()], "district", 5)
    assert "up to 5" in user and "Never pad" in user


# --- the validator ---------------------------------------------------------


def test_clean_question_passes_and_resolves_to_its_term():
    cards = terms.all_terms()[:3]
    row = gen_quiz._validate(_question(cards), "district", cards)
    assert row["term_ids"] == [cards[0]["id"]]
    assert sum(1 for o in row["options"] if o["correct"]) == 1


@pytest.mark.parametrize("over, why", [
    ({"options": []}, "0 options"),
    ({"question": "too short"}, "stem"),
])
def test_structurally_broken_questions_are_rejected(over, why):
    cards = terms.all_terms()[:3]
    with pytest.raises(gen_quiz.Rejected):
        gen_quiz._validate(_question(cards, **over), "district", cards)


def test_two_correct_answers_is_rejected():
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][1]["correct"] = True
    with pytest.raises(gen_quiz.Rejected, match="2 correct"):
        gen_quiz._validate(q, "district", cards)


def test_no_correct_answer_is_rejected():
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][0]["correct"] = False
    with pytest.raises(gen_quiz.Rejected, match="0 correct"):
        gen_quiz._validate(q, "district", cards)


def test_all_of_the_above_is_rejected():
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][3]["text"] = "All of the above options apply"
    with pytest.raises(gen_quiz.Rejected, match="above"):
        gen_quiz._validate(q, "district", cards)


def test_option_without_a_rationale_is_rejected():
    """Every distractor states the misconception it represents. That is what turns
    a wrong pick into feedback instead of a red X."""
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][2]["rationale"] = "  "
    with pytest.raises(gen_quiz.Rejected, match="rationale"):
        gen_quiz._validate(q, "district", cards)


def test_giveaway_long_correct_answer_is_rejected():
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][0]["text"] = "The correct option, stated at considerable length with every qualifying condition spelled out"
    with pytest.raises(gen_quiz.Rejected, match="longest"):
        gen_quiz._validate(q, "district", cards)


def test_a_concept_outside_the_batch_is_rejected():
    """A question about material the student was never given is indefensible, even
    if the question itself is good."""
    cards = terms.all_terms()[:3]
    q = _question(cards, concepts=["Zeppelin Depreciation Hedging"], source_cards=["Zeppelin Depreciation Hedging"])
    with pytest.raises(gen_quiz.Rejected, match="not in the batch"):
        gen_quiz._validate(q, "district", cards)


def test_tier_is_enforced_by_concept_count():
    cards = terms.all_terms()[:3]
    two = [cards[0]["name"], cards[1]["name"]]
    with pytest.raises(gen_quiz.Rejected, match="need exactly 1"):
        gen_quiz._validate(_question(cards, concepts=two, source_cards=two), "state", cards)
    with pytest.raises(gen_quiz.Rejected, match="need 2-3"):
        gen_quiz._validate(_question(cards, level="icdc"), "icdc", cards)


def test_icdc_without_a_visible_break_test_is_rejected():
    """An icdc item that cannot show its break test is a state question in a
    costume until proven otherwise."""
    cards = terms.all_terms()[:3]
    two = [cards[0]["name"], cards[1]["name"]]
    q = _question(cards, level="icdc", concepts=two, source_cards=two, synthesis_check="")
    with pytest.raises(gen_quiz.Rejected, match="break test"):
        gen_quiz._validate(q, "icdc", cards)


def test_icdc_with_a_real_break_test_passes():
    cards = terms.all_terms()[:3]
    two = [cards[0]["name"], cards[1]["name"]]
    check = f"Depends on {two[0]} and {two[1]}; removing either leaves the trade-off unanswerable."
    row = gen_quiz._validate(
        _question(cards, level="icdc", concepts=two, source_cards=two, synthesis_check=check),
        "icdc", cards)
    assert len(row["term_ids"]) == 2
    assert row["notes"]["synthesis_check"] == check


def test_em_dashes_are_rejected():
    cards = terms.all_terms()[:3]
    # The dash is written as an escape so this file stays free of the character
    # it is testing for.
    q = _question(cards, question="A manager weighs two options \u2014 which one fits?")
    with pytest.raises(gen_quiz.Rejected, match="dash"):
        gen_quiz._validate(q, "district", cards)


def test_options_are_reshuffled_so_position_carries_no_signal():
    """The prompt asks the model to vary the correct position; this is what makes
    it true. Over many questions the correct letter has to move."""
    cards = terms.all_terms()[:3]
    rng = random.Random(7)
    letters = set()
    for _ in range(40):
        row = gen_quiz._shuffle_options(gen_quiz._validate(_question(cards), "district", cards), rng)
        assert [o["id"] for o in row["options"]] == ["a", "b", "c", "d"]
        letters.add(next(o["id"] for o in row["options"] if o["correct"]))
    assert len(letters) >= 3


# --- serving ---------------------------------------------------------------


def _bank(monkeypatch, rows: list[dict]) -> None:
    monkeypatch.setattr(quiz, "all_questions", lambda: rows)


def _row(qid: str, level: str, term_ids: list[str], domain_id: str = "marketing") -> dict:
    return {"id": qid, "level": level, "domain_id": domain_id, "domain": "Marketing",
            "topic": "T", "term_ids": term_ids, "concepts": [], "format": "recognition",
            "question": f"stem {qid}", "options": []}


def test_select_filters_by_level_and_domain(monkeypatch):
    _bank(monkeypatch, [
        _row("Q-1", "district", ["FW-001"]),
        _row("Q-2", "state", ["FW-001"]),
        _row("Q-3", "district", ["FW-002"], domain_id="finance"),
    ])
    assert [q["id"] for q in quiz.select(level="state", count=10)] == ["Q-2"]
    assert [q["id"] for q in quiz.select(domain_ids=["finance"], count=10)] == ["Q-3"]


def test_a_deck_quiz_keeps_synthesis_questions_that_only_partly_overlap(monkeypatch):
    """A five-card weak-term deck must not lose every icdc question just because
    synthesis draws on a card outside the deck. Partial matches stay in, behind the
    fully-covered ones."""
    _bank(monkeypatch, [
        _row("Q-full", "icdc", ["FW-001", "FW-002"]),
        _row("Q-part", "icdc", ["FW-001", "FW-900"]),
        _row("Q-none", "icdc", ["FW-800", "FW-900"]),
    ])
    got = [q["id"] for q in quiz.select(term_ids=["FW-001", "FW-002"], count=10)]
    assert got == ["Q-full", "Q-part"]


def test_select_respects_count_and_an_empty_bank(monkeypatch):
    _bank(monkeypatch, [_row(f"Q-{i}", "district", ["FW-001"]) for i in range(10)])
    assert len(quiz.select(count=3)) == 3
    _bank(monkeypatch, [])
    assert quiz.select(count=5) == []


def test_shipped_bank_is_servable():
    """Whatever is in the file has to satisfy the response model's shape: one
    correct option per question and a rationale on every option."""
    for q in quiz.all_questions():
        assert q["level"] in quiz.LEVELS, q["id"]
        assert len(q["options"]) == 4, q["id"]
        assert sum(1 for o in q["options"] if o.get("correct")) == 1, q["id"]
        assert all(str(o.get("rationale", "")).strip() for o in q["options"]), q["id"]
        assert len(terms.get_terms(q["term_ids"])) == len(q["term_ids"]), q["id"]


# --- progress --------------------------------------------------------------


def test_a_quiz_answer_never_finishes_a_term():
    """Recognition among four options is evidence, not proof. Only blitz-or-better
    can mark a term known, which is the promise the Core path rests on."""
    row = study.apply(None, "FW-001", "quiz", "correct")
    assert row["status"] == "learning"
    assert row["best_evidence"] == "quiz"


def test_a_quiz_outranks_a_flip_and_never_outranks_a_blitz():
    after_blitz = study.apply(None, "FW-001", "blitz", "correct")
    after_quiz = study.apply(after_blitz, "FW-001", "quiz", "correct")
    assert after_quiz["best_evidence"] == "blitz"
    assert after_quiz["status"] == "known"  # a correct quiz does not demote a known term


def test_missing_a_quiz_demotes_a_known_term():
    known = study.apply(None, "FW-001", "roleplay", "correct")
    after = study.apply(known, "FW-001", "quiz", "missed")
    assert after["status"] == "learning"
    assert after["best_evidence"] == "roleplay"  # what you proved stays proved


# --- the generator's bookkeeping -------------------------------------------
# cmd_gen with the model stubbed out: this is the part that decides what gets
# re-run, what gets an id, and what reaches disk, and none of it needs a key.


def _args(**over):
    base = dict(domain="", level="", count=3, limit=0, workers=2, seed=1, force=False)
    base.update(over)
    return SimpleNamespace(**base)


def _fake_batch(monkeypatch, per_batch: int = 1):
    """Stub _gen_batch: one already-validated row per batch.

    Every stem is built from its own invented words. Stems that merely differ by
    topic read as near-duplicates to the real dedupe (which is the dedupe working),
    and that would quietly halve what these tests think they generated.
    """
    counter = itertools.count()

    def fake(domain_id, topic, cards, level, count):
        rows = []
        for _ in range(per_batch):
            n = next(counter)
            rows.append({
                "level": level, "domain_id": domain_id, "domain": cards[0]["domain"],
                "topic": topic, "term_ids": [cards[0]["id"]], "concepts": [cards[0]["name"]],
                "format": "recognition",
                "question": f"Which zeta{n} follows alpha{n} when beta{n} meets gamma{n}?",
                "options": [
                    {"id": "", "text": f"delta{n} option {k}", "correct": k == 0, "rationale": "why"}
                    for k in range(4)
                ],
                "notes": {"difficulty_justification": "", "synthesis_check": "", "review_flags": []},
                "batch": gen_quiz._batch_key(domain_id, topic, level),
            })
        return rows
    monkeypatch.setattr(gen_quiz, "_gen_batch", fake)


def test_gen_writes_a_bank_and_a_rerun_re_authors_nothing(tmp_path, monkeypatch):
    """Resumability is what makes a half-finished run cheap to finish: the second
    pass over the same scope must cost nothing."""
    bank = tmp_path / "quiz_bank.json"
    monkeypatch.setattr(gen_quiz, "_BANK", bank)
    _fake_batch(monkeypatch)

    scope = dict(domain="business_law", level="district")
    gen_quiz.cmd_gen(_args(**scope))
    first = json.loads(bank.read_text(encoding="utf-8"))["questions"]
    assert first, "generated nothing"
    assert len({q["batch"] for q in first}) == len(first), "a batch was authored twice"
    assert sorted(q["id"] for q in first) == [f"Q-{n:04d}" for n in range(1, len(first) + 1)]

    gen_quiz.cmd_gen(_args(**scope))
    again = json.loads(bank.read_text(encoding="utf-8"))["questions"]
    assert len(again) == len(first)

    # Widening the scope still only pays for what is missing.
    gen_quiz.cmd_gen(_args(domain="business_law"))
    wider = json.loads(bank.read_text(encoding="utf-8"))["questions"]
    assert len(wider) > len(first)
    assert len({q["batch"] for q in wider}) == len(wider)


def test_an_interrupted_run_keeps_the_batches_it_finished(tmp_path, monkeypatch):
    """The checkpoint is the whole point: a run that dies part-way (a dead key, an
    exhausted balance) must not throw away batches that already succeeded and were
    paid for."""
    bank = tmp_path / "quiz_bank.json"
    monkeypatch.setattr(gen_quiz, "_BANK", bank)
    monkeypatch.setattr(gen_quiz, "_SAVE_EVERY", 2)

    calls = {"n": 0}
    real_key = gen_quiz._batch_key

    def flaky(domain_id, topic, cards, level, count):
        calls["n"] += 1
        if calls["n"] > 6:
            raise RuntimeError("Your credit balance is too low to access the Anthropic API.")
        return [{
            "level": level, "domain_id": domain_id, "domain": cards[0]["domain"],
            "topic": topic, "term_ids": [cards[0]["id"]], "concepts": [cards[0]["name"]],
            "format": "recognition",
            "question": f"Which zeta{calls['n']} follows alpha{calls['n']} given beta{calls['n']}?",
            "options": [{"id": "", "text": f"delta{calls['n']} option {k}", "correct": k == 0, "rationale": "why"}
                        for k in range(4)],
            "notes": {"difficulty_justification": "", "synthesis_check": "", "review_flags": []},
            "batch": real_key(domain_id, topic, level),
        }]

    monkeypatch.setattr(gen_quiz, "_gen_batch", flaky)
    # Single worker so "the first six batches succeed" is deterministic.
    rc = gen_quiz.cmd_gen(_args(limit=12, workers=1))
    assert rc == 1  # failures are reported, not swallowed
    kept = json.loads(bank.read_text(encoding="utf-8"))["questions"]
    assert len(kept) == 6, "work completed before the failure was lost"


def test_generated_questions_are_servable_by_the_api(tmp_path, monkeypatch):
    """What the generator writes has to be what app/quiz.py can serve: same keys,
    lettered options, exactly one correct."""
    bank = tmp_path / "quiz_bank.json"
    monkeypatch.setattr(gen_quiz, "_BANK", bank)
    _fake_batch(monkeypatch)
    gen_quiz.cmd_gen(_args(limit=3))

    for row in json.loads(bank.read_text(encoding="utf-8"))["questions"]:
        served = QuizQuestion(**{k: v for k, v in row.items() if k not in ("notes", "batch")})
        assert [o.id for o in served.options] == ["a", "b", "c", "d"]
        assert sum(1 for o in served.options if o.correct) == 1


def test_ordinary_prose_is_not_mistaken_for_an_all_of_the_above_option():
    """The banned-phrase check has to match phrases, not substrings: "the data and
    benchmarks" contains "a and b", and rejecting it would throw away good options."""
    cards = terms.all_terms()[:3]
    q = _question(cards)
    q["options"][2]["text"] = "Compare the data and benchmarks first"
    row = gen_quiz._validate(q, "district", cards)
    assert any("data and benchmarks" in o["text"] for o in row["options"])

    for banned in ("All of the above", "None of these", "Both a and c"):
        bad = _question(cards)
        bad["options"][3]["text"] = banned
        with pytest.raises(gen_quiz.Rejected, match="above"):
            gen_quiz._validate(bad, "district", cards)
