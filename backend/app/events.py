"""The role-play event catalog, what students pick before practicing.

Loads events.json (our own catalog) and exposes lookups. Each event maps to a set
of OUR framework domains (framework.json), which is the pool scenario generation
draws criteria from. That mapping is the obvious business-discipline mapping any
educator would make, it is NOT DECA's licensed event-to-performance-indicator
blueprint, and no PI text or codes appear here. Focus suggestions are original.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_EVENTS_PATH = Path(__file__).parent / "data" / "events.json"

# Presentation timing by event kind. Team decision-making events get a longer
# prep and presentation window (two people, a meatier case); individual and
# principles role-plays use the standard 10/10. `target_seconds` is the
# recommended *speaking* time delivery is graded against (the rest of the window
# is for the judge's questions).
_TIMING = {
    "team": {"prep_seconds": 1800, "present_seconds": 900, "target_seconds": 660},
    "principles": {"prep_seconds": 600, "present_seconds": 600, "target_seconds": 450},
    "individual": {"prep_seconds": 600, "present_seconds": 600, "target_seconds": 450},
}
_DEFAULT_TIMING = _TIMING["individual"]


def timing_for(event: dict | None) -> dict:
    """Prep/present/target seconds for an event (by its kind)."""
    if not event:
        return dict(_DEFAULT_TIMING)
    return dict(_TIMING.get(event.get("kind", ""), _DEFAULT_TIMING))


def is_quantitative(event: dict | None) -> bool:
    """Whether this event centers on calculations we must verify deterministically."""
    return bool(event and event.get("quantitative"))


def is_team(event: dict | None) -> bool:
    """Whether this is a two-person team event (drives speaker diarization)."""
    return bool(event and event.get("kind") == "team")


@lru_cache(maxsize=1)
def load_events() -> dict:
    """Return the whole catalog document (cached)."""
    with _EVENTS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def all_events() -> list[dict]:
    """Every event in file order."""
    return load_events()["events"]


def clusters() -> list[str]:
    """Ordered cluster names, for grouping in the UI."""
    return load_events().get("clusters", [])


def domains_for_cluster(cluster: str) -> list[str]:
    """Every domain any event in this cluster exercises, in catalog order.

    This is the honest scope of a cluster exam. A Business Finance competitor sits
    the Finance cluster paper, not a paper about the four domains their particular
    role-play happens to draw on, so a quiz scoped to the single event quietly
    under-prepares them for the test they will actually take. The union across the
    cluster's events is the closest thing the catalog has to that scope.
    """
    out: list[str] = []
    for e in all_events():
        if e.get("cluster", "").casefold() != cluster.casefold():
            continue
        for d in e.get("domain_ids", []):
            if d not in out:
                out.append(d)
    return out


@lru_cache(maxsize=1)
def _index() -> dict[str, dict]:
    return {e["id"]: e for e in all_events()}


def get_event(event_id: str) -> dict | None:
    """Resolve an event id to its catalog entry, or None if unknown."""
    return _index().get(event_id)


def event_summaries() -> list[dict]:
    """Events shaped for the client picker (no internal-only fields to hide, but
    kept explicit so the API contract is stable)."""
    return [
        {
            "id": e["id"],
            "name": e["name"],
            "cluster": e["cluster"],
            "kind": e["kind"],
            "quantitative": bool(e.get("quantitative")),
            "blurb": e.get("blurb", ""),
            "suggestions": e.get("suggestions", []),
            # The domains this event exercises, and the wider set its cluster exam
            # covers. Both ship with the picker so the Knowledge Check can offer
            # "my event" against "my cluster" without a second round trip.
            "domain_ids": list(e.get("domain_ids", [])),
            "cluster_domain_ids": domains_for_cluster(e.get("cluster", "")),
        }
        for e in all_events()
    ]
