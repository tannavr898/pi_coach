# PI Coach Evaluation Framework — author's notes

This document explains how `framework.json` was built, so the framework is
reviewable and its independence is auditable if a moderator, advisor, or MBA
Research ever asks how it was made.

## What this is (and what it deliberately is not)

`framework.json` is PI Coach's **own** evaluation framework. It is the layer the
app grades against and teaches from. It replaces the earlier approach of grading
against DECA's official performance indicators.

- **It IS:** a set of **282 coaching indicators** authored from general,
  public-domain business and marketing concepts — the material taught in any
  introductory business course. Our own criteria, our own wording, our own
  two-level structure (domain → topic → indicator), our own id scheme.
- **It is NOT:** DECA / MBA Research's curated performance-indicator list. It
  contains none of their PI text, none of their codes (e.g. `CRM:001`), none of
  their groupings, and none of their event-to-PI mapping.

### On using DECA's PI catalog as a reference

DECA's Business Administration Core PI list (licensed IP) was used as an
**authoring reference only** — a way to see the *breadth of topics* a real
competition spans (~1,800 indicators across 25 areas), so our framework doesn't
leave whole topic areas uncovered and the practice feels realistic. That is the
one and only way it was used: to check topic *coverage*, never as wording to copy
or paraphrase. Two hard rules keep this clean:

1. **No runtime dependency.** No code path reads the DECA PI list. It is a
   dev-time reference file, not part of the running product.
2. **No text reuse.** No PI text, code, performance-element header, or grouping
   from that file appears in `framework.json`. Every indicator is authored from
   the underlying public concept, in our own voice and structure.

To keep zero licensed IP in the deployed artifact, that reference file lives at
`backend/reference/pis-core-reference.json` — which is **git-ignored and
docker-ignored**, so it stays available locally for authoring but never enters
the repo or ships in the image. The framework does not depend on it.

## The event catalog (events.json)

Students pick the **event** they compete in before practicing. `events.json` is our
own catalog of those events. For each event we store its cluster, a blurb, original
focus suggestions, and a list of our framework `domain_ids`.

- **Event names are used descriptively**, so a student can pick what they compete in
  (the app is already, openly, DECA role-play practice and unaffiliated). We do not
  reproduce event *codes*, logos, or branding.
- **The event→domain mapping is ours, from general knowledge** — a marketing event
  exercises the Marketing domain, an HR event the Human Resources domain, and so on.
  It is the obvious mapping any business educator would make. It is **not** DECA's
  licensed event-to-performance-indicator blueprint: no PI text, no PI codes, and no
  "this event = these performance indicators" list appears anywhere. The mapping only
  decides which of *our* domains feed scenario generation.
- **Focus suggestions are original** practice prompts we wrote, not lifted from any
  published materials.

The same two hard rules apply here as to the PI reference: no runtime code reads
DECA's PI list to build this catalog, and no PI text is reproduced in it.

## The legal principle we authored under

There is a hard line between:

- **Public domain (free to use):** the underlying business *concepts* — customer
  relationship management, target markets, the promotional mix, break-even,
  channel strategy, opportunity cost, and so on. No one owns these.
- **Licensed (must not reproduce):** DECA / MBA Research's *specific curated
  list* — their exact PI wording, their codes, their groupings, and their map of
  which PIs belong to which event.

Every criterion was written from the public concept, in our own voice. The
sourcing rule was: **author from business fundamentals, never from DECA's PI
list.** If their document were the source, it would show; because business
fundamentals are the source, the framework is independent by construction.

## The domains (coverage)

Criteria are grouped under 13 standard business-field domains. These field names
are generic and industry-standard (they name whole disciplines taught
everywhere), not DECA's proprietary content:

Business Law · Communication · Customer Relations · Economics · Emotional
Intelligence · Entrepreneurship · Financial Analysis · Human Resources ·
Marketing · Information Management · Operations · Professional Development ·
Strategic Management.

Each domain is split into our own **topics**, and each topic holds several
indicators. Domain sizes range from **14** (Business Law) to **44** (Marketing,
which spans target market, research, the full marketing mix, selling, brand, and
metrics), for **282 indicators total** across **119 topics**. Sizes track how
much real competency space each field covers — Marketing (44), Operations (30),
Financial Analysis (24), and Emotional Intelligence (24) are the largest because
their territory is genuinely the largest — not any external count.

### Why this density

Earlier drafts used ~57 then ~154 criteria. Both were too thin for the goal: a
real competition spans well over a thousand indicators, and the practice should
*feel* like that — the kinds of ideas that come up in an actual role-play should
be present, so a student can't just memorize a short list. Expanding to 282
finer indicators means a role-play (which draws 4–6) surfaces genuine variety
across sessions and covers the real conceptual territory of each field, while
every indicator stays independently authored. The density approaches a real
role-play's; the wording, structure, grouping, and ids remain entirely ours.

## The study corpus (terms.json) — added after the framework

`framework.json` is what we **grade**. `terms.json` is what a student **studies**.
They were the same objects until the study library needed to be bigger than the
grading framework, and splitting them is what let the corpus grow without touching
scoring.

