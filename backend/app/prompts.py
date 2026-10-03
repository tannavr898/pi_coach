"""Prompt construction, this *is* the product.

Five prompts, each returning a (system, user) pair and asking for JSON we parse
defensively:

1. Interpretation, read the user's free-text practice request and map it to our
   business domains + an industry/context (and catch out-of-scope input).
2. Scenario generation, pick the framework criteria that fit the topic and write
   an ORIGINAL role-play that naturally requires all of them.
3. Scoring, grade the response against those exact criteria, using each
   criterion's strong/weak bar so scoring stays honest, not keyword-inflated.
4. Mastery Blitz, one batched "used correctly in context?" pass over a drill.
5. Quiz bank, original multiple-choice items written from the study cards. The
   only one that never runs in a request: questions are generated offline by
   scripts/gen_quiz.py and shipped as data/quiz_bank.json.

Guardrails baked in: original clean-room scenarios (never any real organization's
branding, codes, or copyright), and feedback labelled practice coaching, never an
official or predicted competition score. The judge's follow-up questions are
generated for grading and are the only judge-side text ever returned to the
client; nothing addressed to the judge appears in the participant situation.

Everything here references OUR framework (framework.json) only. No DECA
performance-indicator text, codes, or event-to-PI mapping appears in any prompt.
"""

from __future__ import annotations

import random

from . import rubric

# Names the model reaches for by default, banning them forces genuine variety so
# every session doesn't feature "Crestline" run by "Dana".
_OVERUSED_NAMES = (
    "Crestline, Summit, Apex, Evergreen, Ridgeline, BrightPath, BrightBean, FreshBlend, "
    "Peak, Pinnacle, Horizon, Vertex, Stellar, Nova, Dana, Alex, Sarah, Maria, Sam, Jordan"
)
# Company-name starting letters to seed from (skips ones that bias toward the
# overused set above).
_INITIALS = "ABCDEFGHIJKLMNOQRTUVWYZ"


# Sector nudges so no-industry runs don't all land on the same default (coffee
# shops, candle makers, boutiques). Only a hint, a stated industry always wins.
_SECTORS = (
    "auto repair, landscaping, a dental practice, a moving company, a craft brewery, "
    "a pet daycare, a solar installer, a food truck, a bookstore, a fitness studio, "
    "a print shop, a medical clinic, a farmers' co-op, a bike shop, a catering company, "
    "a tutoring center, a hardware store, an event venue, a trucking firm, a plant nursery"
)


def _variety_block() -> str:
    """A per-call randomized nudge that breaks the model's default name/setting
    attractor, so companies, people, places, AND industries vary between sessions."""
    inits = ", ".join(random.sample(_INITIALS, 3))
    sectors = ", ".join(random.sample(_SECTORS.split(", "), 4))
    seed = random.randint(1000, 9999)
    return (
        f"VARIETY (seed {seed}): invent a fresh, specific company name and character "
        f"name(s) for THIS scenario. Do NOT reuse these overused defaults: "
        f"{_OVERUSED_NAMES}. Try a company name starting with one of: {inits}. Vary the "
        f"setting (region, company size, and the character's name/background) from a "
        f"generic default. If no specific industry is required by the topic, pick an "
        f"UNEXPECTED one rather than the obvious default, e.g. {sectors}, so sessions "
        f"don't all feel the same.\n"
    )


# Level-scaled length/complexity. Shorter and more concrete at the entry tier;
# more stakeholders, constraints, and ambiguity as it goes up.
_LEVEL_GUIDE = {
    "district": "120-170 words. One clear ask, a single stakeholder, concrete and approachable.",
    "state": "170-240 words. A bit more nuance, a constraint or trade-off to weigh.",
    "icdc": "240-330 words. More complex: competing priorities or multiple stakeholders, still solvable in the time.",
}


# House style for every model-written string a student can read. Em dashes are
# banned outright: they're the tell that gives away machine-written copy, and no
# amount of cleaning the data files matters if the grader reinstates them in the
# feedback it writes on every run. Kept as one constant so the rule can't drift
# between prompts.
_STYLE_RULE = (
    "STYLE: never use an em dash or an en dash in any text you write. Use a "
    "comma, a colon, or start a new sentence instead. Plain, spoken, student-facing "
    "English.\n\n"
)


# ---------------------------------------------------------------------------
# 1. Interpret the free-text request
# ---------------------------------------------------------------------------

INTERPRET_SYSTEM = (
    "You interpret a student's free-text request for a business role-play "
    "practice session and map it onto a fixed list of business domains. You are "
    "precise and permissive: almost any business, marketing, management, finance, "
    "or entrepreneurship topic is in scope. Only genuinely non-business requests "
    "(e.g. 'write me a poem', 'help with my chemistry homework') are out of scope.\n\n"
    "Return ONLY a single JSON object (no markdown, no code fences, no commentary)."
)


