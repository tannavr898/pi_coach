"""Build backend/app/data/scenario_bank.json from hand-authored text files.

Offline, no API calls. Source files live in backend/scripts/scenario_bank_src/<event-id>.txt,
one per event, each holding ~10 scenarios in this plain format (blank line between fields
is fine, `===` starts a scenario):

    === district | president of ACME
    PIS:
    - explain the role of ethics in human resources management
    - ...
    SITUATION:
    You are to assume the role of ...
    (paragraphs; bullets start with "- ")
    QUESTIONS:
    - first judge question
    - second judge question
    HOOK: one punchy line under 20 words.

Each `PIS:` line is a phrase close to the official indicator wording. The builder resolves
it to the best-matching official PI id in that event's pool at that level and prints the
match so the author can verify; a weak match fails the build.

Run from backend/:  python -X utf8 scripts/build_scenario_bank.py [event-id ...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import events, pis  # noqa: E402

SRC = Path(__file__).resolve().parent / "scenario_bank_src"
OUT = ROOT / "app" / "data" / "scenario_bank.json"
_WORD = re.compile(r"[a-z]{3,}")
_STOP = {"the", "and", "for", "that", "with", "from", "into", "how", "its", "are", "use", "using"}


def _toks(t: str) -> set[str]:
    return {w[:6] for w in _WORD.findall(t.lower()) if w not in _STOP}


def resolve(phrase: str, pool: list[dict]) -> tuple[dict, float]:
    q = _toks(phrase)
    best, score = None, -1.0
    for p in pool:
        t = _toks(p["text"])
        if not t:
            continue
        s = len(q & t) / max(len(q | t), 1)
        if s > score:
            best, score = p, s
    return best, score


def parse_file(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    out = []
    for block in re.split(r"^===\s*", text, flags=re.M)[1:]:
        head, _, rest = block.partition("\n")
        level, _, judge = (x.strip() for x in head.partition("|"))
        m = {k: "" for k in ("PIS", "SITUATION", "QUESTIONS", "HOOK")}
        cur = None
        for line in rest.split("\n"):
            mm = re.match(r"^(PIS|SITUATION|QUESTIONS|HOOK):\s*(.*)$", line)
            if mm:
                cur = mm.group(1)
                m[cur] += mm.group(2) + "\n"
            elif cur:
                m[cur] += line + "\n"
        out.append({
            "level": level,
            "judge_role": judge,
            "pis": [x[2:].strip() for x in m["PIS"].strip().split("\n") if x.startswith("- ")],
            "situation": re.sub(r"\n{3,}", "\n\n", m["SITUATION"].strip()),
            "questions": [x[2:].strip() for x in m["QUESTIONS"].strip().split("\n") if x.startswith("- ")],
            "hook": m["HOOK"].strip(),
        })
    return out


def build(only: list[str]) -> None:
    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"version": 1, "scenarios": []}
    keep = [s for s in doc["scenarios"] if only and s["event"] not in only]
    bad = 0
    files = [SRC / f"{e}.txt" for e in only] if only else sorted(SRC.glob("*.txt"))
    for f in files:
        eid = f.stem
        ev = events.get_event(eid)
        assert ev, f"unknown event {eid}"
        rows = []
        for n, s in enumerate(parse_file(f), 1):
            pool = pis.eligible(ev, s["level"])
            ids, area_ids = [], []
            for phrase in s["pis"]:
                direct = re.match(r"^([A-Z]{2}:\d{3})", phrase)
                if direct:
                    hit = next((x for x in pool if x["id"] == direct.group(1)), None)
                    if hit is None:
                        print(f"  !! {eid}#{n} {direct.group(1)} is not in this event's {s['level']} pool")
                        bad += 1
                        continue
                    p, sc = hit, 1.0
                else:
                    p, sc = resolve(phrase, pool)
                flag = "" if sc >= 0.5 else "   <-- WEAK"
                if flag:
                    bad += 1
                print(f"{eid}#{n} {s['level']:8} {sc:.2f} {p['id']} {p['text'][:90]}{flag}")
                if p["id"] not in ids:
                    ids.append(p["id"])
                    area_ids.append(p["area"])
            want = events.pi_count_for(ev)
            if len(ids) != want:
                print(f"  !! {eid}#{n} has {len(ids)} PIs, wants {want}")
                bad += 1
            nq = 2 if ev["kind"] == "principles" else 3
            if len(s["questions"]) != nq:
                print(f"  !! {eid}#{n} has {len(s['questions'])} questions, wants {nq}")
                bad += 1
            words = len(s["situation"].split())
            rows.append({
                "id": f"bank:{eid}:{n:02d}",
                "event": eid,
                "level": s["level"],
                "judge_role": s["judge_role"],
                "pi_ids": ids,
                "area": pis.area_name(max(set(area_ids), key=area_ids.count)) if area_ids else "",
                "situation": s["situation"],
                "followup_questions": s["questions"],
                "hook": s["hook"],
                "words": words,
            })
            for ch in ("—", "–"):
                if ch in s["situation"] or any(ch in q for q in s["questions"]):
                    print(f"  !! {eid}#{n} contains a dash character")
                    bad += 1
        keep = [x for x in keep if x["event"] != eid] + rows
        print(f"-- {eid}: {len(rows)} scenarios")
    keep.sort(key=lambda r: (r["event"], r["id"]))
    OUT.write_text(json.dumps({"version": 1, "scenarios": keep}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT} with {len(keep)} scenarios; {bad} problems")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    build(sys.argv[1:])
