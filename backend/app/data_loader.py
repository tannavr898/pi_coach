"""Phase 1 data layer — the single source of truth for events and PIs.

Everything downstream (the Phase 2 scenario/scoring endpoints, the pi_lookup
CLI, tests) reuses these functions instead of re-reading JSON. Keep this thin
and deterministic: load the JSON, index it, expose lookups.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
EVENTS_PATH = DATA_DIR / "events.json"
PIS_PATH = DATA_DIR / "pis.json"


class EventNotFoundError(KeyError):
    """Raised when an event code is not present in events.json."""


@lru_cache(maxsize=1)
def load_events() -> list[dict]:
    """Return the list of event records from events.json (cached)."""
    with EVENTS_PATH.open(encoding="utf-8") as f:
        return json.load(f)["events"]


@lru_cache(maxsize=1)
def _areas_by_id() -> dict[str, dict]:
    """Index instructional areas by their id for O(1) lookup (cached)."""
    with PIS_PATH.open(encoding="utf-8") as f:
        areas = json.load(f)["instructional_areas"]
    return {area["id"]: area for area in areas}


def load_pis() -> list[dict]:
    """Return all instructional areas with their performance indicators."""
    return list(_areas_by_id().values())


def get_event(code: str) -> dict:
    """Return the event record for ``code`` (case-insensitive).

    Raises EventNotFoundError if the code is unknown.
    """
    code = code.upper()
    for event in load_events():
        if event["code"].upper() == code:
            return event
    raise EventNotFoundError(code)


def get_instructional_areas(code: str) -> list[dict]:
    """Return the full instructional-area objects (with PIs) for an event.

    Areas referenced by the event but missing from pis.json are skipped — this
    keeps the lookup robust while data is still being filled in.
    """
    areas = _areas_by_id()
    return [areas[area_id] for area_id in get_event(code)["instructional_areas"] if area_id in areas]


def get_pi_pool(code: str) -> list[dict]:
    """Return a flat list of every PI available to an event.

    Each item is ``{"id", "text", "area"}`` where ``area`` is the area id, so
    callers can group or cite the source area without a second lookup.
    """
    pool: list[dict] = []
    for area in get_instructional_areas(code):
        for pi in area["performance_indicators"]:
            pool.append({"id": pi["id"], "text": pi["text"], "area": area["id"]})
    return pool
