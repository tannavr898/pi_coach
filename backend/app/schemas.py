"""Request/response models for the content loop (rubric-based, 2026 District)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Level = Literal["district", "state", "icdc"]
RubricLevel = Literal["novice", "developing", "proficient", "exemplary"]


# --- shared ---------------------------------------------------------------


class PI(BaseModel):
    id: str
    text: str
    area: str
    area_name: str = ""
    level: str = ""
    definition: str = ""


class EventSummary(BaseModel):
    code: str
    name: str
    level: str
    pi_count: int


class RubricCriterion(BaseModel):
    """A scored criterion shown to the participant before they start (the cover
    sheet) and echoed in feedback."""

    key: str
    label: str
    desc: str = ""
    max_points: int


# --- POST /api/scenario ---------------------------------------------------


class ScenarioRequest(BaseModel):
    event_code: str
    level: Level = "district"
    area: str | None = Field(default=None, description="Focus all PIs in one instructional area.")
    pi_ids: list[str] | None = Field(default=None, description="Use these exact PIs (reproducibility).")
    seed: int | None = None


class ScenarioResponse(BaseModel):
    event: EventSummary
    level: Level
    instructional_area: str
    performance_indicators: list[PI]
    solution_criteria: list[RubricCriterion]
    career_competencies: list[RubricCriterion]
    procedures: list[str]
    # Participant-facing event situation ONLY — never the judge instructions.
    situation: str
    # The judge's set follow-up questions. Surfaced to the participant only AFTER
    # they submit their main response (mirrors a real role-play), then graded.
    followup_questions: list[str]


# --- POST /api/score-content ----------------------------------------------


class ScoreRequest(BaseModel):
    event_code: str
    scenario: str = Field(description="The event situation the participant responded to.")
    pi_ids: list[str]
    response: str = Field(min_length=1)
    followup_questions: list[str] = []
    followup_answer: str = ""


class RubricScore(BaseModel):
    key: str  # e.g. "pi:EN:044", "solution:unique", "competency:critical_thinking", "overall"
    category: Literal[
        "performance_indicator", "solution", "career_competency", "overall_impression"
    ]
    label: str
    pi_id: str | None = None
    level: RubricLevel
    points: int
    max_points: int
    # One-line headline (shown collapsed); feedback is the full detail (expandable).
    headline: str = ""
    feedback: str = ""
    # Verbatim quotes from the participant's response/follow-up, for highlighting.
    evidence: list[str] = []


class ScoreResponse(BaseModel):
    scores: list[RubricScore]
    total_points: int
    max_points: int = 100
    summary: str = ""
    strengths: list[str] = []
    improvements: list[str] = []
    followup_feedback: str = ""


# --- POST /api/score-delivery (voice, Phase 3) ----------------------------


class FillerCount(BaseModel):
    word: str
    count: int


class CrutchCount(BaseModel):
    phrase: str
    count: int


class LongPause(BaseModel):
    at_seconds: float
    length_seconds: float


class DeliveryMetrics(BaseModel):
    duration_seconds: float
    word_count: int
    pace_wpm: int
    pace_flag: Literal["slow", "good", "fast"]
    filler_count: int
    filler_per_min: float
    fillers: list[FillerCount] = []
    crutch_phrases: list[CrutchCount] = []
    pause_count: int
    long_pauses: list[LongPause] = []
    longest_pause_seconds: float
    time_used_seconds: float
    time_target_seconds: int
    time_flag: Literal["short", "good", "long"]
    reading_signal: bool
    notes: list[str] = []


class DeliveryResponse(BaseModel):
    transcript: str
    metrics: DeliveryMetrics
