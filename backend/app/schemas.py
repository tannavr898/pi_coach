"""Request/response models for the content loop (independent framework)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Level = Literal["district", "state", "icdc"]
Mode = Literal["learn", "competition"]
RubricLevel = Literal["novice", "developing", "proficient", "exemplary"]


# --- shared ---------------------------------------------------------------


class FlashcardExample(BaseModel):
    """A term-specific worked example, run through the four DECA beats (the Tips-page
    method), used as the back of a flashcard."""
    define: str = ""
    explain: str = ""
    connect: str = ""
    above: str = ""


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
    # Flashcard display content (Phase 4). Populated only on the /api/criteria
    # (flashcard) path; scenario cover-sheets leave these empty.
    example: FlashcardExample | None = None
    mistake: str = ""


class DomainSummary(BaseModel):
    id: str
    name: str
    blurb: str = ""
    criteria_count: int = 0


class EventSummary(BaseModel):
    """One role-play event in the picker (our own catalog — events.json)."""

    id: str
    name: str
    cluster: str = ""
    kind: str = ""  # principles | individual | team
    quantitative: bool = False  # math-heavy events get deterministic math checks
    blurb: str = ""
    # Original example prompts that pre-fill the "what to focus on" box.
    suggestions: list[str] = []


class Timing(BaseModel):
    """Presentation clock for a role-play (seconds). Team events get more time."""

    prep_seconds: int = 600
    present_seconds: int = 600
    target_seconds: int = 450  # recommended *speaking* time (delivery is graded on this)


class PublicConfig(BaseModel):
    """Client-safe runtime config served to the SPA (no secrets)."""

    posthog_key: str = ""
    posthog_host: str = "https://us.i.posthog.com"
    # Supabase URL + anon key are public (the anon key is safe client-side; row
    # access is enforced by RLS + the backend). Empty = login disabled in the UI.
    supabase_url: str = ""
    supabase_anon_key: str = ""


class FeedbackRequest(BaseModel):
    """A piece of user feedback (no account required)."""

    message: str = Field(min_length=1, max_length=4000)
    rating: int | None = Field(default=None, ge=1, le=5)
    email: str = Field(default="", max_length=200)
    page: str = Field(default="", max_length=80)


# --- POST /api/scenario ---------------------------------------------------


class ScenarioRequest(BaseModel):
    # The event the student is practicing for (id from events.json). Drives which
    # framework domains feed generation. Optional so the plain free-text path
    # still works, but the UI always sends one.
    event: str = Field(default="", max_length=80)
    # Optional free-text focus ("a promotion that isn't converting"). If empty, we
    # generate a random scenario within the event's scope.
    request: str = Field(default="", max_length=400)
    level: Level = "district"
    mode: Mode = "competition"
    # Recent scenario-variety combo signatures for THIS user+event (newest last),
    # so the backend can skip immediate repeats when sampling the taxonomy. Client
    # tracks these locally; empty on the free-text / no-taxonomy paths. Capped to
    # keep the payload small.
    avoid: list[str] = Field(default_factory=list, max_length=20)


class Sampling(BaseModel):
    """The scenario-variety combination the backend sampled and injected (Phase 3).
    Returned so the client can remember it (avoid immediate repeats) and the admin
    QA page can see what drove the scenario. Absent when no taxonomy was applied."""
    signature: str
    labels: dict[str, str] = {}


class ScenarioResponse(BaseModel):
    # What we understood from the request.
    topic: str
    industry: str = ""
    # The event this was generated for (display name), if one was chosen.
    event: str = ""
    event_kind: str = ""  # principles | individual | team
    quantitative: bool = False  # calculations will be math-checked
    team: bool = False  # two-person event: enables speaker diarization
    timing: Timing = Field(default_factory=Timing)
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
    # The variety combination that shaped this scenario (Phase 3), or null when the
    # event has no taxonomy yet / a free-text focus was used.
    sampling: Sampling | None = None


# --- POST /api/score-content ----------------------------------------------


class ScoreRequest(BaseModel):
    scenario: str = Field(description="The situation the participant responded to.")
    criteria_ids: list[str] = Field(min_length=1)
    response: str = Field(min_length=1)
    followup_questions: list[str] = []
    followup_answer: str = ""
    # The event id, so scoring can re-derive (server-side) whether this is a
    # quantitative event and should run deterministic math verification.
    event: str = ""
    # Delivery signal for Section 3 (Professional Presentation). When the response
    # was spoken, the client forwards the deterministic delivery score (0-100) so
    # the presentation section can blend objective pace/filler/pause metrics with
    # the model's read of conversational delivery + follow-up quality. Typed runs
    # leave these unset and Section 3 rests on the written answer + follow-up.
    spoken: bool = False
    delivery_score: int | None = Field(default=None, ge=0, le=100)


class MathCheck(BaseModel):
    """One calculation, recomputed deterministically by the backend. `computed`
    is authoritative; `claimed` is what the student's response asserted (if any)."""

    label: str = ""
    expression: str = ""
    unit: str = ""
    claimed: float | None = None
    computed: float | None = None
    ok: bool | None = None  # True/False when comparable, None when nothing to compare
    note: str = ""


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
    # An example of a stronger line the participant could have said for this
    # criterion — surfaced inline in the transcript as "what you could have said".
    suggestion: str = ""