def build_interpretation_prompt(request: str, domains: list[dict]) -> tuple[str, str]:
    """Map a free-text request to domains + an industry/context."""
    domain_lines = "\n".join(f"- {d['id']}: {d['name']}, {d['blurb']}" for d in domains)
    user = f"""The student typed this practice request:
"{request.strip()}"

BUSINESS DOMAINS (choose from these ids only):
{domain_lines}

Decide what the student wants to practice and return a JSON object with EXACTLY these keys:
{{
  "in_scope": true or false,   // false ONLY if this is not a business/management/marketing/finance topic at all
  "redirect_message": "If out of scope, one friendly sentence steering them to a business topic (e.g. 'Try something like \\"marketing for a coffee shop\\" or \\"a staffing problem in retail.\\"'). Empty string if in scope.",
  "topic": "A short, specific restatement of the business challenge to practice (your words).",
  "industry": "The industry/context in a couple of words (e.g. 'food service', 'retail', 'tech startup', 'healthcare'). Use 'general business' if none is implied.",
  "domain_ids": ["1-3 domain ids from the list above that best fit the request, most relevant first"]
}}

If the request is vague (e.g. just 'marketing' or 'business'), still pick a sensible, coherent set of domains and a reasonable default industry, never refuse a vague-but-business request. Output ONLY the JSON."""
    return INTERPRET_SYSTEM, user


# ---------------------------------------------------------------------------
# 2. Scenario generation (selects criteria + writes the role-play)
# ---------------------------------------------------------------------------

SCENARIO_SYSTEM = (
    "You are an expert business role-play author who has written and judged "
    "hundreds of practice events. You write ORIGINAL practice scenarios in the "
    "style of a competitive business role-play. You never copy published "
    "scenarios and never reproduce any real organization's branding, event "
    "codes, copyright lines, or logos. These are original practice materials.\n\n"
    "You are given a set of evaluation criteria (our own framework) and must (a) "
    "choose the ones that genuinely fit the requested topic and can all be "
    "demonstrated together in a single ~10-minute role-play, and (b) write a "
    "scenario whose task naturally requires every criterion you chose, woven "
    "into one coherent business situation, never as a visible checklist.\n\n"
    f"{_STYLE_RULE}"
    "Return ONLY a single JSON object (no markdown, no code fences, no commentary)."
)


def _format_candidates(criteria: list[dict]) -> str:
    lines: list[str] = []
    for c in criteria:
        lines.append(f"- {c['id']} [{c['domain']} · {c['topic']}] {c['name']}: {c['definition']}")
    return "\n".join(lines)


# How each sampled dimension is phrased as a fixed build parameter. Rendered in
# this order; any dimension the event opted out of is simply skipped.
_PARAM_LINES = [
    ("subtopic", "Focus of the challenge: {}"),
    ("business_type", "The business or setting: {}"),
    ("company_size", "Its scale: {}"),
    ("stakeholder", "The participant presents to: {}"),
    ("problem", "The core problem to solve: {}"),
    ("constraint", "A constraint that must shape the solution: {}"),
]


def _params_block(params: dict[str, str]) -> str:
    """Phase 3: the sampled taxonomy combination, stated as FIXED build parameters.
    The model executes on this specific setup rather than inventing its own, which
    is what actually breaks the repetition (telling it to 'be creative' does not)."""
    lines = [f"- {tmpl.format(params[d])}" for d, tmpl in _PARAM_LINES if params.get(d)]
    # `company_size` is present for every business scenario and dropped only for
    # person-centered ones (e.g. personal finance), where "invent a company" is wrong.
    if params.get("company_size"):
        name_line = (
            "Invent a specific, fresh company name and character name(s) that fit these "
            f"parameters (avoid overused defaults like {_OVERUSED_NAMES})."
        )
    else:
        name_line = (
            "Invent specific, fresh names for the people involved (and any business they "
            f"work at) so it feels real; avoid overused defaults like {_OVERUSED_NAMES}."
        )
    return (
        "SCENARIO PARAMETERS, build the role-play around EXACTLY these. Do not swap, "
        "generalize, or ignore any of them; they are the point of this scenario:\n"
        + "\n".join(lines)
        + "\n" + name_line + " Make the setting, stakeholder, problem, and constraint "
        "all visibly matter in the situation, not just decoration.\n\n"
    )


