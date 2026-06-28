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
    }


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