- **The framework stays at 282.** Scenario selection draws 4–6 from it and mastery
  math is tuned around it; none of that changed.
- **The corpus is 830 terms** — the 282 graded ones plus 548 study-only terms, each
  with a plain definition, a worked example through the four beats, and one common
  mistake.
- **`criterion_id`** links a term to its criterion when it has one. `tier` is
  **core** exactly when that link exists — so "core" means *a skill we actually grade
  you on*, which is what makes the Core study path a real promise rather than a
  progress bar. A test pins that invariant (`tests/test_independence.py`).
- **Ids:** the original 282 keep their `FW-*` id; study-only terms are `T-*`. Both
  are plainly ours and neither resembles a coded PI list.

The same two hard rules govern the corpus. Terms were authored **blind** from
business fundamentals: `scripts/gen_terms.py` never reads `backend/reference/`, and
it cannot — the similarity helpers it uses to dedupe its own output live in
`scripts/_textsim.py` precisely so the authoring path has no import route to the PI
list. Independence is checked **after** the fact (below). Author blind; audit after.

### Why not just make the framework bigger?

Tripling the *grading* framework would have been the easy version and the wrong one.
It would reshape scenario selection and mastery, and — more importantly — it would
have pushed the graded criteria toward the fine grain that is the actual legal risk
(see below). Keeping grading at 282 means the audited artifact stays the audited
artifact, and the growth happens in a layer that is straightforwardly a business
glossary.

### The depth award (grading touches the corpus, carefully)

Section 2 offers the grader ~16 study terms adjacent to the criteria being graded,
and pays a **bonus-only** 0/+0.25/+0.5 for genuinely applying one. This is the one
place study content touches scoring, so three things constrain it:

1. It lives in **Section 2 (application), never Section 1**, whose strong/weak bar is
   the anti-inflation mechanism.
2. It is **capped** by the existing `min(4, …)`, so vocabulary can never paper over
   weak analysis, and it is bonus-only — a plain correct answer loses nothing.
3. **Mention earns nothing.** The bonus is zeroed unless the model cites a quote we
   can find verbatim in the participant's own words (`main.py:_quoted`). That guard
   is code, not prompt wording.

None of this involves DECA's list: the offered vocabulary is our own terms, chosen by
our own topic adjacency.

## The grain (the most important design rule)

Indicators are authored at a **coachable, explainable grain**: each names *one
identifiable skill a student can practice*, sized so a student could explain it
inside a role-play's time. The grain test applied to every indicator was:
*"Can a student read this and know specifically what to work on?"* and
*"Could they demonstrate it in the time they'd have?"*

- "Customer Relationship Thinking" (FW-025) — passes (one coachable idea).
- "Marketing" — too broad; feedback would be useless. Rejected.
- "Explain the birthday-offer tactic" — too narrow; a fragment. Rejected.

Where a topic has real depth (e.g. Selling: prospecting, uncovering needs,
handling objections, closing), it gets several indicators so the coaching stays
specific — rather than one vague "selling" criterion. This grain protects the
app's best-validated feature: deep, specific feedback that shows students
problems they didn't know they had. Independence is carried by the wording,
structure, grouping, and id scheme being ours — not by making the grain
artificially broad.

## The shape of each criterion

```json
{
  "id": "FW-025",
  "domain_id": "customer_relations",
  "domain": "Customer Relations",
  "topic": "Relationships",
  "name": "Customer Relationship Thinking",
  "definition": "<a coaching QUESTION — the bar the response must clear>",
  "strong_looks_like": "<what a strong answer demonstrates>",
  "weak_looks_like": "<what a weak answer looks like>",
  "coaches": "<the one skill this trains, in a phrase>"
}
```

- `definition` is written as a **question**, not a directive. This is a
  structural choice that keeps us clearly distinct from DECA's PIs, which are
  imperative statements ("Explain the nature of…", "Describe methods used to…").
  A question also frames the criterion as a coaching lens rather than a syllabus
  item.
- `strong_looks_like` / `weak_looks_like` are the **anti-inflation bar.** The
  grader scores against these, not against whether a keyword appeared — a shallow
  answer that merely name-drops a concept is caught by the "weak" description.
  Keeping this bar sharp is a core product value.
- `definition` + `strong_looks_like` are what **Learn mode** surfaces to teach
  the student what "good" looks like before they attempt the role-play.

## The id scheme

Ids are `FW-001`…`FW-282`, sequential in domain order. This is intentionally a
plain, obviously-ours scheme with **no resemblance to DECA's coded list**
(`AREA:NNN`). Selection and grouping happen off the `domain_id` and `topic`
fields, so the ids themselves carry no structural meaning to protect — they can
stay stable as the framework is edited.

## How the rest of the app uses this file

The framework is stored as **data, not hardcoded**, so criteria can be edited or
reviewed without touching logic — and so the same framework can later travel to
other competitions (FBLA / BPA / interview prep), which is a real upside of
owning it.

