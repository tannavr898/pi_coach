"""Delivery metrics — deterministic arithmetic over word timestamps (roadmap §8).

This is the trustworthy half of the voice layer: pace, fillers, pauses, and time
use are all computed directly from the per-word start/end times the transcription
API returns. No model, no guessing — just math, so the numbers are accurate and
defensible. We measure ONLY timing/fillers here; tone/confidence are out of scope
(roadmap §2 delivery honesty) and never inferred.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Sequence
from typing import Protocol

# Pace thresholds (WPM), from roadmap §8: sweet spot ~130-160; flag fast/slow.
PACE_SLOW = 110
PACE_FAST = 180

# Pause thresholds (seconds).
NOTICEABLE_PAUSE = 0.75
LONG_PAUSE = 3.0

# Presentation window: a Principles role-play presentation is up to ~10 minutes,
# and that INCLUDES the judge's follow-up questions. So the spoken pitch itself
# should land around 7-8 minutes, leaving 1-2 minutes for the questions.
DEFAULT_TARGET_SECONDS = 450  # ~7:30 recommended speaking time
SPEAK_MIN_SECONDS = 360  # under 6:00 — room to develop each point more
SPEAK_MAX_SECONDS = 510  # over 8:30 — leave time for the judge's questions

# "um"/"uh" family — almost always disfluencies, safe to count as fillers.
HARD_FILLERS = {"um", "umm", "uhm", "uh", "uhh", "er", "erm", "err", "hmm", "hm", "mm", "mhm", "uh-huh"}
# Discourse crutches — context-dependent, so reported separately and advisory
# only (never rolled into the filler rate, to avoid unfair penalties).
CRUTCH_SINGLES = {"like", "basically", "literally", "actually"}
CRUTCH_PHRASES = [("you", "know"), ("i", "mean"), ("sort", "of"), ("kind", "of"), ("you", "see")]


class _Word(Protocol):
    text: str
    start_ms: int
    end_ms: int


def _norm(text: str) -> str:
    """Lowercase and strip surrounding punctuation; keep internal '/-."""
    return re.sub(r"^[^\w]+|[^\w]+$", "", text.lower())


def _clamp(v: float, lo: float = 0, hi: float = 100) -> int:
    return int(round(max(lo, min(hi, v))))


def delivery_score(
    pace_flag: str,
    filler_per_min: float,
    long_pause_count: int,
    time_flag: str,
    reading_signal: bool,
) -> tuple[int, list[dict]]:
    """A deterministic 0-100 delivery score with a component breakdown.

    Built only from timing/fluency facts (never tone or confidence). Returns
    (score, components) where each component is {label, score, hint}. This feeds
    both the Delivery tab and the blended overall score.
    """
    pace = 100 if pace_flag == "good" else 58
    fluency = _clamp(100 - filler_per_min * 12)          # ~0/min=100, 2.5=70, 5=40
    flow = _clamp(100 - long_pause_count * 20)            # each 3s+ pause costs 20
    timing = 100 if time_flag == "good" else 62

    components = [
        {"label": "Pace", "score": pace,
         "hint": "In the 130–160 WPM range" if pace == 100 else "Drifted fast or slow"},
        {"label": "Fluency", "score": fluency,
         "hint": "Few filler words" if fluency >= 80 else "Trim the um/uh"},
        {"label": "Flow", "score": flow,
         "hint": "No long stalls" if flow >= 80 else "Watch the long pauses"},
        {"label": "Timing", "score": timing,
         "hint": "Used the window well" if timing == 100 else "Off the target length"},
    ]
    # Weighted blend; a read-aloud signal shaves a little off.
    overall = pace * 0.30 + fluency * 0.30 + flow * 0.20 + timing * 0.20
    if reading_signal:
        overall -= 4
    return _clamp(overall), components


