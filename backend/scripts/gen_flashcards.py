"""One-time build script: generate flashcard content for every framework criterion.

For each criterion it produces a plain definition, a worked example run through the
four DECA beats (Define -> Explain -> Connect -> Above & Beyond), and one term-specific
common mistake — the shape approved in Phase 4. Output is written to
app/data/flashcard_content.json (display-only; grading still uses framework.json).

Resumable: criteria already present in the output file are skipped, so a re-run only
fills gaps / failures. The three seed cards (hand-authored, approved) are preserved.

Run:  python -m scripts.gen_flashcards          (from the backend/ directory)
      python -m scripts.gen_flashcards --limit 5   (smoke test on a few)
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app import config, framework, llm

_OUT = Path(__file__).resolve().parents[1] / "app" / "data" / "flashcard_content.json"
_BEATS = ("define", "explain", "connect", "above")

SYSTEM = (
    "You write study-flashcard content for a DECA role-play practice app. Given ONE "
    "business skill (our own framework criterion), produce study content for it.\n\n"
    "Return a plain definition, a worked example that runs the skill through the four "
    "beats of a strong role-play answer (Define, Explain, Connect, Above & Beyond) "
    "anchored in ONE specific invented mini-scenario, and one common mistake specific "
    "to THIS skill.\n\n"
    "RULES:\n"
    "- definition: define the SKILL in plain, student-friendly words. NOT a grading "
    "question ('does the response...'). One sentence.\n"
    "- example.define: in the participant's voice, define the skill simply and "
    "conversationally — no textbook jargon.\n"
    "- example.explain: why the skill matters to a business in the real world.\n"
    "- example.connect: apply it to a SPECIFIC invented scenario with a concrete "
    "recommendation. This beat earns the most points — make it concrete and specific.\n"
    "- example.above: ONE number, statistic, trade-off, real brand case, or niche term "
    "that goes beyond the obvious. Any math must be correct and realistic.\n"
    "- mistake: one sentence — a common error SPECIFIC to this skill, not a generic "
    "'be vague' or 'don't ramble'.\n"
    "- Voice: first person, spoken, concise (each beat ~1-2 sentences). Pick a fresh, "
    "varied scenario and industry that fits the skill's domain. No markdown.\n"
    "Output ONLY a JSON object with keys: definition, example (with define, explain, "
    "connect, above), mistake."
)


def _fewshot(cards: dict) -> str:
    """Anchor style on the approved seed cards (whichever are present)."""
    out = []
    for cid, label in (("FW-151", "Target Market Selection (Marketing / Target Market)"),
                        ("FW-109", "Break-even Thinking (Financial Analysis / Cost and Profit)")):
        if cid in cards:
            out.append(f"EXAMPLE — skill: {label}\n{json.dumps(cards[cid], ensure_ascii=False)}")
    return "\n\n".join(out)


def _prompt(c: dict, fewshot: str) -> str:
    return (
        f"{fewshot}\n\n"
        "Now write the content for THIS skill:\n"
        f"Skill name: {c['name']}\n"
        f"Domain: {c['domain']}   Topic: {c['topic']}\n"
        f"What it assesses (for your understanding only — reword into a plain definition): {c['definition']}\n"
        f"Coaching hint: {c.get('coaches', '')}\n\n"
        "Return ONLY the JSON object."
    )


def _generate(c: dict, fewshot: str) -> dict:
    raw = llm.complete(SYSTEM, _prompt(c, fewshot), model=config.SCENARIO_MODEL, max_tokens=800)
    data = llm.parse_json_object(raw)
    ex = data.get("example", {}) or {}
    card = {
        "definition": str(data.get("definition", "")).strip(),
        "example": {k: str(ex.get(k, "")).strip() for k in _BEATS},
        "mistake": str(data.get("mistake", "")).strip(),
    }
    # Validate: every field must be non-empty, or we treat it as a failure to retry.
    if not card["definition"] or not card["mistake"] or not all(card["example"][k] for k in _BEATS):
        raise llm.LLMError(f"incomplete content for {c['id']}")
    return card


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only generate this many (smoke test)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--force", action="store_true", help="regenerate even if present")
    args = ap.parse_args()

    doc = json.loads(_OUT.read_text(encoding="utf-8")) if _OUT.exists() else {"version": 1, "cards": {}}
    cards = doc.setdefault("cards", {})
    fewshot = _fewshot(cards)

    todo = [c for c in framework.all_criteria() if args.force or c["id"] not in cards]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(cards)} already present | generating {len(todo)} | {args.workers} workers", flush=True)

    done = failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_generate, c, fewshot): c for c in todo}
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                cards[c["id"]] = fut.result()
                done += 1
            except Exception as e:  # noqa: BLE001 — log and continue; re-run fills gaps
                failed += 1
                print(f"  ! {c['id']} {c['name']}: {e}", flush=True)
            if (done + failed) % 20 == 0:
                print(f"  ... {done + failed}/{len(todo)}", flush=True)

    # Write sorted by id for stable diffs.
    doc["cards"] = {k: cards[k] for k in sorted(cards)}
    _OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"done: +{done} generated, {failed} failed, {len(doc['cards'])} total -> {_OUT.name}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