- **Interpretation + selection:** a free-text practice request is interpreted to
  a domain (or domains) and an industry, then 4–6 relevant criteria are selected
  for the role-play. That selection logic is ours; it is not DECA's fixed
  "event = these areas" blueprint.
- **Generation:** the scenario generator is given the selected criteria and must
  write an original situation that genuinely requires each of them.
- **Scoring:** the grader references **only** these criteria, scores each against
  its `strong/weak_looks_like` bar, cites verbatim transcript evidence, and marks
  down shallow answers.

The criteria selected up front are the exact criteria scored against, so the
scenario always tests what it grades.

## Independence audit

After drafting, every criterion was re-read against the independence test:

> *"Could someone who studied general business/marketing textbooks but had never
> seen DECA's PI list have written this?"*

Checks performed:

1. **No PI text or codes.** No criterion reproduces or paraphrases a DECA PI
   statement; no DECA codes appear anywhere in the file.
2. **No 1-to-1 structure.** Criteria consolidate multiple concepts each; there is
   no criterion that maps to a single PI, and no domain that reproduces a DECA
   instructional area's PI ordering.
3. **Sourced from fundamentals.** Every `name`, `definition`, and quality bar is
   phrased from general business knowledge in our own voice, as a coaching
   question plus quality descriptions — a structure DECA's list does not use.
4. **Generic domain names only.** Domains are whole-discipline names (Marketing,
   Operations, …), which are industry-standard, not DECA's proprietary curation.

Result: no criterion was found to mirror a PI's phrasing, trace their list 1-to-1,
or read as sourced from their sheet. The framework stands on public business
fundamentals.

### The audit is now automated

The review above was a one-time human read-through, and nothing re-ran it. Tripling
the corpus is exactly the point where that stops being good enough, so it is now a
script: **`scripts/check_independence.py`**, plus `tests/test_independence.py`, which
skips when `backend/reference/` is absent (CI and Docker have no copy, by design) and
runs the real comparison on an authoring machine.

What it measures, and why shared vocabulary is not the signal:

- **`run`** — longest run of consecutive shared content words. The primary red flag:
  an 8-word shared run is not parallel invention. Fails at ≥ 8.
- **`ratio`** — sequence similarity across the whole text. Catches paraphrase.
  Fails at ≥ 0.60.
- **`jaccard`** — bag-of-words overlap. **Informational only.** Two people writing
  about break-even will both say "fixed costs"; the concepts are public domain and
  overlap there is expected, not evidence.

It also detects near-duplicates inside our own corpus and reports per-topic
concentration (the automated look at grain drift). The report contains PI text, so it
is written into `backend/reference/` — already git-ignored and docker-ignored.

**Result at 830 terms, audited against 1,806 performance indicators:**

| | |
|---|---|
| FAIL (run ≥ 8 or ratio ≥ 0.60) | **0** |
| review (run ≥ 6 or ratio ≥ 0.45) | 1 — cleared by hand¹ |
| near-duplicates in our own corpus | 0 (2 found and retired) |
| grain-drift topics | 0 |
| worst case anywhere | run = 4, ratio = 0.33 |

¹ *"Nonverbal Cues in Service Interactions" scored ratio 0.51 with `run = 2` — i.e.
zero shared phrasing. Both texts describe body language with the only vocabulary that
exists for it ("tone", "facial expressions"). Run is dispositive; the pair is clean.*

The two duplicates (`T-0486`, `T-0162`) were the same card written twice in different
domains, caught by comparing definitions rather than names, and retired with
`gen_terms prune`.

### The risk that actually matters: grain collapse

Not vocabulary. Business concepts are public domain and a study glossary is the most
defensible content in the app. The risk is **grain**: check #2 above rests on criteria
consolidating multiple concepts, and slicing finer to reach 3x pushes each term toward
mapping to exactly one PI — at which point the list reads as a re-derivation of their
curated list even with entirely original wording.

Three things hold that line, in order of importance:

1. **The grain test is enforced in the authoring prompt.** `gen_terms.py`'s skeleton
   prompt states it, and explicitly forbids producing terms by sub-dividing existing
   ones: new terms must be *siblings*, not fragments.
2. **Breadth over depth.** The expansion added 46 new topics (Taxation, International
   Law, Public Speaking, …) rather than only slicing existing ones finer. Covering
   more territory is safer than covering the same territory more finely.
3. **The per-topic report**, which flags a topic whose terms are both concentrated in
   one PI performance element *and* textually close to it.

## Maintenance

Keep this file current when criteria or terms change. If either is added or reworded,
re-apply the grain test and run `python -m scripts.check_independence` before shipping,
and note the change here so the audit trail stays honest.

The authoring loop is:

```
gen_terms skeleton  ->  review the names BY HAND  ->  gen_terms content
                    ->  check_independence  ->  gen_terms prune <ids>
```

The by-hand review is the step that matters and the one that shouldn't be automated
away: it is the cheapest place to catch grain and duplication, and it is where a human
decides whether a proposed term is a real sibling or a fragment.
