"""The independent evaluation framework — the single source of truth for the
criteria the app generates against and grades on.

This replaces the old official-PI data layer. It loads framework.json (our own
authored criteria — see backend/app/data/framework-notes.md) and exposes thin,
deterministic lookups. Nothing here reads DECA's PI list; the framework stands on
public-domain business concepts in our own wording, structure, and id scheme.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_FRAMEWORK_PATH = Path(__file__).parent / "data" / "framework.json"


class CriterionNotFoundError(KeyError):
    """Raised when a criterion id is not present in the framework."""


@lru_cache(maxsize=1)
def load_framework() -> dict:
    """Return the whole framework document (cached)."""
    with _FRAMEWORK_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def domains() -> list[dict]:
    """Our business domains: [{id, name, blurb}, ...]."""
    return load_framework()["domains"]


def domain_ids() -> set[str]:
    return {d["id"] for d in domains()}


@lru_cache(maxsize=1)
def all_criteria() -> list[dict]:
    """Every criterion in file order."""
    return load_framework()["criteria"]


@lru_cache(maxsize=1)
def _index() -> dict[str, dict]:
    return {c["id"]: c for c in all_criteria()}


def get_criteria(ids: list[str]) -> list[dict]:
    """Resolve criterion ids against the framework, preserving order and
    skipping unknowns. This is the authoritative text — never trust the client
    (or the model) for criterion wording; always re-pin from here."""
    idx = _index()
    return [idx[i] for i in ids if i in idx]


def criteria_for_domains(domain_ids_wanted: list[str]) -> list[dict]:
    """Every criterion belonging to any of the given domains (file order)."""
    wanted = set(domain_ids_wanted)
    return [c for c in all_criteria() if c["domain_id"] in wanted]


def domain_summaries() -> list[dict]:
    """Domains with a criterion count, for UI/debugging."""
    counts: dict[str, int] = {}
    for c in all_criteria():
        counts[c["domain_id"]] = counts.get(c["domain_id"], 0) + 1
    return [{**d, "criteria_count": counts.get(d["id"], 0)} for d in domains()]
