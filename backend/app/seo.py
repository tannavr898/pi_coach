"""Crawlable, server-rendered study pages — the app's only indexable surface.

WHY THIS EXISTS. Everything else here is a single-page app: one index.html with an
empty ``<div id="root">``, and every word a student reads is painted by React after
the bundle runs. Google can execute that JS, but rendering is a second, slower,
best-effort queue, and what it eventually sees is still one URL with one title. A
search for "BLTDM flashcards" has nothing on this site to match, because as far as
a crawler is concerned the whole site is one page about role-play practice in
general.

So the study corpus gets a real HTML surface. The content already lives server-side
(terms.py) and already groups into an event's path (courses.py); these routes render
that join as ordinary HTML at a stable URL, one page per event:

    /flashcards                            the hub, linking all 28 events
    /flashcards/business-law-ethics-team   the event page (BLTDM)
    /flashcards/bltdm                      301 -> the canonical slug above

No JS, no API call, no bundle — the words are in the first response. That is what
makes them indexable, and it is also why these pages open instantly on a school
Chromebook on school wifi, which is the device most of these students have.

ON THE EVENT CODES. BLTDM, HRM, ETDM and the rest are DECA's own event
abbreviations, used here descriptively: they are how a student actually searches,
and naming the competition you are practicing for is nominative use, not a claim of
affiliation. Every page carries the same disclaimer the app does. Nothing here
reads DECA's performance-indicator list — the term text is our own corpus (see
data/framework-notes.md), and the event->domain mapping is ours (see events.py).

Rendering is pure and deterministic, so every page is built once and cached. There
is no template engine: the pages are small enough to assemble as strings, and that
keeps the dependency list where it is.
"""

from __future__ import annotations

import json
from functools import lru_cache
from html import escape

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response

from . import config, courses, events, terms

router = APIRouter(include_in_schema=False)

# DECA's event codes, which are what students type into a search box — nobody
# searches "Business Law and Ethics Team Decision Making flashcards", they search
# "BLTDM flashcards". Kept here rather than in events.json because it is presentation
# metadata for these pages only: no app code path resolves an event by its code.
EVENT_ABBREV: dict[str, str] = {
    "principles-marketing": "PMK",
    "apparel-accessories-marketing": "AAM",
    "automotive-services-marketing": "ASM",
    "business-services-marketing": "BSM",
    "food-marketing": "FMS",
    "marketing-communications": "MCS",
    "retail-merchandising": "RMS",
    "sports-entertainment-marketing": "SEM",
    "buying-merchandising-team": "BTDM",
    "marketing-management-team": "MTDM",
    "sports-entertainment-marketing-team": "STDM",
    "principles-finance": "PFN",
    "accounting-applications": "ACT",
    "business-finance": "BFS",
    "financial-services-team": "FTDM",
    "personal-financial-literacy": "PFL",
    "principles-hospitality-tourism": "PHT",
    "hotel-lodging-management": "HLM",
    "quick-serve-restaurant-management": "QSRM",
    "restaurant-food-service-management": "RFSM",
    "hospitality-services-team": "HTDM",
    "travel-tourism-team": "TTDM",
    "principles-business-management": "PBM",
    "human-resources-management": "HRM",
    "business-law-ethics-team": "BLTDM",
    "principles-entrepreneurship": "PEN",
    "entrepreneurship-individual": "ENT",
    "entrepreneurship-team": "ETDM",
}

_ABBREV_TO_ID = {code.lower(): event_id for event_id, code in EVENT_ABBREV.items()}

# How each kind of event is described in prose, so the intro reads like a sentence
# someone wrote rather than a field dump.
_KIND_PHRASE = {
    "team": "a two-person team decision-making event",
    "individual": "an individual series role-play",
    "principles": "an introductory principles role-play for first-year members",
}

_DISCLAIMER = (
    "PI Coach is independent practice software. It is not affiliated with, endorsed by, or "
    "sponsored by DECA Inc. These are not official DECA materials — the cards here are our own "
    "study corpus, written from public business fundamentals."
)


def site_url() -> str:
    """Absolute origin for canonicals, Open Graph tags and the sitemap."""
    return config.SITE_URL


def _e(text: str) -> str:
    return escape(text or "", quote=True)