# --- Section 2: Analytical & Problem-Solving --------------------------------


class SubScore(BaseModel):
    """One 1-4 analytical sub-criterion (framing / solution quality / PI
    application) with the phrase that justifies it."""

    score: int  # 1-4
    justification: str = ""
    evidence: str | None = None


class CreativityScore(BaseModel):
    """Bonus-only creativity award for Section 2 (0, +0.25, or +0.5). Never a
    penalty — a plain, correct answer earns 0 here and loses nothing."""

    bonus: float = 0.0
    justification: str = ""
    evidence: str | None = None


class AnalyticalSection(BaseModel):
    """Section 2 — how well the competitor APPLIES business thinking to solve the
    scenario. Sub-scores come from the model; the roll-up arithmetic is computed
    deterministically by the backend (never trusted to the model)."""

    weight: float = 0.25
    framing: SubScore
    solution_quality: SubScore
    pi_application: SubScore
    creativity: CreativityScore
    core_score: float = 0.0  # (2a×0.30)+(2b×0.45)+(2c×0.25)
    section_score: float = 0.0  # min(4, core + creativity)
    section_percent: float = 0.0  # section_score / 4 × 100


# --- Section 3: Professional Presentation -----------------------------------


class PresentationSection(BaseModel):
    """Section 3 — delivery + follow-up handling, rolled to a single 0-4 score.
    When the run was spoken, section_percent blends the deterministic delivery
    score with the model's read; typed runs use the model's read alone."""

    weight: float = 0.15
    section_score: float = 0.0  # 0-4
    section_percent: float = 0.0
    notes: str = ""


# --- Final weighted result --------------------------------------------------


class FinalScore(BaseModel):
    """The weighted roll-up: 60% PIs + 25% analytical + 15% presentation."""

    percent: float = 0.0
    top_strength: str = ""
    biggest_weakness: str = ""
    one_key_fix: str = ""


class ScoreResponse(BaseModel):
    scores: list[CriterionScore]
    total_points: int
    max_points: int
    # Kept for existing UI/analytics: this is now the FINAL weighted percent
    # (rounded), so a single number still reads as "the score".
    overall_percent: int
    overall_level: RubricLevel
    summary: str = ""
    strengths: list[str] = []
    improvements: list[str] = []
    followup_feedback: str = ""
    # Deterministically recomputed calculations (quantitative events only).
    math_checks: list[MathCheck] = []
    # --- New 3-section weighted rubric ---
    # Section 1 (Performance Indicators, 60%) rolls up from `scores`.
    pi_section_score: float = 0.0  # 0-4
    pi_section_percent: float = 0.0
    analytical: AnalyticalSection | None = None  # Section 2 (25%)
    presentation: PresentationSection | None = None  # Section 3 (15%)
    final: FinalScore | None = None


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


class DeliveryComponent(BaseModel):
    label: str
    score: int
    hint: str = ""


