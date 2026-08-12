"""Event study courses — an ordered, finishable path through the study corpus.

The app was built for the rep: generate a scenario, answer it, get graded. That
serves someone who already knows the material. A course serves the student who
doesn't yet — pick your event in June, work the path over the summer, arrive in the
fall with the domain knowledge down so practice can be about delivery.

The join this rests on already existed and was simply unused by the study UI: each
event maps to our framework domains (events.json `domain_ids`), and terms carry a
`domain_id`. So "the terms for this event" is derivable, with no per-event list to
author and drift.

  course  = event -> its domains -> every term in them
  unit    = one topic (~4-7 terms), the thing a student finishes in a sitting
  tier    = core (a skill we actually grade) before extended (worth knowing)

ORDER is deliberate and deterministic:
  - domains follow the event's own `domain_ids` order, so the event's primary
    discipline comes first rather than alphabetically;
  - within a domain, terms keep terms.json file order, which scripts/gen_terms.py
    already sorts to domain -> framework topic order -> core-first. That shared
    ordering is why the library and the course agree; don't re-sort here.

Everything here is pure — no DB, no user. main.py overlays a logged-in user's
progress on top. Same split as progress.py, and it keeps this unit-testable.

Nothing here reads DECA's PI list. The event->domain mapping is our own (see
events.py); there is no event-to-performance-indicator blueprint anywhere.
"""

from __future__ import annotations

from . import events, terms


def _unit_id(domain_id: str, topic: str) -> str:
    """Stable id for a unit. Topics are our own strings, so slugging is cosmetic —
    the pair is what identifies it."""
    return f"{domain_id}::{topic}"


def units_for_domains(domain_ids: list[str]) -> list[dict]:
    """Group the terms of the given domains into topic units.

    Domains come back in the order given (the event's priority), and terms keep
    file order within each — see the module docstring on why that matters.
    """
    out: list[dict] = []
    for domain_id in domain_ids:
        by_topic: dict[str, dict] = {}
        for t in terms.terms_for_domains([domain_id]):
            u = by_topic.get(t["topic"])
            if u is None:
                u = {
                    "id": _unit_id(domain_id, t["topic"]),
                    "domain_id": domain_id,
                    "domain": t["domain"],
                    "topic": t["topic"],
                    "core_ids": [],
                    "extended_ids": [],
                }
                by_topic[t["topic"]] = u
                out.append(u)
            (u["core_ids"] if t["tier"] == "core" else u["extended_ids"]).append(t["id"])
    return out


def course_for(event_id: str) -> dict | None:
    """The full study path for an event, or None if the event is unknown."""
    event = events.get_event(event_id)
    if not event:
        return None

    domain_ids = event.get("domain_ids", [])
    units = units_for_domains(domain_ids)
    core = sum(len(u["core_ids"]) for u in units)
    extended = sum(len(u["extended_ids"]) for u in units)
    return {
        "event_id": event["id"],
        "event": event["name"],
        "cluster": event.get("cluster", ""),
        "units": units,
        "core_count": core,
        "extended_count": extended,
        "total": core + extended,
    }


def course_term_ids(event_id: str, tier: str = "") -> list[str]:
    """Every term id in an event's course, in path order. `tier` filters to
    "core" or "extended"; empty means both."""
    course = course_for(event_id)
    if not course:
        return []
    out: list[str] = []
    for u in course["units"]:
        if tier != "extended":
            out.extend(u["core_ids"])
        if tier != "core":
            out.extend(u["extended_ids"])
    return out


def summarize(course: dict, progress: dict[str, str]) -> dict:
    """Overlay a user's per-term status onto a course.

    `progress` maps term_id -> status ("new" | "learning" | "known"). Terms absent
    from it are "new" — a student who has never seen a term and a student with no
    account look the same here, which is what lets the course render logged-out.
    """
    known_total = 0
    core_known = 0
    for u in course["units"]:
        ids = u["core_ids"] + u["extended_ids"]
        known = [i for i in ids if progress.get(i) == "known"]
        learning = [i for i in ids if progress.get(i) == "learning"]
        u["known"] = len(known)
        u["learning"] = len(learning)
        u["total"] = len(ids)
        # Counted separately because the UI shows one tier at a time: on the Core
        # path a unit's progress must be out of its CORE terms, or a student
        # finishing every graded term in a topic would still see 4/8 and never be
        # able to complete the path they were promised.
        u["core_known"] = sum(1 for i in u["core_ids"] if progress.get(i) == "known")
        u["core_total"] = len(u["core_ids"])
        u["done"] = len(known) == len(ids) and bool(ids)
        known_total += len(known)
        core_known += u["core_known"]

    course["known_count"] = known_total
    course["core_known"] = core_known
    # The Core path is the promise ("every skill we grade you on for this event"),
    # so it gets its own completion number rather than being averaged away.
    course["core_percent"] = round(100 * core_known / course["core_count"]) if course["core_count"] else 0
    course["percent"] = round(100 * known_total / course["total"]) if course["total"] else 0
    return course