def build_scenario_prompt(
    topic: str,
    industry: str,
    level: str,
    candidates: list[dict],
    event: dict | None = None,
    params: dict[str, str] | None = None,
) -> tuple[str, str]:
    """Build the (system, user) messages: select 4-6 criteria, write the scenario,
    and write the one-line share-card `hook`.

    When `params` (a sampled taxonomy combination) is given, the scenario is pinned
    to that specific setup via a fixed-parameters block; otherwise we fall back to
    the free-form variety nudge (`_variety_block`)."""
    guide = _LEVEL_GUIDE.get(level, _LEVEL_GUIDE["district"])
    industry_line = industry.strip() or "not specified, choose one that fits the event and topic"
    event_line = ""
    quant_line = ""
    if event is not None:
        kind = {"team": "a two-person team presents", "principles": "an introductory-level single participant", "individual": "a single participant"}.get(event.get("kind", ""), "a single participant")
        window = "~15-minute" if event.get("kind") == "team" else "~10-minute"
        event_line = (
            f"EVENT: {event['name']} ({kind}). Set the scenario in a business and role that "
            f"fits this event's world; keep the challenge solvable in one {window} role-play.\n"
        )
        if event.get("quantitative"):
            quant_line = (
                "QUANTITATIVE EVENT: give the participant the raw numbers they need to work with "
                "(prices, costs, units, rates, balances, dates) as clear inputs, and ask them to "
                "compute/interpret the result themselves. Do NOT state any DERIVED figure (margin, "
                "break-even, ROI, totals, ratios) as a fact in the situation, that is the "
                "participant's work to show. Make sure the raw inputs you give are internally "
                "consistent and realistic.\n"
            )
    variety = _params_block(params) if params else _variety_block()
    user = f"""{event_line}{quant_line}{variety}REQUESTED TOPIC: {topic}
INDUSTRY / CONTEXT: {industry_line}
COMPLEXITY: {level}   ({guide})

CANDIDATE EVALUATION CRITERIA (choose from these ids only):
{_format_candidates(candidates)}

STEP 1, SELECT the criteria to assess. Pick a coherent set of EXACTLY 4 criteria
from the list above that are genuinely relevant to the topic AND can all be
demonstrated together in one role-play. Prefer a focused, complementary set over a
scattered one. Use ONLY ids from the list. Return exactly 4 ids, no more, no fewer.

STEP 2, WRITE an original role-play whose task naturally gives the participant a
reason to demonstrate EVERY criterion you selected. The participant takes a
specific role at a specific, realistic (invented) company in the stated industry
and must work through a concrete business situation that calls for a solution.
Keep it grounded and current; no placeholder names; invent specific, believable
details. Give the task enough SUBSTANCE to fill the full presentation window: weave
in 2-3 concrete angles a strong answer must address (e.g. a specific constraint or
budget, a second stakeholder's concern, a tradeoff between two options, or a couple
of realistic data points), so there is genuinely enough to talk through, not a
one-line problem.

Return a JSON object with EXACTLY these keys:
{{
  "criteria_ids": ["the EXACTLY 4 ids you selected in step 1"],
  "situation": "The participant-facing situation ONLY. {guide} OPEN by establishing,
     in the first sentence or two, the participant's specific role AND a one-line
     description of the company (its name and what it does) so the participant has
     the context to reason about, never reference company facts you didn't state
     here. Then give the specific challenge/decision and note they will meet a judge
     who plays a named counterpart and will ask follow-up questions. Plain prose,
     2-3 short paragraphs. Do NOT include the criteria list, procedures, or anything
     addressed to the judge.",
  "hook": "A single punchy CHALLENGE framing of this scenario. HARD LIMIT 20 words,
     aim for 12-16. Count them before you answer. Present tense, third person, about
     the BUSINESS, never the participant. Name the company and ONE concrete pressure:
     a single number or stake, NOT a list of them. Leaving detail out is the whole
     point, this is bait on a share card, it must make a stranger want to attempt
     this role-play, not brief them on it. Do NOT describe the participant's role or
     task, do NOT use 'you', do NOT ask a question, do NOT trail off. One sentence,
     one clause of tension, ending in a period.
     GOOD (17 words): 'A regional coffee chain just lost 18% of its foot traffic to a
     new competitor three blocks away.'
     TOO LONG, never do this (26 words, three separate figures): 'Ironveil Bindery
     has $9,200 in the bank, $19,400 due in eight days, and $22,000 locked in a
     receivable that will not arrive for 38 more days.'",
  "followup_questions": ["Two questions the judge asks AFTER the presentation.
     Ground them in THIS scenario and the selected criteria (a trade-off, a risk,
     how they'd measure success, an alternative they should have weighed). CRITICAL:
     these are written before the participant speaks, so you do NOT know what they
     said, NEVER reference, quote, paraphrase, or assume anything the participant
     said. Forbidden openers: 'You mentioned', 'You said', 'Earlier you', 'As you
     noted', 'Since you suggested'. Ask about the situation itself, not their answer.",
     "second question"]
}}

CRITICAL: never put judge instructions, judge characterization, or answers inside
"situation", that text is shown to the participant. Output ONLY the JSON."""
    return SCENARIO_SYSTEM, user


# ---------------------------------------------------------------------------
# 3. Scoring against the selected framework criteria
# ---------------------------------------------------------------------------