class SpeakerStat(BaseModel):
    """Per-speaker delivery breakdown for team events (from diarization)."""

    speaker: str  # "A", "B", …
    talk_seconds: float
    talk_share: float  # 0..1 fraction of total speaking time
    word_count: int
    filler_count: int
    pace_wpm: int


class Utterance(BaseModel):
    """One continuous turn by a single speaker (team transcript view)."""

    speaker: str
    text: str
    start_seconds: float
    end_seconds: float


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
    # Deterministic 0-100 delivery score + its component breakdown. Blended into
    # the overall score when the participant spoke.
    delivery_score: int = 0
    delivery_components: list[DeliveryComponent] = []
    # Team events only: who spoke how much, and a plain-language balance note.
    speakers: list[SpeakerStat] = []
    dominated_by: str = ""  # speaker label if one voice dominated, else ""
    balance_note: str = ""


class DeliveryResponse(BaseModel):
    transcript: str
    metrics: DeliveryMetrics
    # Team events only: the transcript split into speaker turns.
    utterances: list[Utterance] = []


# --- Account / progress (logged-in users) ----------------------------------

class SessionSaveRequest(BaseModel):
    """A completed session to persist (the feedback-screen bundle). The backend
    flattens a few columns from these for cheap progress queries."""

    scenario: ScenarioResponse
    score: ScoreResponse
    response: str
    followup_answer: str = ""
    delivery: DeliveryMetrics | None = None
    utterances: list[Utterance] = []
    event_id: str = ""  # stable event slug (for grouping / targeted practice)
    retry_of_session_id: str | None = None


class SessionSaved(BaseModel):
    id: str


class SessionSummary(BaseModel):
    """Compact row for the recent-sessions list."""

    id: str
    created_at: str
    topic: str = ""
    event: str = ""
    content_score: int = 0
    level: RubricLevel = "novice"
    mode: str = ""
    filler_per_min: float | None = None
    pace_wpm: int | None = None
    retry_of_session_id: str | None = None


class SessionDetail(BaseModel):
    """A full stored session, enough to re-render the feedback screen."""

    id: str
    created_at: str
    scenario: ScenarioResponse
    score: ScoreResponse
    response: str
    followup_answer: str = ""
    delivery: DeliveryMetrics | None = None
    utterances: list[Utterance] = []
    retry_of_session_id: str | None = None


class DeliveryTrend(BaseModel):
    available: bool
    note: str
    metric: str = "filler_per_min"
    early: float | None = None
    recent: float | None = None
    recent_wpm: int | None = None
    spoken_sessions: int = 0


class CriterionMastery(BaseModel):
    criterion_id: str
    name: str
    domain: str = ""
    sessions: int
    recent_level: RubricLevel
    consistent_level: RubricLevel
    avg_rank: float


class WeakestCriterion(BaseModel):
    criterion_id: str
    name: str
    domain: str = ""
    consistent_level: RubricLevel
    note: str


class ScoreTrendPoint(BaseModel):
    created_at: str
    score: int


class ScoreTrend(BaseModel):
    available: bool
    points: list[ScoreTrendPoint] = []
    direction: str = "flat"
    note: str


class ProgressResponse(BaseModel):
    sessions_count: int
    delivery_trend: DeliveryTrend
    criterion_mastery: list[CriterionMastery] = []
    weakest_criterion: WeakestCriterion | None = None
    score_trend: ScoreTrend


# --- Mastery Blitz (Phase 5) ----------------------------------------------


class BlitzScenario(BaseModel):
    """A short, predetermined drill scenario."""
    id: str
    text: str


class BlitzAnswer(BaseModel):
    """One drilled term + the student's quick (typed or transcribed) answer."""
    criterion_id: str
    response: str = ""


class BlitzScoreRequest(BaseModel):
    scenario: str = Field(max_length=1200)
    answers: list[BlitzAnswer] = Field(min_length=1, max_length=12)


class BlitzResult(BaseModel):
    criterion_id: str
    verdict: Literal["correct", "partial", "missed"] = "missed"
    note: str = ""


class BlitzScoreResponse(BaseModel):
    results: list[BlitzResult]


class TranscribeResponse(BaseModel):
    transcript: str
