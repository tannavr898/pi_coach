"""Build script: write the multiple-choice quiz bank (quiz_bank.json) from the
study cards in terms.json.

Offline on purpose. /api/quiz is a file read, so every cost this script pays is
paid once, at build time, for all students: a slow prompt, a strict validator, and
a human review pass. Nothing here runs while a student waits.

ONE BATCH = one topic at one tier. Questions are generated per (domain, topic,
level) so the model sees a handful of genuinely related cards at once, which is
what makes icdc synthesis possible at all. A topic too small to field a synthesis
question borrows its nearest neighbours from the same domain rather than forcing a
pairing between concepts that do not interact.

WHAT THE VALIDATOR ENFORCES (scripts reject, they do not repair):
  - exactly four options, exactly one correct, a rationale on every option
  - concept count matches the tier: 1 for district/state, 2 or 3 for icdc
  - icdc items show their break test (synthesis_check naming 2+ concepts)
  - every concept resolves to a card in the batch, so a question can never be
    about material the student was not given
  - no "all/none of the above", no em or en dashes, no duplicate option text
  - the correct answer is not the giveaway longest option
  - the stem is not a near-duplicate of one already in the bank

Questions do not have to come from the API. `import` takes hand-authored batches
through the identical validator, dedupe and shuffle, so who wrote a question changes
nothing about the bar it has to clear.

ANSWER POSITION is fixed here, not asked for. The prompt asks the model to vary
which letter is correct, and models are bad at that in aggregate; the options are
shuffled and re-lettered on the way into the bank, so position tells a student
nothing no matter what the model did.

SOURCING, the rule that keeps this legal
Questions are written BLIND from our own study cards and general business
fundamentals. This script never reads backend/reference/, and must never be given
any competition organization's published item bank or indicator list, as a source
or as a checklist. See data/framework-notes.md and scripts/gen_terms.py.

Resumable: a (domain, topic, level) batch already in the bank is skipped, so a
re-run fills gaps only, and the bank is checkpointed to disk every few batches so
an interrupted run keeps everything it had already paid for. Ids are never reused.

Run:  python -m scripts.gen_quiz gen --limit 2            (smoke test, 2 batches)
      python -m scripts.gen_quiz gen --domain marketing
      python -m scripts.gen_quiz gen --level icdc --workers 6
      python -m scripts.gen_quiz import batches.json       (hand-authored, same checks)
      python -m scripts.gen_quiz audit                    (re-validate + report)
      python -m scripts.gen_quiz prune Q-0042             (retire a bad item)
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app import config, framework, llm, prompts, terms
from scripts import _quality
from scripts._textsim import ratio, tokens

_BANK = Path(__file__).resolve().parents[1] / "app" / "data" / "quiz_bank.json"

LEVELS = ("district", "state", "icdc")
# Cards shown per batch. Enough for the model to pick genuinely combinable pairs,
# small enough that every card still gets real attention inside one call.
_MAX_CARDS = 6
# A synthesis question needs concepts that interact, which needs a choice of them.
_MIN_ICDC_CARDS = 3
# Two stems this similar are the same question asked twice.
_DUPE_STEM_RATIO = 0.82
# The correct answer may not be BOTH the longest option and this much longer than
# the next longest: that combination is what lets a student pick by shape alone.
#
# A ratio ALONE is the wrong test and briefly had this at 1.05. On short options a
# ratio exaggerates: a 24 character key against a 21 character distractor is 1.15
# and visually identical, so the ratio flagged 421 questions of which almost none
# were actually readable as longer. The pair of thresholds below is the honest
# test, and by it the bank has one offender rather than 421.
_LENGTH_GIVEAWAY = 1.15
# ...and at least this many characters longer. Roughly half a line on a phone,
# which is the point a skimming student can see the difference without counting.
_LENGTH_GIVEAWAY_CHARS = 12

# Ceilings on the question itself. A student comparing four 130-character options
# is being tested on reading rather than on business, and the difference between
# the options is the thing that has to be visible. Set from the hand-authored half
# of the bank, where the 99th percentile option is 58 characters and the 99th
# percentile stem is 249: generous against that, and the generated half ran 17% of
# options and 31% of stems past it.
_MAX_OPTION_CHARS = 110
_MAX_STEM_CHARS = 280
# Being a few characters longer than the next option is noise. Past this the length
# is visible to a student skimming four lines, which is what the audit counts.
_VISIBLY_LONGER = 1.15
# How often a long run flushes the bank to disk, in completed batches.
_SAVE_EVERY = 10
# "All of the above" and friends, matched as PHRASES rather than substrings. The
# obvious `"a and b" in text` version rejects "the data and benchmarks", which is
# ordinary prose and exactly the kind of option this bank wants to keep.
_BANNED_OPTION = re.compile(
    r"\b(all|none|both) of (the )?(above|these)\b|\bboth [a-d] and [a-d]\b|^[a-d] and [a-d]$",
    re.IGNORECASE)
# Escapes, not literals: this file bans the characters it is naming.
_DASHES = ("\u2014", "\u2013")


# --- batches ----------------------------------------------------------------


def _groups() -> list[tuple[str, str, list[dict]]]:
    """Every (domain_id, topic) in corpus order, with its cards."""
    out: dict[tuple[str, str], list[dict]] = {}
    for t in terms.all_terms():
        out.setdefault((t["domain_id"], t["topic"]), []).append(t)
    return [(d, tp, cards) for (d, tp), cards in out.items()]


def _windows(cards: list[dict]) -> list[list[dict]]:
    """Split a topic's cards into batch-sized windows.

    A batch shows the model at most _MAX_CARDS cards, and for a long time it was
    simply the FIRST six: a nineteen-card topic like Marketing/Promotion could
    never be asked about its last thirteen, and 89 terms in the corpus had no
    question that could reach them. Windowing covers the whole topic instead, and
    a rich topic earns proportionally more questions, which is the right answer
    anyway.

    A trailing window of one is folded back into the previous one rather than left
    alone, because a single card cannot carry a batch and _MAX_CARDS + 1 is a
    harmless overshoot.
    """
    out = [cards[i : i + _MAX_CARDS] for i in range(0, len(cards), _MAX_CARDS)]
    if len(out) > 1 and len(out[-1]) == 1:
        # Pop first: the index on the left would otherwise resolve against the
        # already-shortened list.
        tail = out.pop()
        out[-1] = out[-1] + tail
    return out or [[]]


def _cards_for(domain_id: str, topic: str, cards: list[dict], level: str) -> list[dict]:
    """The cards one batch may build from, for a single window.

    For icdc a thin window borrows its nearest neighbours: the rest of the same
    domain, in corpus order (which is topic order, so "nearest" is literal). One
    card cannot produce synthesis on its own, and padding it beats skipping the
    topic entirely or, worse, letting the model invent a concept it was never
    given.
    """
    picked = list(cards[:_MAX_CARDS + 1])
    if level == "icdc" and len(picked) < _MIN_ICDC_CARDS:
        have = {c["id"] for c in picked}
        neighbours = [t for t in terms.terms_for_domains([domain_id]) if t["id"] not in have]
        picked += neighbours[: _MIN_ICDC_CARDS - len(picked)]
    return picked


def _batch_key(domain_id: str, topic: str, level: str, window: int = 0) -> str:
    # Window 0 keeps the un-suffixed key so every batch already in the bank still
    # counts as done and is not regenerated.
    suffix = f"|w{window}" if window else ""
    return f"{domain_id}|{topic}|{level}{suffix}"


# --- validation -------------------------------------------------------------


class Rejected(Exception):
    """A question that failed a hygiene rule. Carries the reason for the log."""


def _resolve_concepts(names: list[str], cards: list[dict]) -> list[str]:
    """Map the model's concept names back to term ids in THIS batch.

    Fuzzy, because a model that was shown "Break-even Thinking" will sometimes
    write "break-even analysis". Anything that matches nothing is a concept the
    student was never given, which is the one failure that makes a question
    indefensible rather than merely rough, so it rejects the item.
    """
    ids = []
    for name in names:
        want = tokens(str(name))
        best, best_score = None, 0.0
        for c in cards:
            score = ratio(want, tokens(c["name"]))
            if score > best_score:
                best, best_score = c, score
        if not best or best_score < 0.6:
            raise Rejected(f"concept not in the batch: {name!r}")
        ids.append(best["id"])
    return list(dict.fromkeys(ids))


def _validate(q: dict, level: str, cards: list[dict]) -> dict:
    """Check one raw question and return the bank row, or raise Rejected."""
    stem = str(q.get("question", "")).strip()
    if len(stem) < 15:
        raise Rejected("stem missing or too short")
    if len(stem) > _MAX_STEM_CHARS:
        raise Rejected(f"stem is {len(stem)} chars (max {_MAX_STEM_CHARS}); cut the scene, not the problem")

    opts = q.get("options") or []
    if len(opts) != 4:
        raise Rejected(f"{len(opts)} options (need 4)")
    texts = [str(o.get("text", "")).strip() for o in opts]
    if not all(texts):
        raise Rejected("an option has no text")
    overlong = [len(t) for t in texts if len(t) > _MAX_OPTION_CHARS]
    if overlong:
        raise Rejected(
            f"{len(overlong)} option(s) over {_MAX_OPTION_CHARS} chars (longest {max(overlong)}); "
            "the difference between the options has to be readable at a glance")
    if len({t.lower() for t in texts}) != 4:
        raise Rejected("duplicate option text")
    if any(_BANNED_OPTION.search(t) for t in texts):
        raise Rejected("all/none-of-the-above option")
    if not all(str(o.get("rationale", "")).strip() for o in opts):
        raise Rejected("an option has no rationale")

    correct = [i for i, o in enumerate(opts) if o.get("correct") is True]
    if len(correct) != 1:
        raise Rejected(f"{len(correct)} correct options (need exactly 1)")

    # Anti-gaming: the right answer must not be identifiable by shape alone.
    right = texts[correct[0]]
    others = sorted((len(t) for i, t in enumerate(texts) if i != correct[0]), reverse=True)
    if (len(right) > others[0] * _LENGTH_GIVEAWAY
            and len(right) - others[0] >= _LENGTH_GIVEAWAY_CHARS):
        raise Rejected(
            f"correct option is the giveaway longest "
            f"({len(right)} chars vs {others[0]})")

    # ...nor by tone. Distractors that over-claim ("always", "never", "only ever")
    # against a hedging key are the oldest giveaway in multiple choice: strike the
    # over-claimers and the key is the last one standing, which measures test
    # craft rather than business. A quarter of the questions from the first
    # generation run failed this way, so it is enforced rather than reported.
    wrong_texts = [t for i, t in enumerate(texts) if i != correct[0]]
    over_claiming = sum(1 for t in wrong_texts if _quality.ABSOLUTE.search(t))
    if over_claiming >= 2 and not _quality.ABSOLUTE.search(right):
        raise Rejected(
            f"{over_claiming} distractors over-claim while the key hedges "
            "(eliminate-the-absolutes gives the answer away)")

    blob = " ".join([stem, *texts, *(str(o.get("rationale", "")) for o in opts)])

    # The dash rule goes first: a dash is a style violation with its own fix, and
    # the catch-all below would otherwise swallow it behind a vaguer message.
    if any(d in blob for d in _DASHES):
        raise Rejected("em/en dash in the copy")

    # Student-facing copy is plain English. Anything well outside Latin script is a
    # typo that survived review: a stray CJK character once reached a rationale in a
    # hand written batch, and nothing before this would have stopped it shipping.
    stray = sorted({c for c in blob if ord(c) > 0x24F and c not in "‘’“”…"})
    if stray:
        raise Rejected(f"non-Latin characters in the copy: {''.join(stray)!r}")

    names = [str(n) for n in (q.get("concepts") or []) if str(n).strip()]
    if level == "icdc":
        if not 2 <= len(names) <= 3:
            raise Rejected(f"icdc names {len(names)} concepts (need 2-3)")
        check = str(q.get("synthesis_check", "")).strip()
        if len(check) < 20 or sum(1 for n in names if n.split()[0].lower() in check.lower()) < 2:
            raise Rejected("icdc break test missing or does not name its concepts")
    elif len(names) != 1:
        raise Rejected(f"{level} names {len(names)} concepts (need exactly 1)")

    term_ids = _resolve_concepts(names + [str(n) for n in (q.get("source_cards") or [])], cards)
    home = next((c for c in cards if c["id"] == term_ids[0]), cards[0])

    return {
        "level": level,
        "domain_id": home["domain_id"],
        "domain": home["domain"],
        "topic": home["topic"],
        "term_ids": term_ids,
        "concepts": names,
        "format": str(q.get("format", "")).strip()[:40],
        "question": stem,
        "options": [
            {
                "id": "",  # re-lettered after the shuffle below
                "text": texts[i],
                "correct": i == correct[0],
                "rationale": str(opts[i].get("rationale", "")).strip(),
            }
            for i in range(4)
        ],
        # Audit trail: reviewed by hand, never served to the client (app/quiz.py).
        "notes": {
            "difficulty_justification": str(q.get("difficulty_justification", "")).strip(),
            "synthesis_check": str(q.get("synthesis_check", "")).strip(),
            "review_flags": [str(f) for f in (q.get("review_flags") or []) if str(f).strip()],
        },
    }


def _shuffle_options(row: dict, rng: random.Random) -> dict:
    """Shuffle the options and re-letter them a-d. Position carries no signal."""
    opts = row["options"][:]
    rng.shuffle(opts)
    for letter, o in zip("abcd", opts):
        o["id"] = letter
    row["options"] = opts
    return row


# --- generation -------------------------------------------------------------


def _attempt(system: str, user: str, level: str, cards: list[dict]) -> tuple[list[dict], list[str]]:
    """One call: returns (validated rows, rejection reasons)."""
    data = llm.complete_json(system, user, model=config.SCENARIO_MODEL, max_tokens=4000)
    raw = data.get("questions") or []
    if not isinstance(raw, list):
        raise llm.LLMError("no questions array")
    kept, rejected = [], []
    for q in raw:
        try:
            kept.append(_validate(q, level, cards))
        except Rejected as e:
            rejected.append(str(e))
    return kept, rejected


def _gen_batch(domain_id: str, topic: str, cards: list[dict], level: str, count: int) -> list[dict]:
    """Generate one batch, with a single re-ask when the validator ate most of it.

    Worth the extra call: the rules the model actually trips over are mechanical
    (the right answer came out longest, a tier got the wrong concept count) and it
    fixes them reliably once told which one it broke. Without the re-ask a state or
    icdc batch can come back with nothing at all, and the spend is simply lost.
    Still a reject, never a repair: the model rewrites its own set, we never edit a
    question into passing.
    """
    system, user = prompts.build_quiz_prompt(cards, level, count)
    where = f"{domain_id}/{topic} [{level}]"
    kept, rejected = _attempt(system, user, level, cards)

    if rejected and len(kept) < len(rejected):
        reasons = "; ".join(sorted(set(rejected)))
        retry = (
            f"{user}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED. The validator threw out "
            f"{len(rejected)} of {len(kept) + len(rejected)} questions for: {reasons}.\n"
            "Write the set again from scratch, fixing exactly that. If the problem was "
            "option length, the fix is not a shorter correct answer alone: give the "
            "distractors the same weight of detail so all four read as plausible."
        )
        print(f"  ~ {where}: {len(rejected)} rejected ({reasons}), re-asking", flush=True)
        second, rejected_again = _attempt(system, retry, level, cards)
        if len(second) > len(kept):
            kept, rejected = second, rejected_again

    if rejected:
        print(f"  ~ {where}: dropped {len(rejected)} ({'; '.join(sorted(set(rejected))[:3])})", flush=True)
    if not kept:
        raise llm.LLMError(f"nothing survived validation for {where}")
    for row in kept:
        row["batch"] = _batch_key(domain_id, topic, level)
    return kept


def _load_bank() -> dict:
    if _BANK.exists():
        return json.loads(_BANK.read_text(encoding="utf-8"))
    return {"version": 1, "questions": []}


def _save_bank(doc: dict) -> None:
    dom_order = {d["id"]: i for i, d in enumerate(framework.domains())}
    lvl_order = {lvl: i for i, lvl in enumerate(LEVELS)}
    doc["questions"].sort(key=lambda q: (
        dom_order.get(q.get("domain_id", ""), 99),
        q.get("topic", ""),
        lvl_order.get(q.get("level", ""), 9),
        q["id"]))
    _BANK.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _is_dupe(stem: str, existing: list[list[str]]) -> bool:
    t = tokens(stem)
    return any(ratio(t, e) >= _DUPE_STEM_RATIO for e in existing)


def cmd_gen(args) -> int:
    doc = _load_bank()
    questions = doc["questions"]
    done_batches = {q.get("batch") for q in questions}
    next_id = 1 + max((int(q["id"].split("-")[1]) for q in questions), default=0)

    levels = [args.level] if args.level else list(LEVELS)
    todo = []
    for domain_id, topic, cards in _groups():
        if args.domain and domain_id != args.domain:
            continue
        for window, chunk in enumerate(_windows(cards)):
            for level in levels:
                key = _batch_key(domain_id, topic, level, window)
                if key in done_batches and not args.force:
                    continue
                batch_cards = _cards_for(domain_id, topic, chunk, level)
                if level == "icdc" and len(batch_cards) < 2:
                    print(f"  - skipped {domain_id}/{topic} w{window} [icdc]: too few cards")
                    continue
                todo.append((domain_id, topic, batch_cards, level))
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(questions)} questions in the bank | generating {len(todo)} batches "
          f"(up to {args.count} each) | {args.workers} workers", flush=True)
    if not todo:
        print("nothing to do (pass --force to regenerate)")
        return 0

    rng = random.Random(args.seed)
    seen_stems = [tokens(q["question"]) for q in questions]
    added = failed = dupes = 0
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_gen_batch, d, tp, cs, lv, args.count): (d, tp, lv)
                   for d, tp, cs, lv in todo}
        for fut in as_completed(futures):
            d, tp, lv = futures[fut]
            try:
                for row in fut.result():
                    if _is_dupe(row["question"], seen_stems):
                        dupes += 1
                        continue
                    row["id"] = f"Q-{next_id:04d}"
                    next_id += 1
                    questions.append(_shuffle_options(row, rng))
                    seen_stems.append(tokens(row["question"]))
                    added += 1
            except Exception as e:  # noqa: BLE001, log and continue; a re-run fills gaps
                failed += 1
                print(f"  ! {d}/{tp} [{lv}]: {e}", flush=True)
            done += 1
            # Checkpoint. A full bank is a ~40 minute run against a paid API, and
            # saving only at the end means anything that stops it mid-way (a dead
            # key, an exhausted balance, a closed laptop) throws away every batch
            # that had already succeeded and paid for itself. Writing every
            # _SAVE_EVERY batches costs one JSON dump per few model calls, which is
            # nothing next to what it protects, and the run stays resumable at
            # whatever point it died.
            if done % _SAVE_EVERY == 0:
                doc["questions"] = questions
                _save_bank(doc)
            if done % 25 == 0:
                print(f"  ... {done}/{len(todo)} batches | +{added} questions "
                      f"| {failed} failed", flush=True)

    doc["questions"] = questions
    _save_bank(doc)
    print(f"\ndone: +{added} questions ({dupes} near-duplicates dropped, {failed} batches failed)")
    print(f"{len(questions)} in the bank -> {_BANK.name}")
    print("NEXT: python -m scripts.gen_quiz audit")
    return 1 if failed else 0


# --- import -----------------------------------------------------------------


def _ingest(rows: list[dict], doc: dict, rng: random.Random) -> tuple[int, int]:
    """Merge validated rows into the bank. Returns (added, duplicates dropped)."""
    questions = doc["questions"]
    next_id = 1 + max((int(q["id"].split("-")[1]) for q in questions), default=0)
    seen = [tokens(q["question"]) for q in questions]
    added = dupes = 0
    for row in rows:
        if _is_dupe(row["question"], seen):
            dupes += 1
            continue
        row["id"] = f"Q-{next_id:04d}"
        next_id += 1
        questions.append(_shuffle_options(row, rng))
        seen.append(tokens(row["question"]))
        added += 1
    return added, dupes


def cmd_import(args) -> int:
    """Ingest hand-authored batches from a JSON file.

    The API is the unattended way to fill the bank, not the only legitimate one. A
    person (or a model working in a session, which is the same author by a different
    route) can write the questions directly, and they must clear exactly the same
    bar: this runs the identical validator, the identical dedupe, and the identical
    option shuffle. A question that skips those checks is worth less than no
    question, because it looks reviewed and isn't.

    File shape:
      {"batches": [
        {"domain_id": "marketing", "topic": "Target Market", "level": "state",
         "window": 0,
         "questions": [ <same object shape the model returns> ]}
      ]}

    `window` picks which slice of a long topic the batch draws on (see _windows);
    it defaults to 0, which is the first six cards and the only window most topics
    have.

    The cards a batch may draw on are resolved here from terms.json, exactly as
    generation resolves them, so a question naming a concept outside its own batch
    is rejected on import just as it would be on generation.
    """
    path = Path(args.file)
    if not path.exists():
        print(f"! no such file: {path}")
        return 1
    payload = json.loads(path.read_text(encoding="utf-8"))
    batches = payload.get("batches") or []
    if not batches:
        print("! nothing to import (expected a 'batches' array)")
        return 1

    groups = {(d, tp): cards for d, tp, cards in _groups()}
    doc = _load_bank()
    known = {q.get("batch") for q in doc["questions"]}
    kept: list[dict] = []
    rejected = skipped = 0

    for b in batches:
        domain_id, topic, level = b.get("domain_id", ""), b.get("topic", ""), b.get("level", "")
        where = f"{domain_id}/{topic} w{b.get('window', 0)} [{level}]"
        if level not in LEVELS:
            print(f"  ! {where}: unknown level")
            rejected += len(b.get("questions") or [])
            continue
        if (domain_id, topic) not in groups:
            print(f"  ! {where}: no such topic in terms.json")
            rejected += len(b.get("questions") or [])
            continue
        window = int(b.get("window", 0) or 0)
        windows = _windows(groups[(domain_id, topic)])
        if not 0 <= window < len(windows):
            print(f"  ! {where}: window {window} does not exist (topic has {len(windows)})")
            rejected += len(b.get("questions") or [])
            continue
        key = _batch_key(domain_id, topic, level, window)
        if key in known and not args.force:
            skipped += 1
            continue
        cards = _cards_for(domain_id, topic, windows[window], level)
        for q in b.get("questions") or []:
            try:
                row = _validate(q, level, cards)
            except Rejected as e:
                rejected += 1
                print(f"  ! {where}: {e}", flush=True)
                continue
            row["batch"] = key
            kept.append(row)

    added, dupes = _ingest(kept, doc, random.Random(args.seed))
    _save_bank(doc)
    print(f"\nimported {added} question(s) from {path.name} "
          f"({rejected} rejected, {dupes} near-duplicates, {skipped} batch(es) already present)")
    print(f"{len(doc['questions'])} in the bank -> {_BANK.name}")
    print("NEXT: python -m scripts.gen_quiz audit")
    return 1 if rejected else 0


# --- audit ------------------------------------------------------------------


def cmd_audit(args) -> int:
    """Re-validate the shipped bank and report what a reviewer should look at.

    Runs the same rules as generation, because a bank is edited by hand after it is
    written and a hand edit can break an invariant a generator guaranteed.
    """
    doc = _load_bank()
    questions = doc["questions"]
    if not questions:
        print(f"{_BANK.name} is empty, run `python -m scripts.gen_quiz gen` first.")
        return 1

    by_level: dict[str, int] = {}
    by_domain: dict[str, int] = {}
    positions: dict[str, int] = {}
    longest_is_correct = 0
    padded: list[str] = []
    flagged: list[tuple[str, list[str]]] = []
    broken: list[tuple[str, str]] = []
    unknown_terms: list[str] = []
    stems: list[tuple[str, list[str]]] = []
    dupes: list[tuple[str, str]] = []

    for q in questions:
        by_level[q["level"]] = by_level.get(q["level"], 0) + 1
        by_domain[q.get("domain", "?")] = by_domain.get(q.get("domain", "?"), 0) + 1
        correct = [o for o in q["options"] if o.get("correct")]
        if len(correct) != 1:
            broken.append((q["id"], f"{len(correct)} correct options"))
        else:
            positions[correct[0]["id"]] = positions.get(correct[0]["id"], 0) + 1
            lengths = sorted((len(o["text"]) for o in q["options"] if o is not correct[0]), reverse=True)
            if len(correct[0]["text"]) == max(len(o["text"]) for o in q["options"]):
                longest_is_correct += 1
                if lengths and len(correct[0]["text"]) > lengths[0] * _VISIBLY_LONGER:
                    padded.append(q["id"])
        if len(q["options"]) != 4:
            broken.append((q["id"], f"{len(q['options'])} options"))
        if any(not str(o.get("rationale", "")).strip() for o in q["options"]):
            broken.append((q["id"], "an option has no rationale"))
        if q["level"] == "icdc" and not str(q.get("notes", {}).get("synthesis_check", "")).strip():
            broken.append((q["id"], "icdc without a break test"))
        want_ids = q.get("term_ids") or []
        if len(terms.get_terms(want_ids)) != len(want_ids):
            unknown_terms.append(q["id"])
        flags = q.get("notes", {}).get("review_flags") or []
        if flags:
            flagged.append((q["id"], flags))
        t = tokens(q["question"])
        for other_id, other in stems:
            if ratio(t, other) >= _DUPE_STEM_RATIO:
                dupes.append((q["id"], other_id))
                break
        stems.append((q["id"], t))

    print(f"{len(questions)} questions in {_BANK.name}\n")
    print("  by level:  " + "  ".join(f"{lvl}={by_level.get(lvl, 0)}" for lvl in LEVELS))
    print("  answer position: " + "  ".join(f"{k}={positions.get(k, 0)}" for k in "abcd"))
    # Chance alone puts the longest option on the answer a quarter of the time. The
    # bare count drifts high and mostly harmlessly (a key that is four characters
    # longer than the next option is not a tell), so what is worth acting on is the
    # second number: keys long enough to see while skimming. Neither is visible to a
    # per-question rule, which is why the audit computes them over the whole bank.
    share = longest_is_correct / max(1, len(questions))
    print(f"  correct option is the longest: {longest_is_correct}/{len(questions)} "
          f"({share:.0%}, chance is 25%)")
    if padded:
        print(f"  visibly padded keys ({len(padded)}): {', '.join(padded[:10])}"
              "  <- consider pruning and regenerating")
    print(f"  domains covered: {len(by_domain)}/{len(framework.domains())}")
    thin = [d for d, n in sorted(by_domain.items(), key=lambda kv: kv[1]) if n < 5]
    if thin:
        print(f"  thin domains (<5 questions): {', '.join(thin[:8])}")

    if unknown_terms:
        print(f"\n! {len(unknown_terms)} question(s) point at term ids that no longer exist: "
              f"{', '.join(unknown_terms[:8])}")
    if dupes:
        print(f"\n! {len(dupes)} near-duplicate stem(s):")
        for a, b in dupes[:8]:
            print(f"  - {a} ~ {b}")
    if broken:
        print(f"\n! {len(broken)} question(s) violate a hygiene rule:")
        for qid, why in broken[:12]:
            print(f"  - {qid}: {why}")
    if flagged and args.flags:
        print(f"\n{len(flagged)} question(s) the generator flagged for review:")
        for qid, fl in flagged[: args.flags_limit]:
            print(f"  - {qid}: {'; '.join(fl)}")
    elif flagged:
        print(f"\n{len(flagged)} question(s) carry review flags (--flags to list them)")

    if broken or unknown_terms:
        print("\nprune the bad ones: python -m scripts.gen_quiz prune <id> [<id> ...]")
        return 1
    print("\nclean.")
    return 0


# --- prune ------------------------------------------------------------------


def cmd_prune(args) -> int:
    """Retire questions by id. Ids are never reused.

    "Already generated" is derived from the questions present, so pruning one of a
    batch's questions leaves that batch marked done, while pruning its last one
    re-opens it for the next `gen` run. That is the behavior you want in both
    cases: a rejected item stays rejected, and a topic left with nothing gets
    another attempt."""
    doc = _load_bank()
    ids = set(args.ids)
    gone = [q["id"] for q in doc["questions"] if q["id"] in ids]
    missing = ids - set(gone)
    if missing:
        print(f"! not in the bank: {sorted(missing)}")
    doc["questions"] = [q for q in doc["questions"] if q["id"] not in ids]
    _save_bank(doc)
    print(f"pruned {len(gone)} | {len(doc['questions'])} questions remain")
    return 0


def cmd_revise(args) -> int:
    """Replace the options of questions already in the bank, by id.

    Rewriting beats pruning: the stem, the concepts and the tier were fine on the
    questions this is aimed at, and only the options gave the answer away. Keeping
    the id also keeps any progress a student has already recorded against it.

    File shape, four options each, exactly as a batch file states them:
      {"revisions": [{"id": "Q-0235", "question": "<optional new stem>",
                      "options": [{"text": ..., "correct": ..., "rationale": ...}]}]}

    Every revision goes through the same validator as a new question, against that
    question's own batch cards, and is reshuffled so the rewrite does not park the
    answer in a predictable slot.
    """
    path = Path(args.file)
    if not path.exists():
        print(f"! no such file: {path}")
        return 1
    payload = json.loads(path.read_text(encoding="utf-8"))
    revisions = {r["id"]: r for r in payload.get("revisions") or []}
    if not revisions:
        print("! nothing to revise (expected a 'revisions' array)")
        return 1

    doc = _load_bank()
    groups = {(d, tp): cards for d, tp, cards in _groups()}
    rng = random.Random(args.seed)
    done = rejected = 0

    for i, q in enumerate(doc["questions"]):
        r = revisions.pop(q["id"], None)
        if r is None:
            continue
        # Resolve the same card window this question was written against, so a
        # rewrite cannot quietly wander outside its own batch.
        key = (q["domain_id"], q["topic"])
        window = 0
        batch = str(q.get("batch", ""))
        if batch.endswith(tuple(f"|w{n}" for n in range(1, 9))):
            window = int(batch.rsplit("|w", 1)[1])
        cards = _cards_for(q["domain_id"], q["topic"], _windows(groups[key])[window], q["level"])

        candidate = {
            "question": r.get("question", q["question"]),
            "options": r["options"],
            "concepts": q.get("concepts", []),
            "source_cards": q.get("concepts", []),
            "format": q.get("format", ""),
            "difficulty_justification": q.get("notes", {}).get("difficulty_justification", ""),
            "synthesis_check": q.get("notes", {}).get("synthesis_check", ""),
            "review_flags": [],
        }
        try:
            row = _validate(candidate, q["level"], cards)
        except Rejected as e:
            rejected += 1
            print(f"  ! {q['id']}: {e}")
            continue
        row["id"] = q["id"]
        row["batch"] = q.get("batch", "")
        row["notes"] = q.get("notes", {})
        doc["questions"][i] = _shuffle_options(row, rng)
        done += 1

    for missing in revisions:
        print(f"  ! {missing}: not in the bank")
        rejected += 1

    if done:
        _save_bank(doc)
    print(f"\nrevised {done} question(s) from {path.name} ({rejected} rejected)")
    return 1 if rejected else 0


def cmd_quality(args) -> int:
    """Rank the bank by how easily a test-wise student could beat it.

    Separate from `audit`, which asks whether a question is well formed. This asks
    whether it measures anything at all. The signals live in scripts/_quality.py.
    """
    questions = _load_bank()["questions"]
    if not questions:
        print(f"{_BANK.name} is empty.")
        return 1
    _quality.report(questions, show=args.list, ids=args.ids)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gen", help="generate questions into the bank")
    g.add_argument("--domain", default="", help="only this domain_id")
    g.add_argument("--level", default="", choices=[*LEVELS, ""], help="only this tier")
    g.add_argument("--count", type=int, default=3, help="questions per batch (a ceiling)")
    g.add_argument("--limit", type=int, default=0, help="only this many batches (smoke test)")
    g.add_argument("--workers", type=int, default=4)
    g.add_argument("--seed", type=int, default=0, help="option-shuffle seed (reproducible runs)")
    g.add_argument("--force", action="store_true", help="regenerate batches already in the bank")
    g.set_defaults(fn=cmd_gen)

    i = sub.add_parser("import", help="ingest hand-authored batches from a JSON file")
    i.add_argument("file", help="path to the batches file")
    i.add_argument("--seed", type=int, default=0, help="option-shuffle seed")
    i.add_argument("--force", action="store_true", help="import even if the batch already exists")
    i.set_defaults(fn=cmd_import)

    a = sub.add_parser("audit", help="re-validate the bank and report")
    a.add_argument("--flags", action="store_true", help="list the generator's review flags")
    a.add_argument("--flags-limit", type=int, default=30)
    a.set_defaults(fn=cmd_audit)

    rv = sub.add_parser("revise", help="replace the options of questions already in the bank")
    rv.add_argument("file", help="path to the revisions file")
    rv.add_argument("--seed", type=int, default=0, help="option-shuffle seed")
    rv.set_defaults(fn=cmd_revise)

    qa = sub.add_parser("quality", help="rank questions a test-wise student could beat")
    qa.add_argument("--list", type=int, default=0, help="print the N worst in full")
    qa.add_argument("--ids", action="store_true", help="print ids over the rewrite line")
    qa.set_defaults(fn=cmd_quality)

    p = sub.add_parser("prune", help="retire questions by id")
    p.add_argument("ids", nargs="+", help="question ids, e.g. Q-0042")
    p.set_defaults(fn=cmd_prune)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
