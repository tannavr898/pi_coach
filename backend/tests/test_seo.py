"""The crawlable study pages (app/seo.py).

These assertions look fussy for HTML, but every one of them is a way the pages
silently stop doing their only job. A page that renders beautifully and 500s for
one event, or emits a canonical pointing at the wrong host, or drifts out of sync
with events.json, still looks fine in a browser — and quietly earns nothing.
"""

from __future__ import annotations

import json
from pathlib import Path
import re

import pytest
from fastapi.testclient import TestClient

from app import courses, events, seo
from app.main import app

client = TestClient(app)

ALL_EVENT_IDS = [e["id"] for e in events.all_events()]


def _main(html: str) -> str:
    """Just the <main> region — the rendered content, without the shared page chrome."""
    return html.split('<main class="wrap">', 1)[1].split("</main>", 1)[0]


def _text(html: str) -> str:
    """Visible text only — what a crawler indexes, minus markup and JSON-LD."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", _main(html)))


def test_every_event_has_a_page():
    """events.json is the source of truth; a new event must not 404 here."""
    for event_id in ALL_EVENT_IDS:
        r = client.get(f"/flashcards/{event_id}")
        assert r.status_code == 200, event_id
        assert r.headers["content-type"].startswith("text/html")


def test_every_event_has_an_abbreviation():
    """The event code IS the search query. An unmapped event falls back to its full
    name, which quietly gives up the exact term students type."""
    assert set(seo.EVENT_ABBREV) == set(ALL_EVENT_IDS)
    codes = list(seo.EVENT_ABBREV.values())
    assert len(set(codes)) == len(codes), "duplicate codes would collide on redirect"


def test_bltdm_page_answers_the_query():
    """The page this whole module exists for: "BLTDM flashcards"."""
    html = client.get("/flashcards/business-law-ethics-team").text
    title = re.search(r"<title>(.*?)</title>", html, re.S).group(1)
    assert title.startswith("BLTDM Flashcards")
    assert "<h1>BLTDM Flashcards</h1>" in html

    text = _text(html)
    assert "BLTDM" in text
    assert "Business Law" in text
    # The content has to be in the HTML, not fetched later — that is the entire
    # point of rendering server-side rather than letting the SPA paint it.
    assert "Legal Environment Awareness" in text
    # A page thin enough to be a stub cannot rank for anything.
    assert len(text.split()) > 2000


def test_event_codes_redirect_to_the_canonical_slug():
    """Two URLs serving one page split its ranking, so codes 301 rather than serve."""
    r = client.get("/flashcards/bltdm", follow_redirects=False)
    assert r.status_code == 301
    assert r.headers["location"] == "/flashcards/business-law-ethics-team"
    # Case must not matter: a link typed as /flashcards/BLTDM is the same page.
    assert client.get("/flashcards/BLTDM", follow_redirects=False).status_code == 301


def test_unknown_slug_is_404_not_a_soft_200():
    """A soft 404 (200 with an empty page) gets indexed as real content."""
    assert client.get("/flashcards/not-an-event").status_code == 404


def test_pages_carry_self_referencing_canonicals():
    """A canonical pointing anywhere else hands the ranking to another URL."""
    for path in ["/flashcards", "/flashcards/business-law-ethics-team"]:
        html = client.get(path).text
        canonical = re.search(r'<link rel="canonical" href="(.*?)"', html).group(1)
        assert canonical == f"{seo.site_url()}{path}"


def test_hub_links_every_event_page():
    """The hub is the crawl path to all 28. A missing link is an orphaned page."""
    html = client.get("/flashcards").text
    for event_id in ALL_EVENT_IDS:
        assert f'href="/flashcards/{event_id}"' in html


def test_sitemap_lists_every_event_page_with_absolute_urls():
    xml = client.get("/sitemap.xml").text
    assert xml.startswith("<?xml")
    for event_id in ALL_EVENT_IDS:
        assert f"<loc>{seo.site_url()}/flashcards/{event_id}</loc>" in xml
    assert f"<loc>{seo.site_url()}/</loc>" in xml
    # Relative <loc> values are invalid in a sitemap and get the file rejected.
    assert "<loc>/" not in xml


def test_robots_points_at_the_sitemap_and_hides_the_api():
    body = client.get("/robots.txt").text
    assert f"Sitemap: {seo.site_url()}/sitemap.xml" in body
    assert "Disallow: /api/" in body
    assert "Disallow: /admin" in body
    assert "Disallow: /\n" not in body, "a bare Disallow: / would deindex the site"


@pytest.mark.parametrize("path", ["/flashcards", "/flashcards/business-law-ethics-team"])
def test_structured_data_is_valid_json(path):
    html = client.get(path).text
    graph = json.loads(re.search(r'application/ld\+json">(.*?)</script>', html, re.S).group(1))
    assert graph["@context"] == "https://schema.org"
    types = {node["@type"] for node in graph["@graph"]}
    assert "BreadcrumbList" in types
    assert "FAQPage" in types


def test_chrome_matches_the_app():
    """These pages are a doorway into the app, so they have to look like the app.

    The failure mode is silent and embarrassing: someone lands here from Google,
    sees a page styled like a different website, and bounces. Pinning the shared
    details means a palette or font change in the SPA that skips this file shows up
    as a test failure rather than as a visitor's "why does this look different?".
    """
    html = client.get("/flashcards/business-law-ethics-team").text
    # The app's type stack (index.css @theme) and canvas (index.css body).
    for token in ["Space+Grotesk", "JetBrains+Mono", "Inter", "#f6f7fb", "#0a0f1f"]:
        assert token in html, token
    # Dark mode is the app's: a `dark` class on <html>, remembered under this key.
    # A different key would mean the toggle silently forgets across the two.
    assert "pic-theme" in html
    assert "classList.add('dark')" in html
    # Resolved before first paint, or the reader gets a white flash on every load.
    head = html.split("</head>", 1)[0]
    assert "pic-theme" in head


def test_icon_urls_stay_in_step_with_the_spa():
    """Both surfaces must request the SAME favicon URL.

    The ?v= exists because browsers cache favicons by URL in a store an ordinary
    reload does not revalidate. If these two drift, one surface quietly serves an
    icon URL the browser already has a stale (or empty) entry for, and the icon
    silently stops appearing on exactly one half of the site -- the hardest kind
    of bug to notice, because nothing errors.
    """
    index = Path(__file__).resolve().parents[2] / "frontend" / "index.html"
    if not index.is_file():  # backend-only checkout; nothing to compare against
        pytest.skip("frontend/index.html not present")
    spa = index.read_text(encoding="utf-8")
    rendered = client.get("/flashcards").text
    for icon in ["favicon.ico", "favicon.svg", "apple-touch-icon.png"]:
        want = f"/{icon}?v={seo._ICON_V}"
        assert want in spa, f"{want} missing from index.html"
        assert want in rendered, f"{want} missing from the rendered page"


def test_counts_match_the_course_they_describe():
    """The page states numbers ("227 flashcards"). If courses.py changes and these
    drift, the page is confidently wrong to every student who reads it."""
    course = courses.course_for("business-law-ethics-team")
    text = _text(client.get("/flashcards/business-law-ethics-team").text)
    assert f"{course['total']} flashcards" in text
    assert f"{course['core_count']} graded skills" in text


def test_rendering_does_not_leak_unescaped_markup():
    """Term text is authored content, not markup. If a definition ever contains an
    angle bracket it must render as text rather than becoming a tag."""
    body = _main(client.get("/flashcards/business-law-ethics-team").text)
    # Every tag in the rendered content should be one we emit; a stray tag name
    # coming from term text would show up here. Scoped to <main> so the shared
    # chrome (header, footer, the theme-toggle script) is not what is being tested.
    tags = {t.lower() for t in re.findall(r"</?([a-zA-Z][a-zA-Z0-9]*)", body)}
    allowed = {"p", "a", "b", "h1", "h2", "h3", "h4", "article", "span", "div",
               "ul", "li", "dl", "dt", "dd", "strong", "em"}
    assert tags <= allowed, tags - allowed
    assert "<script" not in body.lower(), "no script belongs in rendered term content"
