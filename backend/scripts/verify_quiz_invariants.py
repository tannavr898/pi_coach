"""Prove a quiz revision lost nothing: every earlier question still exists with the same
id, term links, domain, topic, level, concepts, option ids, correct option and rationales.
Usage: python -X utf8 scripts/verify_quiz_invariants.py before.json
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
before = {q["id"]: q for q in json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["questions"]}
after = {q["id"]: q for q in json.loads((ROOT / "app" / "data" / "quiz_bank.json").read_text(encoding="utf-8"))["questions"]}
terms = {t["id"] for t in json.loads((ROOT / "app" / "data" / "terms.json").read_text(encoding="utf-8"))["terms"]}
bad = 0
for qid, b in before.items():
    a = after.get(qid)
    if a is None:
        print("MISSING", qid); bad += 1; continue
    for k in ("term_ids", "domain_id", "topic", "level", "concepts"):
        if a.get(k) != b.get(k):
            print("CHANGED", qid, k); bad += 1
    if [(o["id"], o["correct"], o["rationale"]) for o in a["options"]] != [(o["id"], o["correct"], o["rationale"]) for o in b["options"]]:
        print("OPTION KEYS/RATIONALE CHANGED", qid); bad += 1
for qid, a in after.items():
    for t in a.get("term_ids", []):
        if t not in terms:
            print("UNKNOWN TERM", qid, t); bad += 1
print(f"{len(before)} earlier questions checked, {len(after)} now, {len(after) - len(before)} new, {bad} problem(s)")
sys.exit(1 if bad else 0)
