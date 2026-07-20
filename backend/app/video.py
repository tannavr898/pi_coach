"""Video analysis — observable eye-contact and expression checks on sampled frames.

THE CLAIM RULE, AND HOW IT'S ENFORCED
This module reports only what is directly observable in a frame:

    "Looked at the camera in 38 of 45 checks (84%)"        <- observable
    "Smiled or showed a positive expression in 12 of 45"   <- observable
    "Face not detected in 6 checks"                        <- observable

It never reports an inferred internal state — no confidence score, no charisma
rating, no "you seemed nervous". Two reasons, and the second is the one that
matters: inferring internal state from sampled frames is unreliable, and telling
an already-anxious student that they "seemed unconfident" is actively harmful
feedback. This mirrors the existing rule that delivery is timing only, never tone.

That rule is enforced STRUCTURALLY, not by prompt discipline. The model answers
three yes/no questions per frame and writes no prose at all. Every number and
every sentence a student reads is computed in Python from those booleans (see
`_notes`). A prompt that drifts can't leak an inference into the UI, because
there is no path from the model's output to user-facing text.

PRIVACY (users are minors, so this is stricter than the audio path)
No video and no frames are ever persisted. Frames arrive in the request body,
are held in memory for the length of the call, and are gone when it returns.
The full video file is never uploaded — never even recorded: the client samples
still frames from the live camera preview (see the frontend capture code), so
there is no video file to leak in the first place.

COST (this is why the caps exist)
Vision is the expensive part of a session — roughly 2-3x an audio-only rep — so
sampling and batching are doing real work:
  - frames are downscaled client-side to ~512px before upload. Image tokens scale
    with pixel area (~w*h/750), so a 512x384 frame is ~260 tokens instead of the
    ~1,600 a full-resolution one would cost. Face presence, gaze direction, and a
    smile are all coarse features; they do not need fidelity we'd be paying for.
  - HARD CAP of 60 frames per session, regardless of length. A 10-minute rep must
    not cost more than a 5-minute one.
  - frames are batched BATCH_SIZE per call, so the system prompt and instruction
    are charged once per batch rather than once per frame.
At 60 frames that's ~5 calls of ~4k input tokens each on a fast/cheap model —
cents per session, not dollars.
"""

from __future__ import annotations

import logging

from . import config, llm

log = logging.getLogger("uvicorn.error")

# Never analyze more than this many frames in one session, whatever its length.
# The client widens its sampling interval to fit under the cap; this is the
# server-side backstop, because the cap protects the bill and the client doesn't.
MAX_FRAMES = 60

# Frames per vision call. Large enough that the per-call prompt overhead is
# amortized, small enough that one flaky call loses only a slice of the session
# and the per-frame JSON stays comfortably inside max_tokens.
BATCH_SIZE = 15

_ALLOWED_MEDIA = {"image/jpeg", "image/png", "image/webp"}

_SYSTEM = """You are a precise visual annotator for a presentation-practice app.

You will be shown numbered still frames sampled from a student's practice
presentation. For EACH frame, answer three factual yes/no questions:

1. face_detected  — is a human face visible in the frame at all?
2. eye_contact    — is the person looking at or near the camera (roughly toward
                    the viewer), as opposed to clearly away, down, or to the side?
3. positive_expression — is the person smiling or showing a clearly positive
                    facial expression (raised cheeks, open mouth smile, warm
                    expression)? A neutral face is NOT a positive expression.

If face_detected is false, set the other two to false for that frame.

Answer ONLY these observable questions. Do NOT assess confidence, nervousness,
engagement, enthusiasm, charisma, competence, or any internal state — you cannot
observe those and must not guess at them.

Return ONLY a JSON object of this exact shape, with one entry per frame shown:
{"frames": [{"i": 0, "face_detected": true, "eye_contact": true, "positive_expression": false}]}"""

_INSTRUCTION = (
    "Annotate every frame above. Return one entry per frame, using the frame's "
    "number as `i`. JSON only, no commentary."
)


class VideoNotConfigured(RuntimeError):
    """No Anthropic key configured, so vision analysis can't run."""


def sample_cap(total_frames: int) -> int:
    """How many of the client's frames we'll actually analyze."""
    return min(total_frames, MAX_FRAMES)


