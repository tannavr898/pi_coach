"""Build backend/app/data/sample_roleplays.json from the official DECA samples.

Offline, no API calls. Reads the series sample PDFs in backend/reference/samples
and the principles sample text in backend/reference/deca_samples. The output is
used ONLY as few-shot style guides and as measurements of official length and
structure. It is never returned to users as a role-play.

Run from backend/:  python -X utf8 scripts/build_samples.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "reference"
OUT = ROOT / "app" / "data" / "sample_roleplays.json"


def _clean(t: str) -> str:
    t = t.replace(" ", " ")
    t = re.sub(r"[ \t]+", " ", t)
    # pdf text breaks words/hyphens oddly: "vide o", "intra -office"
    t = re.sub(r" -", "-", t)
    t = re.sub(r"- ", "-", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _between(t: str, start: str, end_pat: str) -> str:
    i = t.find(start)
    if i < 0:
        return ""
    i += len(start)
    m = re.search(end_pat, t[i:])
    return t[i : i + m.start()] if m else t[i:]


def parse_series(path: Path) -> dict | None:
    r = pypdf.PdfReader(str(path))
    t = "\n".join((p.extract_text() or "") for p in r.pages)
    t = re.sub(r"[A-Z]{2,5}-\d{2}\s*\nSample\s*\n\s*\d*\s*\n", "\n", t)
    cluster = _clean(_between(t, "CAREER CLUSTER", r"CAREER PATHWAY|INSTRUCTIONAL AREA"))
    pathway = _clean(_between(t, "CAREER PATHWAY", r"INSTRUCTIONAL AREA"))
    area = _clean(_between(t, "INSTRUCTIONAL AREA", r"\n[A-Z ]+EVENT"))
    skills = [
        _clean(s)
        for s in re.findall(r"•\s*([A-Z][^•\n]+? – [^•]+?)(?=\n•|\n\s*\n|\nPERFORMANCE)", _between(t, "21st CENTURY SKILLS", r"PERFORMANCE INDICATORS"), re.S)
    ]
    pis = [
        _clean(x)
        for x in re.findall(r"^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.\s|\n\s*\n|\Z)", _between(t, "PERFORMANCE INDICATORS", r"EVENT SITUATION"), re.M | re.S)
    ]
    sit = _clean(_between(t, "EVENT SITUATION", r"JUDGE.?S INSTRUCTIONS"))
    sit = re.sub(r"\n[A-Z]{2,5}-\d{2}\s*\nSample\s*\n\s*\d+\s*", "\n", sit)
    qs_block = _between(t, "ask the following questions", r"Once the|You are not to make")
    qs = [_clean(x) for x in re.findall(r"^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.\s|\Z)", qs_block, re.M | re.S)]
    if not sit or not pis:
        return None
    return {
        "id": path.stem.replace("_sample", ""),
        "format": "series",
        "cluster": cluster,
        "pathway": pathway,
        "area": area,
        "skills": skills,
        "pis": pis,
        "situation": sit,
        "judge_questions": qs,
        "situation_words": len(sit.split()),
    }


def parse_principles(path: Path) -> dict | None:
    t = path.read_text(encoding="utf-8", errors="replace")
    sit = _between(t, "EVENT SITUATION", r"JUDGE INSTRUCTIONS")
    sit = re.sub(r"online without written permission.*?\n.*?\n.*?\n", "", sit, flags=re.S)
    sit = _clean(re.sub(r"\s*\n\s*", " ", sit))
    qs_block = _between(t, "ask the following questions", r"Once the|You are not to make")
    qs = [_clean(x) for x in re.findall(r"^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.\s|\Z)", qs_block, re.M | re.S)]
    cluster = _clean(_between(t, "CAREER CLUSTER", r"CAREER PATHWAY|INSTRUCTIONAL AREA|_____"))
    area = _clean(_between(t, "INSTRUCTIONAL AREA", r"\n\s*\n\s*[A-Z]{3,}"))
    if len(sit.split()) < 60:
        return None
    return {
        "id": path.stem,
        "format": "principles",
        "cluster": cluster,
        "pathway": "",
        "area": area,
        "skills": [],
        "pis": [],
        "situation": sit,
        "judge_questions": [re.sub(r"\s+", " ", q) for q in qs],
        "situation_words": len(sit.split()),
    }


def main() -> None:
    out = []
    for p in sorted((REF / "samples").glob("*_sample.pdf")):
        row = parse_series(p)
        if row:
            out.append(row)
        else:
            print("skip", p.name)
    for p in sorted((REF / "deca_samples").glob("*.txt")):
        row = parse_principles(p)
        if row:
            out.append(row)
        else:
            print("skip", p.name)
    OUT.write_text(
        json.dumps(
            {
                "version": "1.0-deca",
                "note": "Official DECA sample role-plays, used with permission as style guides only. Never served to users.",
                "samples": out,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"wrote {OUT}: {len(out)} samples")
    for s in out:
        print(s["id"], s["format"], s["situation_words"], "w", len(s["pis"]), "PIs", len(s["skills"]), "skills", len(s["judge_questions"]), "qs")


if __name__ == "__main__":
    main()
