"""The owner dashboard's numbers (app/admin_metrics.py)."""

from datetime import date

from fastapi.testclient import TestClient

from app import admin_metrics, config
from app.main import app

client = TestClient(app)
TODAY = date(2026, 11, 23)


def _ts(day: str) -> str:
    return f"{day}T12:00:00+00:00"


def _build(days=7, **kw):
    base = dict(sessions=[], activity=[], scenarios=[], diagnostics=[], chapters=[], members=[], daily=[], users=[])
    return admin_metrics.build(days, today=TODAY, **{**base, **kw})


def test_axis_is_zero_filled_and_ends_today():
    out = _build(days=7)
    assert len(out["axis"]) == 7 and out["axis"][-1] == "2026-11-23" and out["axis"][0] == "2026-11-17"
    assert out["series"]["roleplays"]["values"] == [0] * 7
    assert out["series"]["avg_score"]["values"] == [None] * 7  # a day with nothing is a gap, not a zero


def test_counter_wins_when_larger_and_sessions_floor_it():
    sessions = [{"user_id": "a", "created_at": _ts("2026-11-22"), "event": "BMA", "content_score": 80}] * 2
    daily = [{"day": "2026-11-22", "kind": "roleplay", "count": 5}, {"day": "2026-11-21", "kind": "roleplay", "count": 1}]
    out = _build(sessions=sessions, daily=daily)
    vals = dict(zip(out["axis"], out["series"]["roleplays"]["values"]))
    assert vals["2026-11-22"] == 5  # anonymous reps are in the counter, not in sessions
    assert vals["2026-11-21"] == 1
    # With no counter row for the day (before it existed), the saved sessions stand in.
    out = _build(sessions=sessions)
    assert dict(zip(out["axis"], out["series"]["roleplays"]["values"]))["2026-11-22"] == 2


def test_admin_sample_rows_are_not_real_activity():
    sessions = [{"user_id": "a", "created_at": _ts("2026-11-22"), "event": "admin-sample", "content_score": 90}]
    out = _build(sessions=sessions)
    assert out["series"]["roleplays"]["total"] == 0
    assert out["series"]["active_users"]["total"] == 0
    assert out["series"]["avg_score"]["total"] is None


def test_active_users_are_distinct_per_day_across_sessions_and_activity():
    sessions = [{"user_id": "a", "created_at": _ts("2026-11-22"), "event": "E", "content_score": 70}]
    activity = [{"user_id": "a", "kind": "quiz", "created_at": _ts("2026-11-22")},
                {"user_id": "b", "kind": "quiz", "created_at": _ts("2026-11-22")}]
    out = _build(sessions=sessions, activity=activity)
    assert dict(zip(out["axis"], out["series"]["active_users"]["values"]))["2026-11-22"] == 2
    assert out["totals"]["wau"] == 2 and out["totals"]["ever_active"] == 2


def test_previous_period_total_and_cumulative_users():
    users = [{"id": str(i), "created_at": _ts(d)} for i, d in enumerate(["2026-10-01", "2026-11-10", "2026-11-22", "2026-11-22"])]
    out = _build(days=7, users=users)
    s = out["series"]["signups"]
    assert s["total"] == 2 and s["prev_total"] == 1  # 11-10 falls in the 7 days before the window
    assert out["cumulative_users"][0] == 2 and out["cumulative_users"][-1] == 4
    assert out["totals"]["users"] == 4


def test_unavailable_accounts_are_reported_not_hidden():
    out = _build(users=None)
    assert out["totals"]["users"] is None and out["notes"]


def test_spikes_flag_only_days_far_above_normal():
    quiet = [2, 3, 2, 2, 3, 2, 2, 30, 2, 3]
    assert admin_metrics.spikes(quiet) == [7]
    assert admin_metrics.spikes([0, 0, 0, 1, 0, 0, 0]) == []  # a lone 1 is not a spike
    assert admin_metrics.spikes([5, 5, 5, 5, 5, 5]) == []  # flat
    assert admin_metrics.spikes([1, 2]) == []  # too little history to call anything unusual


def test_top_events_ranked_within_window():
    sessions = [{"user_id": "a", "created_at": _ts("2026-11-22"), "event": "BMA", "content_score": 1},
                {"user_id": "a", "created_at": _ts("2026-11-21"), "event": "BMA", "content_score": 1},
                {"user_id": "b", "created_at": _ts("2026-11-21"), "event": "PFN", "content_score": 1},
                {"user_id": "b", "created_at": _ts("2026-01-01"), "event": "OLD", "content_score": 1}]
    out = _build(sessions=sessions)
    assert out["top_events"] == [{"event": "BMA", "n": 2}, {"event": "PFN", "n": 1}]


def test_overview_endpoint_needs_the_passphrase(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_PASSPHRASE", "open-sesame")
    assert client.get("/api/admin/overview").status_code == 403
    assert client.get("/api/admin/overview", headers={"X-Admin-Passphrase": "wrong"}).status_code == 403
    monkeypatch.setattr(config, "has_supabase", lambda: False)
    r = client.get("/api/admin/overview", headers={"X-Admin-Passphrase": "open-sesame"})
    assert r.status_code == 503  # authorised, but nothing to chart without accounts
