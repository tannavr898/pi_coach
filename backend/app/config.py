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

# We split the model by job (Phase 2, latency). Scenario generation is creative
# writing with a lower accuracy bar; scoring is where grading accuracy matters.
# Both currently run Sonnet 5 (near-Opus quality at Sonnet price) — a quality
# upgrade over the old Sonnet 4.6 — but they're separate knobs so scoring can be
# moved to a stronger model later without touching scenario latency. Overridable
# via env without a code change. MODEL stays as the shared fallback/back-compat.
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5")
SCENARIO_MODEL = os.getenv("ANTHROPIC_SCENARIO_MODEL", MODEL)
SCORING_MODEL = os.getenv("ANTHROPIC_SCORING_MODEL", MODEL)
# Mastery Blitz (Phase 5): a single "used correctly in context?" judgment, batched
# into ONE call per drill — a fast/cheap model is the right fit, so Haiku by default.
BLITZ_MODEL = os.getenv("ANTHROPIC_BLITZ_MODEL", "claude-haiku-4-5")

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

# Supabase (optional login + cross-session progress). Anonymous practice never
# needs these — they only gate the account features.
#  - URL + ANON_KEY are PUBLIC (the anon key is safe client-side, guarded by RLS);
#    we serve them to the SPA via /api/config, like the PostHog key.
#  - SERVICE_ROLE_KEY is a SECRET (backend-only). It lets FastAPI read/write the
#    `sessions` table on the user's behalf; it must never reach the client.
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Secret passphrase for the owner-only admin QA page (/admin). Verified server-side
# so the secret never ships in the frontend bundle. Empty = admin page disabled.
ADMIN_PASSPHRASE = os.getenv("ADMIN_PASSPHRASE", "")


def has_supabase() -> bool:
    """True if Supabase is configured (login + progress features are enabled)."""
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def has_api_key() -> bool:
    """True if an Anthropic key is configured (used for friendly 503s)."""
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def transcription_key() -> str:
    """The transcription provider key (server-side only)."""
    return os.getenv("TRANSCRIPTION_API_KEY", "")


def has_transcription_key() -> bool:
    """True if a transcription key is configured (used for friendly 503s)."""
    return bool(transcription_key())
