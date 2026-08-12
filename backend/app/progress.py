"""Cross-session progress — deterministic math over a user's stored sessions.

Design principle (matches the product brief): headline what the student CONTROLS
and can improve, never what swings with scenario difficulty.

- Delivery trend is the lead signal: filler rate / pace are measured from audio
  and are independent of which scenario was drawn — an honest, earned "you got
  better."
- Criterion mastery is the most useful diagnostic: a pattern across sessions
  ("Developing on X in 4 of your last 5"), which is scenario-robust.
- Score trend is included but framed as a many-session trend, never a
  last-vs-this delta, with a plain note that scores vary with difficulty.

Every number here is meant to map to a next action. Pure functions over plain
dicts so it's trivially unit-testable (see tests/test_progress.py).
"""

from __future__ import annotations

from statistics import mean

LEVELS = ("novice", "developing", "proficient", "exemplary")
LEVEL_RANK = {lvl: i for i, lvl in enumerate(LEVELS)}
LEVEL_LABEL = {
    "novice": "Novice",
    "developing": "Developing",
    "proficient": "Proficient",
    "exemplary": "Exemplary",
}


def _rank(level: str) -> int:
    return LEVEL_RANK.get(level, 0)


def compute_progress(rows: list[dict]) -> dict:
    """Build the home-page progress payload from a user's session rows.

    Each row needs: created_at (ISO str), content_score (int),
    criterion_results (list of {criterion_id, name, domain, level, points}),
    filler_per_min (float|None), pace_wpm (int|None).
    """
    ordered = sorted(rows, key=lambda r: r.get("created_at") or "")
    return {
        "sessions_count": len(ordered),
        "delivery_trend": _delivery_trend(ordered),
        "criterion_mastery": _mastery(ordered),
        "weakest_criterion": _weakest(ordered),
        "score_trend": _score_trend(ordered),
    }


def _delivery_trend(ordered: list[dict]) -> dict:
    """Lead metric: filler rate over time (spoken sessions only)."""
    spoken = [r for r in ordered if r.get("filler_per_min") is not None]
    if len(spoken) < 2:
        return {
            "available": False,
            "note": "Do a couple of spoken reps and we'll track your filler rate and pace over time — the most reliable sign you're improving.",
        }
    fpm = [float(r["filler_per_min"]) for r in spoken]
    tail = min(3, len(fpm))
    early = round(fpm[0], 1)
    recent = round(mean(fpm[-tail:]), 1)

    wpm_vals = [int(r["pace_wpm"]) for r in spoken if r.get("pace_wpm") is not None]
    recent_wpm = round(mean(wpm_vals[-tail:])) if wpm_vals else None

    if recent + 0.3 < early:
        note = f"Fillers: {early}/min → {recent}/min across your spoken sessions. That's real progress — keep trading “ums” for a short pause."
    elif recent > early + 0.3:
        note = f"Fillers ticked up: {early}/min → {recent}/min. Slow down a touch and let a silent pause do the work instead of a filler."
    else:
        note = f"Fillers are steady around {recent}/min. Solid — a silent beat instead of an “um” is the next gain."

    return {
        "available": True,
        "metric": "filler_per_min",
        "early": early,
        "recent": recent,
        "recent_wpm": recent_wpm,
        "spoken_sessions": len(spoken),
        "note": note,
    }


def _mastery(ordered: list[dict]) -> list[dict]:
    """Per-criterion level history across sessions, weakest first."""
    by_id: dict[str, dict] = {}
    for row in ordered:
        for cr in row.get("criterion_results") or []:
            cid = cr.get("criterion_id")
            if not cid:
                continue
            entry = by_id.setdefault(
                cid,
                {"criterion_id": cid, "name": cr.get("name", cid), "domain": cr.get("domain", ""), "levels": []},
            )
            entry["name"] = cr.get("name", entry["name"])
            entry["domain"] = cr.get("domain", entry["domain"])
            entry["levels"].append(cr.get("level", "novice"))

    out: list[dict] = []
    for entry in by_id.values():
        levels = entry["levels"]
        recent = levels[-5:]
        consistent = _mode_level(recent)
        out.append(
            {
                "criterion_id": entry["criterion_id"],
                "name": entry["name"],
                "domain": entry["domain"],
                "sessions": len(levels),
                "recent_level": levels[-1],
                "consistent_level": consistent,
                "avg_rank": round(mean(_rank(l) for l in levels), 3),
            }
        )
    # Weakest (lowest average rank) first; more sessions = more reliable on ties.
    out.sort(key=lambda e: (e["avg_rank"], -e["sessions"]))
    return out


def _mode_level(levels: list[str]) -> str:
    """Most common level in a window; ties broken toward the weaker level."""
    if not levels:
        return "novice"
    counts: dict[str, int] = {}
    for l in levels:
        counts[l] = counts.get(l, 0) + 1
    best = max(counts.values())
    tied = [l for l, c in counts.items() if c == best]
    return min(tied, key=_rank)


def _weakest(ordered: list[dict]) -> dict | None:
    """The single criterion to drill next, plus a plain-language action."""
    mastery = _mastery(ordered)
    if not mastery:
        return None
    # Prefer criteria seen at least twice (a pattern, not a one-off) when any exist.
    repeated = [m for m in mastery if m["sessions"] >= 2]
    pool = repeated or mastery
    target = pool[0]

    # How many of the recent window sit at (or below) the consistent level.
    window = [
        cr.get("level", "novice")
        for row in ordered
        for cr in (row.get("criterion_results") or [])
        if cr.get("criterion_id") == target["criterion_id"]
    ][-5:]
    consistent = target["consistent_level"]
    at_level = sum(1 for l in window if _rank(l) <= _rank(consistent))
    label = LEVEL_LABEL.get(consistent, "Developing")

    if _rank(consistent) >= 2:  # proficient or above — sharpen, don't alarm
        note = (
            f"Your thinnest area lately is {target['name']}, and you're already {label} on it "
            f"in {at_level} of your last {len(window)} sessions. Push it toward exemplary."
        )
    else:
        note = (
            f"You've been {label} on {target['name']} in {at_level} of your last {len(window)} sessions. "
            f"That's the one to drill next."
        )

    return {
        "criterion_id": target["criterion_id"],
        "name": target["name"],
        "domain": target["domain"],
        "consistent_level": consistent,
        "note": note,
    }


def _score_trend(ordered: list[dict]) -> dict:
    """Overall-score points over time, framed as a trend, never a delta."""
    points = [
        {"created_at": r.get("created_at"), "score": int(r.get("content_score", 0))}
        for r in ordered
    ]
    note = "Scores swing with scenario difficulty, so watch the overall trend — not any single session."
    direction = "flat"
    if len(points) >= 3:
        third = max(1, len(points) // 3)
        early = mean(p["score"] for p in points[:third])
        late = mean(p["score"] for p in points[-third:])
        if late > early + 2:
            direction = "up"
        elif late < early - 2:
            direction = "down"
    return {
        "available": len(points) >= 3,
        "points": points,
        "direction": direction,
        "note": note,
    }