def abbrev(event_id: str) -> str:
    """The DECA event code for an event, or "" when we have not mapped one."""
    return EVENT_ABBREV.get(event_id, "")


# --------------------------------------------------------------------------- #
# Page chrome
# --------------------------------------------------------------------------- #

# One stylesheet, inlined. An external CSS file would be a second round trip for a
# page whose entire job is to be readable on the first one.
#
# These values are not "close to" the app's — they are the app's, lifted from
# index.css and the Tailwind classes in App.tsx/ui.tsx: the same #f6f7fb canvas with
# its indigo wash and diamond lattice, the same Inter/Space Grotesk/JetBrains Mono
# stack, the same rounded-2xl cards and two-layer shadow, the same indigo-600
# buttons. A student who lands here from Google and then clicks into the app must
# not feel like they crossed onto a different website, and "roughly matching" reads
# as exactly that. If the app's palette changes, change it here too.
_CSS = """
:root{--ink:#0f172a;--ink-soft:#475569;--ink-faint:#64748b;--line:#e2e8f0;
--surface:#ffffff;--surface-soft:#f8fafc;--brand:#4f46e5;--brand-hover:#4338ca;
--brand-soft:#eef2ff;--brand-ink:#4338ca;--brand-eyebrow:#6366f1;
--shadow:0 1px 3px rgba(15,23,42,.06),0 1px 2px rgba(15,23,42,.04);
--shadow-hover:0 6px 24px rgba(15,23,42,.08)}
.dark{--ink:#e2e8f0;--ink-soft:#cbd5e1;--ink-faint:#94a3b8;--line:#1e293b;
--surface:#0f172a;--surface-soft:#0b1220;--brand:#4f46e5;--brand-hover:#4338ca;
--brand-soft:rgba(30,27,75,.5);--brand-ink:#a5b4fc;--brand-eyebrow:#818cf8;
--shadow:none;--shadow-hover:none}
*{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{margin:0;min-height:100dvh;color:var(--ink);background-color:#f6f7fb;
font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif}
.dark body{background-color:#0a0f1f}
/* The app's canvas: a faint indigo wash over a crisscrossed hairline lattice.
   Pinned to the viewport with a fixed pseudo-element rather than painted onto the
   body, because these pages run to 14,000 words and a body-height radial would
   stretch the wash over 20,000px and disappear. */
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
background-image:radial-gradient(120% 55% at 50% -10%,rgba(99,102,241,.12),transparent 60%),
repeating-linear-gradient(45deg,rgba(79,70,229,.05) 0 1px,transparent 1px 30px),
repeating-linear-gradient(-45deg,rgba(79,70,229,.05) 0 1px,transparent 1px 30px)}
.dark body::before{background-image:radial-gradient(120% 55% at 50% -12%,rgba(99,102,241,.2),transparent 60%),
repeating-linear-gradient(45deg,rgba(129,140,248,.06) 0 1px,transparent 1px 30px),
repeating-linear-gradient(-45deg,rgba(129,140,248,.06) 0 1px,transparent 1px 30px)}
a{color:var(--brand-ink);text-underline-offset:2px}
a:hover{text-decoration:underline}
.wrap{max-width:64rem;margin:0 auto;padding:0 1.25rem}
h1,h2,h4,.brand-name{font-family:"Space Grotesk",Inter,sans-serif}
/* Header: sticky, translucent, blurred — the app's exact shell. */
header.site{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.7);
backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.dark header.site{background:rgba(2,6,23,.6)}
header.site .bar{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
max-width:64rem;margin:0 auto;padding:.875rem 1.25rem}
header.site .brand{display:flex;align-items:center;gap:.625rem;text-decoration:none;color:inherit}
header.site .brand:hover{text-decoration:none}
header.site .brand>span{display:block;min-width:0}
.brand-name{display:block;font-size:1.125rem;font-weight:600;letter-spacing:-.025em;
line-height:1;color:var(--ink)}
.brand-tag{display:block;margin-top:.25rem;font-family:"JetBrains Mono",ui-monospace,monospace;
font-size:10px;text-transform:uppercase;letter-spacing:.2em;color:var(--ink-faint)}
header.site nav{display:flex;align-items:center;gap:1.25rem;font-size:.875rem;font-weight:500}
header.site nav a{color:var(--ink-soft);text-decoration:none}
header.site nav a:hover{color:var(--brand-ink)}
#theme{display:inline-flex;height:2rem;width:2rem;align-items:center;justify-content:center;
border-radius:9999px;border:0;background:transparent;color:var(--ink-faint);cursor:pointer}
#theme:hover{background:var(--surface-soft);color:var(--ink)}
h1{font-size:2.25rem;line-height:1.1;letter-spacing:-.025em;margin:2rem 0 .35rem;font-weight:600}
h2{font-size:1.5rem;letter-spacing:-.02em;margin:2.75rem 0 .25rem;font-weight:600;
scroll-margin-top:5rem}
h3{margin:1.75rem 0 .7rem;color:var(--ink-faint);text-transform:uppercase;font-weight:600;
letter-spacing:.18em;font-size:11px;font-family:"JetBrains Mono",ui-monospace,monospace}
h4{font-size:1rem;margin:0 0 .2rem;letter-spacing:-.01em;font-weight:600}
.lede{font-size:1.05rem;color:var(--ink-soft);margin:.9rem 0}
.sub{color:var(--ink-faint);font-size:.95rem;margin:.15rem 0 0}
.eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;font-weight:500;
letter-spacing:.18em;text-transform:uppercase;color:var(--brand-eyebrow);margin:0}
.stats{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.5rem 0;padding:0;list-style:none}
.stats li{background:var(--surface);border:1px solid var(--line);border-radius:.75rem;
padding:.5rem .85rem;font-size:.85rem;color:var(--ink-soft);box-shadow:var(--shadow)}
.stats b{color:var(--ink);font-weight:600}
/* BTN_PRIMARY / BTN_SECONDARY from ui.tsx. */
.cta{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
background:var(--brand);color:#fff;border-radius:.75rem;padding:.625rem 1.25rem;
font-weight:600;font-size:.875rem;text-decoration:none;box-shadow:var(--shadow);
transition:background .15s}
.cta:hover{background:var(--brand-hover);text-decoration:none;color:#fff}
.cta.ghost{background:var(--surface);color:var(--ink-soft);border:1px solid var(--line)}
.cta.ghost:hover{background:var(--surface-soft);color:var(--ink)}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.4rem 0 2rem}
.toc{background:var(--surface);border:1px solid var(--line);border-radius:1rem;
padding:1.25rem;box-shadow:var(--shadow)}
.toc ul{margin:.5rem 0 0;padding-left:1.1rem}
.toc li{margin:.25rem 0;font-size:.9rem;color:var(--ink-soft)}
.card{border:1px solid var(--line);border-radius:1rem;padding:1.25rem;margin:.75rem 0;
background:var(--surface);box-shadow:var(--shadow);transition:box-shadow .2s}
.card:hover{box-shadow:var(--shadow-hover)}
.card .coaches{margin:0 0 .5rem;color:var(--brand-eyebrow);font-size:.85rem;font-weight:500}
.card p{margin:.45rem 0}
.card .miss{font-size:.875rem;color:var(--ink-faint);border-top:1px solid var(--line);
padding-top:.6rem;margin-top:.75rem}
.tag{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;font-weight:600;
letter-spacing:.1em;text-transform:uppercase;border-radius:.5rem;padding:.15rem .45rem;
vertical-align:.15em;margin-left:.5rem;background:var(--brand-soft);color:var(--brand-ink)}
.tag.soft{background:var(--surface-soft);color:var(--ink-faint);border:1px solid var(--line)}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(15.5rem,1fr));
margin:1rem 0}
.tile{border:1px solid var(--line);border-radius:1rem;padding:1rem;text-decoration:none;
color:inherit;display:block;background:var(--surface);box-shadow:var(--shadow);
transition:box-shadow .2s,border-color .2s}
.tile:hover{border-color:#c7d2fe;box-shadow:var(--shadow-hover);text-decoration:none}
.dark .tile:hover{border-color:#3730a3}
.tile .code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.8rem;font-weight:700;
letter-spacing:.06em;color:var(--brand-eyebrow)}
.tile .name{display:block;margin:.2rem 0 .35rem;font-weight:600;font-family:"Space Grotesk",Inter,sans-serif}
.tile .meta{font-size:.8rem;color:var(--ink-faint)}
.faq dt{font-weight:600;margin:1.25rem 0 .3rem;font-family:"Space Grotesk",Inter,sans-serif}
.faq dd{margin:0;color:var(--ink-soft)}
.note{background:var(--surface);border:1px solid var(--line);border-radius:1rem;
padding:1rem 1.25rem;font-size:.85rem;color:var(--ink-faint);margin:2rem 0;box-shadow:var(--shadow)}
footer.site{border-top:1px solid rgba(226,232,240,.8);background:rgba(255,255,255,.5);
margin-top:3.5rem;padding:1.5rem 0 2.5rem;font-size:.75rem;line-height:1.65;color:var(--ink-faint)}
.dark footer.site{border-top-color:rgba(30,41,59,.8);background:rgba(2,6,23,.4)}
footer.site .name{font-family:"Space Grotesk",Inter,sans-serif;font-size:.875rem;font-weight:600;
color:var(--ink-soft);display:block;margin-bottom:.75rem}
footer.site nav{display:flex;flex-wrap:wrap;gap:1rem;margin-top:.75rem;font-weight:500}
.crumbs{font-size:.8rem;color:var(--ink-faint);margin:1.5rem 0 0}
@media (max-width:640px){h1{font-size:1.75rem;margin-top:1.5rem}h2{font-size:1.25rem}
.brand-tag{display:none}header.site nav{gap:.9rem}}
"""

