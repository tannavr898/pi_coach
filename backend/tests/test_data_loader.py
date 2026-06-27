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
    area_ids = [a["id"] for a in get_instructional_areas("PMK")]
    assert area_ids == get_event("PMK")["instructional_areas"]
    assert "MK" in area_ids


def test_pi_pool_is_flat_and_tagged():
    pool = get_pi_pool("PMK")
    assert len(pool) > 0
    for pi in pool:
        assert set(pi.keys()) == {"id", "text", "area"}
    # Every PI's area is one of the event's instructional areas.
    valid_areas = set(get_event("PMK")["instructional_areas"])
    assert {pi["area"] for pi in pool} <= valid_areas
