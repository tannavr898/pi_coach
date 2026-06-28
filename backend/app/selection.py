"""Pick the performance indicators a single role-play will surface.

A real Principles role-play surfaces ~4 PIs and feels coherent because they hang
together — so by default we draw all of them from one instructional area, which
keeps the generated scenario focused. Callers can override with an explicit
`area` or an exact `pi_ids` list (e.g. to reproduce a scenario).
"""

from __future__ import annotations

import random

from .data_loader import get_event, get_instructional_areas


def _index(code: str) -> dict[str, dict]:
    """Map every PI id available to an event to an enriched record."""
    out: dict[str, dict] = {}
    for area in get_instructional_areas(code):
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


def select_pis(
    code: str,
    *,
    count: int | None = None,
    area: str | None = None,
    pi_ids: list[str] | None = None,
    seed: int | None = None,
) -> list[dict]:
    """Return the PI records for one role-play.

    - `pi_ids` given → return exactly those (preserving order), skipping unknowns.
    - `area` given → draw `count` PIs from that instructional area.
    - otherwise → pick one instructional area at random and draw `count` from it,
      topping up from the wider pool only if that area is too small.
    """
    index = _index(code)
    if pi_ids:
        return [index[i] for i in pi_ids if i in index]

    if count is None:
        count = get_event(code).get("pi_count", 4)
    rng = random.Random(seed)
    areas = get_instructional_areas(code)

    if area:
        pool = [p for p in index.values() if p["area"] == area.upper()]
    else:
        # prefer an area with enough PIs to fill the role-play on its own
        candidates = [a for a in areas if len(a["performance_indicators"]) >= count] or areas
        primary = rng.choice(candidates)
        pool = [index[pi["id"]] for pi in primary["performance_indicators"]]

    rng.shuffle(pool)
    selected = pool[:count]
    if len(selected) < count:
        chosen = {p["id"] for p in selected}
        rest = [p for p in index.values() if p["id"] not in chosen]
        rng.shuffle(rest)
        selected += rest[: count - len(selected)]
    return selected