# The app's actual BrandMark (ui.tsx): three concentric rings, light to dark inward.
# Deliberately NOT the favicon's simplified two-element version — this renders at
# 30px next to the wordmark, exactly where the app renders it, so it should be the
# same drawing the app uses.
_MARK = (
    '<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">'
    '<circle cx="16" cy="16" r="14.5" fill="none" stroke="#c7d2fe" stroke-width="2.5"/>'
    '<circle cx="16" cy="16" r="9" fill="none" stroke="#818cf8" stroke-width="2.5"/>'
    '<circle cx="16" cy="16" r="3.5" fill="#4f46e5"/></svg>'
)

# Theme, resolved before first paint. The app stores the choice in localStorage
# under "pic-theme" and toggles a `dark` class on <html> (App.tsx useTheme); this
# reads the SAME key, so a student who set dark mode in the app does not get
# flashbanged on the way back from Google. Inline and blocking on purpose — in an
# external file or a deferred script it would run after the first paint, which is
# the flash it exists to prevent.
_THEME_BOOT = (
    "(function(){try{var s=localStorage.getItem('pic-theme');"
    "if(s==='dark'||(!s&&matchMedia('(prefers-color-scheme: dark)').matches))"
    "document.documentElement.classList.add('dark')}catch(e){}})()"
)

