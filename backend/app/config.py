"""Runtime configuration. Keys and model choice live here, server-side only."""

from __future__ import annotations

import os

from dotenv import load_dotenv

# Load backend/.env if present. Keys never leave the backend (roadmap §5/§9).
load_dotenv()

# On networks that do TLS inspection (corporate proxy / AV), Python's bundled
# certifi store won't trust the intercepting CA, so the Anthropic SDK's HTTPS
# calls fail with a connection error. Inject the OS trust store so requests use
# the same CAs the machine already trusts. No-op (and silently skipped) on
# normal networks or if truststore isn't installed.
try:  # pragma: no cover - environment-dependent
    import truststore

    truststore.inject_into_ssl()
except Exception:
    pass

# Scenario generation + content scoring model. The roadmap (§5) explicitly chose
# "Sonnet-class for quality; it's the product" — so we default to Sonnet 4.6,
# overridable via env without a code change.
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

# Transcription (Phase 3, voice). Provider is swappable; default AssemblyAI —
# simplest REST integration with word timestamps + filler/disfluency detection.
TRANSCRIPTION_PROVIDER = os.getenv("TRANSCRIPTION_PROVIDER", "assemblyai")


def has_api_key() -> bool:
    """True if an Anthropic key is configured (used for friendly 503s)."""
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def transcription_key() -> str:
    """The transcription provider key (server-side only)."""
    return os.getenv("TRANSCRIPTION_API_KEY", "")


def has_transcription_key() -> bool:
    """True if a transcription key is configured (used for friendly 503s)."""
    return bool(transcription_key())
