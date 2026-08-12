"""Tier allowances, period math, and the founding-user reward. All pure — the
enforcement itself is one atomic SQL statement (see supabase/schema.sql)."""

from datetime import datetime, timezone

from app import tiers


# --- period math -----------------------------------------------------------


def test_period_key_is_a_utc_calendar_month():
    assert tiers.period_key(datetime(2026, 7, 20, 23, 59, tzinfo=timezone.utc)) == "2026-07"
    assert tiers.period_key(datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)) == "2026-01"


def test_reset_date_is_the_first_of_next_month():
    assert tiers.resets_on(datetime(2026, 7, 20, tzinfo=timezone.utc)) == "2026-08-01"


def test_reset_date_rolls_over_the_year():
    """December must roll to January of the NEXT year — an off-by-one here would
    show a student a reset date in the past."""
    assert tiers.resets_on(datetime(2026, 12, 15, tzinfo=timezone.utc)) == "2027-01-01"


# --- allowances ------------------------------------------------------------


def test_video_is_capped_tighter_than_voice_on_every_metered_tier():
    """Video is the cost driver (~2-3x an audio session), so it carries the
    tighter cap. If this ever inverts, the caps have stopped tracking the cost."""
    for tier in ("anonymous", "free"):
        assert tiers.limit_for(tier, "video") < tiers.limit_for(tier, "voice")


def test_anonymous_cannot_use_video_at_all():
    """Video requires an account, which is what makes its cap server-enforceable."""
    assert tiers.limit_for("anonymous", "video") == 0


def test_pro_is_unlimited():
    assert tiers.limit_for("pro", "voice") == tiers.UNLIMITED
    assert tiers.remaining("pro", "voice", 9999) == tiers.UNLIMITED


def test_remaining_never_goes_negative():
    cap = tiers.limit_for("free", "voice")
    assert tiers.remaining("free", "voice", cap + 5) == 0


def test_unknown_tier_falls_back_to_the_most_restrictive():
    """A tier we don't recognize must not accidentally grant more than anonymous."""
    assert tiers.limit_for("enterprise", "video") == tiers.limit_for("anonymous", "video")


# --- founding-user reward --------------------------------------------------


def test_founder_needs_both_early_signup_and_real_usage():
    early = "2026-03-01T12:00:00Z"
    assert tiers.founder_eligible(early, tiers.FOUNDER_MIN_ROLEPLAYS) is True


def test_early_signup_alone_is_not_enough():
    """Rewards loyalty, not just timing — a dormant account hasn't earned it."""
    assert tiers.founder_eligible("2026-03-01T12:00:00Z", 0) is False
    assert tiers.founder_eligible("2026-03-01T12:00:00Z", tiers.FOUNDER_MIN_ROLEPLAYS - 1) is False


def test_late_signup_is_not_eligible_however_active():
    assert tiers.founder_eligible("2099-01-01T00:00:00Z", 500) is False


def test_missing_or_malformed_signup_date_is_not_eligible():
    """Fail closed on bad data — quietly granting a reward we can't justify is
    worse than withholding one we can't verify."""
    assert tiers.founder_eligible(None, 500) is False
    assert tiers.founder_eligible("", 500) is False
    assert tiers.founder_eligible("not-a-date", 500) is False
