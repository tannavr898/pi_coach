"""Build script: expand the study corpus (terms.json) past the graded framework.

Replaces gen_flashcards.py, which could only ever author one card per framework
criterion — the coupling that capped the library at 282.

TWO PASSES, because the hard part is deciding WHICH terms exist, not writing their
backs:

  skeleton  Per domain, propose new term names (topic + name only). Cheap, and the
            one place a human can actually review 500+ decisions. STOP HERE and read
            app/data/term_skeleton.json before running `content`.
  content   Per proposed term, write the card: coaches line, plain definition, a
            worked example through the four beats, and one common mistake.

SOURCING — the rule that keeps this legal
Terms are authored BLIND from business fundamentals. This script never reads
backend/reference/ and must never be given DECA's PI list, as a source, a checklist,
or a "don't match this" filter — any of those would make their list an input, which
is what framework-notes.md's two hard rules forbid. Independence is checked AFTER
the fact by scripts/check_independence.py. Author blind; audit after.

GRAIN — the rule that keeps this defensible
Tripling the corpus means slicing finer, and a fine enough slice maps to exactly one
PI. The prompts below enforce the grain test from framework-notes.md ("one
identifiable skill a student can practice") and explicitly forbid producing new terms
by sub-dividing existing ones. New terms must be SIBLINGS, not fragments. This is the
main thing to check when reviewing the skeleton.

New terms are always tier="extended" with criterion_id=None: core means "a skill we
actually grade you on", and generating a card cannot make something graded.

Resumable: terms already carrying content are skipped, so a re-run fills gaps only.

The full loop:
      skeleton -> review by hand -> content -> check_independence -> prune

Run:  python -m scripts.gen_terms skeleton                (all 13 domains)
      python -m scripts.gen_terms skeleton --domain marketing
      python -m scripts.gen_terms content --limit 5       (smoke test)
      python -m scripts.gen_terms content --workers 8
      python -m scripts.gen_terms prune T-0486            (retire a duplicate)
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app import config, framework, llm
from scripts._textsim import ratio, tokens

_DATA = Path(__file__).resolve().parents[1] / "app" / "data"
_SKELETON = _DATA / "term_skeleton.json"
_TERMS = _DATA / "terms.json"

_BEATS = ("define", "explain", "connect", "above")
# Each topic/domain grows to 3x its current size: the existing 1x plus 2x new. Keeps
# the domain balance framework-notes.md argues for (Marketing largest because its
# territory genuinely is) rather than flattening every domain to the same count.
_GROWTH = 2
# Two proposed names this similar are the same card. Domains are generated in
# parallel and each call is blind to its siblings, so the same public concept gets
# proposed in several domains at once ("Economies of Scale" under both Economics and
# Operations). 0.85 catches those plus "X" vs "X in Business"; below that, terms like
# "Supply and Demand" vs "Labor Supply and Demand" are genuinely distinct concepts
# and must survive.
_DUPE_NAME_RATIO = 0.85
# A new topic that can't field this many terms makes a stub course unit — units are
# topics, so one-term topics turn the study path choppy.
_MIN_NEW_TOPIC = 3


# --- pass 1: skeleton -------------------------------------------------------

SKELETON_SYSTEM = (
    "You are a business educator building a STUDY GLOSSARY for a high-school business "
    "competition practice app. Given ONE business domain — its existing topics and the "
    "terms already covered — propose NEW terms that expand that domain's coverage.\n\n"
    "SOURCE RULE (critical): author ONLY from general business fundamentals — the "
    "material taught in any introductory business or marketing textbook. Do NOT "
    "reproduce, adapt, or work from any competition organization's published list of "
    "performance indicators, its wording, or its groupings. If you happen to know such "
    "a list, do not use it as a source or as a checklist. Every term you propose must "
    "be a concept you could point to in a textbook.\n\n"
    "GRAIN RULE (critical): each term names ONE identifiable skill or concept a student "
    "could explain in about a minute inside a role-play.\n"
    "- Too broad: 'Marketing' — coaching on it would be useless.\n"
    "- Too narrow: 'The birthday-offer tactic' — a fragment, not a skill.\n"
    "- Right: 'Target Market Selection', 'Break-even Thinking'.\n"
    "Do NOT create a term by slicing an existing term into smaller pieces. New terms "
    "must be SIBLINGS of the existing ones — genuinely different concepts at the same "
    "altitude. A term that only makes sense as a sub-part of a listed term is wrong.\n\n"
    "COVERAGE RULE: prefer breadth over depth. You may extend an existing topic, or "
    "introduce a NEW topic within this domain where real territory is uncovered — but a "
    "new topic must carry AT LEAST 3 terms. Do not create a topic to hold one term; put "
    "that term in an existing topic instead. Never duplicate or merely rephrase anything "
    "in the already-covered list.\n\n"
    "STAY IN YOUR DOMAIN: propose only terms that genuinely belong to THIS domain. Other "
    "domains (marketing, finance, operations, HR, and so on) are being written "
    "separately — a concept that is really theirs will collide with their work. If a "
    "term's natural home is another field, leave it out.\n\n"
    "Return ONLY a JSON object: {\"terms\": [{\"topic\": \"...\", \"name\": \"...\"}, ...]}\n"
    "- topic: an existing topic from the list, or a new one (1-3 words, Title Case).\n"
    "- name: 2-5 words, Title Case, in your own phrasing."
)


def _skeleton_prompt(domain: dict, existing: list[dict], want: int) -> str:
    by_topic: dict[str, list[str]] = {}
    for c in existing:
        by_topic.setdefault(c["topic"], []).append(c["name"])
    covered = "\n".join(f"- {t}: {', '.join(names)}" for t, names in by_topic.items())
    return (
        f"Domain: {domain['name']}\n"
        f"What this domain covers: {domain.get('blurb', '')}\n\n"
        f"ALREADY COVERED ({len(existing)} terms across {len(by_topic)} topics) — do not "
        f"duplicate or rephrase any of these:\n{covered}\n\n"
        f"Propose exactly {want} NEW terms for this domain. Return ONLY the JSON object."
    )


def _gen_skeleton(domain: dict) -> list[dict]:
    existing = framework.criteria_for_domains([domain["id"]])
    want = len(existing) * _GROWTH
    raw = llm.complete(
        SKELETON_SYSTEM,
        _skeleton_prompt(domain, existing, want),
        model=config.SCENARIO_MODEL,
        max_tokens=4000,
    )
    data = llm.parse_json_object(raw)
    seen = {c["name"].strip().lower() for c in existing}
    out: list[dict] = []
    for t in data.get("terms", []):
        name, topic = str(t.get("name", "")).strip(), str(t.get("topic", "")).strip()
        if not name or not topic or name.lower() in seen:
            continue  # empty or a duplicate of an existing term
        seen.add(name.lower())
        out.append({"domain_id": domain["id"], "domain": domain["name"], "topic": topic, "name": name})
    return out


def _dedupe(proposed: list[dict]) -> tuple[list[dict], list[tuple[dict, dict]]]:
    """Drop proposals that repeat an existing term or an earlier proposal.

    Necessary because domains are generated in parallel, so each call is blind to
    what its siblings are proposing and the same public concept lands in two or three
    domains at once. Deterministic: the first occurrence in domain order wins, so a
    re-run drops the same side every time.
    """
    kept: list[dict] = []
    dropped: list[tuple[dict, dict]] = []
    # Ids aren't assigned until after dedupe, so match on name/tokens only.
    seen = [{"name": c["name"], "toks": tokens(c["name"])} for c in framework.all_criteria()]
    for p in proposed:
        pt = tokens(p["name"])
        hit = next((s for s in seen if ratio(pt, s["toks"]) >= _DUPE_NAME_RATIO), None)
        if hit:
            dropped.append((p, hit))
            continue
        seen.append({"name": p["name"], "toks": pt})
        kept.append(p)
    return kept, dropped


def _drop_stub_topics(proposed: list[dict]) -> tuple[list[dict], list[dict]]:
    """Move terms out of brand-new topics too small to be a course unit.

    Units are topics, so a one-term topic is a stub in the study path. Rather than
    delete the term (the concept is usually fine), reassign it to the domain's
    largest established topic and let the human reviewer re-home it.
    """
    existing_topics: dict[str, list[str]] = {}
    for c in framework.all_criteria():
        existing_topics.setdefault(c["domain_id"], []).append(c["topic"])

    counts: dict[tuple[str, str], int] = {}
    for c in framework.all_criteria():
        counts[(c["domain_id"], c["topic"])] = counts.get((c["domain_id"], c["topic"]), 0) + 1
    for p in proposed:
        counts[(p["domain_id"], p["topic"])] = counts.get((p["domain_id"], p["topic"]), 0) + 1

    moved: list[dict] = []
    for p in proposed:
        key = (p["domain_id"], p["topic"])
        is_new = p["topic"] not in existing_topics.get(p["domain_id"], [])
        if is_new and counts[key] < _MIN_NEW_TOPIC:
            fallback = max(set(existing_topics.get(p["domain_id"], ["General"])),
                           key=lambda t: existing_topics[p["domain_id"]].count(t))
            moved.append({**p, "_was": p["topic"]})
            p["topic"] = fallback
    return proposed, moved


def cmd_skeleton(args) -> int:
    doc = json.loads(_SKELETON.read_text(encoding="utf-8")) if _SKELETON.exists() else {}
    proposed: list[dict] = [] if args.force else doc.get("proposed", [])
    done_domains = {p["domain_id"] for p in proposed}

    targets = [d for d in framework.domains() if not args.domain or d["id"] == args.domain]
    todo = [d for d in targets if args.force or d["id"] not in done_domains]
    if not todo:
        print("skeleton already covers every domain — use --force to redo")
        return 0
    print(f"proposing terms for {len(todo)} domain(s)...", flush=True)

    failed = 0
    with ThreadPoolExecutor(max_workers=min(args.workers, len(todo))) as pool:
        futures = {pool.submit(_gen_skeleton, d): d for d in todo}
        for fut in as_completed(futures):
            d = futures[fut]
            try:
                got = fut.result()
                proposed.extend(got)
                print(f"  + {d['name']}: {len(got)} proposed", flush=True)
            except Exception as e:  # noqa: BLE001 — log and continue; re-run fills gaps
                failed += 1
                print(f"  ! {d['name']}: {e}", flush=True)

    # Sort BEFORE dedupe so "first occurrence wins" means "earliest domain wins",
    # not "whichever thread happened to finish first".
    order = {d["id"]: i for i, d in enumerate(framework.domains())}
    proposed.sort(key=lambda p: (order.get(p["domain_id"], 99), p["topic"], p["name"]))

    proposed, dropped = _dedupe(proposed)
    proposed, moved = _drop_stub_topics(proposed)
    proposed.sort(key=lambda p: (order.get(p["domain_id"], 99), p["topic"], p["name"]))
    for i, p in enumerate(proposed, start=1):
        p["id"] = f"T-{i:04d}"

    if dropped:
        print(f"\ndeduped {len(dropped)} (same concept proposed twice):")
        for p, hit in dropped[:12]:
            print(f"  - {p['domain']:24} {p['name']:38} ~ {hit['name']}")
        if len(dropped) > 12:
            print(f"  ... and {len(dropped) - 12} more")
    if moved:
        print(f"\nre-homed {len(moved)} term(s) out of stub topics (<{_MIN_NEW_TOPIC} terms):")
        for m in moved[:8]:
            print(f"  - {m['name']:38} {m['_was']} -> (reviewer: pick a better topic)")

    _SKELETON.write_text(json.dumps(
        {"version": 1,
         "note": ("Proposed study terms, authored blind from business fundamentals. "
                  "REVIEW THIS BY HAND before running `gen_terms content`: check the grain "
                  "(one coachable skill, a sibling of its neighbours — not a fragment of "
                  "one) and delete anything duplicative. Deleting a row is free; its id is "
                  "simply retired."),
         "proposed": proposed},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n{len(proposed)} proposed -> {_SKELETON.name}  ({failed} domain(s) failed)")
    print("REVIEW IT BY HAND, then: python -m scripts.gen_terms content")
    return 1 if failed else 0


# --- pass 2: content --------------------------------------------------------

CONTENT_SYSTEM = (
    "You write study-flashcard content for a business role-play practice app. Given ONE "
    "business skill, produce study content for it.\n\n"
    "Return a one-phrase 'coaches' line, a plain definition, a worked example that runs "
    "the skill through the four beats of a strong role-play answer (Define, Explain, "
    "Connect, Above & Beyond) anchored in ONE specific invented mini-scenario, and one "
    "common mistake specific to THIS skill.\n\n"
    "RULES:\n"
    "- coaches: the ONE skill this trains, as a short phrase (e.g. 'Choosing and serving "
    "a specific target market'). No sentence, no period.\n"
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
    "- Write from general business fundamentals in your own words. Never reproduce any "
    "competition organization's published indicator wording.\n"
    "- NEVER use an em dash (—) or en dash (–). Use a comma, a colon, or a new "
    "sentence. This is a hard rule: the shipped cards contain none.\n"
    "- Voice: first person, spoken, concise (each beat ~1-2 sentences). Pick a fresh, "
    "varied scenario and industry that fits the skill's domain. No markdown.\n"
    "Output ONLY a JSON object with keys: coaches, definition, example (with define, "
    "explain, connect, above), mistake."
)


def _fewshot(by_id: dict[str, dict]) -> str:
    """Anchor style on the two hand-authored seed cards (the approved voice)."""
    out = []
    for tid, label in (("FW-151", "Target Market Selection (Marketing / Target Market)"),
                       ("FW-109", "Break-even Thinking (Financial Analysis / Cost and Profit)")):
        t = by_id.get(tid)
        if not t:
            continue
        card = {k: t[k] for k in ("coaches", "definition", "example", "mistake") if k in t}
        out.append(f"EXAMPLE — skill: {label}\n{json.dumps(card, ensure_ascii=False)}")
    return "\n\n".join(out)


def _content_prompt(t: dict, fewshot: str) -> str:
    return (
        f"{fewshot}\n\n"
        "Now write the content for THIS skill:\n"
        f"Skill name: {t['name']}\n"
        f"Domain: {t['domain']}   Topic: {t['topic']}\n\n"
        "Return ONLY the JSON object."
    )


def _gen_content(t: dict, fewshot: str) -> dict:
    raw = llm.complete(CONTENT_SYSTEM, _content_prompt(t, fewshot), model=config.SCENARIO_MODEL, max_tokens=900)
    data = llm.parse_json_object(raw)
    ex = data.get("example", {}) or {}
    card = {
        "coaches": str(data.get("coaches", "")).strip().rstrip("."),
        "definition": str(data.get("definition", "")).strip(),
        "example": {k: str(ex.get(k, "")).strip() for k in _BEATS},
        "mistake": str(data.get("mistake", "")).strip(),
    }
    if not all((card["coaches"], card["definition"], card["mistake"], *(card["example"][k] for k in _BEATS))):
        raise llm.LLMError(f"incomplete content for {t['id']} {t['name']}")
    return card


def _sort_terms(all_terms: list[dict]) -> list[dict]:
    """Domain order from framework.json, then topics in framework order (new topics
    after the established ones), then core before extended. This is what the library
    renders, so a new topic must not wedge itself between two existing ones."""
    dom_order = {d["id"]: i for i, d in enumerate(framework.domains())}
    topic_order: dict[tuple[str, str], int] = {}
    for c in framework.all_criteria():
        topic_order.setdefault((c["domain_id"], c["topic"]), len(topic_order))
    return sorted(all_terms, key=lambda t: (
        dom_order.get(t["domain_id"], 99),
        topic_order.get((t["domain_id"], t["topic"]), 10_000),  # new topics sort last
        t["topic"],
        0 if t["tier"] == "core" else 1,
        t["id"],
    ))


def cmd_content(args) -> int:
    if not _SKELETON.exists():
        print(f"No {_SKELETON.name} — run `python -m scripts.gen_terms skeleton` first.")
        return 1
    proposed = json.loads(_SKELETON.read_text(encoding="utf-8")).get("proposed", [])
    doc = json.loads(_TERMS.read_text(encoding="utf-8"))
    by_id = {t["id"]: t for t in doc["terms"]}
    fewshot = _fewshot(by_id)
    if not fewshot:
        print("! seed cards FW-151/FW-109 missing — style would drift. Aborting.")
        return 1

    todo = [p for p in proposed if args.force or not by_id.get(p["id"], {}).get("definition")]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(by_id)} terms present | generating {len(todo)} | {args.workers} workers", flush=True)

    done = failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_gen_content, p, fewshot): p for p in todo}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                by_id[p["id"]] = {
                    "id": p["id"],
                    "criterion_id": None,   # study-only: generating a card can't make it graded
                    "tier": "extended",
                    "domain_id": p["domain_id"],
                    "domain": p["domain"],
                    "topic": p["topic"],
                    "name": p["name"],
                    **fut.result(),
                }
                done += 1
            except Exception as e:  # noqa: BLE001 — log and continue; re-run fills gaps
                failed += 1
                print(f"  ! {p['id']} {p['name']}: {e}", flush=True)
            if (done + failed) % 25 == 0:
                print(f"  ... {done + failed}/{len(todo)}", flush=True)

    doc["terms"] = _sort_terms(list(by_id.values()))
    _TERMS.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    core = sum(1 for t in doc["terms"] if t["tier"] == "core")
    print(f"\ndone: +{done}, {failed} failed | {len(doc['terms'])} terms "
          f"({core} core / {len(doc['terms']) - core} extended) -> {_TERMS.name}")
    print("NEXT: python -m scripts.check_independence")
    return 1 if failed else 0


# --- pass 3: prune ----------------------------------------------------------


def cmd_prune(args) -> int:
    """Retire terms by id, from both the skeleton and the corpus.

    The last step of the loop: skeleton -> content -> check_independence -> prune.
    check_independence compares name AND definition, so it catches same-card-twice
    pairs that the skeleton's name-only dedupe can't — "Conflict of Interest
    Recognition" vs "Recognizing Conflicts of Interest" are only 0.81 alike by name
    but say the same thing. Which twin to keep is a judgment about the better home
    for the concept, which is why this takes ids rather than deciding for you.

    Removing from the skeleton too is what makes it stick: leave it there and the
    next `content` run rebuilds the card. Ids are never reused.
    """
    ids = set(args.ids)
    skel = json.loads(_SKELETON.read_text(encoding="utf-8")) if _SKELETON.exists() else {"proposed": []}
    doc = json.loads(_TERMS.read_text(encoding="utf-8"))

    core = {t["id"] for t in doc["terms"] if t["tier"] == "core"} & ids
    if core:
        print(f"! refusing to prune graded terms (drop the criterion first): {sorted(core)}")
        return 1

    gone = [t["name"] for t in doc["terms"] if t["id"] in ids]
    missing = ids - {t["id"] for t in doc["terms"]}
    if missing:
        print(f"! not in the corpus: {sorted(missing)}")

    doc["terms"] = [t for t in doc["terms"] if t["id"] not in ids]
    skel["proposed"] = [p for p in skel.get("proposed", []) if p["id"] not in ids]

    _TERMS.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _SKELETON.write_text(json.dumps(skel, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name in gone:
        print(f"  - retired {name}")
    print(f"pruned {len(gone)} | {len(doc['terms'])} terms remain")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("skeleton", help="propose new term names (review by hand after)")
    s.add_argument("--domain", default="", help="only this domain_id")
    s.add_argument("--workers", type=int, default=4)
    s.add_argument("--force", action="store_true", help="re-propose even if present")
    s.set_defaults(fn=cmd_skeleton)

    c = sub.add_parser("content", help="write cards for the reviewed skeleton")
    c.add_argument("--limit", type=int, default=0, help="only generate this many (smoke test)")
    c.add_argument("--workers", type=int, default=8)
    c.add_argument("--force", action="store_true", help="regenerate even if present")
    c.set_defaults(fn=cmd_content)

    p = sub.add_parser("prune", help="retire terms by id (after check_independence)")
    p.add_argument("ids", nargs="+", help="term ids, e.g. T-0486 T-0162")
    p.set_defaults(fn=cmd_prune)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