def _decimate(frames: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Reduce an oversized frame list to MAX_FRAMES, evenly across the session.

    Evenly, not "the first 60": truncating would analyze only the opening minutes
    and silently report nothing about how the student finished — which is often
    the part that changed. Sampling across the whole recording keeps every
    reported percentage representative of the session the student actually gave.
    """
    n = len(frames)
    if n <= MAX_FRAMES:
        return frames
    step = n / MAX_FRAMES
    return [frames[int(i * step)] for i in range(MAX_FRAMES)]


def analyze(frames: list[tuple[str, str]]) -> dict:
    """Analyze sampled frames and return observable counts + coaching notes.

    `frames` is ``(media_type, base64_data)``, already downscaled client-side.
    Frames are discarded when this function returns — nothing is written anywhere.
    """
    if not config.has_api_key():
        raise VideoNotConfigured("Video analysis isn't configured on this server.")

    usable = _decimate([f for f in frames if f[0] in _ALLOWED_MEDIA and f[1]])
    if not usable:
        return _aggregate([])

    results: list[dict] = []
    for start in range(0, len(usable), BATCH_SIZE):
        batch = usable[start:start + BATCH_SIZE]
        try:
            raw = llm.complete_vision(
                _SYSTEM, batch, _INSTRUCTION,
                model=config.VIDEO_MODEL,
                # ~40 tokens of JSON per frame, plus headroom.
                max_tokens=64 * len(batch) + 256,
            )
            data = llm.parse_json_object(raw)
        except llm.LLMError as exc:
            # One bad batch shouldn't lose the whole session's video feedback.
            # We drop the batch and report on what we could read — the
            # denominator the student sees is the number of checks we ACTUALLY
            # made, so the percentages stay honest rather than being padded with
            # frames we never looked at.
            log.warning("video batch %d failed, skipping: %s", start // BATCH_SIZE, exc)
            continue

        for entry in data.get("frames", []):
            if isinstance(entry, dict):
                results.append(entry)

    return _aggregate(results)


def _aggregate(entries: list[dict]) -> dict:
    """Turn per-frame booleans into the counts and notes the UI renders.

    All arithmetic is done here, in Python — the model is never asked for a
    percentage, a score, or a sentence.
    """
    checks = len(entries)

    def _truthy(entry: dict, key: str) -> bool:
        return entry.get(key) is True

    faces = sum(1 for e in entries if _truthy(e, "face_detected"))
    off_frame = checks - faces
    # Gaze and expression are only meaningful when a face was actually found, so
    # a frame with no face can't quietly count as "not making eye contact".
    eye = sum(1 for e in entries if _truthy(e, "face_detected") and _truthy(e, "eye_contact"))
    smile = sum(1 for e in entries if _truthy(e, "face_detected") and _truthy(e, "positive_expression"))

    def pct(n: int) -> float:
        return round(n / checks * 100, 1) if checks else 0.0

    return {
        "checks": checks,
        "eye_contact_count": eye,
        "eye_contact_percent": pct(eye),
        "positive_expression_count": smile,
        "positive_expression_percent": pct(smile),
        "off_frame_count": off_frame,
        "off_frame_percent": pct(off_frame),
        "notes": _notes(checks, eye, smile, off_frame),
    }


def _notes(checks: int, eye: int, smile: int, off_frame: int) -> list[str]:
    """Coaching notes, derived deterministically from the counts.

    Written in Python rather than asked of the model for two reasons. First, it
    makes the no-inferred-states rule structural: there is no way for "you seemed
    nervous" to reach a student, because no model output becomes user-facing text.
    Second, every line answers "so what do I do next?" — a number a student can't
    act on is just a scoreboard, and this product is coaching, not judging.
    """
    if not checks:
        return ["We couldn't read any frames from this recording, so there's nothing to report here."]

    out: list[str] = []
    eye_pct = eye / checks * 100
    off_pct = off_frame / checks * 100

    # Off-frame first: if the camera couldn't see them, every other number below
    # is measured against a smaller sample and framing is the fix that unlocks it.
    if off_frame:
        out.append(
            f"Your face wasn't visible in {off_frame} of {checks} checks — try centering "
            "yourself in frame before you start, and check you stay in shot if you move "
            "while you talk."
        )

    if eye_pct >= 80:
        out.append(
            f"You looked at the camera in {eye} of {checks} checks. That's the habit judges "
            "read as directness — keep it when you move to notes."
        )
    elif eye_pct >= 50:
        out.append(
            f"You looked at the camera in {eye} of {checks} checks. Try glancing at your notes "
            "for a key figure and then returning to the camera, rather than reading from them."
        )
    else:
        out.append(
            f"You looked at the camera in {eye} of {checks} checks. Pick two or three moments "
            "in your response — your opening line, your recommendation, your close — and "
            "deliver those straight to the lens."
        )

    if smile == 0:
        out.append(
            "No positive expression was detected in any check. A brief smile on your greeting "
            "and your close is an easy, concrete thing to add on your next rep."
        )
    else:
        out.append(
            f"A smile or positive expression showed up in {smile} of {checks} checks — the "
            "greeting and the close are the two moments where it lands hardest."
        )

    # Cap at three so the panel stays actionable rather than becoming a list to
    # skim past.
    return out[:3]


DISCLAIMER = (
    "Video measures eye contact and expression as observable checks on sampled "
    "frames — not confidence, charisma, or how you felt. It's practice coaching, "
    "never an official or predicted judge score. Your video is never uploaded or "
    "stored: frames are sampled in your browser, analyzed, and discarded."
)
