"""Phase 1 acceptance test: event code -> instructional areas + PI pool."""

import pytest

from app.data_loader import (
    EventNotFoundError,
    get_event,
    get_instructional_areas,
    get_pi_pool,
)


def test_get_event_pmk():
    event = get_event("PMK")
    assert event["code"] == "PMK"
    assert event["name"] == "Principles of Marketing"
    assert event["level"] == "principles"


def test_get_event_is_case_insensitive():
    assert get_event("pmk")["code"] == "PMK"


def test_unknown_event_raises():
    with pytest.raises(EventNotFoundError):
        get_event("ZZZ")


def test_instructional_areas_match_event():
    # Principles events are core-only: the 13 Business Administration Core areas.
    area_ids = [a["id"] for a in get_instructional_areas("PMK")]
    assert "MK" in area_ids
    assert len(area_ids) == 13


def test_pi_pool_is_flat_and_tagged():
    pool = get_pi_pool("PMK")
    assert len(pool) > 0
    for pi in pool:
        assert set(pi.keys()) == {"id", "text", "area"}
    # Every PI's area appears among the event's instructional areas.
    valid_areas = {a["id"] for a in get_instructional_areas("PMK")}
    assert {pi["area"] for pi in pool} <= valid_areas


def test_individual_series_pool_is_wider_than_core():
    # An individual-series event draws the BA Core PLUS its cluster/pathway PIs.
    core = get_pi_pool("PMK")
    rms = get_pi_pool("RMS")  # Retail Merchandising (marketing / Merchandising pathway)
    assert len(rms) > len(core)
    assert any(pi["area"] == "SE" for pi in rms)  # Selling is a marketing-cluster area


def test_principles_stays_core_only():
    # Cluster-only areas (e.g. Selling) must never leak into a Principles pool.
    assert not any(pi["area"] == "SE" for pi in get_pi_pool("PMK"))
