"""One-time migration: fold framework.json + flashcard_content.json into terms.json.

Study content used to be a display-only overlay keyed by criterion id, which made a
flashcard 1-to-1 with a grading criterion by construction. terms.json makes a term a
real object, so the study corpus can grow past the 282 graded criteria while grading
keeps reading framework.json alone.

The migrated terms keep their FW-* id (so saved ★ flags, dashboard deep links, and
Blitz all keep resolving) and carry criterion_id + tier="core" — core means "a skill
we actually grade you on", which is what makes the Core study path a real promise.

Idempotent: re-running rebuilds terms.json from the same two sources. Study-only
terms added later by gen_terms.py are preserved (matched on id).

Run:  python -m scripts.migrate_terms        (from the backend/ directory)
      python -m scripts.migrate_terms --check   (verify only, write nothing)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app import framework

_DATA = Path(__file__).resolve().parents[1] / "app" / "data"
_OLD_CARDS = _DATA / "flashcard_content.json"
_OUT = _DATA / "terms.json"

_NOTE = (
    "Our own study corpus. Terms are authored from public-domain business "
    "fundamentals in our own wording and structure — this file contains no DECA / "
    "MBA Research performance-indicator text, codes, groupings, or event mapping. "
    "`criterion_id` links a term to our framework.json criterion when one exists "
    "(tier=core); study-only terms are tier=extended. See framework-notes.md."
)

# Term field order — kept explicit so regenerated files diff cleanly.
_FIELDS = ("id", "criterion_id", "tier", "domain_id", "domain", "topic", "name",
           "coaches", "definition", "example", "mistake")
_BEATS = ("define", "explain", "connect", "above")


def _load_old_cards() -> dict[str, dict]:
    if not _OLD_CARDS.exists():
        return {}
    with _OLD_CARDS.open(encoding="utf-8") as f:
        return json.load(f).get("cards", {})


def _existing_study_terms() -> list[dict]:
    """Study-only (non-criterion) terms already in terms.json, so a re-run of this
    migration never drops generated content."""
    if not _OUT.exists():
        return []
    with _OUT.open(encoding="utf-8") as f:
        return [t for t in json.load(f).get("terms", []) if not t.get("criterion_id")]


def _term_from_criterion(c: dict, card: dict | None) -> dict:
    ex = (card or {}).get("example") or {}
    return {
        "id": c["id"],  # grandfathered: term id == criterion id for the original 282
        "criterion_id": c["id"],
        "tier": "core",
        "domain_id": c["domain_id"],
        "domain": c["domain"],
        "topic": c["topic"],
        "name": c["name"],
        "coaches": c.get("coaches", ""),
        # The plain, student-facing definition. The criterion's own `definition` is a
        # grading QUESTION ("does the response...") and is deliberately not used here.
        "definition": (card or {}).get("definition", ""),
        "example": {k: ex.get(k, "") for k in _BEATS},
        "mistake": (card or {}).get("mistake", ""),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    args = ap.parse_args()

    cards = _load_old_cards()
    criteria = framework.all_criteria()
    terms = [_term_from_criterion(c, cards.get(c["id"])) for c in criteria]

    missing = [t["id"] for t in terms if not t["definition"]]
    if missing:
        print(f"! {len(missing)} criteria have no flashcard content: {missing[:5]}...", flush=True)

    kept = _existing_study_terms()
    terms.extend(kept)
    terms = [{k: t[k] for k in _FIELDS if k in t} for t in terms]

    core = sum(1 for t in terms if t["tier"] == "core")
    print(f"{len(terms)} terms | {core} core (graded) | {len(terms) - core} extended (study-only)")
    if kept:
        print(f"  preserved {len(kept)} existing study-only terms")

    if args.check:
        return 1 if missing else 0

    doc = {"version": 1, "_note": _NOTE, "terms": terms}
    _OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {_OUT.name}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
