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

# Analytics (PostHog). The project key is a *public*, write-only ingest key meant
# to live client-side, so we serve it to the SPA via /api/config (not baked into
# the bundle at build time). Empty = analytics disabled (the frontend no-ops).
POSTHOG_KEY = os.getenv("POSTHOG_KEY", "")
POSTHOG_HOST = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com")

# Feedback email notifications (optional). When a RESEND_API_KEY is set, each
# submitted feedback is emailed to FEEDBACK_EMAIL_TO via Resend's HTTPS API
# (Render's free tier blocks outbound SMTP, so we use an HTTPS provider). Empty
# key = no email is sent (feedback is still logged + sent to analytics).
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
FEEDBACK_EMAIL_TO = os.getenv("FEEDBACK_EMAIL_TO", "tannavr898@gmail.com")
# Resend lets you send from this shared address to your *own* account email with
# no domain verification. Override once you verify trypicoach.com in Resend.
FEEDBACK_EMAIL_FROM = os.getenv("FEEDBACK_EMAIL_FROM", "PI Coach <onboarding@resend.dev>")


def has_api_key() -> bool:
    """True if an Anthropic key is configured (used for friendly 503s)."""
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def transcription_key() -> str:
    """The transcription provider key (server-side only)."""
    return os.getenv("TRANSCRIPTION_API_KEY", "")


def has_transcription_key() -> bool:
    """True if a transcription key is configured (used for friendly 503s)."""
    return bool(transcription_key())
