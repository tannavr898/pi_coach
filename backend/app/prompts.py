"""Prompt construction — per the roadmap, this *is* the product.

Two prompts: §7.1 scenario generation and §7.2 rubric scoring. Each returns a
(system, user) pair and asks for JSON we parse defensively.

Both target DECA's current (2026 District) format: a SHORT, concrete event
situation the participant must solve, graded on the official rubric (four
Performance Indicators, three Solution criteria, three Career Competencies, and
an Overall Impression — 100 points across Novice/Developing/Proficient/Exemplary).

Guardrails baked in (roadmap §2): original clean-room scenarios in DECA's style
(never DECA branding/codes/copyright), and feedback labelled practice coaching —
never an official competition score. The judge instructions are generated for
grading only and are NEVER part of the participant-facing scenario.
"""

from __future__ import annotations

from . import rubric


def _format_pis(pis: list[dict]) -> str:
    lines: list[str] = []
    for pi in pis:
        lines.append(f"- {pi['text']} ({pi['id']})")
        if pi.get("definition"):
            lines.append(f"    context (not part of the PI): {pi['definition']}")
    return "\n".join(lines)


# Level-scaled length/complexity. Real district scenarios are short and concrete;
# state and ICDC add stakeholders, constraints, and ambiguity.
_LEVEL_GUIDE = {
    "district": "120-170 words. One clear ask, a single stakeholder, concrete and approachable.",
    "state": "170-240 words. A bit more nuance — a constraint or trade-off to weigh.",
    "icdc": "240-330 words. More complex: competing priorities or multiple stakeholders, still solvable in the time.",
}


# ---------------------------------------------------------------------------
# §7.1 Scenario generation
# ---------------------------------------------------------------------------

SCENARIO_SYSTEM = (
    "You are an expert DECA role-play author who has written and judged hundreds "
    "of events. You write ORIGINAL practice scenarios in DECA's current format. "
    "You never copy published scenarios and never reproduce DECA's branding, "
    "event codes, copyright lines, or logos — these are original practice "
    "materials in DECA's style.\n\n"
    "Return ONLY a single JSON object (no markdown, no code fences, no commentary)."
)


def build_scenario_prompt(
    event: dict, level: str, instructional_area: str, pis: list[dict]
) -> tuple[str, str]:
    """Build the (system, user) messages for one original scenario."""
    guide = _LEVEL_GUIDE.get(level, _LEVEL_GUIDE["district"])
    user = f"""EVENT: {event['name']}
COMPETITION LEVEL: {level}   ({guide})
INSTRUCTIONAL AREA: {instructional_area}

PERFORMANCE INDICATORS the participant must get a natural reason to demonstrate
(verbatim; do not reword):
{_format_pis(pis)}

Write an original role-play. The participant takes a specific role at a specific,
realistic (invented) company and must work through a concrete business situation
that calls for a SOLUTION and naturally requires every performance indicator
above. Keep it grounded and current; no placeholder names.

Return a JSON object with EXACTLY these keys:
{{
  "situation": "The participant-facing EVENT SITUATION only. {guide} OPEN by
     establishing, in the first sentence or two, the participant's specific role
     AND a one-line description of the company (its name and what it does) so the
     participant has the context to reason about — never reference company facts
     you didn't state here. Then give the specific challenge/decision and note
     they will meet a judge who plays a named counterpart and will ask follow-up
     questions. Plain prose, 2-3 short paragraphs. Do NOT include procedures, the
     PI list, or anything addressed to the judge.",
  "followup_questions": ["Two questions the judge asks AFTER the presentation.
     Make them probe depth on the indicators or a trade-off in the situation —
     specific to this scenario, not generic.", "second question"]
}}

CRITICAL: never put judge instructions, judge characterization, or the answers
inside "situation" — that text is shown to the participant. Output ONLY the JSON."""
    return SCENARIO_SYSTEM, user


# ---------------------------------------------------------------------------
# §7.2 Rubric scoring (2026 District evaluation form)
# ---------------------------------------------------------------------------


