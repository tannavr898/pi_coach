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

## Maintenance

Keep this file current when criteria change. If a criterion is ever added or
reworded, re-apply the grain test and the independence test above before shipping
it, and note the change here so the audit trail stays honest.
