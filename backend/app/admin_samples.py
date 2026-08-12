"""Canned sample sessions for the admin QA page — NO LLM tokens.

`build_sample_rows()` returns fully-valid session rows (same shape db.insert_session
writes) with BACKDATED created_at spread over a couple of weeks and a deliberate
shape so the home page looks alive: filler rate trending DOWN (delivery improving),
scores drifting up, and one consistently weak criterion (Branding) so the
"weakest criterion" nudge has something to point at.

Every row is tagged `event = SAMPLE_EVENT` so the admin "clear sample data" action
can delete exactly these and nothing the owner created for real. Built through the
Pydantic models so the stored jsonb round-trips cleanly back into the feedback screen.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .rubric import overall_level
from .schemas import (
    AnalyticalSection,
    CreativityScore,
    Criterion,
    CriterionScore,
    DeliveryMetrics,
    FinalScore,
    PresentationSection,
    ScenarioResponse,
    ScoreResponse,
    SubScore,
)

SAMPLE_EVENT = "admin-sample"

# Four criteria reused across the sample runs. Branding (FW-164) is intentionally
# kept weak so it surfaces as the "weakest criterion".
_CRITERIA = [
    Criterion(id="FW-041", domain="Customer Relations", topic="Relationships", name="Customer Relationship Thinking"),
    Criterion(id="FW-168", domain="Marketing", topic="Promotion", name="Promotional Strategy"),
    Criterion(id="FW-164", domain="Marketing", topic="Brand", name="Branding and Brand Identity"),
    Criterion(id="FW-280", domain="Strategic Management", topic="Measurement", name="Measuring Success and Follow-Through"),
]

# Per-session shape: (topic, event_name, content_score, filler_per_min, pace_wpm,
# levels for the 4 criteria above). Ordered oldest → newest.
_SESSIONS = [
    ("Grow repeat visits at a smoothie chain", "Food Marketing", 61, 9.0, 108, ["developing", "developing", "novice", "developing"]),
    ("Launch a loyalty app for a bakery", "Marketing Communications", 58, 7.5, 115, ["proficient", "developing", "developing", "developing"]),
    ("Reposition a struggling bookstore", "Business Services Marketing", 69, 6.5, 122, ["proficient", "proficient", "developing", "proficient"]),
    ("Cut membership churn at a gym", "Sports and Entertainment Marketing", 72, 5.0, 128, ["proficient", "proficient", "developing", "proficient"]),
    ("Promote a new food truck", "Food Marketing", 76, 4.0, 132, ["exemplary", "proficient", "developing", "proficient"]),
    ("Rebrand a neighborhood coffee cart", "Marketing Communications", 81, 3.0, 135, ["exemplary", "exemplary", "developing", "proficient"]),
]

_POINTS = {"novice": 2, "developing": 5, "proficient": 8, "exemplary": 9}


def _scenario(topic: str, event: str) -> ScenarioResponse:
    return ScenarioResponse(
        topic=topic,
        industry="retail / services",
        event=event,
        event_kind="individual",
        level="district",
        mode="learn",
        criteria=_CRITERIA,
        procedures=["Prep, then present your recommendation.", "The judge asks a follow-up."],
        situation=f"Sample scenario for QA: {topic}. (Generated for the admin preview — not a real role-play.)",
        hook=f"Sample hook for QA: {topic.lower()} — the share card headlines with this line.",
        followup_questions=["What would you try first, and how would you know it worked?"],
    )


def _score(content_score: int, levels: list[str]) -> ScoreResponse:
    scores = [
        CriterionScore(
            criterion_id=c.id,
            name=c.name,
            domain=c.domain,
            topic=c.topic,
            level=lvl,  # type: ignore[arg-type]
            points=_POINTS[lvl],
            max_points=10,
            headline=f"Sample: {c.name}",
            feedback="Sample feedback for QA preview.",
            evidence=["a sample quote from the response"],
        )
        for c, lvl in zip(_CRITERIA, levels)
    ]
    total = sum(s.points for s in scores)
    pi_percent = round(total / (len(scores) * 10) * 100, 1)
    analytical = AnalyticalSection(
        framing=SubScore(score=3, justification="Sample framing."),
        solution_quality=SubScore(score=3, justification="Sample solution."),
        pi_application=SubScore(score=3, justification="Sample application."),
        creativity=CreativityScore(bonus=0.25, justification="A memorable sample touch."),
        core_score=3.0,
        section_score=3.25,
        section_percent=81.0,
    )
    presentation = PresentationSection(section_score=3.2, section_percent=80.0, notes="Sample presentation note.")
    return ScoreResponse(
        scores=scores,
        total_points=total,
        max_points=len(scores) * 10,
        overall_percent=content_score,
        overall_level=overall_level(content_score),
        summary="Sample session generated for the admin QA preview.",
        strengths=["Clear structure.", "Named a concrete metric."],
        improvements=["Develop the brand point.", "Tie tactics to the target number."],
        followup_feedback="Handled the follow-up with a sensible, specific answer.",
        pi_section_score=round(total / len(scores) / 10 * 4, 2),
        pi_section_percent=pi_percent,
        analytical=analytical,
        presentation=presentation,
        final=FinalScore(
            percent=float(content_score),
            top_strength="A realistic, well-sequenced solution.",
            biggest_weakness="Brand is treated as look-and-feel.",
            one_key_fix="State what the business stands for and tie tactics to the target.",
        ),
    )


def _delivery(filler_per_min: float, pace_wpm: int) -> DeliveryMetrics:
    return DeliveryMetrics(
        duration_seconds=430.0,
        word_count=int(pace_wpm * 430 / 60),
        pace_wpm=pace_wpm,
        pace_flag="good" if 110 <= pace_wpm <= 160 else "slow",
        filler_count=int(round(filler_per_min * 430 / 60)),
        filler_per_min=filler_per_min,
        pause_count=8,
        longest_pause_seconds=3.2,
        time_used_seconds=430.0,
        time_target_seconds=450,
        time_flag="good",
        reading_signal=False,
        notes=["Sample delivery notes for QA."],
        delivery_score=max(50, min(95, 100 - int(filler_per_min * 5))),
    )


def build_sample_rows(user_id: str) -> list[dict]:
    """Six backdated sample rows for the given user, oldest first."""
    now = datetime.now(timezone.utc)
    rows: list[dict] = []
    n = len(_SESSIONS)
    for i, (topic, event, content_score, fpm, wpm, levels) in enumerate(_SESSIONS):
        created = now - timedelta(days=(n - 1 - i) * 3)
        scenario = _scenario(topic, event)
        score = _score(content_score, levels)
        delivery = _delivery(fpm, wpm)
        rows.append(
            {
                "user_id": user_id,
                "created_at": created.isoformat(),
                "scenario": scenario.model_dump(),
                "response": f"[Sample typed response for QA — {topic}.]",
                "followup_answer": "[Sample follow-up answer.]",
                "score": score.model_dump(),
                "delivery": delivery.model_dump(),
                "utterances": [],
                "event": SAMPLE_EVENT,
                "content_score": content_score,
                "criterion_results": [
                    {"criterion_id": s.criterion_id, "name": s.name, "domain": s.domain, "level": s.level, "points": s.points}
                    for s in score.scores
                ],
                "filler_per_min": fpm,
                "pace_wpm": wpm,
                "long_pause_count": 1,
                "duration_seconds": 430.0,
                "retry_of_session_id": None,
            }
        )
    return rows