SCORING_SYSTEM = (
    "You are an experienced, fair judge and coach grading a business role-play "
    "practice response. You grade against a weighted rubric with three sections: "
    "(1) the participant's UNDERSTANDING and EXPLANATION of each evaluation "
    "criterion, (2) how well they APPLY business thinking to solve the scenario, "
    "and (3) their professional presentation.\n\n"
    "GLOBAL GRADING RULES (apply to every score):\n"
    "- Default to the MIDDLE of every scale. Move up only with specific evidence; "
    "move down when evidence is missing, vague, or wrong.\n"
    "- Cite the exact phrase from the transcript that justifies each score. If no "
    "phrase supports a score, that score cannot be high and its evidence must be null.\n"
    "- Do not reward length, effort, or enthusiasm by themselves. A short, correct "
    "answer beats a long, padded one.\n"
    "- Never invent content the participant did not say. If something the rubric "
    "requires is absent, say so and score accordingly.\n\n"
    "Be specific and honest; cite verbatim quotes as evidence; never inflate; never "
    "invent criteria beyond the ones given.\n\n"
    f"{_STYLE_RULE}"
    "Return ONLY a single JSON object (no markdown, no code fences, no commentary)."
)


def _levels_brief() -> str:
    ld = rubric.level_descriptions()
    mx = rubric.criterion_max()
    return f"""LEVELS (pick ONE per criterion, then a score inside its 0-{mx} band):
- Novice (0-3), {ld['novice']}
- Developing (4-6), {ld['developing']}
- Proficient (7-8), {ld['proficient']}
- Exemplary (9-10), {ld['exemplary']}"""


def _criteria_block(criteria: list[dict]) -> str:
    out: list[str] = []
    for c in criteria:
        out.append(
            f"- {c['id']}, {c['name']} ({c['domain']} · {c['topic']})\n"
            f"    what it asks: {c['definition']}\n"
            f"    strong looks like: {c['strong_looks_like']}\n"
            f"    weak looks like: {c['weak_looks_like']}"
        )
    return "\n".join(out)


_MATH_BLOCK = """
THIS IS A QUANTITATIVE EVENT, DO NOT DO ARITHMETIC IN YOUR HEAD. List the KEY
quantities the participant was expected to calculate (margin, break-even, ROI,
totals, ratios, interest, price changes, etc.) in "math_checks". Follow these rules
EXACTLY so the checks are clean and never contradict each other:

1. ONE check per distinct quantity. Never produce two versions of the same quantity.
2. ALWAYS build "expression" from the CORRECT input values given in the scenario,
   never from a number the participant got wrong. The expression is the right way to
   compute it; "claimed" is what the participant actually said.
3. If the participant used a wrong input or made an error, you still write the
   expression with the correct inputs and put their final answer in "claimed", the
   check will then show the mismatch. Do NOT add a separate "using their wrong number"
   check, and do NOT cascade an error into later expressions (later expressions still
   use correct inputs).
4. Keep it to the ~4-6 quantities that actually matter. Do not invent extra
   calculations the scenario didn't call for.
5. Use ONLY numbers and + - * / % ** and parentheses in "expression" (no words, no
   units, no $ or ,: write 50000, not $50,000).

Our backend evaluates each expression; that result, NOT your mental math, is
authoritative and is what feedback shows. In your written feedback, defer to these
checks: don't call a calculation wrong unless its check shows a mismatch.
Each entry: {"label": "gross margin %", "expression": "(50000-30000)/50000*100", "claimed": 40, "unit": "%"}.
Omit "claimed" only if the participant clearly should have computed it but didn't.
"""


def _delivery_block(spoken: bool, delivery_score: int | None) -> str:
    """Context for Section 3. Spoken runs get the deterministic delivery score
    (pace/fillers/pauses/timing already measured) so the model doesn't guess at
    what it can't hear; typed runs are told to judge written structure instead."""
    if spoken and delivery_score is not None:
        return (
            f"DELIVERY_METRICS: this response was SPOKEN. Our system already measured "
            f"objective delivery (pace, filler words, pauses, timing) as a deterministic "
            f"score of {delivery_score}/100, you do NOT need to re-estimate pace or "
            f"fillers. For the presentation score, focus on what the transcript reveals "
            f"that raw metrics can't: whether the delivery reads as conversational and "
            f"adaptive versus stiff or memorized, and the quality of the answer to the "
            f"judge's follow-up. The backend blends your read with the {delivery_score}/100 "
            f"metric, so grade the human side."
        )
    return (
        "DELIVERY_METRICS: this response was TYPED, so there is no audio. Base the "
        "presentation score on the clarity, structure, and professionalism of the "
        "WRITTEN response and, above all, the quality of the answer to the judge's "
        "follow-up question. Do not penalize the absence of vocal delivery."
    )