# --- video's contribution to the delivery score -----------------------------
#
# WHY THIS IS DELIBERATELY SMALL
# Video sees ~8-60 still frames of a multi-minute rep. That is a real signal —
# a student who never looks up is visible in it — but it is a SNAPSHOT, and the
# error bars are wide: a frame lands where it lands, and glancing at notes for
# the two seconds a sample happened to fire is indistinguishable from reading
# the whole time. Audio metrics, by contrast, are computed over every word.
#
# So video is a nudge, never a verdict. Four rules keep it honest:
#
#   1. FLOOR. Under VIDEO_MIN_CHECKS frames we don't adjust at all. A 3-frame
#      sample of a 6-minute rep isn't evidence, and pretending otherwise to
#      produce a number would be the exact dishonesty this app exists to avoid.
#   2. CAP. The swing is at most VIDEO_MAX_ADJUSTMENT points on a 0-100 score —
#      too small to move a student across a grade band on the strength of a
#      handful of frames, large enough to notice and act on.
#   3. CONFIDENCE SCALING. Between the floor and VIDEO_FULL_CONFIDENCE_CHECKS
#      the cap scales linearly with sample size, so a short rep with 10 frames
#      moves the score about a third as much as a full 30-frame one. More
#      evidence, more influence — which is what a sample size is FOR.
#   4. OBSERVABLE INPUT ONLY. The input is the eye-contact rate, a count of
#      frames. Not "presence", not "confidence" — the same rule the rest of the
#      delivery engine follows.
#
# The center is 60%, not 100%: a presenter who looks at their notes or their
# product a third of the time is doing the job correctly, and scoring against a
# never-look-away ideal would coach students into staring.
VIDEO_MIN_CHECKS = 8
VIDEO_FULL_CONFIDENCE_CHECKS = 30
VIDEO_MAX_ADJUSTMENT = 4.0
VIDEO_CENTER_PERCENT = 60.0
VIDEO_FULL_SWING = 30.0  # 30 points either side of center reaches the full cap


def video_adjustment(checks: int, eye_contact_count: int) -> tuple[float, str]:
    """How much the sampled frames should move the delivery score, and why.

    Returns ``(delta, reason)``. `delta` is signed and already capped/scaled;
    `reason` is shown to the student so the number is never unexplained.
    """
    if checks <= 0:
        return 0.0, "No frames were readable, so video didn't affect your delivery score."
    if checks < VIDEO_MIN_CHECKS:
        return 0.0, (
            f"Only {checks} frame{'s' if checks != 1 else ''} were sampled — too few to "
            "adjust your delivery score, so this rep was scored on audio alone. Longer "
            "reps sample more frames."
        )

    eye_percent = eye_contact_count / checks * 100
    # -1..+1 relative to the center band, then capped and scaled by sample size.
    offset = max(-1.0, min(1.0, (eye_percent - VIDEO_CENTER_PERCENT) / VIDEO_FULL_SWING))
    confidence = min(1.0, checks / VIDEO_FULL_CONFIDENCE_CHECKS)
    delta = round(offset * VIDEO_MAX_ADJUSTMENT * confidence, 1)

    direction = "raised" if delta > 0 else "lowered" if delta < 0 else "didn't change"
    magnitude = f" by {abs(delta):.1f}" if delta else ""
    return delta, (
        f"Eye contact in {eye_contact_count} of {checks} checks {direction} your delivery "
        f"score{magnitude}. Video is sampled from still frames, so it can only move this "
        f"score by up to {VIDEO_MAX_ADJUSTMENT:.0f} points either way."
    )


def apply_video(
    score: int,
    components: list[dict],
    *,
    checks: int,
    eye_contact_count: int,
) -> tuple[int, list[dict], float, str]:
    """Fold observable video checks into an existing delivery score.

    Additive by design: the four audio components are computed and weighted
    exactly as they were before this feature existed, and video only shifts the
    final number. That keeps the audio engine — the accurate half — untouched,
    and means a voice-only rep and a video rep are graded on the same scale
    rather than on two different ones.
    """
    delta, reason = video_adjustment(checks, eye_contact_count)
    if checks <= 0:
        return score, components, 0.0, reason

    eye_percent = round(eye_contact_count / checks * 100)
    # Shown alongside the audio components, but marked advisory: its `score` is
    # the observed rate itself, not a graded band, and the hint states the raw
    # count so a student can check the claim against their own memory of the rep.
    enriched = [
        *components,
        {
            "label": "Eye contact",
            "score": eye_percent,
            "hint": f"Looked at the camera in {eye_contact_count} of {checks} sampled frames",
            "advisory": True,
        },
    ]
    return _clamp(score + delta), enriched, delta, reason


