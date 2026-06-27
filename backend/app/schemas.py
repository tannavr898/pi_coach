"""Request/response models for the Phase 2 content loop."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Level = Literal["district", "state", "icdc"]


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
    performance_indicators: list[PI]
    scenario: str


# --- POST /api/score-content ----------------------------------------------


class ScoreRequest(BaseModel):
    scenario: str
    pi_ids: list[str]
    response: str = Field(min_length=1)


class PIResult(BaseModel):
    id: str
    text: str
    coverage: Literal["hit", "partial", "missed"]
    evidence: str = ""
    improvement: str = ""


class CoverageSummary(BaseModel):
    hit: int = 0
    partial: int = 0
    missed: int = 0


class ScoreResponse(BaseModel):
    pi_results: list[PIResult]
    structure_feedback: str = ""
    addressed_task: bool = True
    overall_notes: str = ""
    pi_coverage_summary: CoverageSummary = CoverageSummary()
    followup_question: str = ""
