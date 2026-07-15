"""Independence audit: score our study corpus against DECA's PI list.

WHY THIS EXISTS
The framework's independence was originally established by a one-time manual
read-through (see app/data/framework-notes.md, "Independence audit"). Nothing
re-ran it. Tripling the corpus is exactly the moment that stops being good enough,
so this makes the audit repeatable.

THE ORDERING RULE — read this before changing anything here
The PI list is an AUDIT INPUT ONLY, never an authoring input. Terms are written
blind from business fundamentals (scripts/gen_terms.py never sees this file), and
this script checks the result afterwards. Wiring it into generation — even as a
"rewrite anything that matches" filter — would make the PI list a source, which is
precisely what framework-notes.md's two hard rules forbid. Audit after; never author
against.

WHAT COUNTS AS A PROBLEM
Not shared vocabulary. Two people writing about break-even analysis will both say
"fixed costs" — the concepts are public domain and overlap is expected and fine.
Copying shows up as shared PHRASING, so the signals are ranked accordingly:

  run     longest shared run of consecutive content words. The primary red flag:
          an 8-word shared run is not parallel invention.
  ratio   sequence similarity over the whole blob. Secondary — catches paraphrase.
  jaccard bag-of-words overlap. INFORMATIONAL ONLY. High jaccard on the same
          concept is expected and is not evidence of anything.

It also does two jobs that aren't about legality but are free here:
  - near-duplicate detection inside our own corpus (846 LLM-drafted terms across
    119 topics will collide with each other), and
  - a per-topic concentration report, which is the only automated look we get at
    grain collapse: if every term in one of our topics best-matches a distinct PI
    inside a single performance element, our topic has drifted into tracing their
    group, whatever the wording says.

OUTPUT
stdout stays safe to paste: our text, scores, and PI ids only. The full side-by-side
report contains PI text, so it is written into backend/reference/ — already
git-ignored and docker-ignored, so the licensed text cannot escape that directory.

Exits 0 when clean, 1 when anything trips a FAIL threshold, 2 when the reference
file is absent (it is git-ignored by design; CI and Docker have no copy).

Run:  python -m scripts.check_independence            (from the backend/ directory)
      python -m scripts.check_independence --top 40   (widen the review list)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app import terms as terms_mod
from scripts._textsim import jaccard as _jaccard
from scripts._textsim import longest_run as _longest_run
from scripts._textsim import ratio as _ratio
from scripts._textsim import tokens as _tokens

_REF = Path(__file__).resolve().parents[1] / "reference" / "pis-core-reference.json"
_REPORT = Path(__file__).resolve().parents[1] / "reference" / "independence-report.md"

# Hard fail — this is copied or near-copied text.
FAIL_RUN = 8
FAIL_RATIO = 0.60
# Worth a human look, not automatically wrong.
REVIEW_RUN = 6
REVIEW_RATIO = 0.45
# Within our own corpus: two terms this close are the same card twice.
DUPE_RATIO = 0.75
# Grain drift: concentration on one performance element only counts as a signal if
# our terms are also textually close to it. See _topic_report.
GRAIN_RATIO = 0.35


def _load_pis() -> list[dict]:
    """Flatten the reference to comparable records. PI text stays in memory and in
    the git-ignored report — it is never written anywhere the repo can see."""
    doc = json.loads(_REF.read_text(encoding="utf-8"))
    out: list[dict] = []
    for area in doc.get("instructional_areas", []):
        for pi in area.get("performance_indicators", []):
            blob = " ".join(filter(None, (pi.get("text", ""), pi.get("definition", ""))))
            toks = _tokens(blob)
            out.append({
                "id": pi.get("id", "?"),
                "area": area.get("name", "?"),
                "element": pi.get("performance_element", ""),
                "text": pi.get("text", ""),
                "definition": pi.get("definition", ""),
                "tokens": toks,
                "set": set(toks),
            })
    return out


def _score_pair(ours: dict, pi: dict) -> dict:
    ratio = _ratio(ours["tokens"], pi["tokens"])
    run = _longest_run(ours["tokens"], pi["tokens"])
    return {
        "pi": pi,
        "ratio": ratio,
        "run": run,
        "jaccard": _jaccard(ours["set"], pi["set"]),
        "flag": "FAIL" if (run >= FAIL_RUN or ratio >= FAIL_RATIO)
        else ("review" if (run >= REVIEW_RUN or ratio >= REVIEW_RATIO) else ""),
    }


def _best_match(ours: dict, pis: list[dict], prefilter: int) -> dict:
    """Cheap jaccard prefilter, then the expensive metrics on the top candidates.
    846 terms x ~1800 PIs is 1.5M pairs; SequenceMatcher on all of them is hours."""
    ranked = sorted(pis, key=lambda p: _jaccard(ours["set"], p["set"]), reverse=True)
    scored = [_score_pair(ours, p) for p in ranked[:prefilter]]
    return max(scored, key=lambda s: (s["run"], s["ratio"]))


def _check_dupes(ours: list[dict]) -> list[tuple[dict, dict, float]]:
    """Near-duplicates inside our own corpus (quality, not legality)."""
    hits: list[tuple[dict, dict, float]] = []
    for i, a in enumerate(ours):
        for b in ours[i + 1:]:
            if _jaccard(a["set"], b["set"]) < 0.5:  # prefilter
                continue
            r = _ratio(a["tokens"], b["tokens"])
            if r >= DUPE_RATIO:
                hits.append((a, b, r))
    return sorted(hits, key=lambda h: h[2], reverse=True)


def _topic_report(matched: list[dict]) -> list[str]:
    """Grain-collapse signal: a topic whose terms are BOTH concentrated inside one PI
    performance element AND textually close to it.

    Concentration on its own means nothing, and an earlier version of this that
    flagged on concentration alone was a pure false-positive generator: a topic
    called "Promotion" will obviously best-match promotion PIs, and "each onto a
    distinct PI" only says our own terms aren't duplicates of each other — which is
    the thing we want. Drift only bites when our terms also sit CLOSE to their group,
    which is the shape of having decomposed their list rather than the concept. So
    the textual floor below is what makes this signal mean anything.
    """
    by_topic: dict[tuple[str, str], list[dict]] = {}
    for m in matched:
        by_topic.setdefault((m["term"]["domain"], m["term"]["topic"]), []).append(m)

    lines: list[str] = []
    for (domain, topic), ms in sorted(by_topic.items()):
        if len(ms) < 3:
            continue
        elements: dict[str, int] = {}
        for m in ms:
            el = m["best"]["pi"]["element"] or "(none)"
            elements[el] = elements.get(el, 0) + 1
        _, n = max(elements.items(), key=lambda kv: kv[1])
        share = n / len(ms)
        distinct = len({m["best"]["pi"]["id"] for m in ms})
        mean_ratio = sum(m["best"]["ratio"] for m in ms) / len(ms)
        if share >= 0.6 and distinct == len(ms) and mean_ratio >= GRAIN_RATIO:
            lines.append(
                f"- **{domain} / {topic}** — {n}/{len(ms)} terms best-match inside one "
                f"performance element, each onto a distinct PI, mean ratio "
                f"{mean_ratio:.2f}. Re-apply the grain test."
            )
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=25, help="how many closest pairs to list")
    ap.add_argument("--prefilter", type=int, default=25, help="PI candidates scored per term")
    args = ap.parse_args()

    if not _REF.exists():
        print(f"No PI reference at {_REF} — nothing to audit against.")
        print("This file is git-ignored by design; it exists only on an authoring machine.")
        return 2

    pis = _load_pis()
    ours = [
        {
            "term": t,
            "tokens": _tokens(f"{t['name']}. {t.get('definition', '')}"),
            "set": set(_tokens(f"{t['name']}. {t.get('definition', '')}")),
        }
        for t in terms_mod.all_terms()
    ]
    print(f"auditing {len(ours)} terms against {len(pis)} performance indicators...", flush=True)

    matched = []
    for i, o in enumerate(ours):
        matched.append({"term": o["term"], "best": _best_match(o, pis, args.prefilter)})
        if (i + 1) % 100 == 0:
            print(f"  ... {i + 1}/{len(ours)}", flush=True)

    fails = [m for m in matched if m["best"]["flag"] == "FAIL"]
    reviews = [m for m in matched if m["best"]["flag"] == "review"]
    dupes = _check_dupes(ours)
    grain = _topic_report(matched)

    # stdout: safe to paste — our text, our scores, their ids only.
    print()
    print(f"FAIL   {len(fails)}   (run >= {FAIL_RUN} or ratio >= {FAIL_RATIO})")
    print(f"review {len(reviews)}   (run >= {REVIEW_RUN} or ratio >= {REVIEW_RATIO})")
    print(f"dupes  {len(dupes)}   (our own terms, ratio >= {DUPE_RATIO})")
    print(f"grain  {len(grain)}   (topics concentrated 1-to-1 on one performance element)")
    print()
    worst = sorted(matched, key=lambda m: (m["best"]["run"], m["best"]["ratio"]), reverse=True)
    print(f"closest {min(args.top, len(worst))} terms:")
    for m in worst[: args.top]:
        b = m["best"]
        print(f"  {b['flag'] or '·':6} run={b['run']:2}  ratio={b['ratio']:.2f}  "
              f"jac={b['jaccard']:.2f}  {m['term']['id']:8} {m['term']['name'][:44]:44} vs {b['pi']['id']}")

    # Full report (contains PI text) -> inside the git-ignored reference dir.
    lines = [
        "# Independence report",
        "",
        "Generated by `scripts/check_independence.py`. **Contains licensed DECA PI text —",
        "this file lives in backend/reference/ because that directory is git-ignored and",
        "docker-ignored. Do not move, paste, or commit it.**",
        "",
        f"- terms audited: {len(ours)}",
        f"- performance indicators: {len(pis)}",
        f"- FAIL: {len(fails)} · review: {len(reviews)} · dupes: {len(dupes)} · grain: {len(grain)}",
        "",
        "## Closest pairs",
        "",
    ]
    for m in worst[: max(args.top, 40)]:
        b, t = m["best"], m["term"]
        lines += [
            f"### {t['id']} — {t['name']}  ({b['flag'] or 'ok'}: run={b['run']}, ratio={b['ratio']:.2f})",
            f"- **ours:** {t.get('definition', '')}",
            f"- **theirs ({b['pi']['id']}, {b['pi']['area']}):** {b['pi']['text']} — {b['pi']['definition']}",
            "",
        ]
    if dupes:
        lines += ["## Near-duplicates in our own corpus", ""]
        for a, b, r in dupes[:40]:
            lines.append(f"- {r:.2f}  {a['term']['id']} *{a['term']['name']}*  ≈  {b['term']['id']} *{b['term']['name']}*")
        lines.append("")
    if grain:
        lines += ["## Grain-collapse candidates", "", *grain, ""]
    _REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nfull report -> {_REPORT} (git-ignored; contains PI text)")

    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
