"""Runtime configuration. Keys and model choice live here, server-side only."""

from __future__ import annotations

import os

from dotenv import load_dotenv

# Load backend/.env if present. Keys never leave the backend (roadmap §5/§9).
load_dotenv()

# Scenario generation + content scoring model. The roadmap (§5) explicitly chose
# "Sonnet-class for quality; it's the product" — so we default to Sonnet 4.6,
# overridable via env without a code change.
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")


def has_api_key() -> bool:
    """True if an Anthropic key is configured (used for friendly 503s)."""
    return bool(os.getenv("ANTHROPIC_API_KEY"))
