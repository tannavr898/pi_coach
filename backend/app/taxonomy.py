"""Scenario-variety taxonomy (Phase 3).

Repetition isn't fixed by telling the model to "be more creative" — given the same
prompt it collapses to the same few outputs. Instead we force variety from the
INPUT side: each event has a structured pool of dimension values (subtopic,
business type, company size, stakeholder, problem, constraint), and on every
no-focus generation we RANDOMLY SAMPLE one value per dimension and inject them as
fixed parameters. The model then executes on a given combination rather than
inventing diversity itself.

The taxonomy is OUR own general-business categorization (see the file's `note`) —
not DECA/MBA Research performance indicators or event blueprints.

Data shape (scenario_taxonomy.json):
    shared:   { company_size|stakeholder|problem|constraint: [ {id,label}, ... ] }
    clusters: { <cluster name>: { <dim>: [...] } }   # per-cluster overrides
    events:   { <event_id>: { cluster?, subtopic:[...], business_type:[...], <overrides> } }

An event's pool is `shared`, overlaid with its `cluster`'s overrides, overlaid with
its own entry (event wins). So most events only author `subtopic` + `business_type`;
a whole cluster (finance, hospitality, entrepreneurship, management) can retune the
shared dimensions once; and any single event can override or OPT OUT of a dimension
by giving it an empty list (e.g. personal finance drops `company_size`).
"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path

_PATH = Path(__file__).parent / "data" / "scenario_taxonomy.json"

# Order is fixed so signatures are stable and comparable across requests.
DIMENSIONS = ["subtopic", "business_type", "company_size", "stakeholder", "problem", "constraint"]


@lru_cache(maxsize=1)
def _doc() -> dict:
    with _PATH.open(encoding="utf-8") as f:
        return json.load(f)


def has_event(event_id: str) -> bool:
    """True if this event has an authored taxonomy entry (else callers fall back to
    the old free-form generation, so unfilled events keep working)."""
    return bool(event_id) and event_id in _doc().get("events", {})


def dimensions_for(event_id: str) -> dict[str, list[dict]]:
    """The full pool for an event: shared dimensions, overlaid with its cluster's
    overrides, overlaid with the event's own entry. A dimension mapped to an empty
    list is treated as opted-out. Returns {} if the event has no entry."""
    doc = _doc()
    events = doc.get("events", {})
    if event_id not in events:
        return {}
    entry = dict(events[event_id])
    cluster = entry.pop("cluster", None)  # routing key, not a dimension
    merged: dict[str, list[dict]] = dict(doc.get("shared", {}))
    if cluster:
        merged.update(doc.get("clusters", {}).get(cluster, {}))
    merged.update(entry)  # event-specific dims + overrides win
    return {d: vs for d, vs in merged.items() if isinstance(vs, list)}


def _signature(dims: dict[str, dict]) -> str:
    """Stable, decodable combo id — e.g. "subtopic:pricing|business_type:bike-shop|...".
    Only the dimensions actually present (in canonical order) appear. Used
    client-side to remember recent combos and skip immediate repeats."""
    return "|".join(f"{d}:{dims[d]['id']}" for d in DIMENSIONS if d in dims)


def _decode(signature: str) -> dict[str, str]:
    """Parse a signature back into {dimension: value_id} (best-effort)."""
    out: dict[str, str] = {}
    for part in signature.split("|"):
        d, _, vid = part.partition(":")
        if d and vid:
            out[d] = vid
    return out


def sample(event_id: str, avoid: list[str] | None = None) -> dict | None:
    """Sample one value per dimension for `event_id`.

    - biases each dimension AWAY from the value used in the most recent avoided
      combo, so back-to-back scenarios differ on every axis; and
    - resamples the whole combo if its signature is in `avoid` (recent combos),
      so a user doesn't get the same combination twice in a short window.

    Returns {"signature": str, "dims": {dim: {id,label}}, "labels": {dim: label}}
    or None when the event has no taxonomy entry (caller falls back).
    """
    pools = dimensions_for(event_id)
    # The two event-defining axes are required; the other four can be opted out per
    # event (e.g. personal finance has no company_size).
    present = [d for d in DIMENSIONS if pools.get(d)]
    if "subtopic" not in present or "business_type" not in present:
        return None

    avoid = avoid or []
    avoid_set = set(avoid)
    last = _decode(avoid[-1]) if avoid else {}  # newest combo — differ from it per-axis

    fallback: dict | None = None
    for _ in range(12):
        chosen: dict[str, dict] = {}
        for d in present:
            pool = pools[d]
            recent_id = last.get(d)
            options = [v for v in pool if v.get("id") != recent_id] or pool
            chosen[d] = random.choice(options)
        sig = _signature(chosen)
        result = {
            "signature": sig,
            "dims": chosen,
            "labels": {d: chosen[d]["label"] for d in present},
        }
        if sig not in avoid_set:
            return result
        fallback = result  # everything collided (tiny pool) — return the last try
    return fallback