_THEME_TOGGLE = (
    "(function(){var b=document.getElementById('theme');if(!b)return;"
    "var r=document.documentElement;"
    "function paint(){var d=r.classList.contains('dark');"
    "b.innerHTML=d?'\\u2600\\ufe0e':'\\u263e\\ufe0e';"
    "b.setAttribute('aria-label',d?'Switch to light mode':'Switch to dark mode')}"
    "paint();b.addEventListener('click',function(){"
    "var d=r.classList.toggle('dark');"
    "try{localStorage.setItem('pic-theme',d?'dark':'light')}catch(e){}paint()})})()"
)


def _shell(*, title: str, description: str, path: str, body: str, jsonld: str) -> str:
    """Wrap rendered body content in the full document."""
    url = f"{site_url()}{path}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_e(title)}</title>
<meta name="description" content="{_e(description)}">
<link rel="canonical" href="{_e(url)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta name="theme-color" content="#4f46e5">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="PI Coach">
<meta property="og:title" content="{_e(title)}">
<meta property="og:description" content="{_e(description)}">
<meta property="og:url" content="{_e(url)}">
<meta property="og:image" content="{_e(site_url())}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Space+Grotesk:wght@500;600;700&amp;family=JetBrains+Mono:wght@500;700&amp;display=swap" rel="stylesheet">
<style>{_CSS}</style>
<script>{_THEME_BOOT}</script>
<script type="application/ld+json">{jsonld}</script>
</head>
<body>
<header class="site"><div class="bar">
<a class="brand" href="/">{_MARK}<span><span class="brand-name">PI Coach</span>
<span class="brand-tag">DECA role-play practice</span></span></a>
<nav><a href="/">Practice</a><a href="/flashcards">Flashcards</a>
<button id="theme" type="button" aria-label="Switch theme"></button></nav>
</div></header>
<main class="wrap">
{body}
</main>
<footer class="site"><div class="wrap">
<span class="name">PI Coach</span>
<p>{_e(_DISCLAIMER)} Feedback from PI Coach is practice coaching, never an official competition score.</p>
<nav><a href="/">Home</a><a href="/flashcards">All flashcard decks</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</div></footer>
<script>{_THEME_TOGGLE}</script>
</body>
</html>
"""


def _faq_block(pairs: list[tuple[str, str]]) -> str:
    items = "".join(f"<dt>{_e(q)}</dt><dd>{_e(a)}</dd>" for q, a in pairs)
    return f'<h2 id="faq">Common questions</h2><dl class="faq">{items}</dl>'


def _faq_jsonld(pairs: list[tuple[str, str]]) -> dict:
    return {
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
            for q, a in pairs
        ],
    }


def _crumbs_jsonld(trail: list[tuple[str, str]]) -> dict:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i, "name": name, "item": f"{site_url()}{path}"}
            for i, (name, path) in enumerate(trail, start=1)
        ],
    }


def _graph(*nodes: dict) -> str:
    return json.dumps({"@context": "https://schema.org", "@graph": list(nodes)}, ensure_ascii=False)


def _html(markup: str) -> HTMLResponse:
    """An HTML response crawlers and CDNs may cache — these pages are static in
    everything but where they are built."""
    return HTMLResponse(markup, headers={"Cache-Control": "public, max-age=3600"})


# --------------------------------------------------------------------------- #
# The event page — the one that has to answer "BLTDM flashcards"
# --------------------------------------------------------------------------- #


def _domain_groups(course: dict) -> list[dict]:
    """The course's units regrouped under their domain, preserving course order."""
    groups: list[dict] = []
    by_id: dict[str, dict] = {}
    for unit in course["units"]:
        g = by_id.get(unit["domain_id"])
        if g is None:
            g = {"id": unit["domain_id"], "name": unit["domain"], "units": [], "count": 0}
            by_id[unit["domain_id"]] = g
            groups.append(g)
        g["units"].append(unit)
        g["count"] += len(unit["core_ids"]) + len(unit["extended_ids"])
    return groups


