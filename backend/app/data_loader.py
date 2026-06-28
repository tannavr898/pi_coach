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
def _all_areas() -> list[dict]:
    """Return every instructional area (with all its PIs) from pis.json (cached)."""
    with PIS_PATH.open(encoding="utf-8") as f:
        return json.load(f)["instructional_areas"]


def load_pis() -> list[dict]:
    """Return all instructional areas with their performance indicators."""
    return _all_areas()


def get_event(code: str) -> dict:
    """Return the event record for ``code`` (case-insensitive).

    Raises EventNotFoundError if the code is unknown.
    """
    code = code.upper()
    for event in load_events():
        if event["code"].upper() == code:
            return event
    raise EventNotFoundError(code)


def allowed_tokens(event: dict) -> set[str]:
    """Membership tokens whose PIs this event may surface.

    Every event includes the Business Administration Core (``core``). Individual
    series events also include their career-cluster core and career pathway, so a
    PI is in-pool if any of its membership tags matches one of these tokens.
    """
    tokens = {"core"}
    cluster = event.get("cluster")
    if cluster:
        tokens.add(f"cluster:{cluster}")
        pathway = event.get("pathway")
        if pathway:
            tokens.add(f"pathway:{cluster}:{pathway}")
    return tokens


def get_instructional_areas(code: str) -> list[dict]:
    """Return the instructional areas for an event, each carrying only the PIs
    that belong to that event (filtered by PI membership). Areas with no
    in-pool PIs are omitted, so callers see exactly the event's pool.
    """
    tokens = allowed_tokens(get_event(code))
    out: list[dict] = []
    for area in _all_areas():
        pis = [pi for pi in area["performance_indicators"] if tokens.intersection(pi.get("membership", []))]
        if pis:
            out.append({"id": area["id"], "name": area["name"], "performance_indicators": pis})
    return out


@lru_cache(maxsize=1)
def _catalog() -> dict[str, dict]:
    """Index every PI in pis.json by id (across all areas), for direct lookup."""
    out: dict[str, dict] = {}
    for area in _all_areas():
        for pi in area["performance_indicators"]:
            out[pi["id"]] = {
                "id": pi["id"],
                "text": pi["text"],
                "area": area["id"],
                "area_name": area["name"],
                "level": pi.get("level", ""),
                "definition": pi.get("definition", ""),
            }
    return out


def get_pis_by_ids(pi_ids: list[str]) -> list[dict]:
    """Resolve arbitrary PI ids against the full catalog (order preserved)."""
    cat = _catalog()
    return [cat[i] for i in pi_ids if i in cat]


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