def compute_delivery(
    words: Sequence[_Word],
    audio_duration_s: float = 0.0,
    *,
    target_seconds: int = DEFAULT_TARGET_SECONDS,
) -> dict:
    """Compute delivery metrics from timestamped words. Pure and total."""
    n = len(words)
    if n == 0:
        return {
            "duration_seconds": round(audio_duration_s, 1),
            "word_count": 0,
            "pace_wpm": 0,
            "pace_flag": "slow",
            "filler_count": 0,
            "filler_per_min": 0.0,
            "fillers": [],
            "crutch_phrases": [],
            "pause_count": 0,
            "long_pauses": [],
            "longest_pause_seconds": 0.0,
            "time_used_seconds": round(audio_duration_s, 1),
            "time_target_seconds": target_seconds,
            "time_flag": "short",
            "reading_signal": False,
            "notes": ["No speech was detected in the recording."],
            "delivery_score": 0,
            "delivery_components": [],
        }

    first_start = words[0].start_ms
    last_end = words[-1].end_ms
    active_s = max((last_end - first_start) / 1000.0, 0.001)
    duration_s = audio_duration_s if audio_duration_s > 0 else active_s

    # --- pace ---
    pace = round(n / (active_s / 60.0))
    pace_flag = "slow" if pace < PACE_SLOW else "fast" if pace > PACE_FAST else "good"

    # --- fillers + crutches ---
    tokens = [_norm(w.text) for w in words]
    filler_counts: dict[str, int] = {}
    for t in tokens:
        if t in HARD_FILLERS:
            filler_counts[t] = filler_counts.get(t, 0) + 1
    filler_total = sum(filler_counts.values())
    filler_per_min = round(filler_total / (active_s / 60.0), 1)

    crutch_counts: dict[str, int] = {}
    for t in tokens:
        if t in CRUTCH_SINGLES:
            crutch_counts[t] = crutch_counts.get(t, 0) + 1
    for i in range(len(tokens) - 1):
        pair = (tokens[i], tokens[i + 1])
        if pair in CRUTCH_PHRASES:
            phrase = " ".join(pair)
            crutch_counts[phrase] = crutch_counts.get(phrase, 0) + 1

    # --- pauses (gaps between consecutive words) ---
    gaps_s: list[float] = []
    long_pauses: list[dict] = []
    noticeable = 0
    for i in range(n - 1):
        gap = (words[i + 1].start_ms - words[i].end_ms) / 1000.0
        if gap <= 0:
            gaps_s.append(0.0)
            continue
        gaps_s.append(gap)
        if gap >= NOTICEABLE_PAUSE:
            noticeable += 1
        if gap >= LONG_PAUSE:
            long_pauses.append({"at_seconds": round(words[i].end_ms / 1000.0, 1), "length_seconds": round(gap, 1)})
    longest_pause = round(max(gaps_s), 1) if gaps_s else 0.0

    # --- time management (aim ~7-8 min of speaking; questions fill the rest) ---
    if duration_s < SPEAK_MIN_SECONDS:
        time_flag = "short"
    elif duration_s > SPEAK_MAX_SECONDS:
        time_flag = "long"
    else:
        time_flag = "good"

    # --- reading-vs-presenting (soft signal, never a hard penalty) ---
    reading_signal = False
    if n >= 40 and noticeable <= 1:
        nonzero = [g for g in gaps_s if g > 0]
        if len(nonzero) >= 5:
            mean_gap = statistics.fmean(nonzero)
            cv = statistics.pstdev(nonzero) / mean_gap if mean_gap > 0 else 1.0
            reading_signal = cv < 0.5

    dscore, dcomponents = delivery_score(pace_flag, filler_per_min, len(long_pauses), time_flag, reading_signal)

    return {
        "duration_seconds": round(duration_s, 1),
        "word_count": n,
        "pace_wpm": pace,
        "pace_flag": pace_flag,
        "filler_count": filler_total,
        "filler_per_min": filler_per_min,
        "fillers": [{"word": w, "count": c} for w, c in sorted(filler_counts.items(), key=lambda x: -x[1])],
        "crutch_phrases": [{"phrase": p, "count": c} for p, c in sorted(crutch_counts.items(), key=lambda x: -x[1])],
        "pause_count": noticeable,
        "long_pauses": long_pauses,
        "longest_pause_seconds": longest_pause,
        "time_used_seconds": round(duration_s, 1),
        "time_target_seconds": target_seconds,
        "time_flag": time_flag,
        "reading_signal": reading_signal,
        "notes": _notes(pace, pace_flag, filler_total, filler_per_min, crutch_counts, long_pauses, duration_s, time_flag, reading_signal),
        "delivery_score": dscore,
        "delivery_components": dcomponents,
    }