def _prose_list(items: list[str]) -> str:
    """Join for running prose: "a, b and c"."""
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _term_card(term: dict) -> str:
    tier = (
        '<span class="tag">Graded</span>'
        if term["tier"] == "core"
        else '<span class="tag soft">Worth knowing</span>'
    )
    mistake = (
        f'<p class="miss"><strong>Common mistake:</strong> {_e(term["mistake"])}</p>'
        if term.get("mistake")
        else ""
    )
    return (
        f'<article class="card" id="{_e(term["id"])}">'
        f'<h4>{_e(term["name"])}{tier}</h4>'
        f'<p class="coaches">{_e(term["coaches"])}</p>'
        f'<p>{_e(term["definition"])}</p>'
        f"{mistake}</article>"
    )


def _event_faq(event: dict, course: dict, code: str) -> list[tuple[str, str]]:
    name = event["name"]
    kind = _KIND_PHRASE.get(event["kind"], "a role-play event")
    domains = _prose_list([g["name"] for g in _domain_groups(course)])
    graded_note = (
        f"The {course['core_count']} cards marked Graded are the skills PI Coach actually scores "
        f"you on in a {code} role-play; the other {course['extended_count']} are supporting "
        "vocabulary that earns credit when you bring it into an answer and apply it."
    )
    return [
        (
            f"What is {code} in DECA?",
            f"{code} stands for {name} — {kind} in DECA's {event['cluster']} cluster. "
            f"{event['blurb']} You get a scenario, prep against a timer, present your "
            "recommendation to a judge, then answer follow-up questions.",
        ),
        (
            f"What should I study for {code}?",
            f"The business skills a {code} judge scores cluster into {domains}. This deck covers "
            f"all of them: {course['core_count']} graded skills plus {course['extended_count']} "
            f"supporting terms, {course['total']} cards in total, grouped into "
            f"{len(course['units'])} topics you can finish one sitting at a time.",
        ),
        (f"How many flashcards are in the {code} deck?", f"{course['total']}. {graded_note}"),
        (
            f"Can I practice a {code} role-play, not just the cards?",
            f"Yes — that is the main thing PI Coach does. It writes an original {code} scenario, "
            "times your prep, listens while you present out loud, and grades the substance "
            "criterion by criterion alongside your delivery. Your first few role-plays are free "
            "and need no account.",
        ),
        (
            f"Are these official DECA {code} flashcards?",
            f"{_DISCLAIMER} They teach the same business fundamentals judges reward, in our own "
            "words.",
        ),
    ]


