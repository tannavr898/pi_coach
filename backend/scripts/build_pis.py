"""Build backend/app/data/pis.json from the official DECA PI list.

Offline, no API calls. Reads backend/reference/pis-core-reference.json (kept
local, large) and writes a compact runtime file with only what the app needs:
id, official text, level, instructional area, and the membership tags that say
which events draw on each indicator.

Run from backend/:  python -X utf8 scripts/build_pis.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "reference" / "pis-core-reference.json"
OUT = ROOT / "app" / "data" / "pis.json"

# Event -> membership tags whose indicators that event may draw from.
# Principles events: core only (the Business Administration Core exam list).
# Series/team events: core plus their cluster and pathway tags.
EVENT_TAGS: dict[str, list[str]] = {
    "principles-marketing": ["core"],
    "principles-finance": ["core"],
    "principles-hospitality-tourism": ["core"],
    "principles-business-management": ["core"],
    "principles-entrepreneurship": ["core"],
    "apparel-accessories-marketing": ["core", "cluster:marketing", "pathway:marketing:Merchandising"],
    "automotive-services-marketing": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "business-services-marketing": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "food-marketing": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "marketing-communications": ["core", "cluster:marketing", "pathway:marketing:Marketing Communications"],
    "retail-merchandising": ["core", "cluster:marketing", "pathway:marketing:Merchandising"],
    "sports-entertainment-marketing": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "buying-merchandising-team": ["core", "cluster:marketing", "pathway:marketing:Merchandising"],
    "marketing-management-team": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "sports-entertainment-marketing-team": ["core", "cluster:marketing", "pathway:marketing:Marketing Management"],
    "hotel-lodging-management": ["core", "cluster:hospitality", "pathway:hospitality:Lodging"],
    "quick-serve-restaurant-management": ["core", "cluster:hospitality", "pathway:hospitality:Restaurant Management"],
    "restaurant-food-service-management": ["core", "cluster:hospitality", "pathway:hospitality:Restaurant Management"],
    "hospitality-services-team": ["core", "cluster:hospitality", "pathway:hospitality:Lodging", "pathway:hospitality:Event Management"],
    "travel-tourism-team": ["core", "cluster:hospitality", "pathway:hospitality:Travel and Tourism"],
    "human-resources-management": ["core", "cluster:business_management", "pathway:business_management:Human Resource Management"],
    "business-law-ethics-team": ["core", "cluster:business_management", "pathway:business_management:General Management"],
    "entrepreneurship-individual": ["core", "cluster:entrepreneurship"],
    "entrepreneurship-team": ["core", "cluster:entrepreneurship"],
    "accounting-applications": ["core", "cluster:finance", "pathway:finance:Accounting"],
    "business-finance": ["core", "cluster:finance", "pathway:finance:Corporate Finance"],
    "financial-services-team": [
        "core", "cluster:finance", "pathway:finance:Banking Services",
        "pathway:finance:Insurance", "pathway:finance:Securities and Investments",
    ],
    # Personal Financial Literacy draws on the personal-finance side of the core list.
    "personal-financial-literacy": ["pfl"],
}

# Instructional areas that are not appropriate as a role-play's main subject
# for a given event are simply not selected by weighting in interpret.py; the
# full pool is kept here.


_PI_RE = re.compile(r"\(([A-Z]{2}:\d{3})\)\s*\((PQ|CS|SP|MN|ON)\)")
_AREA_RE = re.compile(r"Instructional Area:\s*(.+?)\s*\(([A-Z]{2})\)")
_TIER_RE = re.compile(r"Tier (\d): ([^\n]*?)\s*Page \d+")


AREA_NAMES: dict[str, str] = {}


def parse_finance_pdf(path: Path) -> list[dict]:
    """Official Finance cluster list: Tier 1 core, Tier 2 cluster, Tier 3 pathways."""
    out: list[dict] = []
    area, element = "", ""
    for page in pypdf.PdfReader(str(path)).pages:
        txt = page.extract_text() or ""
        m = _TIER_RE.search(txt)
        if not m:
            continue
        tier, label = int(m.group(1)), re.sub(r"\s+", " ", m.group(2)).strip()
        tag = {1: "core", 2: "cluster:finance"}.get(tier) or f"pathway:finance:{label.replace('Pathway', '').strip()}"
        body = re.sub(r"Tier \d:[^\n]*Page \d+", "", txt)
        body = re.sub(r"Finance Cluster for[^\n]*|Copyright[^\n]*", "", body)
        chunk = ""
        for line in body.split(chr(10)):
            line = line.strip()
            if not line:
                continue
            am = _AREA_RE.search(line)
            if am:
                area = am.group(2)
                AREA_NAMES[area] = am.group(1).strip()
                continue
            if line.startswith("Standard:"):
                continue
            if line.startswith("Performance Element:"):
                element = line.split(":", 1)[1].strip()
                chunk = ""
                continue
            if line.startswith("Performance Indicators"):
                chunk = ""
                continue
            chunk += " " + line
            pm = _PI_RE.search(chunk)
            if pm:
                text = re.sub(r"\s+", " ", chunk[: pm.start()]).strip()
                out.append({"id": pm.group(1), "text": text, "level": pm.group(2), "area": area,
                            "element": element, "tag": tag})
                chunk = chunk[pm.end():]
    return out


def main() -> None:
    src = json.loads(SRC.read_text(encoding="utf-8"))
    areas = {a["id"]: a["name"] for a in src["instructional_areas"]}
    pis = []
    seen: set[str] = set()
    for a in src["instructional_areas"]:
        for p in a["performance_indicators"]:
            if p["id"] in seen:
                continue
            seen.add(p["id"])
            pis.append(
                {
                    "id": p["id"],
                    "text": p["text"].strip(),
                    "level": p["level"],
                    "area": a["id"],
                    "element": p.get("performance_element", ""),
                    "tags": p["membership"],
                }
            )
    by_id = {p["id"]: p for p in pis}
    fin = ROOT / "reference" / "pis" / "finance.pdf"
    added = 0
    if fin.exists():
        for f in parse_finance_pdf(fin):
            if f["id"] in by_id:
                if f["tag"] not in by_id[f["id"]]["tags"]:
                    by_id[f["id"]]["tags"].append(f["tag"])
            else:
                row = {"id": f["id"], "text": f["text"], "level": f["level"], "area": f["area"],
                       "element": f["element"], "tags": [f["tag"]]}
                pis.append(row)
                by_id[f["id"]] = row
                added += 1
    # Personal Financial Literacy: the personal-finance side of the core list.
    for p in pis:
        if "core" in p["tags"] and p["area"] in ("FI", "EC"):
            p["tags"].append("pfl")
    for k, v in AREA_NAMES.items():
        areas.setdefault(k, v)
    print(f"finance PDF added {added} new indicators")
    out = {
        "version": "1.0-deca",
        "note": "Official DECA performance indicators (used with DECA's permission). Practice tool, not an official DECA product.",
        "areas": areas,
        "event_tags": EVENT_TAGS,
        "pis": pis,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT} with {len(pis)} indicators, {len(areas)} areas")


if __name__ == "__main__":
    main()