def _rubric_brief() -> str:
    r = rubric.load_rubric()
    ld = r["level_descriptions"]
    sol = ", ".join(f"{i['label']} ({i['desc']})" for i in rubric.solution_items())
    comp = ", ".join(f"{i['label']} ({i['desc']})" for i in rubric.competency_items())
    return f"""LEVELS (pick ONE per criterion, then a score inside its point band):
- Novice — {ld['novice']}
- Developing — {ld['developing']}
- Proficient — {ld['proficient']}
- Exemplary — {ld['exemplary']}

CRITERIA AND POINT BANDS:
- Each Performance Indicator (4): novice 0-3, developing 4-7, proficient 8-11, exemplary 12.
- Solution (3) — {sol}: novice 0-2, developing 3-5, proficient 6-7, exemplary 8.
- Career Competencies (3) — {comp}: novice 0-1, developing 2-3, proficient 4-5, exemplary 6.
- Overall Impression (career readiness: professionalism, poise, confidence): novice 0-3, developing 4-6, proficient 7-9, exemplary 10.
Total is out of 100."""


SCORING_SYSTEM = (
    "You are an experienced, fair DECA judge and coach grading a typed practice "
    "response against the official 2026 District rubric. Judge ONLY what the words "
    "show — content, reasoning, structure, and how well each criterion is met — "
    "NOT delivery, voice, confidence, or presence (those are coached separately). "
    "Be specific and honest; cite verbatim quotes from the response as evidence; "
    "never inflate. A typed practice answer that merely mentions an indicator is "
    "usually Developing, not Proficient.\n\n"
    "Return ONLY a single JSON object (no markdown, no code fences, no commentary)."
)


def build_scoring_prompt(
    scenario: str,
    pis: list[dict],
    response: str,
    followup_questions: list[str],
    followup_answer: str,
) -> tuple[str, str]:
    """Build the (system, user) messages for rubric scoring."""
    pi_block = "\n".join(f'- {pi["id"]}: {pi["text"]}' for pi in pis)
    fq = "\n".join(f"- {q}" for q in followup_questions) or "(none)"
    user = f"""{_rubric_brief()}

EVENT SITUATION the participant responded to:
{scenario}

ASSIGNED PERFORMANCE INDICATORS:
{pi_block}

PARTICIPANT'S MAIN RESPONSE (transcript):
{response}

JUDGE'S FOLLOW-UP QUESTIONS:
{fq}

PARTICIPANT'S ANSWER TO THE FOLLOW-UP:
{followup_answer or "(the participant did not answer)"}

Grade every criterion. For "evidence", quote EXACT substrings from the
participant's text (main response or follow-up) so each quote can be found and
highlighted — never paraphrase inside evidence. Give concrete, criterion-specific
feedback that names what was present and what would raise the level.

For EVERY criterion provide BOTH:
- "headline": a punchy one-line verdict, at most 8 words (e.g. "Named the PI but never applied it"). This is shown first; the reader expands to see the full feedback.
- "feedback": 1-2 sentences of specific detail. Wrap the 1-2 most important
  phrases — the key thing to fix or the thing done well — in **double asterisks**
  so they stand out when scanned. Do not bold whole sentences.

Return a JSON object with EXACTLY this shape:
{{
  "performance_indicators": [
    {{"pi_id": "<id>", "level": "novice|developing|proficient|exemplary",
      "points": <int in band>, "headline": "<<=8 words>", "feedback": "<specific, with **key phrase** bolded>", "evidence": ["<verbatim quote>"]}}
    // one object per assigned PI, same order
  ],
  "solution": {{
    "unique": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}},
    "practical": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}},
    "effective": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}}
  }},
  "career_competencies": {{
    "critical_thinking": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}},
    "communication": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}},
    "decision_making": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}}
  }},
  "overall_impression": {{"level": "...", "points": <int>, "headline": "...", "feedback": "...", "evidence": ["..."]}},
  "summary": "<2-3 sentence overall read>",
  "strengths": ["<short>", "..."],
  "improvements": ["<short, actionable>", "..."],
  "followup_feedback": "<how well they handled the judge's follow-up questions>"
}}

Output ONLY the JSON object."""
    return SCORING_SYSTEM, user
