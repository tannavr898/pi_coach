"""Import hand-authored, official-format quiz questions through the normal validator.

Authoring file (JSON list):
  {"term": "Net Pay"            # a study term name (or unique fragment); icdc may add "term2"
   "level": "district|state|icdc",
   "format": "recognition|scenario|fill in the blank|...",
   "q": "stem",
   "a": ["key", "wrong1", "wrong2", "wrong3"],     # the FIRST option is the key; shuffled on import
   "why": "why the key holds",
   "miss": ["why wrong1 fails", "why wrong2 fails", "why wrong3 fails"],
   "check": "icdc only: the break test naming both concepts"}

It resolves each term to its domain/topic/window, builds the batches gen_quiz.import
expects, and runs the identical validator, dedupe and shuffle. No model call.

Run from backend/:  python -X utf8 scripts/import_authored.py file.json
"""

from __future__ import annotations

import json
import sys
from argparse import Namespace
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import gen_quiz  # noqa: E402

TERMS = json.loads((ROOT / "app" / "data" / "terms.json").read_text(encoding="utf-8"))["terms"]


def find(query: str) -> dict:
    q = query.strip().lower()
    exact = [t for t in TERMS if t["name"].lower() == q]
    if len(exact) == 1:
        return exact[0]
    part = [t for t in TERMS if q in t["name"].lower()]
    if len(part) == 1:
        return part[0]
    names = ", ".join(t["name"] for t in (part or exact)[:6]) or "no match"
    raise KeyError(f"term {query!r}: {names}")


def window_of(term: dict) -> tuple[str, str, int]:
    groups = {(d, tp): cards for d, tp, cards in gen_quiz._groups()}
    cards = groups[(term["domain_id"], term["topic"])]
    for i, w in enumerate(gen_quiz._windows(cards)):
        if any(c["id"] == term["id"] for c in w):
            return term["domain_id"], term["topic"], i
    raise KeyError(f"{term['name']} is in no window")


def main(path: str) -> int:
    items = json.loads(Path(path).read_text(encoding="utf-8"))
    batches: dict[tuple, list[dict]] = defaultdict(list)
    bad = 0
    for n, it in enumerate(items, 1):
        try:
            t1 = find(it["term"])
            dom, topic, win = window_of(t1)
            names = [t1["name"]]
            if it.get("term2"):
                t2 = find(it["term2"])
                if window_of(t2) != (dom, topic, win):
                    raise KeyError(f"{t2['name']} is in a different window than {t1['name']}")
                names.append(t2["name"])
            opts = [{"text": it["a"][0], "correct": True, "rationale": it["why"]}]
            for text, why in zip(it["a"][1:], it["miss"]):
                opts.append({"text": text, "correct": False, "rationale": why})
            row = {
                "question": it["q"], "options": opts, "concepts": names, "format": it.get("format", "recognition"),
                "difficulty_justification": it.get("dj", "Official-exam formula: short stem, short options."),
                "synthesis_check": it.get("check", ""),
            }
            batches[(dom, topic, it["level"], win)].append(row)
        except Exception as e:  # noqa: BLE001
            bad += 1
            print(f"  ! #{n} {it.get('term')}: {e}")
    out = {"batches": [
        {"domain_id": d, "topic": tp, "level": lv, "window": w, "questions": qs}
        for (d, tp, lv, w), qs in batches.items()
    ]}
    tmp = Path(path).with_suffix(".batches.json")
    tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    rc = gen_quiz.cmd_import(Namespace(file=str(tmp), force=True, seed=7))
    tmp.unlink(missing_ok=True)
    return 1 if (bad or rc) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
