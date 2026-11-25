"""Revise quiz wording in place without touching anything progress depends on.

Input JSON: {"Q-0023": {"d": "new option text", "q": "optional new stem"}, ...}
Keys are option ids (a to d) and the special key "q" for the stem.

Never changes: question id, term_ids, domain, topic, level, concepts, which option is
correct, option ids, or any rationale. Refuses a revision that would put a dash in the
copy or make the correct option the giveaway-longest. Study progress keys on term ids,
and the diagnostic keeps question ids, so both survive.

Run from backend/:  python -X utf8 scripts/revise_in_place.py revisions.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANK = ROOT / "app" / "data" / "quiz_bank.json"
DASHES = ("—", "–")


def main(path: str) -> int:
    rev = json.loads(Path(path).read_text(encoding="utf-8"))
    doc = json.loads(BANK.read_text(encoding="utf-8"))
    by_id = {q["id"]: q for q in doc["questions"]}
    done = bad = 0
    for qid, changes in rev.items():
        q = by_id.get(qid)
        if q is None:
            print(f"  ! {qid}: no such question")
            bad += 1
            continue
        trial = json.loads(json.dumps(q))
        for key, text in changes.items():
            text = text.strip()
            if not text or any(d in text for d in DASHES):
                print(f"  ! {qid}.{key}: empty or contains a dash")
                bad += 1
                break
            if key == "q":
                trial["question"] = text
            else:
                opt = next((o for o in trial["options"] if o["id"] == key), None)
                if opt is None:
                    print(f"  ! {qid}: no option {key}")
                    bad += 1
                    break
                opt["text"] = text
        else:
            texts = [o["text"] for o in trial["options"]]
            right = next(o["text"] for o in trial["options"] if o["correct"])
            others = sorted((len(t) for t in texts if t != right), reverse=True)
            if len({t.lower() for t in texts}) != 4:
                print(f"  ! {qid}: duplicate option text")
                bad += 1
                continue
            if len(right) > others[0] * 1.15 and len(right) - others[0] >= 6:
                print(f"  ! {qid}: correct option would be the giveaway longest ({len(right)} vs {others[0]})")
                bad += 1
                continue
            q.update(trial)
            done += 1
    BANK.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"revised {done} question(s); {bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
