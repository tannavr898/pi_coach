"""Can a student who knows nothing about the topic still pick the right answer?

The validator in gen_quiz.py answers "is this question well formed". This answers
the harder one. Every signal below is a route to the right answer that does not go
through the material, which is the only thing that makes a quiz worth taking.

The dominant tell, by a wide margin, is ABSOLUTES. Writing distractors that
over-claim ("always", "never", "only ever", "automatically") while the key hedges
reads like careful writing and is the oldest giveaway in multiple choice: strike
the over-claimers and the key is the last one standing. A question built that way
measures test-taking, not business.

None of these is fatal on its own, so they are weighted and ranked rather than
used as a pass/fail gate. The line at REWRITE_AT is a judgement about where a
rewrite is worth the effort, not a claim that everything below it is fine.
"""

from __future__ import annotations

import re

from scripts._textsim import ratio, tokens

# Deliberately narrower than "words that sound strong". "must" and "all" are
# usually doing ordinary grammatical work ("what must a business do", "all future
# dealings") and flagging them buried the real cases. What is left is the set that
# genuinely over-claims: a student can strike these on tone alone.
# "guarantee" is deliberately absent: in this corpus it is almost always the
# ordinary noun (a delivery guarantee, a money-back guarantee) rather than an
# over-claim, and flagging it rejected correct questions about warranties.
ABSOLUTE = re.compile(
    r"\b(always|never|every|none|no one|nobody|cannot|impossible|"
    r"only|entirely|completely|automatically|regardless)\b",
    re.I,
)

STOPWORDS = set(
    """a an the and or of to in for on with is are was were be been it its that this those these
    as at by from into than then so if not no yes do does did has have had will would can could
    should what which who whom whose when where why how more most less least very just also
    about over under""".split()
)

# Where a rewrite earns its keep. Tuned against a read of the worst fifty: below
# this the tells are mostly incidental, above it they stack into a real shortcut.
REWRITE_AT = 3.0


def content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOPWORDS and len(w) > 3}


def signals(q: dict) -> dict[str, float]:
    """Per-question tells, each sized by how much of a shortcut it hands over."""
    key = next(o for o in q["options"] if o.get("correct"))
    others = [o for o in q["options"] if not o.get("correct")]
    out: dict[str, float] = {}

    # Over-claiming distractors against a hedging key.
    key_absolute = bool(ABSOLUTE.search(key["text"]))
    n_absolute = sum(1 for o in others if ABSOLUTE.search(o["text"]))
    out["absolutes"] = n_absolute if (n_absolute >= 2 and not key_absolute) else 0

    # Distinctive words the stem shares with the key and with nothing else.
    stem = content_words(q["question"])
    in_key = len(stem & content_words(key["text"]))
    in_best_other = max((len(stem & content_words(o["text"])) for o in others), default=0)
    out["clue_words"] = in_key - in_best_other if in_key > in_best_other else 0

    # Visibly longer, not proportionally longer. A ratio exaggerates on short
    # options (24 characters against 21 is 1.15 and looks identical), so this only
    # counts a key a skimming student could actually pick out by its length.
    key_len = len(key["text"])
    longest_other = max(len(o["text"]) for o in others)
    extra = key_len - longest_other
    out["long_key"] = round(key_len / longest_other, 2) if extra >= 12 else 0

    # Two distractors saying the same thing make a four-option question into three.
    out["twin_distractors"] = max(
        (ratio(tokens(a["text"]), tokens(b["text"]))
         for i, a in enumerate(others) for b in others[i + 1:]),
        default=0,
    )

    # A rationale that paraphrases its own option teaches nothing about the miss,
    # which is the whole reason the rationale ships with the question.
    out["echo_rationale"] = sum(
        1 for o in q["options"]
        if ratio(tokens(o["text"]), tokens(str(o.get("rationale", "")))) > 0.45
    )

    out["negative_stem"] = 1 if re.search(r"\b(not|except|least|never)\b", q["question"], re.I) else 0
    return out


def score(s: dict[str, float]) -> float:
    """Weighted so a single mild signal rarely clears the rewrite line alone."""
    return (
        2.0 * min(s["absolutes"], 3)
        + 1.5 * min(s["clue_words"], 3)
        + 30.0 * max(0.0, s["long_key"] - 1.10)
        + 4.0 * max(0.0, s["twin_distractors"] - 0.55)
        + 1.0 * s["echo_rationale"]
        + 0.5 * s["negative_stem"]
    )


def rank(questions: list[dict]) -> list[tuple[float, dict[str, float], dict]]:
    """Every question with its tells, worst first."""
    out = []
    for q in questions:
        s = signals(q)
        out.append((score(s), s, q))
    out.sort(key=lambda r: -r[0])
    return out


def report(questions: list[dict], *, show: int = 0, ids: bool = False) -> None:
    """Print the ranking. Called by `gen_quiz quality`."""
    ranked = rank(questions)
    tally: dict[str, int] = {}
    for _, s, _q in ranked:
        for name, value in s.items():
            if value:
                tally[name] = tally.get(name, 0) + 1

    n = len(questions)
    print(f"{n} questions probed")

    # How far above chance a student gets by picking on shape alone. Read the
    # second line, not the first: picking the longest option scores above chance
    # even when the margin is a character or two, which nobody can see. The
    # "visibly" line counts only the questions where the difference is readable,
    # and that is the number worth acting on.
    print()
    longest = sum(
        1 for q in questions
        if max(q["options"], key=lambda o: len(o["text"])).get("correct")
    )
    readable = 0
    for q in questions:
        key = next(o for o in q["options"] if o.get("correct"))
        other = max(len(o["text"]) for o in q["options"] if not o.get("correct"))
        if len(key["text"]) - other >= 12:
            readable += 1
    print(f"  pick the longest option          scores {100 * longest / n:>4.0f}%   (chance is 25%)")
    print(f"  ...where it is visibly longest   {readable:>5} questions  ({100 * readable / n:.0f}%)")

    print()
    print("  questions tripping each signal:")
    for name, hits in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"    {name:<18} {hits:>5}  ({100 * hits / n:.0f}%)")

    weak = [r for r in ranked if r[0] >= REWRITE_AT]
    print()
    print(f"  over the rewrite line ({REWRITE_AT:g}): {len(weak)}  ({100 * len(weak) / n:.0f}%)")

    if ids:
        print()
        print(" ".join(q["id"] for _, _, q in weak))

    for sc, s, q in ranked[:show]:
        tells = {k: v for k, v in s.items() if v}
        print()
        print(f"--- {q['id']} [{q['level']}] {q.get('domain_id', '')} score {sc:.1f} {tells}")
        print(f"  Q: {q['question']}")
        for o in q["options"]:
            mark = "*" if o.get("correct") else " "
            print(f"   {mark} {o['text']}")