@lru_cache(maxsize=64)
def render_event_page(event_id: str) -> str | None:
    """The full HTML for one event's flashcard page, or None if the event is unknown."""
    event = events.get_event(event_id)
    course = courses.course_for(event_id)
    if not event or not course:
        return None

    code = abbrev(event_id) or event["name"]
    name = event["name"]
    path = f"/flashcards/{event_id}"
    groups = _domain_groups(course)
    domain_names = [g["name"] for g in groups]

    # "BLTDM Flashcards — DECA Business Law & Ethics (Team) | PI Coach". Code first
    # because that is the literal query; the full event name follows it because a
    # searcher who typed the words out should still see their phrase in the result.
    title = f"{code} Flashcards — DECA {name} | PI Coach"
    description = (
        f"{course['total']} free {code} flashcards for DECA {name}: "
        f"{course['core_count']} graded skills plus supporting terms across "
        f"{_prose_list(domain_names)}. Study the deck, then practice a real role-play out loud."
    )

    kind = _KIND_PHRASE.get(event["kind"], "a role-play event")
    suggestions = _prose_list(event.get("suggestions", [])[:3])
    intro = (
        f'<p class="lede"><strong>{_e(code)}</strong> is DECA\'s {_e(name)} event — {_e(kind)} '
        f"in the {_e(event['cluster'])} cluster. {_e(event['blurb'])} This deck is every business "
        f"skill PI Coach grades for {_e(code)}, plus the supporting vocabulary that makes an "
        "answer sound like someone who actually knows the field.</p>"
    )
    if suggestions:
        intro += (
            f"<p>A {_e(code)} case usually turns on something like {_e(suggestions)} — which is "
            f"why the deck leans hardest on {_e(_prose_list(domain_names[:2]))}. Cards marked "
            "<em>Graded</em> are the ones a PI Coach role-play scores you against directly.</p>"
        )

    stats = (
        '<ul class="stats">'
        f'<li><b>{course["total"]}</b> flashcards</li>'
        f'<li><b>{course["core_count"]}</b> graded skills</li>'
        f'<li><b>{len(course["units"])}</b> topics</li>'
        f'<li><b>{len(groups)}</b> skill areas</li>'
        f"<li>{_e(kind.capitalize())}</li>"
        "</ul>"
    )

    actions = (
        '<div class="actions">'
        f'<a class="cta" href="/">Practice a {_e(code)} role-play →</a>'
        '<a class="cta ghost" href="/flashcards">Browse every event →</a>'
        "</div>"
    )

    toc = (
        '<div class="toc"><strong>What is in this deck</strong><ul>'
        + "".join(
            f'<li><a href="#{_e(g["id"])}">{_e(g["name"])}</a> — {g["count"]} cards '
            f"across {len(g['units'])} topics</li>"
            for g in groups
        )
        + "</ul></div>"
    )

    sections = []
    for g in groups:
        parts = [
            f'<h2 id="{_e(g["id"])}">{_e(g["name"])}</h2>',
            f'<p class="sub">{g["count"]} {_e(code)} cards, grouped into '
            f"{len(g['units'])} topics.</p>",
        ]
        for unit in g["units"]:
            parts.append(f"<h3>{_e(unit['topic'])}</h3>")
            parts.extend(_term_card(t) for t in terms.get_terms(unit["core_ids"] + unit["extended_ids"]))
        sections.append("".join(parts))

    related = [e for e in events.all_events() if e["cluster"] == event["cluster"] and e["id"] != event_id]
    related_html = ""
    if related:
        related_html = (
            f'<h2 id="related">Other {_e(event["cluster"])} decks</h2><div class="grid">'
            + "".join(
                f'<a class="tile" href="/flashcards/{_e(e["id"])}">'
                f'<span class="code">{_e(abbrev(e["id"]))}</span>'
                f'<span class="name">{_e(e["name"])}</span>'
                f'<span class="meta">{courses.course_for(e["id"])["total"]} cards</span></a>'
                for e in related
            )
            + "</div>"
        )

    faq = _event_faq(event, course, code)

    body = (
        '<p class="crumbs"><a href="/">PI Coach</a> › <a href="/flashcards">Flashcards</a> › '
        f"{_e(code)}</p>"
        f'<p class="eyebrow">DECA {_e(event["cluster"])}</p>'
        f"<h1>{_e(code)} Flashcards</h1>"
        f'<p class="sub">{_e(name)}</p>'
        f"{intro}{stats}{actions}{toc}"
        + "".join(sections)
        + related_html
        + _faq_block(faq)
        + f'<div class="note">{_e(_DISCLAIMER)}</div>'
    )

    jsonld = _graph(
        _crumbs_jsonld([("PI Coach", "/"), ("Flashcards", "/flashcards"), (f"{code} Flashcards", path)]),
        {
            "@type": "LearningResource",
            "@id": f"{site_url()}{path}#deck",
            "url": f"{site_url()}{path}",
            "name": f"{code} Flashcards — {name}",
            "description": description,
            "learningResourceType": "Flashcard deck",
            "educationalLevel": "High school",
            "inLanguage": "en-US",
            "isAccessibleForFree": True,
            "teaches": domain_names,
            "isPartOf": {"@id": f"{site_url()}/#website"},
        },
        _faq_jsonld(faq),
    )
    return _shell(title=title, description=description, path=path, body=body, jsonld=jsonld)


