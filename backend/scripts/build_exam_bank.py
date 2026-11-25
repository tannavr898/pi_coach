"""Extract the official DECA sample exams into a LOCAL reference file for auditing our quiz.

Offline, no API calls. Reads the sample/district exam PDFs in backend/reference/deca_exams
that include a descriptive test key, and keeps each question, its four options, the
correct letter, DECA's rationale, and the performance indicator it tests.

Run from backend/:  python -X utf8 scripts/build_exam_bank.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "reference" / "deca_exams"
# LOCAL reference only (git-ignored under reference/). Never shipped or served: used to
# audit our own quiz questions against how the real exams phrase and key concepts.
OUT = ROOT / "reference" / "exam_items_local.json"

# Exam title keywords -> the exam name the app uses (matches events.json `exam`).
_EXAMS = [
    ("core", "Business Administration Core"),
    ("marketing", "Marketing"),
    ("hospitality", "Hospitality & Tourism"),
    ("entrepreneurship", "Entrepreneurship"),
    ("entre", "Entrepreneurship"),
    ("finance", "Finance"),
    ("business_management", "Business Management & Administration"),
    ("bma", "Business Management & Administration"),
]


def exam_name(filename: str) -> str:
    low = filename.lower()
    if "business_administration_core" in low or "ba core" in low or "ba_core" in low:
        return "Business Administration Core"
    if "business_management" in low or "bma" in low:
        return "Business Management & Administration"
    for key, name in _EXAMS:
        if key in low:
            return name
    return ""


def _clean(t: str) -> str:
    t = t.replace(" ", " ").replace("’", "'").replace("‘", "'")
    t = t.replace("“", '"').replace("”", '"').replace("—", ", ").replace("–", "-")
    t = re.sub(r"\bW hat\b", "What", t)
    t = re.sub(r"[ \t]+", " ", t)
    return t.strip()


def parse(path: Path) -> list[dict]:
    r = pypdf.PdfReader(str(path))
    text = "\n".join(p.extract_text() or "" for p in r.pages)
    text = re.sub(r"(?m)^Test \d+.*$|^Copyright.*$", "", text)
    m = re.search(r"(?m)^\s*1\.\s+[A-D]\s*$", text)
    if not m:
        return []
    body, key = text[: m.start()], text[m.start():]
    qstart = re.search(r"(?m)^\s*1\.\s+\S", body)
    if not qstart:
        return []
    body = body[qstart.start():]

    answers: dict[int, dict] = {}
    for blk in re.split(r"(?m)^\s*(?=\d{1,3}\.\s+[A-D]\s*$)", key):
        mm = re.match(r"\s*(\d{1,3})\.\s+([A-D])\s*\n(.*)", blk, re.S)
        if not mm:
            continue
        n, letter, rest = int(mm.group(1)), mm.group(2), mm.group(3)
        src = re.search(r"SOURCE:\s*([A-Z]{2}:\d{3})", rest)
        rationale = re.split(r"\n\s*SOURCE:", rest)[0]
        answers[n] = {
            "answer": letter,
            "rationale": _clean(re.sub(r"\s*\n\s*", " ", rationale)),
            "pi": src.group(1) if src else "",
        }

    out: list[dict] = []
    for blk in re.split(r"(?m)^\s*(?=\d{1,3}\.\s+\S)", body):
        mm = re.match(r"\s*(\d{1,3})\.\s+(.*)", blk, re.S)
        if not mm:
            continue
        n, rest = int(mm.group(1)), mm.group(2)
        parts = re.split(r"(?m)^\s*([A-D])\.\s+", rest)
        if len(parts) < 9:
            continue
        stem = _clean(re.sub(r"\s*\n\s*", " ", parts[0]))
        opts = {parts[i]: _clean(re.sub(r"\s*\n\s*", " ", parts[i + 1])) for i in range(1, len(parts) - 1, 2)}
        if set(opts) != set("ABCD") or n not in answers or not stem:
            continue
        out.append({
            "n": n,
            "question": stem,
            "options": [{"id": k, "text": opts[k]} for k in "ABCD"],
            **answers[n],
        })
    return out


def main() -> None:
    items: list[dict] = []
    seen_q: set[str] = set()
    for path in sorted(SRC.glob("*.pdf")):
        name = exam_name(path.name)
        try:
            qs = parse(path)
        except Exception as e:  # noqa: BLE001 - a bad PDF should not stop the others
            print("ERR", path.name, e)
            continue
        kept = 0
        for q in qs:
            key = re.sub(r"\W+", "", q["question"].lower())[:90]
            if key in seen_q:
                continue
            seen_q.add(key)
            items.append({"id": f"ex-{len(items) + 1:04d}", "exam": name, "source": path.stem[:40], **q})
            kept += 1
        print(f"{path.name[:60]:60} {name:38} parsed {len(qs):3} kept {kept:3}")
    OUT.write_text(json.dumps({"version": 1, "note": "Official DECA sample exam items (MBA Research) with DECA's answer rationale.", "questions": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}: {len(items)} questions")


if __name__ == "__main__":
    main()
