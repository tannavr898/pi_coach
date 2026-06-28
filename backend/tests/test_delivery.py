"""Delivery-metric math + /api/score-delivery wiring (transcription monkeypatched)."""

from fastapi.testclient import TestClient

from app import delivery, transcription
from app.main import app
from app.transcription import Transcript, Word

client = TestClient(app)


def words_evenly(n: int, span_ms: int, *, gap_ms: int = 0, texts=None) -> list[Word]:
    """n words across span_ms. Each word: duration = (span - gaps)/n; uniform gaps."""
    total_gap = gap_ms * (n - 1)
    dur = (span_ms - total_gap) / n
    out = []
    t = 0.0
    for i in range(n):
        out.append(Word(texts[i] if texts else "word", int(t), int(t + dur)))
        t += dur + gap_ms
    return out


def test_empty_is_safe():
    m = delivery.compute_delivery([], 0.0)
    assert m["word_count"] == 0
    assert m["pace_wpm"] == 0
    assert m["time_flag"] == "short"
    assert "No speech" in m["notes"][0]


def test_pace_buckets():
    # 150 words over exactly 60s of active speech => 150 WPM (good)
    m = delivery.compute_delivery(words_evenly(150, 60_000), 60.0)
    assert m["pace_wpm"] == 150
    assert m["pace_flag"] == "good"
    # 80 words over 60s => 80 WPM (slow)
    assert delivery.compute_delivery(words_evenly(80, 60_000), 60.0)["pace_flag"] == "slow"
    # 220 words over 60s => fast
    assert delivery.compute_delivery(words_evenly(220, 60_000), 60.0)["pace_flag"] == "fast"


def test_fillers_counted_and_broken_down():
    texts = ["so", "um", "the", "uh", "plan", "um", "is", "good"]
    m = delivery.compute_delivery(words_evenly(len(texts), 8_000, texts=texts), 8.0, target_seconds=600)
    assert m["filler_count"] == 3  # two "um", one "uh"
    counts = {f["word"]: f["count"] for f in m["fillers"]}
    assert counts == {"um": 2, "uh": 1}
    # "so" is NOT a hard filler
    assert "so" not in counts


def test_crutch_phrases_separate_from_fillers():
    texts = ["it", "is", "you", "know", "basically", "fine"]
    m = delivery.compute_delivery(words_evenly(len(texts), 6_000, texts=texts), 6.0)
    phrases = {c["phrase"]: c["count"] for c in m["crutch_phrases"]}
    assert phrases.get("you know") == 1
    assert phrases.get("basically") == 1
    assert m["filler_count"] == 0  # crutches don't inflate the filler rate


def test_long_pause_detected():
    # two words with a 4s gap between them
    w = [Word("first", 0, 500), Word("second", 4_500, 5_000)]
    m = delivery.compute_delivery(w, 5.0)
    assert len(m["long_pauses"]) == 1
    assert m["long_pauses"][0]["length_seconds"] == 4.0
    assert m["longest_pause_seconds"] == 4.0
    assert m["pause_count"] == 1


def test_time_flags():
    assert delivery.compute_delivery(words_evenly(20, 30_000), 30.0)["time_flag"] == "short"
    assert delivery.compute_delivery(words_evenly(200, 240_000), 240.0)["time_flag"] == "good"
    assert delivery.compute_delivery(words_evenly(900, 590_000), 590.0)["time_flag"] == "long"


def test_reading_signal_on_very_even_pacing():
    # 50 words, uniform tiny 100ms gaps, no noticeable pauses => soft reading signal
    m = delivery.compute_delivery(words_evenly(50, 60_000, gap_ms=100), 60.0)
    assert m["reading_signal"] is True


def test_endpoint_returns_transcript_and_metrics(monkeypatch):
    def fake(audio, **kw):
        return Transcript(text="um the plan is good", words=words_evenly(5, 5_000, texts=["um", "the", "plan", "is", "good"]), audio_duration_s=5.0)

    monkeypatch.setattr(transcription, "transcribe", fake)
    r = client.post("/api/score-delivery", files={"audio": ("take.webm", b"xxxx", "audio/webm")})
    assert r.status_code == 200
    body = r.json()
    assert body["transcript"] == "um the plan is good"
    assert body["metrics"]["filler_count"] == 1
    assert body["metrics"]["word_count"] == 5


def test_endpoint_503_without_key(monkeypatch):
    def boom(audio, **kw):
        raise transcription.TranscriptionNotConfigured("no key")

    monkeypatch.setattr(transcription, "transcribe", boom)
    r = client.post("/api/score-delivery", files={"audio": ("take.webm", b"xxxx", "audio/webm")})
    assert r.status_code == 503
