"""Video analysis: the sampling math, the aggregation, and — most importantly —
the honesty rules. Everything here is pure; the vision call itself is the only
part that isn't, and it produces booleans, not prose."""

import re

import pytest

from app import video


def _entry(face=True, eye=False, smile=False):
    return {"face_detected": face, "eye_contact": eye, "positive_expression": smile}


# --- the hard frame cap ----------------------------------------------------


def test_never_analyzes_more_than_the_cap():
    """A 10-minute session must not cost more than a 5-minute one."""
    frames = [("image/jpeg", f"f{i}") for i in range(500)]
    assert len(video._decimate(frames)) == video.MAX_FRAMES


def test_short_sessions_are_untouched():
    frames = [("image/jpeg", f"f{i}") for i in range(12)]
    assert video._decimate(frames) == frames


def test_decimation_spans_the_whole_session():
    """Truncating to the first N frames would report only on the opening minutes
    and say nothing about how the student finished — often the part that changed.
    Sampling must reach the end of the recording."""
    frames = [("image/jpeg", str(i)) for i in range(600)]
    kept = video._decimate(frames)
    assert kept[0][1] == "0"
    # Last kept frame lands in the final stretch, not at frame 59.
    assert int(kept[-1][1]) > 550


def test_batching_math_covers_every_frame():
    """Batches must tile the frame list exactly — no frame analyzed twice, none
    silently dropped (a dropped frame would skew every percentage we report)."""
    n = video.MAX_FRAMES
    batches = [
        list(range(s, min(s + video.BATCH_SIZE, n)))
        for s in range(0, n, video.BATCH_SIZE)
    ]
    assert [i for b in batches for i in b] == list(range(n))


# --- aggregation -----------------------------------------------------------


def test_counts_and_percentages():
    entries = [_entry(eye=True)] * 8 + [_entry(eye=False)] * 2
    got = video._aggregate(entries)
    assert got["checks"] == 10
    assert got["eye_contact_count"] == 8
    assert got["eye_contact_percent"] == 80.0
    assert got["off_frame_count"] == 0


def test_missing_face_counts_as_off_frame():
    got = video._aggregate([_entry(face=False)] * 3 + [_entry(eye=True)] * 7)
    assert got["off_frame_count"] == 3
    assert got["eye_contact_count"] == 7


def test_no_face_cannot_count_as_eye_contact_or_smile():
    """A frame with no face must not quietly become a 'not looking' data point in
    a way that also credits gaze or expression — those are unobservable there."""
    got = video._aggregate([_entry(face=False, eye=True, smile=True)] * 4)
    assert got["eye_contact_count"] == 0
    assert got["positive_expression_count"] == 0
    assert got["off_frame_count"] == 4


def test_zero_checks_is_safe():
    """Every batch failing must not divide by zero — it must report nothing."""
    got = video._aggregate([])
    assert got["checks"] == 0
    assert got["eye_contact_percent"] == 0.0
    assert got["notes"]


def test_denominator_is_frames_actually_read():
    """When a batch fails we report on what we could read. The denominator has to
    be the checks we actually made, or the percentages become fiction."""
    got = video._aggregate([_entry(eye=True)] * 30)  # 60 sent, 30 readable
    assert got["checks"] == 30
    assert got["eye_contact_percent"] == 100.0


# --- the claim rules (§2) --------------------------------------------------

# Language that asserts an internal state we cannot observe from sampled frames.
_BANNED = re.compile(
    r"\b(confiden|nervous|anxious|unconfident|charisma|engag|disengag|enthusias|"
    r"passion|comfortable|uncomfortable|shy|scared|energy|likeab|warmth|"
    r"personab|authentic|sincer)",
    re.I,
)


@pytest.mark.parametrize(
    "checks,eye,smile,off",
    [
        (45, 38, 12, 6),   # strong
        (40, 20, 3, 0),    # middling
        (40, 5, 0, 12),    # weak, no smile, often off-frame
        (10, 10, 10, 0),   # perfect
        (0, 0, 0, 0),      # nothing readable
    ],
)
def test_notes_never_infer_an_internal_state(checks, eye, smile, off):
    """The rule that makes this feature safe to ship to anxious teenagers: we
    report what the camera saw, never what we think they felt."""
    for note in video._notes(checks, eye, smile, off):
        assert not _BANNED.search(note), note


@pytest.mark.parametrize(
    "checks,eye,smile,off",
    [(45, 38, 12, 6), (40, 20, 3, 0), (40, 5, 0, 12), (10, 10, 10, 0)],
)
def test_every_note_is_actionable_and_bounded(checks, eye, smile, off):
    notes = video._notes(checks, eye, smile, off)
    assert 1 <= len(notes) <= 3
    for note in notes:
        assert note.strip().endswith(".")


def test_off_frame_note_appears_only_when_it_happened():
    assert any("wasn't visible" in n for n in video._notes(40, 30, 5, 8))
    assert not any("wasn't visible" in n for n in video._notes(40, 30, 5, 0))


def test_disclaimer_states_the_limits_and_the_privacy_posture():
    d = video.DISCLAIMER.lower()
    assert "observable" in d
    assert "never an official" in d or "never a" in d
    assert "discarded" in d or "never uploaded" in d
    # The disclaimer must not itself claim to measure the things we refuse to.
    assert "not confidence" in d
