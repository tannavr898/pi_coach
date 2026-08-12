"""Test isolation from external services.

WHY THIS EXISTS (learned the hard way): `app/config.py` calls `load_dotenv()` at
import time, so a developer's real `backend/.env` — with real Supabase
credentials — is live during the test run. That was harmless while every
Supabase write sat behind an authenticated endpoint, because no test ever
carried a token.

The scenario cache broke that assumption. It is the first code path that reads
AND WRITES Supabase on an anonymous request, so running the suite against a real
`.env` silently inserted test-fixture scenarios ("BrightPath Co.") into the
shared production pool — where they would then be served to actual students.

The fix is structural rather than per-test: no unit test may reach the network.
`has_supabase()` returning False makes the cache a no-op that always falls
through to generation, which is exactly the behavior we want under test anyway —
tests assert on what the model was asked, and a cache hit skips the model.

Set `PIC_TEST_ALLOW_SUPABASE=1` if you ever deliberately want an integration run
against a real (throwaway) project.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _isolate_external_services(monkeypatch):
    """Cut every test off from real Supabase unless explicitly opted in."""
    if os.getenv("PIC_TEST_ALLOW_SUPABASE") == "1":
        return
    from app import config

    monkeypatch.setattr(config, "SUPABASE_URL", "", raising=False)
    monkeypatch.setattr(config, "SUPABASE_ANON_KEY", "", raising=False)
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "", raising=False)