def _depth_block(vocab: list[dict]) -> str:
    """The optional depth vocabulary: related study terms the scenario did NOT
    require, offered so a competitor who brings one in and uses it well can be
    rewarded for it. Empty string when there's nothing to offer."""
    if not vocab:
        return ""
    lines = "\n".join(f"- {t['id']}, {t['name']}: {t['definition']}" for t in vocab)
    return f"""
DEPTH VOCABULARY, related business terms this role-play does NOT require and does
NOT grade. They exist ONLY so that a competitor who brings one in AND genuinely
applies it can be credited in Section 2's "depth" bonus:
{lines}
"""


def build_scoring_prompt(
    scenario: str,
    criteria: list[dict],
    response: str,
    followup_questions: list[str],
    followup_answer: str,
    quantitative: bool = False,
    spoken: bool = False,
    delivery_score: int | None = None,
    depth_vocab: list[dict] | None = None,
) -> tuple[str, str]:
    """Build the (system, user) messages for the weighted 3-section scoring."""
    fq = "\n".join(f"- {q}" for q in followup_questions) or "(none)"
    depth_block = _depth_block(depth_vocab or [])
    math_instructions = _MATH_BLOCK if quantitative else ""
    math_key = '\n  "math_checks": [{"label": "...", "expression": "...", "claimed": <number or omit>, "unit": "..."}],' if quantitative else ""
    user = f"""{_levels_brief()}
{math_instructions}

THE EVALUATION CRITERIA (the "performance indicators") for this role-play, grade
against these and ONLY these:
{_criteria_block(criteria)}
{depth_block}
BUSINESS SITUATION the participant responded to:
{scenario}

PARTICIPANT'S MAIN RESPONSE (transcript):
{response}

JUDGE'S FOLLOW-UP QUESTIONS:
{fq}

PARTICIPANT'S ANSWER TO THE FOLLOW-UP:
{followup_answer or "(the participant did not answer)"}

{_delivery_block(spoken, delivery_score)}

================================================================================
SECTION 1, PERFORMANCE INDICATORS (understanding & explanation)
Grade ONLY the participant's UNDERSTANDING and EXPLANATION of each criterion, how
well they DEFINE and EXPLAIN it, with a slight boost for CONNECTING it and going
ABOVE AND BEYOND. Do NOT grade how well they APPLIED it to the scenario here, that
is scored entirely in Section 2. A participant who explains a criterion perfectly
but applies it poorly should score HIGH here and LOW in Section 2. This separation
is a hard rule; do not let application leak into this section. Grade each criterion
against its own strong/weak bar; a response that merely name-drops the idea is
Developing, not Proficient.

For "evidence", quote EXACT substrings from the participant's text (main response or
follow-up) so each quote can be found and highlighted, never paraphrase inside
evidence. For EVERY criterion provide:
- "headline": a punchy one-line verdict, at most 8 words (e.g. "Named the idea but never applied it").
- "feedback": 1-2 sentences of specific detail. Wrap the 1-2 most important phrases in **double asterisks**. Do not bold whole sentences.
- "gaps": 1-3 SHORT, concrete things that were MISSING or too weak and would have raised the level. Empty list [] ONLY if genuinely Exemplary.
- "suggestion": ONE first-person sentence of "what you could have said" to strengthen THIS criterion, specific to this scenario. Empty string ONLY if already Exemplary.

SECTION 2, ANALYTICAL & PROBLEM-SOLVING (application)
Grade how well the participant APPLIES business thinking to SOLVE the scenario.
STRICTLY follow what the scenario actually asks for (e.g. if it asks how to save
money, do NOT reward an off-target marketing plan). Score three sub-criteria 1-4:
  framing (2a): 1 misreads/ignores the core problem · 2 identifies it loosely, misses
    key constraints/stakeholders · 3 clearly frames the actual problem and context ·
    4 that PLUS a constraint or stakeholder most competitors overlook.
  solution_quality (2b): 1 no real solution · 2 partly addresses it but unrealistic/
    disorganized/hard to implement · 3 realistic, organized, implementable solution
    that solves the stated problem · 4 all of 3 PLUS accounts for a real-world
    constraint (budget, timeline, stakeholder) the scenario implies.
  pi_application (2c): 1 doesn't apply the relevant criteria, or applies them wrong ·
    2 applies some superficially or in the wrong place · 3 applies the relevant ones
    correctly and appropriately · 4 weaves them in so they directly drive the recommendation.
Then "creativity", a BONUS ONLY, NEVER a penalty. A plain, correct, straightforward
answer earns +0.0 and loses nothing; absence of acronyms/visuals/flourishes is never
penalized. Award a bonus ONLY if BOTH: (a) solution_quality is already 3+, and (b)
the creative element makes the response genuinely clearer, more persuasive, or more
effective. +0.0 none · +0.25 one clear beneficial creative element (an apt acronym,
a referenced visual that aids clarity, a memorable framing) · +0.5 creativity is a
consistent, defining strength that materially elevates the response.
Then "depth", also a BONUS ONLY, NEVER a penalty, for reaching beyond the graded
criteria into the DEPTH VOCABULARY above. An answer that uses none earns +0.0 and
loses nothing. Award ONLY for a term that is (a) listed in the depth vocabulary,
(b) genuinely APPLIED to this scenario, driving a recommendation, a trade-off, or a
number, and (c) correct. MENTIONING A TERM EARNS NOTHING: "we'd look at our break-
even" is a name-drop, while "break-even is 500 units a month, so the kiosk clears it
at our current 30/day" is application. If you cannot quote the participant actually
using the term, the bonus is +0.0. Do not reward a term used wrongly, and never
invent a term they did not say. +0.25 one relevant term genuinely applied · +0.5 two
or more, or one used to real analytical effect. List the ids you credited in "terms".

SECTION 3, PROFESSIONAL PRESENTATION
Give ONE integer score 1-4 for professional presentation, using DELIVERY_METRICS
above, conversational versus memorized delivery, and the quality of the answer to
the judge's follow-up. Do NOT score visual cues (eye contact, posture), this is
audio/text only. Add a one-line "notes" summary.

Return a JSON object with EXACTLY this shape:
{{
  "performance_indicators": [
    {{"criterion_id": "<id>", "level": "novice|developing|proficient|exemplary",
      "points": <int 0-10 in band>, "headline": "<<=8 words>", "feedback": "<specific, with **key phrase** bolded>", "evidence": ["<verbatim quote>"], "gaps": ["<short missing item>"], "suggestion": "<one first-person line they could have said>"}}
    // one object per criterion above, SAME order
  ],
  "analytical": {{
    "framing": {{"score": <1-4>, "justification": "<one sentence>", "evidence": "<exact quote or null>"}},
    "solution_quality": {{"score": <1-4>, "justification": "<one sentence>", "evidence": "<exact quote or null>"}},
    "pi_application": {{"score": <1-4>, "justification": "<one sentence>", "evidence": "<exact quote or null>"}},
    "creativity": {{"bonus": <0.0|0.25|0.5>, "justification": "<one sentence>", "evidence": "<exact quote or null>"}},
    "depth": {{"bonus": <0.0|0.25|0.5>, "terms": ["<depth vocabulary id>"], "justification": "<one sentence>", "evidence": "<exact quote showing the term APPLIED, or null>"}}
  }},
  "presentation": {{"score": <1-4>, "notes": "<one sentence on pace/delivery/follow-up>"}},
  "final": {{
    "top_strength": "<one sentence, their single strongest area>",
    "biggest_weakness": "<one sentence, the single area costing them the most>",
    "one_key_fix": "<one sentence, the highest-leverage change for next attempt>"
  }},
  "summary": "<2-3 sentence overall read of the response>",
  "strengths": ["<short>", "..."],
  "improvements": ["<short, actionable>", "..."],
  "followup_feedback": "<how well they handled the judge's follow-up questions>",{math_key}
}}

Output ONLY the JSON object."""
    return SCORING_SYSTEM, user