# A single voice doing this share (or more) of the talking reads as dominating.
DOMINATION_SHARE = 0.65


def compute_speakers(words: Sequence[_Word]) -> dict:
    """Per-speaker talk breakdown for team events. Deterministic, from timestamps.

    Returns {"speakers": [...], "dominated_by": "A"|"", "balance_note": "..."}.
    Talk time is summed voiced word durations (gaps excluded), so it reflects who
    actually held the floor. Empty when there aren't at least two labeled speakers.
    """
    by: dict[str, list] = {}
    for w in words:
        spk = getattr(w, "speaker", "") or ""
        if spk:
            by.setdefault(spk, []).append(w)
    if len(by) < 2:
        return {"speakers": [], "dominated_by": "", "balance_note": ""}

    rows: list[dict] = []
    for spk in sorted(by):
        ws = by[spk]
        talk_s = sum(max(w.end_ms - w.start_ms, 0) for w in ws) / 1000.0
        fillers = sum(1 for w in ws if _norm(w.text) in HARD_FILLERS)
        pace = round(len(ws) / (talk_s / 60.0)) if talk_s > 0 else 0
        rows.append({
            "speaker": spk,
            "talk_seconds": round(talk_s, 1),
            "word_count": len(ws),
            "filler_count": fillers,
            "pace_wpm": pace,
        })

    total = sum(r["talk_seconds"] for r in rows) or 1.0
    for r in rows:
        r["talk_share"] = round(r["talk_seconds"] / total, 3)

    top = max(rows, key=lambda r: r["talk_share"])
    dominated_by = top["speaker"] if top["talk_share"] >= DOMINATION_SHARE else ""
    shares = ", ".join(f"{r['speaker']} {round(r['talk_share'] * 100)}%" for r in rows)
    if dominated_by:
        balance_note = (
            f"Speaker {dominated_by} did {round(top['talk_share'] * 100)}% of the talking ({shares}). "
            "In a team event judges want to see both partners contribute — aim for a more even split."
        )
    else:
        balance_note = f"Fairly balanced split ({shares}) — both partners held the floor."
    return {"speakers": rows, "dominated_by": dominated_by, "balance_note": balance_note}


def _fmt_time(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m}:{s:02d}"


def _notes(pace, pace_flag, filler_total, filler_per_min, crutch_counts, long_pauses, duration_s, time_flag, reading_signal) -> list[str]:
    notes: list[str] = []
    if pace_flag == "fast":
        notes.append(f"Your pace was {pace} WPM — on the fast side. Aim for 130–160 so the judge can follow.")
    elif pace_flag == "slow":
        notes.append(f"Your pace was {pace} WPM — a bit slow. Lifting toward 130–160 will sound more confident.")
    else:
        notes.append(f"Your pace was {pace} WPM — right in the presentation sweet spot.")

    if filler_total == 0:
        notes.append("No filler words (um/uh) — clean delivery.")
    elif filler_per_min >= 4:
        notes.append(f"{filler_total} filler words ({filler_per_min}/min) — noticeable. A brief silent pause beats an 'um'.")
    else:
        notes.append(f"{filler_total} filler words ({filler_per_min}/min) — low, but worth trimming.")

    if crutch_counts:
        top = max(crutch_counts.items(), key=lambda x: x[1])
        notes.append(f"Watch crutch phrases like \"{top[0]}\" (used {top[1]}×) — advisory, not counted against pace.")

    if long_pauses:
        worst = max(long_pauses, key=lambda p: p["length_seconds"])
        notes.append(f"{len(long_pauses)} long pause(s) over 3s — the longest was {worst['length_seconds']}s at {_fmt_time(worst['at_seconds'])}. Short stalls are fine; long ones lose the room.")

    if time_flag == "short":
        notes.append(f"You spoke for {_fmt_time(duration_s)} — short of the 7-8 minute target. Develop each point further to use the window.")
    elif time_flag == "long":
        notes.append(f"You spoke for {_fmt_time(duration_s)} — long. The 10-minute window includes the judge's two questions, so aim to wrap your pitch by ~8 minutes.")
    else:
        notes.append(f"You spoke for {_fmt_time(duration_s)} — right around the 7-8 minute target, leaving room for the judge's questions.")

    if reading_signal:
        notes.append("Soft signal: your pacing was very even with almost no natural pauses, which can sound read rather than presented. (Advisory only.)")
    return notes