# --------------------------------------------------------------------------- #
# The hub
# --------------------------------------------------------------------------- #

_HUB_FAQ = [
    (
        "What are DECA flashcards?",
        "Decks of the business skills and vocabulary a DECA judge scores in a role-play — reading "
        "a target market, spotting a legal limit, explaining a cash-flow problem. PI Coach groups "
        "them by event, so you study the set that matters for the event you actually compete in.",
    ),
    (
        "Which deck should I study?",
        "The one for your event. Pick it from the list above — the code (BLTDM, HRM, ETDM, and so "
        "on) is DECA's abbreviation for it. Each deck carries every skill we grade for that event "
        "plus the supporting terms that make an answer sound informed.",
    ),
    (
        "Are the flashcards free?",
        "Yes. Every deck is readable here with no account. Signing in adds progress tracking, so "
        "the app remembers which terms you have proven under pressure and which you have only "
        "looked at.",
    ),
    (
        "Do flashcards alone win a role-play?",
        "No, and that is the honest answer. Knowing a term is not the same as applying it out "
        "loud to a judge under a timer. Study the deck, then run a role-play — PI Coach grades "
        "the substance criterion by criterion and measures delivery separately.",
    ),
    ("Are these official DECA materials?", _DISCLAIMER),
]


@lru_cache(maxsize=1)
def render_hub_page() -> str:
    """The hub every event page links back to, and the page the sitemap points at first."""
    path = "/flashcards"
    total_terms = len(terms.all_terms())
    all_events = events.all_events()

    title = "DECA Flashcards by Event — All 28 Decks | PI Coach"
    description = (
        "Free DECA flashcards for all 28 events — BLTDM, HRM, ETDM, MTDM, PFL and the rest. "
        f"{total_terms} study cards with plain-English definitions and the mistake to avoid, "
        "grouped into the deck for your event."
    )

    sections = []
    for cluster in events.clusters():
        in_cluster = [e for e in all_events if e["cluster"] == cluster]
        if not in_cluster:
            continue
        tiles = []
        for e in in_cluster:
            c = courses.course_for(e["id"])
            tiles.append(
                f'<a class="tile" href="/flashcards/{_e(e["id"])}">'
                f'<span class="code">{_e(abbrev(e["id"]))}</span>'
                f'<span class="name">{_e(e["name"])}</span>'
                f'<span class="meta">{c["total"]} cards · {c["core_count"]} graded</span></a>'
            )
        anchor = cluster.lower().replace(" & ", "-").replace(" ", "-")
        sections.append(f'<h2 id="{_e(anchor)}">{_e(cluster)}</h2><div class="grid">{"".join(tiles)}</div>')

    body = (
        '<p class="crumbs"><a href="/">PI Coach</a> › Flashcards</p>'
        '<p class="eyebrow">Study decks</p>'
        "<h1>DECA Flashcards by Event</h1>"
        f'<p class="lede">Every deck below is built from the same {total_terms}-card study '
        "corpus, filtered to the skills that matter for one event and ordered so you can finish "
        "a topic in a sitting. Each card gives you the idea in plain English and the mistake "
        "competitors actually make with it.</p>"
        '<div class="actions"><a class="cta" href="/">Practice a role-play out loud →</a></div>'
        + "".join(sections)
        + _faq_block(_HUB_FAQ)
        + f'<div class="note">{_e(_DISCLAIMER)}</div>'
    )

    jsonld = _graph(
        _crumbs_jsonld([("PI Coach", "/"), ("Flashcards", path)]),
        {
            "@type": "CollectionPage",
            "@id": f"{site_url()}{path}#page",
            "url": f"{site_url()}{path}",
            "name": title,
            "description": description,
            "isPartOf": {"@id": f"{site_url()}/#website"},
            "mainEntity": {
                "@type": "ItemList",
                "numberOfItems": len(all_events),
                "itemListElement": [
                    {
                        "@type": "ListItem",
                        "position": i,
                        "name": f"{abbrev(e['id'])} Flashcards — {e['name']}",
                        "url": f"{site_url()}/flashcards/{e['id']}",
                    }
                    for i, e in enumerate(all_events, start=1)
                ],
            },
        },
        _faq_jsonld(_HUB_FAQ),
    )
    return _shell(title=title, description=description, path=path, body=body, jsonld=jsonld)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@router.get("/flashcards")