# ---------------------------------------------------------------------------
# 4. Mastery Blitz, one batched "used correctly in context?" pass (Phase 5)
# ---------------------------------------------------------------------------

BLITZ_SYSTEM = (
    "You are a fast, fair DECA coach grading a rapid drill. The student was given a "
    "short scenario and, one at a time with 45 seconds each, had to use a specific "
    "business skill in that scenario. You grade a batch of these at once.\n\n"
    "For EACH item, judge ONLY one thing: does the answer show they understand THAT "
    "skill and can put it to work in the scenario? Ignore delivery, grammar, spelling, "
    "length, and every other skill. Answers are typed or transcribed speech produced "
    "in under a minute, so expect one or two rough sentences and read past typos and "
    "mis-heard words.\n"
    "- correct  = the idea is right AND it is tied to the scenario in any concrete way "
    "(the business, its problem, or a specific action). Their own words count: they do "
    "not need the textbook definition, the skill's name, or any numbers.\n"
    "- partial  = the idea is right but nothing connects it to the scenario, or it is "
    "tied to the scenario but the idea is only half right.\n"
    "- missed   = the idea is wrong, or the answer is off-topic or empty.\n\n"
    "Grade generously: this is practice against a clock, not a final. If an answer "
    "sits between two verdicts, give the higher one. Some skills fit the scenario only "
    "loosely (a personal or career skill in a store scenario, for example); accept any "
    "sensible way the student makes it fit.\n\n"
    "An item may include a sample of correct use. That sample was written for a "
    "DIFFERENT scenario and is more polished than 45 seconds allows. Use it only to "
    "understand the skill. Never mark an answer down for not matching the sample's "
    "details, length, or scenario.\n\n"
    "Give ONE short, specific coaching note per item (max ~20 words). For a correct "
    "answer, say what worked. Otherwise say what would have made it correct.\n\n"
    f"{_STYLE_RULE}"
    "Return ONLY a JSON object, no markdown."
)


