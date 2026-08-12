"""Cross-session progress math (app/progress.py) — pure functions over rows."""

from app import progress


def _cr(cid, name, level, points, domain="Marketing"):
    return {"criterion_id": cid, "name": name, "domain": domain, "level": level, "points": points}


def _row(created_at, score, crits, *, fpm=None, wpm=None):
    return {
        "created_at": created_at,
        "content_score": score,
        "criterion_results": crits,
        "filler_per_min": fpm,
        "pace_wpm": wpm,
    }


def test_empty_is_safe():
    p = progress.compute_progress([])
    assert p["sessions_count"] == 0
    assert p["delivery_trend"]["available"] is False
    assert p["weakest_criterion"] is None
    assert p["score_trend"]["available"] is False


def test_delivery_trend_needs_two_spoken_sessions():
    rows = [_row("2026-01-01", 70, [_cr("FW-1", "A", "developing", 5)], fpm=8.0, wpm=120)]
    trend = progress.compute_progress(rows)["delivery_trend"]
    assert trend["available"] is False  # only one spoken session


def test_delivery_trend_reports_improvement():
    rows = [
        _row("2026-01-01", 60, [_cr("FW-1", "A", "developing", 5)], fpm=8.0, wpm=110),
        _row("2026-01-02", 62, [_cr("FW-1", "A", "developing", 5)], fpm=5.0, wpm=120),
        _row("2026-01-03", 65, [_cr("FW-1", "A", "proficient", 7)], fpm=3.0, wpm=130),
    ]
    trend = progress.compute_progress(rows)["delivery_trend"]
    assert trend["available"] is True
    assert trend["early"] == 8.0
    assert trend["recent"] < trend["early"]
    assert "→" in trend["note"]


def test_typed_sessions_dont_break_trend():
    # Typed runs have filler_per_min=None; they must be ignored by the trend.
    rows = [
        _row("2026-01-01", 60, [_cr("FW-1", "A", "developing", 5)], fpm=None),
        _row("2026-01-02", 62, [_cr("FW-1", "A", "developing", 5)], fpm=6.0, wpm=120),
        _row("2026-01-03", 65, [_cr("FW-1", "A", "developing", 5)], fpm=4.0, wpm=125),
    ]
    trend = progress.compute_progress(rows)["delivery_trend"]
    assert trend["available"] is True
    assert trend["spoken_sessions"] == 2


def test_weakest_criterion_is_lowest_average():
    rows = [
        _row("2026-01-01", 70, [
            _cr("FW-STRONG", "Strong Skill", "proficient", 8),
            _cr("FW-WEAK", "Weak Skill", "developing", 5),
        ]),
        _row("2026-01-02", 72, [
            _cr("FW-STRONG", "Strong Skill", "proficient", 8),
            _cr("FW-WEAK", "Weak Skill", "developing", 4),
        ]),
    ]
    p = progress.compute_progress(rows)
    weakest = p["weakest_criterion"]
    assert weakest["criterion_id"] == "FW-WEAK"
    assert weakest["consistent_level"] == "developing"
    assert "Weak Skill" in weakest["note"]
    # Mastery is sorted weakest-first.
    assert p["criterion_mastery"][0]["criterion_id"] == "FW-WEAK"


def test_weakest_prefers_repeated_pattern_over_one_off():
    rows = [
        _row("2026-01-01", 70, [
            _cr("FW-REPEAT", "Repeated", "developing", 5),
        ]),
        _row("2026-01-02", 71, [
            _cr("FW-REPEAT", "Repeated", "developing", 5),
            _cr("FW-ONCE", "One Off", "novice", 2),  # lower, but seen only once
        ]),
    ]
    weakest = progress.compute_progress(rows)["weakest_criterion"]
    assert weakest["criterion_id"] == "FW-REPEAT"


def test_score_trend_direction_up():
    rows = [
        _row("2026-01-01", 50, [_cr("FW-1", "A", "developing", 5)]),
        _row("2026-01-02", 60, [_cr("FW-1", "A", "developing", 5)]),
        _row("2026-01-03", 75, [_cr("FW-1", "A", "proficient", 7)]),
    ]
    trend = progress.compute_progress(rows)["score_trend"]
    assert trend["available"] is True
    assert trend["direction"] == "up"
    assert len(trend["points"]) == 3


def test_rows_are_sorted_by_created_at():
    # Out-of-order input must still compute early=first-chronological.
    rows = [
        _row("2026-01-03", 65, [_cr("FW-1", "A", "developing", 5)], fpm=3.0, wpm=130),
        _row("2026-01-01", 60, [_cr("FW-1", "A", "developing", 5)], fpm=9.0, wpm=110),
        _row("2026-01-02", 62, [_cr("FW-1", "A", "developing", 5)], fpm=6.0, wpm=120),
    ]
    trend = progress.compute_progress(rows)["delivery_trend"]
    assert trend["early"] == 9.0  # earliest chronological, not first in list
