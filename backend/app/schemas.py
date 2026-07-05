"""Request/response models for the content loop (independent framework)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Level = Literal["district", "state", "icdc"]
Mode = Literal["learn", "competition"]
RubricLevel = Literal["novice", "developing", "proficient", "exemplary"]


# --- shared ---------------------------------------------------------------


class Criterion(BaseModel):
    """One evaluation criterion, as shown to the participant on the cover sheet.

    In Competition mode the teaching fields (definition / strong_looks_like /
    weak_looks_like) are blanked server-side so the participant sees only the
    names — the criteria are still graded by id from the framework. In Learn mode
    they are populated so the UI can teach what "good" looks like.
    """

    id: str
    domain: str = ""
    topic: str = ""
    name: str
    definition: str = ""
    strong_looks_like: str = ""
    weak_looks_like: str = ""
    coaches: str = ""


class DomainSummary(BaseModel):
    id: str
    name: str
    blurb: str = ""
    criteria_count: int = 0


class PublicConfig(BaseModel):
    """Client-safe runtime config served to the SPA (no secrets)."""

    posthog_key: str = ""
    posthog_host: str = "https://us.i.posthog.com"


class FeedbackRequest(BaseModel):
    """A piece of user feedback (no account required)."""

    message: str = Field(min_length=1, max_length=4000)
    rating: int | None = Field(default=None, ge=1, le=5)
    email: str = Field(default="", max_length=200)
    page: str = Field(default="", max_length=80)


# --- POST /api/scenario ---------------------------------------------------


class ScenarioRequest(BaseModel):
    # The user's free-text description of what they want to practice.
    request: str = Field(min_length=1, max_length=400)
    level: Level = "district"
    mode: Mode = "competition"


class ScenarioResponse(BaseModel):
    # What we understood from the free-text request.
    topic: str
    industry: str = ""
    domain_focus: list[str] = []
    level: Level
    mode: Mode
    # The criteria this role-play is generated against AND will be scored against.
    # (Teaching fields are populated only in Learn mode.)
    criteria: list[Criterion]
    procedures: list[str]
    # Participant-facing situation ONLY — never the judge instructions.
    situation: str
    # The judge's set follow-up questions, surfaced to the participant only AFTER
    # they submit their main response (mirrors a real role-play), then graded.
    followup_questions: list[str]


# --- POST /api/score-content ----------------------------------------------


class ScoreRequest(BaseModel):
    scenario: str = Field(description="The situation the participant responded to.")
    criteria_ids: list[str] = Field(min_length=1)
    response: str = Field(min_length=1)
    followup_questions: list[str] = []
    followup_answer: str = ""


class CriterionScore(BaseModel):
    criterion_id: str
    name: str
    domain: str = ""
    topic: str = ""
    level: RubricLevel
    points: int
    max_points: int
    # One-line headline (shown collapsed); feedback is the full detail (expandable).
    headline: str = ""
    feedback: str = ""
    # Verbatim quotes from the participant's response/follow-up, for highlighting.
    evidence: list[str] = []
    # Concrete things that were missing/too weak and would raise the level. These
    # are ABSENT from the response, so they can't be highlighted — listed instead.
    gaps: list[str] = []


class ScoreResponse(BaseModel):
    scores: list[CriterionScore]
    total_points: int
    max_points: int
    overall_percent: int
    overall_level: RubricLevel
    summary: str = ""
    strengths: list[str] = []
    improvements: list[str] = []
    followup_feedback: str = ""


# --- POST /api/score-delivery (voice) -------------------------------------


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
