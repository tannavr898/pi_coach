"""Prompt construction — per the roadmap, this *is* the product.

Two prompts: §7.1 scenario generation and §7.2 content scoring. Each returns a
(system, user) pair. PI text is always pasted verbatim from our official data;
the plain-language `definition` rides along only as authoring/judging context so
the model understands a terse indicator, never as a replacement for the PI text.

Guardrails baked in (roadmap §2): original clean-room scenarios in DECA's style
(never DECA branding/codes/copyright), and scoring labelled PI coverage — never
a judge score.
"""

from __future__ import annotations


def _format_pis(pis: list[dict]) -> str:
    lines: list[str] = []
    for pi in pis:
        lines.append(f"- {pi['text']} ({pi['id']})")
        if pi.get("definition"):
            lines.append(f"    context (not part of the PI): {pi['definition']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# §7.1 Scenario generation
# ---------------------------------------------------------------------------

SCENARIO_SYSTEM = (
    "You are an expert DECA roleplay author who has written and judged hundreds "
    "of events. You write ORIGINAL practice scenarios in DECA's official format. "
    "You never copy published scenarios and never reproduce DECA's branding, "
    "event codes, copyright lines, or logos — these are original practice "
    "materials in DECA's style.\n\n"
    "Output ONLY the participant scenario sheet — no preamble, no markdown code "
    "fences, and no notes about how you wrote it."
)


def build_scenario_prompt(event: dict, level: str, pis: list[dict]) -> tuple[str, str]:
    """Build the (system, user) messages for one original scenario."""
    user = f"""EVENT: {event['name']}   LEVEL: {level}   EVENT TYPE: principles
PERFORMANCE INDICATORS (verbatim; the scenario must give a natural reason to
address every one):
{_format_pis(pis)}

Write the participant sheet in this structure:
[Header: Career Cluster / Instructional Area]
{event['name'].upper()} — PARTICIPANT INSTRUCTIONS
PROCEDURES (standard 10-min prep / 10-min role-play / evaluated on the PIs / turn in notes)
PERFORMANCE INDICATORS (verbatim, exactly as listed above)
EVENT SITUATION   // use "INTERVIEW SITUATION" ONLY if the scenario is literally a job interview
   - realistic, current, specific company + business context (no placeholder names)
   - the specific challenge/decision; the participant's exact role and task
   - the task must naturally require every performance indicator above
   - how the meeting begins; that the judge asks follow-ups
JUDGE INSTRUCTIONS / JUDGE ROLE-PLAY CHARACTERIZATION
   - mirror the situation from the judge's point of view
   - exactly TWO specific questions the judge asks every participant
   - standard closing (thank the participant; no other comments)

Constraints: solvable in 10 min prep + ~10 min presentation; difficulty matched
to the LEVEL; every PI genuinely relevant (adjust the scenario if any feels
forced). Output ONLY the scenario sheet."""
    return SCENARIO_SYSTEM, user


# ---------------------------------------------------------------------------
# §7.2 Content scoring (PI coverage + structure)
# ---------------------------------------------------------------------------

SCORING_SYSTEM = (
    "You are an experienced DECA judge and coach. You evaluate a participant's "
    "response strictly against the assigned performance indicators and on general "
    "response quality. You are specific and honest, cite evidence from their "
    "response, and never inflate. Assess only what the words show — content, "
    "structure, PI coverage — NOT delivery, confidence, or presence (those are "
    "scored separately).\n\n"
    "Return ONLY valid JSON (no markdown, no code fences, no commentary) with "
    "exactly this shape:\n"
    '{"pi_results":[{"id":"","text":"","coverage":"hit|partial|missed",'
    '"evidence":"","improvement":""}],"structure_feedback":"",'
    '"addressed_task":true,"overall_notes":"",'
    '"pi_coverage_summary":{"hit":0,"partial":0,"missed":0},'
    '"followup_question":""}'
)


def build_scoring_prompt(scenario: str, pis: list[dict], response: str) -> tuple[str, str]:
    """Build the (system, user) messages for scoring a typed response."""
    user = f"""SCENARIO:
{scenario}

ASSIGNED PERFORMANCE INDICATORS:
{_format_pis(pis)}

PARTICIPANT RESPONSE (transcript):
{response}

For EACH assigned PI: set coverage to "hit", "partial", or "missed"; quote or
paraphrase the evidence from their response; give one concrete improvement. Use
the exact PI id and verbatim PI text in each pi_results entry.
Then assess: structure/organization; whether they addressed the task; and
specificity / business reasoning (overall_notes). Fill pi_coverage_summary with
the counts. Finally, write ONE realistic judge follow-up question targeting the
weakest-covered PI or an obvious gap.

Return ONLY the JSON object described in the system message."""
    return SCORING_SYSTEM, user