def build_blitz_prompt(scenario: str, items: list[dict]) -> tuple[str, str]:
    """Batched blitz grading. `items`: [{name, definition, good_example, response}].
    Returns (system, user); the model returns a verdict + note per item by index."""
    blocks = []
    for i, it in enumerate(items):
        good = (it.get("good_example") or "").strip()
        # The card's Connect beat is written against its own scenario, never this
        # drill's. Labelled as such, or the grader holds answers to the wrong story.
        good_line = f"\n   Sample of correct use (from a different scenario): {good}" if good else ""
        name = it.get("name", "")
        definition = it.get("definition", "")
        answer = (it.get("response") or "").strip() or "(no answer)"
        blocks.append(
            f"ITEM {i}\n"
            f"   Skill: {name}\n"
            f"   What it means: {definition}{good_line}\n"
            f"   Student answer: {answer}"
        )
    items_block = "\n\n".join(blocks)
    user = f"""SCENARIO (shared by every item):
{scenario}

Grade each item below on whether the student understood THAT skill and tied it to the scenario above.

{items_block}

Return ONLY this JSON:
{{
  "results": [
    {{ "index": 0, "verdict": "correct" | "partial" | "missed", "note": "<=20 words, specific" }}
  ]
}}
One result per item, matched by index. Output ONLY the JSON."""
    return BLITZ_SYSTEM, user


# ---------------------------------------------------------------------------
# 5. Quiz bank, original multiple-choice items built from study cards
# ---------------------------------------------------------------------------
#
# Unlike everything above, this prompt does NOT run in the request path. Questions
# are generated offline by scripts/gen_quiz.py, reviewed, and shipped as
# data/quiz_bank.json; /api/quiz only serves what is already on disk. That is why
# it can afford a slow, careful prompt with a self-check the model has to write
# down: nothing here costs a waiting student a second.
#
# The tier is set by COGNITIVE STRUCTURE, never by word count or vocabulary. A
# one-line question can be icdc and a paragraph-long one can be district, so the
# prompt defines each tier by how many concepts it holds and what it does with
# them, and makes the model state that back to us (difficulty_justification,
# synthesis_check). Those fields exist to be audited, not displayed: gen_quiz.py
# rejects an icdc item whose break test it cannot see.

# Difficulty by structure, stated once and reused by the builder below.
_QUIZ_TIERS = """district - ONE concept, recognition. Tests what a single concept IS, or the direct
  first-order consequence of one action. One concept, one reasoning step. Someone with
  general business literacy and plain logic can reason it out; knowing the term helps
  but is not strictly required.
state - ONE concept, application. The student must USE that concept correctly inside a
  specific, novel situation, predicting how it behaves there. That takes the mechanism,
  not the definition. Still exactly one core concept, deployed rather than defined. The
  card's "connect" beat models the KIND of applied scenario to write: write a fresh one,
  never that one.
icdc - TWO or THREE concepts, synthesis. Cannot be answered by knowing any single
  concept. The student has to hold the concepts at once and reason about how they
  interact, combine, or trade off against each other."""

QUIZ_SYSTEM = (
    "You write original multiple-choice business questions for a high-school study app, "
    "built ONLY from the study cards given to you in the request. The cards are your "
    "single source of truth: every question, every correct answer, and every distractor "
    "must be defensible from the card content in front of you.\n\n"
    "SOURCE RULE (critical): write from the supplied cards and general business "
    "fundamentals, in your own words. Never reproduce, adapt, or reconstruct a real exam "
    "item, question bank, or any competition organization's published indicator list or "
    "its category wording. If you happen to know such material, it is not a source and "
    "not a checklist.\n\n"
    "DIFFICULTY IS STRUCTURAL. The requested tier is set by concept count and cognitive "
    "operation, never by length, rare words, or format:\n"
    f"{_QUIZ_TIERS}\n\n"
    "Before you emit an icdc question, run the BREAK TEST: name each concept the question "
    "depends on, then delete one and ask whether the question still works. If it does, the "
    "question is a state question wearing a costume: rewrite it or drop it. Write the "
    "result into synthesis_check. Only combine concepts that genuinely interact, and if "
    "the supplied cards hold no pair that meaningfully combines, say so in review_flags "
    "instead of forcing one.\n\n"
    "EXACTLY ONE option is defensibly correct. No 'all of the above', no 'none of the "
    "above', no second option a sharp student could argue for.\n\n"
    "DISTRACTORS are where a quiz earns its keep. Every wrong option must be wrong for a "
    "reason a real student would fall for: a common misconception, an adjacent term "
    "applied to the wrong situation, the right idea in the wrong context, or a "
    "partly-right answer that misses a key condition. Mine the cards' explain and above "
    "beats for the confusions students actually have. A throwaway option nobody would "
    "pick is a wasted option.\n\n"
    "ANSWER HYGIENE (the quiz has to resist test-taking tricks, not just ignorance):\n"
    "- Count the words in your four options before you emit them. They must land "
    "within a few words of each other and share the same grammatical shape, and the "
    "correct one must NOT be the longest or the most qualified. This is the single "
    "most common way a question leaks its answer: the writer piles the conditions "
    "onto the right option and strips them from the wrong ones. If the correct "
    "option came out longest, cut it down or put the same weight of detail into the "
    "distractors before you move on.\n"
    "- No option may be eliminable by format alone. Ruling one out must take "
    "understanding.\n"
    "- Vary which position is correct across the set.\n\n"
    "Vary the question format freely (recognition, scenario, cause and effect, best "
    "choice and why, compare two situations). Format never sets the tier. Never pad a "
    "stem to make it feel harder.\n\n"
    "NEVER use an em dash or an en dash. Use a comma, a colon, or a new sentence.\n"
    "Return ONLY a JSON object, no markdown."
)


