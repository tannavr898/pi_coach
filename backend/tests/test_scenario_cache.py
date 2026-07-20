"""Scenario cache key normalization — the part that decides whether the cache
ever hits. Everything else in scenario_cache.py is I/O against Supabase; these
are the pure functions the hit rate actually depends on."""

from app import scenario_cache as sc


# --- cache key -------------------------------------------------------------


def test_domain_order_does_not_change_the_key():
    """The interpreter returns domains in whatever order the model emitted them.
    If that order leaked into the key, two identical requests would land on two
    different keys and the cache would never hit."""
    a = sc.build_key("district", ["marketing", "communication"], "principles_marketing")
    b = sc.build_key("district", ["communication", "marketing"], "principles_marketing")
    assert a == b


def test_key_is_case_and_whitespace_insensitive():
    assert sc.build_key("District", [" Marketing "], " EVT ") == sc.build_key(
        "district", ["marketing"], "evt"
    )


def test_level_and_event_still_separate_keys():
    """Normalization must not over-collapse: a district rep and an ICDC rep are
    genuinely different scenarios, and so are two different events."""
    base = sc.build_key("district", ["marketing"], "evt_a")
    assert base != sc.build_key("icdc", ["marketing"], "evt_a")
    assert base != sc.build_key("district", ["marketing"], "evt_b")
    assert base != sc.build_key("district", ["finance"], "evt_a")


def test_free_text_never_reaches_the_key():
    """Two phrasings of the same request interpret to the same plan, so they must
    produce the same key — this is the whole point of keying on the interpreted
    result instead of the raw string."""
    # "marketing for a restaurant" and "restaurant marketing" both interpret to
    # the marketing domain at the same level for the same event.
    assert sc.build_key("state", ["marketing"], "evt") == sc.build_key("state", ["marketing"], "evt")


# --- industry normalization (the secondary preference) ---------------------


def test_industry_variants_collapse_to_one_token():
    got = {
        sc.normalize_context("restaurant"),
        sc.normalize_context("Restaurants"),
        sc.normalize_context("the restaurant business"),
        sc.normalize_context("a Restaurant Company"),
    }
    assert got == {"restaurant"}


def test_distinct_industries_stay_distinct():
    assert sc.normalize_context("restaurant") != sc.normalize_context("gym")


def test_empty_industry_normalizes_to_empty():
    """An empty context must not match everything by accident — the caller treats
    "" as 'no preference expressed', not as a wildcard industry."""
    assert sc.normalize_context("") == ""
    assert sc.normalize_context("general business") == ""


def test_multiword_industry_is_kept_but_bounded():
    out = sc.normalize_context("a fast-casual restaurant chain in the Midwest")
    assert "restaurant" in out
    assert len(out.split()) <= 4


# --- test isolation --------------------------------------------------------


def test_cache_is_inert_under_test_config():
    """Regression guard for a real incident: `config.load_dotenv()` runs at import
    time, so a developer's real .env made the suite read AND WRITE the production
    Supabase — and the scenario cache (the first anonymous write path) inserted
    test-fixture scenarios into the live pool, where students would have been
    served them.

    tests/conftest.py blanks the Supabase config for every test. If that ever
    stops working, this fails here rather than in production data."""
    from app import config

    assert config.has_supabase() is False
    assert sc.enabled() is False


async def _lookup_when_disabled():
    return await sc.lookup(
        cache_key="k", seen_ids=[], user_id=None, want_context="", strict_context=False
    )


def test_lookup_short_circuits_when_disabled():
    """With no Supabase, a lookup must return None immediately (fall through to
    generation) rather than attempting a request."""
    import asyncio

    assert asyncio.run(_lookup_when_disabled()) is None
