"""Transcription provider client (Phase 3, voice).

Raw audio in → word-level timestamps + filler words out. The browser's Web
Speech API couldn't give reliable timing or fillers (roadmap §8), so we send the
recorded audio to a transcription API and do our own metric math on the result.

Default provider is AssemblyAI: upload the bytes, create a transcript with
`disfluencies=true` (so "um"/"uh" are kept), then poll until it's done. The key
lives only on the backend (roadmap §5/§9). `config.py` injects the OS trust store
at import, so these HTTPS calls work on TLS-inspection networks too.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

from .config import TRANSCRIPTION_PROVIDER, transcription_key

_AAI_BASE = "https://api.assemblyai.com/v2"


class TranscriptionNotConfigured(RuntimeError):
    """Raised when no transcription API key is configured on the backend."""


class TranscriptionError(RuntimeError):
    """Raised when the provider call fails or returns an error status."""


@dataclass
class Word:
    text: str
    start_ms: int
    end_ms: int


@dataclass
class Transcript:
    text: str
    words: list[Word] = field(default_factory=list)
    audio_duration_s: float = 0.0


def transcribe(
    audio: bytes,
    *,
    poll_interval: float = 2.0,
    timeout: float = 300.0,
) -> Transcript:
    """Transcribe audio bytes to text + word timestamps.

    Runs synchronously (the endpoint is a sync `def`, so FastAPI executes it in a
    threadpool — the polling sleep won't block the event loop).
    """
    if TRANSCRIPTION_PROVIDER != "assemblyai":
        raise TranscriptionError(f"Unsupported transcription provider: {TRANSCRIPTION_PROVIDER!r}")
    key = transcription_key()
    if not key:
        raise TranscriptionNotConfigured("TRANSCRIPTION_API_KEY is not set on the backend.")
    if not audio:
        raise TranscriptionError("No audio was received.")

    headers = {"authorization": key}
    try:
        with httpx.Client(timeout=60.0) as client:
            up = client.post(f"{_AAI_BASE}/upload", headers=headers, content=audio)
            up.raise_for_status()
            audio_url = up.json()["upload_url"]

            created = client.post(
                f"{_AAI_BASE}/transcript",
                headers=headers,
                json={"audio_url": audio_url, "disfluencies": True, "punctuate": True},
            )
            created.raise_for_status()
            tid = created.json()["id"]

            deadline = time.monotonic() + timeout
            while True:
                poll = client.get(f"{_AAI_BASE}/transcript/{tid}", headers=headers)
                poll.raise_for_status()
                data = poll.json()
                status = data.get("status")
                if status == "completed":
                    break
                if status == "error":
                    raise TranscriptionError(data.get("error", "Transcription failed."))
                if time.monotonic() > deadline:
                    raise TranscriptionError("Transcription timed out.")
                time.sleep(poll_interval)
    except httpx.HTTPError as e:
        raise TranscriptionError(f"Transcription provider error: {e}") from e

    words = [Word(w.get("text", ""), int(w.get("start", 0)), int(w.get("end", 0))) for w in data.get("words", [])]
    duration = float(data.get("audio_duration") or (words[-1].end_ms / 1000 if words else 0.0))
    return Transcript(text=(data.get("text") or "").strip(), words=words, audio_duration_s=duration)
