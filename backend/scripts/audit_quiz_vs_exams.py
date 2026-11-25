"""Audit our quiz bank against the official exams (LOCAL ONLY, reads reference/).

For each official exam item, find the study term it is most about, then print the exam's
keyed answer and rationale next to our term definition and our quiz answers for that
term, so a person can spot places where we say something different from the real test.

Nothing here is shipped; output goes to the console / a local file.
Run from backend/:  python -X utf8 scripts/audit_quiz_vs_exams.py [min_score] [out.txt]
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_W = re.compile(r"[a-z]{4,}")
_STOP = set("that this with from which their there about would should could when what into have been they them than then also each other more most some such only over very your".split())


def toks(t: str) -> set[str]:
    return {w[:6] for w in _W.findall(t.lower()) if w not in _STOP}


def main() -> None:
    min_score = float(sys.argv[1]) if len(sys.argv) > 1 else 0.22
    exam = json.loads((ROOT / "reference" / "exam_items_local.json").read_text(encoding="utf-8"))["questions"]
    terms = json.loads((ROOT / "app" / "data" / "terms.json").read_text(encoding="utf-8"))["terms"]
    quiz = json.loads((ROOT / "app" / "data" / "quiz_bank.json").read_text(encoding="utf-8"))["questions"]
    by_term = defaultdict(list)
    for q in quiz:
        for tid in q.get("term_ids", []):
            by_term[tid].append(q)
    tt = [(t, toks(f"{t['name']} {t['name']} {t['topic']} {t['definition']}")) for t in terms]
    rows = []
    for e in exam:
        right = next(o["text"] for o in e["options"] if o["id"] == e["answer"])
        et = toks(f"{e['question']} {right} {e['rationale']}")
        best, score = None, 0.0
        for t, tk in tt:
            if not tk:
                continue
            s = len(et & tk) / (len(tk) ** 0.5 * len(et) ** 0.5 + 1e-9)
            if s > score:
                best, score = t, s
        if best and score >= min_score:
            rows.append((score, e, right, best))
    rows.sort(key=lambda r: -r[0])
    out = []
    for score, e, right, t in rows:
        qs = by_term.get(t["id"], [])[:2]
        out.append(f"### {e['id']} {e['exam']} ({score:.2f}) -> {t['id']} {t['name']}\n"
                   f"EXAM Q: {e['question']}\n  KEY: {right}\n  WHY: {e['rationale'][:420]}\n"
                   f"OUR DEF: {t['definition'][:360]}\n"
                   + "".join(f"OUR Q [{q['level']}]: {q['question'][:200]}\n  OUR KEY: "
                             f"{next(o['text'] for o in q['options'] if o['correct'])[:200]}\n" for q in qs))
    path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "reference" / "quiz_audit_local.txt"
    path.write_text("\n".join(out), encoding="utf-8")
    print(f"{len(rows)} exam items matched a term at >= {min_score}; wrote {path}")


if __name__ == "__main__":
    main()
