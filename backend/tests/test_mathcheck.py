"""The deterministic arithmetic verifier — the safety net for quantitative events."""

import math

import pytest

from app import delivery, mathcheck


def test_evaluates_basic_arithmetic():
    assert mathcheck.evaluate("(50000 - 30000) / 50000 * 100") == pytest.approx(40.0)
    assert mathcheck.evaluate("2 ** 10") == 1024
    assert mathcheck.evaluate("round(10/3, 2)") == pytest.approx(3.33)


@pytest.mark.parametrize("expr", [
    "__import__('os')",          # no calls to arbitrary names
    "os.system('ls')",           # no attributes
    "open('x')",                 # not in the whitelist
    "1 + ",                      # syntax error
    "[1,2,3][0]",                # no indexing/lists
    "9 ** 9 ** 9",               # exponent guard
    "1/0",                       # division by zero
])
def test_rejects_unsafe_or_bad(expr):
    with pytest.raises(mathcheck.MathError):
        mathcheck.evaluate(expr)


def test_verify_check_flags_wrong_claim():
    # Student claimed 45% margin; the real answer is 40% -> ok is False, computed wins.
    r = mathcheck.verify_check({"label": "margin", "expression": "(50000-30000)/50000*100", "claimed": 45, "unit": "%"})
    assert r["computed"] == pytest.approx(40.0)
    assert r["ok"] is False

    # A correct claim (within rounding) passes.
    r2 = mathcheck.verify_check({"label": "margin", "expression": "(50000-30000)/50000*100", "claimed": 40})
    assert r2["ok"] is True


def test_verify_check_survives_bad_expression():
    r = mathcheck.verify_check({"label": "x", "expression": "totally not math", "claimed": 5})
    assert r["computed"] is None and r["ok"] is None and r["note"]


# --- speaker diarization breakdown ----------------------------------------


class _W:
    def __init__(self, text, start_ms, end_ms, speaker=""):
        self.text, self.start_ms, self.end_ms, self.speaker = text, start_ms, end_ms, speaker


def test_compute_speakers_detects_domination():
    # Speaker A talks ~9s, speaker B ~1s -> A dominates.
    words = [_W("word", i * 1000, i * 1000 + 900, "A") for i in range(9)]
    words.append(_W("ok", 9000, 9900, "B"))
    out = delivery.compute_speakers(words)
    assert len(out["speakers"]) == 2
    assert out["dominated_by"] == "A"
    assert "A" in out["balance_note"]


def test_compute_speakers_none_when_single_speaker():
    words = [_W("word", i * 1000, i * 1000 + 900, "A") for i in range(5)]
    assert delivery.compute_speakers(words)["speakers"] == []