def flashcards_hub() -> HTMLResponse:
    return _html(render_hub_page())


@router.get("/flashcards/{slug}")
def flashcards_event(slug: str):
    """One event's deck. Event codes redirect to the canonical slug rather than
    serving the same page at two URLs — duplicates split whatever ranking the page
    earns, which is the opposite of the point."""
    key = slug.strip().lower()
    if key in _ABBREV_TO_ID:
        return RedirectResponse(f"/flashcards/{_ABBREV_TO_ID[key]}", status_code=301)
    page = render_event_page(key)
    if page is None:
        raise HTTPException(status_code=404, detail="Unknown event")
    return _html(page)


@router.get("/robots.txt")
def robots() -> PlainTextResponse:
    lines = [
        "User-agent: *",
        "Allow: /",
        # Nothing here is secret — /admin is passphrase-gated and /api is JSON — but
        # neither belongs in an index, and crawling them only burns budget that
        # should go to the study pages.
        "Disallow: /admin",
        "Disallow: /api/",
        "",
        f"Sitemap: {site_url()}/sitemap.xml",
        "",
    ]
    return PlainTextResponse("\n".join(lines), headers={"Cache-Control": "public, max-age=86400"})


@router.get("/sitemap.xml")
def sitemap() -> Response:
    """Generated from the live event catalog, so adding an event to events.json puts
    its page in the sitemap with no second file to remember."""
    urls = [("/", "1.0"), ("/flashcards", "0.9")]
    urls += [(f"/flashcards/{e['id']}", "0.8") for e in events.all_events()]
    urls += [("/privacy", "0.2"), ("/terms", "0.2")]
    entries = "".join(
        f"<url><loc>{escape(site_url() + path)}</loc><priority>{pri}</priority></url>"
        for path, pri in urls
    )
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{entries}</urlset>"
    )
    return Response(xml, media_type="application/xml", headers={"Cache-Control": "public, max-age=86400"})