def _quiz_card_block(cards: list[dict]) -> str:
    """The cards a batch may draw on, with all four beats.

    The beats are not decoration. `connect` shows the kind of applied scenario a
    state question should imitate (and must not copy), and `explain` / `above` are
    where the misconceptions worth turning into distractors live.
    """
    out = []
    for c in cards:
        ex = c.get("example") or {}
        beats = "\n".join(
            f"    {label}: {ex.get(key, '').strip()}"
            for key, label in (("define", "define"), ("explain", "explain"),
                               ("connect", "connect"), ("above", "above_beyond"))
            if ex.get(key)
        )
        mistake = (c.get("mistake") or "").strip()
        out.append(
            f"CARD: {c['name']}\n"
            f"  Domain: {c.get('domain', '')}   Topic: {c.get('topic', '')}\n"
            f"  Definition: {c.get('definition', '')}\n"
            f"  Worked example:\n{beats}"
            + (f"\n  Common mistake: {mistake}" if mistake else "")
        )
    return "\n\n".join(out)


_QUIZ_TIER_RULE = {
    "district": "Exactly ONE concept per question, one reasoning step.",
    "state": "Exactly ONE concept per question, used inside a fresh, specific situation.",
    "icdc": "TWO or THREE concepts per question that genuinely interact. Break test required.",
}


def build_quiz_prompt(cards: list[dict], level: str, count: int) -> tuple[str, str]:
    """One batch of quiz questions at ONE tier, from ONE set of study cards.

    `cards` are terms.json rows; `level` is district | state | icdc. Returns
    (system, user). The model answers with a "questions" array carrying, per item,
    four options with a correct flag and a per-option rationale, plus the two audit
    fields (difficulty_justification, synthesis_check) that gen_quiz.py checks
    before anything reaches the bank.

    A smaller honest set beats a padded one, so `count` is a ceiling rather than a
    quota: the prompt says to return fewer instead of padding, and the caller keeps
    whatever survives validation.
    """
    names = ", ".join(c["name"] for c in cards)
    user = f"""STUDY CARDS you may build from (and nothing else):

{_quiz_card_block(cards)}

TARGET_LEVEL: {level}
{_QUIZ_TIER_RULE.get(level, "")}
COUNT: up to {count} questions. Return FEWER if you cannot write that many honest
questions at this tier from these cards. Never pad the set.

Concept names you may use in "concepts" and "source_cards": {names}

Return ONLY this JSON:
{{
  "questions": [
    {{
      "domain": "<the source card's domain>",
      "level": "{level}",
      "concepts": ["<term name(s) tested: 1 for district/state, 2-3 for icdc>"],
      "source_cards": ["<term name(s) this was built from>"],
      "format": "<short label, e.g. scenario, recognition, trade-off>",
      "question": "<the stem>",
      "options": [
        {{ "id": "a", "text": "...", "correct": false, "rationale": "<the specific misconception this option represents>" }},
        {{ "id": "b", "text": "...", "correct": true,  "rationale": "<why this one is defensibly correct>" }},
        {{ "id": "c", "text": "...", "correct": false, "rationale": "..." }},
        {{ "id": "d", "text": "...", "correct": false, "rationale": "..." }}
      ],
      "difficulty_justification": "<concept count + cognitive operation, and why that lands it here>",
      "synthesis_check": "<icdc ONLY: name the concepts and state the break-test result. Empty string otherwise>",
      "review_flags": ["<anything you are unsure about: an arguable distractor, a forced pairing, a concept the cards underspecify. Empty array if clean>"]
    }}
  ]
}}
Exactly four options, exactly one with correct=true, a rationale on every option.
Output ONLY the JSON object."""
    return QUIZ_SYSTEM, user
