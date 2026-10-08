"""FastAPI application, content loop (independent evaluation framework).

Endpoints:
- GET  /api/health         liveness
- GET  /api/config         client-safe runtime config
- GET  /api/framework      our business domains (for UI hints)
- GET  /api/rubric         the scoring levels (labels + descriptions) for the UI
- GET  /api/terms          the study corpus (flashcards / course units)
- GET  /api/quiz           multiple-choice questions from the pre-generated bank
- POST /api/feedback       record a piece of user feedback
- POST /api/scenario       interpret a free-text request, select framework
                           criteria, and generate an original scenario
- POST /api/score-content  grade a response against the selected criteria
- POST /api/score-delivery transcribe audio + compute deterministic delivery metrics
- POST /api/score-video    observable eye-contact/expression checks on sampled frames
- GET  /api/usage          this caller's tier + remaining monthly allowance
- GET  /api/stats          site-wide totals: role-plays, Blitz drills, scenarios
- GET  /api/course/{id}    an event's study path (anonymous-friendly)
- POST /api/course/enroll  start/switch the signed-in user's path
- POST /api/study/mark     fold a flip/quiz/blitz/role-play result into progress
- POST /api/plan/preview   a study plan from inputs, unsaved (anonymous-friendly)
- GET/PUT/DELETE /api/plan the signed-in user's saved study plan
- GET  /api/me             name + chapter memberships (+ unread counts)
- /api/chapters/...        chapters: create, join, roster, student profiles,
                           feed and assignments, messages (see that section)
- POST /api/activity       record a finished quiz / Blitz / flashcard set, or a live role-play

Plus the server-rendered study pages (app/seo.py): /flashcards, /flashcards/{event},
/robots.txt and /sitemap.xml. Those are plain HTML rather than JSON, they are the
only pages a search crawler can read without executing the SPA bundle.

The Vite dev server proxies /api/* here, so no CORS in development. Provider keys
stay server-side; the frontend only ever talks to /api/*. The judge's instructions
are never returned to the client, only the participant-facing situation and (after
the response) the follow-up questions.

The evaluation layer references OUR framework (framework.json) only: no DECA
performance-indicator text, codes, or event-to-PI mapping exists anywhere here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Literal

import anyio.to_thread
import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, Response, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from starlette.concurrency import run_in_threadpool

from . import admin_samples, blitz, chapters, config, courses, db, delivery, events, framework, interpret, llm, notify, plan, progress, prompts, quiz, rubric, scenario_cache, seo, stats, study, taxonomy, terms, transcription, usage, video
from .auth import current_user, optional_user
from pydantic import BaseModel
from .ratelimit import daily_cap, daily_cap_completion, rate_limit, rate_limit_completion
from .schemas import (
    ActivityIn,
    AdminChapter,
    AdminChapterStatus,
    AnalyticalSection,
    AssignmentRow,
    AssignmentStatus,
    AssignmentTarget,
    ChapterCreate,
    ChapterInfo,
    ChapterJoin,
    CodeRotate,
    MeResponse,
    Membership,
    MessageIn,
    MessageOut,
    PostCreate,
    PostOut,
    ProfileIn,
    ProfileOut,
    ReadMark,
    RosterManager,
    RosterResponse,
    RosterStudent,
    StudentProfile,
    ThreadSummary,
    CreativityScore,
    Criterion,
    CriterionScore,
    DeliveryMetrics,
    DeliveryResponse,
    DomainSummary,
    EventSummary,
    FeedbackRequest,
    FinalScore,
    Mode,
    PresentationSection,
    ProgressResponse,
    PublicConfig,
    BlitzScenario,
    BlitzResult,
    BlitzScoreRequest,
    BlitzScoreResponse,
    CourseResponse,
    DepthScore,
    EnrollRequest,
    PlanInputs,
    PlanResponse,
    PublicStats,
    StatReport,
    QuizQuestion,
    QuizResponse,
    Sampling,
    StudyMarkRequest,
    StudyMarkResponse,
    ScenarioRequest,
    ScenarioResponse,
    ScoreRequest,
    ScoreResponse,
    SessionDetail,
    SessionSaveRequest,
    SessionSaved,
    SessionSummary,
    SubScore,
    Term,
    Timing,
    TranscribeResponse,
    Utterance,
    VideoMetrics,
    VideoRequest,
)
from . import mathcheck

# How many blocking calls may be in flight at once.
#
# Everything slow in this app is I/O waiting on somebody else, the transcription
# provider's poll loop, an Anthropic completion, a Supabase round trip, so these
# threads spend their lives asleep, not competing for CPU. The default of 40 is
# tuned for short database calls; here a single transcription can hold its thread
# for the length of a student's recording, and once all 40 are held every plain
# `def` endpoint in this file (they share the same pool) queues behind them. The
# raised ceiling is what keeps a class submitting together from stalling each
# other; the real spend limits are the guards in ratelimit.py, not this number.
_THREADPOOL_SIZE = int(os.getenv("THREADPOOL_SIZE", "120"))


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Must happen inside the running loop: the limiter is loop-scoped state.
    anyio.to_thread.current_default_thread_limiter().total_tokens = _THREADPOOL_SIZE
    log.info("threadpool sized to %d", _THREADPOOL_SIZE)
    yield


app = FastAPI(title="PI Coach", version="1.0.0", lifespan=_lifespan)

# Compress anything worth compressing. The study corpus is the reason: /api/terms
# is 1.1MB of JSON and the server-rendered deck pages run to 14,000 words each,
# both of which are almost entirely repeated prose and shrink by roughly 80
# percent. On a phone on school wifi that is the difference between a visible
# pause on the Study tab and none. 1KB floor so tiny replies don't pay the CPU.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Server-rendered study pages (/flashcards, /flashcards/{event}) plus robots.txt and
# sitemap.xml. Included here, near the top, because Starlette matches routes in
# registration order and the SPA is mounted at "/" at the very bottom of this file,
# anything registered after that mount is unreachable.
app.include_router(seo.router)

# How long a browser may reuse the reference data without asking. These three
# endpoints read files off disk that only change when we deploy, so the risk of a
# stale copy is one release cycle at worst, and a student mid-session keeps the
# copy they started with either way. `stale-while-revalidate` is what makes a
# return visit feel instant: serve the old answer, refresh in the background.
STATIC_CACHE = "public, max-age=600, stale-while-revalidate=86400"

# Standard participant-facing procedures (our own wording, original material).
PROCEDURES = [
    "You have up to 10 minutes to review the situation and prepare. You may make notes to use during your presentation.",
    "You then have up to 10 minutes to present to the judge.",
    "You are evaluated on your solution and how well you demonstrate the business skills listed for this role-play.",
    "The judge will ask you follow-up questions after your presentation.",
]


# Use uvicorn's configured logger so our INFO lines actually reach the log stream.
log = logging.getLogger("uvicorn.error")


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness check used by the frontend to prove the wire works."""
    return {"status": "ok"}


@app.get("/api/config", response_model=PublicConfig)
def public_config() -> PublicConfig:
    """Client-safe runtime config (public PostHog + Supabase keys, if configured)."""
    return PublicConfig(
        posthog_key=config.POSTHOG_KEY,
        posthog_host=config.POSTHOG_HOST,
        supabase_url=config.SUPABASE_URL,
        supabase_anon_key=config.SUPABASE_ANON_KEY,
    )


@app.get("/api/framework", response_model=list[DomainSummary])
def get_domains(response: Response) -> list[DomainSummary]:
    """Our business domains (with criterion counts), for UI hints/examples."""
    response.headers["Cache-Control"] = STATIC_CACHE
    return [DomainSummary(**d) for d in framework.domain_summaries()]


@app.get("/api/events", response_model=list[EventSummary])
def get_events(response: Response) -> list[EventSummary]:
    """The role-play events students pick from (our own catalog), in file order.
    Each carries its cluster (for grouping) and original focus suggestions."""
    response.headers["Cache-Control"] = STATIC_CACHE
    return [EventSummary(**e) for e in events.event_summaries()]


@app.get("/api/terms", response_model=list[Term])
def get_terms(response: Response, ids: str = "") -> list[Term]:
    """Study terms. With `ids` (comma list) returns just those (a weak-term deck, a
    flagged set, or a course unit); with no `ids` returns the whole corpus (the
    library). Each term carries a plain definition, a worked example run through the
    four DECA beats, and one term-specific common mistake.

    These are study content, NOT the grading criteria, see app/terms.py. Terms that
    map to a graded criterion carry `criterion_id` and tier="core"; the rest are
    study-only. Grading reads framework.json and never touches this path."""
    response.headers["Cache-Control"] = STATIC_CACHE
    wanted = [x.strip() for x in ids.split(",") if x.strip()]
    source = terms.get_terms(wanted) if wanted else terms.all_terms()
    return [Term(**t) for t in source]


@app.get("/api/rubric")
def get_rubric() -> dict:
    """The scoring levels (labels, descriptions, band) for the UI to render."""
    r = rubric.load_rubric()
    return {
        "levels": r["levels"],
        "level_labels": r["level_labels"],
        "level_descriptions": r["level_descriptions"],
        "criterion_max_points": r["criterion_max_points"],
    }


@app.post("/api/feedback", dependencies=[Depends(rate_limit)])
def feedback(req: FeedbackRequest, background: BackgroundTasks) -> dict[str, str]:
    """Record a piece of user feedback. No account needed; logged server-side,
    mirrored to analytics from the client, and (if configured) emailed to the
    operator via a best-effort background task."""
    log.info(
        "FEEDBACK rating=%s email=%s page=%s message=%r",
        req.rating, req.email or "-", req.page or "-", req.message,
    )
    background.add_task(
        notify.send_feedback_email,
        req.rating, req.email, req.page, req.message,
    )
    return {"status": "ok"}


def _criterion_view(c: dict, mode: Mode) -> Criterion:
    """Shape a framework criterion for the client. Learn mode reveals the teaching
    fields; Competition mode sends only the name (+ domain/topic), so the participant
    sees what's assessed but not the answer key."""
    if mode == "learn":
        return Criterion(**{k: c.get(k, "") for k in (
            "id", "domain", "topic", "name", "definition",
            "strong_looks_like", "weak_looks_like", "coaches",
        )})
    return Criterion(id=c["id"], domain=c["domain"], topic=c["topic"], name=c["name"])


@app.post("/api/scenario", response_model=ScenarioResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
async def scenario(
    req: ScenarioRequest,
    background: BackgroundTasks,
    user: dict | None = Depends(optional_user),
) -> ScenarioResponse:
    """Plan the session from the chosen event (+ optional focus), select framework
    criteria, and generate an original scenario built to require exactly those.

    Generation is attempted only on a cache MISS. On a hit we return a scenario
    another user already paid for, instantly and for free, see app/scenario_cache.py
    for how the key is built and when a cached scenario is allowed to be served.
    `optional_user` is used (not `current_user`) because the practice loop stays
    fully anonymous; knowing who is asking only makes the never-repeat guarantee
    survive a device change."""
    # 0) Resolve the chosen event (if any) from our catalog.
    event = events.get_event(req.event) if req.event else None
    if req.event and event is None:
        raise HTTPException(status_code=400, detail="Unknown event.")

    # 1) Plan -> topic + industry + the domain pool (event drives the domains).
    try:
        interp = await run_in_threadpool(interpret.plan_session, event, req.request)
    except interpret.OutOfScope as e:
        raise HTTPException(status_code=422, detail=e.message)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # 1b) Scenario variety (Phase 3): on the no-focus path (where scenarios were
    # repetitive), sample a fixed combination from the event's taxonomy and inject
    # it as concrete parameters, so the model executes on a given setup instead of
    # inventing diversity. A free-text focus is the user steering it themselves, so
    # we leave that path to the interpretation above. Events without a taxonomy
    # entry yet fall through unchanged.
    sampled = None
    if event is not None and not req.request.strip() and taxonomy.has_event(event["id"]):
        sampled = taxonomy.sample(event["id"], req.avoid)
    if sampled is not None:
        interp["topic"] = sampled["dims"]["subtopic"]["label"]
        interp["industry"] = sampled["dims"]["business_type"]["label"]

    pool = interpret.candidate_pool(interp["domain_ids"])

    # 1c) Cache lookup, BEFORE we spend anything on generation.
    #
    # The key is built from the interpreted plan, not the raw request text, so
    # "marketing for a restaurant" and "restaurant marketing" land on the same key
    # (see app/scenario_cache.py). `strict_context` encodes the quality rule: when
    # the user typed a focus we only reuse an industry-matching scenario, because
    # answering a restaurant question with a gym scenario is a regression no cost
    # saving justifies. With no focus, anything under the key is a correct answer.
    focused = bool(req.request.strip())
    cache_key = scenario_cache.build_key(req.level, interp["domain_ids"], req.event)
    context = scenario_cache.normalize_context(interp["industry"])
    uid = user["id"] if user else None

    hit = await scenario_cache.lookup(
        cache_key=cache_key,
        seen_ids=req.seen,
        user_id=uid,
        want_context=context,
        strict_context=focused,
    )
    if hit is not None:
        # Bookkeeping (serve counter + this user's seen list) happens after the
        # response is on the wire: the student already has their scenario, and no
        # cache accounting should be able to slow that down or fail it.
        background.add_task(scenario_cache.record_served, hit["id"])
        log.info("SCENARIO cache=hit key=%s id=%s", cache_key, hit["id"])
        cached = ScenarioResponse(**hit["scenario"])
        cached.scenario_id = hit["id"]  # so the client records it and never re-sees it
        # Mode is a per-request view concern, not a property of the scenario: the
        # same situation is served to Learn and Competition users, and only the
        # criteria's teaching fields differ. Re-derive that view from OUR framework
        # rather than trusting whatever mode the row was cached under.
        cached.mode = req.mode
        cached.criteria = [
            _criterion_view(c, req.mode)
            for c in framework.get_criteria([c.id for c in cached.criteria])
        ]
        return cached

    log.info("SCENARIO cache=miss key=%s focused=%s", cache_key, focused)

    # 2) Generate: the model selects the criteria from the pool AND writes the scenario.
    system, user = prompts.build_scenario_prompt(
        interp["topic"], interp["industry"], req.level, pool, event,
        params=sampled["labels"] if sampled else None,
    )
    try:
        data = await run_in_threadpool(
            llm.complete_json, system, user, model=config.SCENARIO_MODEL, max_tokens=2400
        )
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        log.warning("SCENARIO generation failed: %s", e)
        raise HTTPException(
            status_code=502,
            detail="We couldn't build a role-play just now. Give it another try.",
        )

    situation = str(data.get("situation", "")).strip()
    if not situation:
        raise HTTPException(status_code=502, detail="The model returned an empty scenario.")

    # Share-card headline. Deliberately NOT fatal when missing, unlike `situation`
    # above: a hookless scenario is a slightly worse share card, and that must never
    # be a reason to fail a student's rep. The prompt caps it at 20 words; anything
    # wildly past that is a model slip that would overflow the card hero, so we drop
    # it and let the client fall back to the topic rather than ship a broken card.
    hook = str(data.get("hook", "")).strip()
    if len(hook) > 200:
        log.warning("SCENARIO hook too long (%d chars), dropping", len(hook))
        hook = ""

    # The criteria selected here are the EXACT criteria scoring will grade against.
    criteria = interpret.resolve_selection([str(i) for i in data.get("criteria_ids", [])], pool)
    if not criteria:
        raise HTTPException(status_code=502, detail="No evaluation criteria were selected for this scenario.")

    followups = [str(q).strip() for q in data.get("followup_questions", []) if str(q).strip()]
    domain_focus = sorted({c["domain"] for c in criteria})

    built = ScenarioResponse(
        topic=interp["topic"],
        industry=interp["industry"],
        event=event["name"] if event else "",
        event_kind=event["kind"] if event else "",
        quantitative=events.is_quantitative(event),
        team=events.is_team(event),
        timing=Timing(**events.timing_for(event)),
        domain_focus=domain_focus,
        level=req.level,
        mode=req.mode,
        criteria=[_criterion_view(c, req.mode) for c in criteria],
        procedures=PROCEDURES,
        situation=situation,
        hook=hook,
        followup_questions=followups,
        sampling=Sampling(signature=sampled["signature"], labels=sampled["labels"]) if sampled else None,
    )

    # 3) Pool it, so the next student with this key gets it instantly and free.
    #
    # Only scenarios that reached this point are stored: a non-empty situation and
    # exactly the required criteria count are both already enforced above. That
    # matters more here than elsewhere because a cached scenario is served to many
    # users, a bad one gets amplified instead of absorbed.
    #
    # We cache the LEARN view of the criteria (teaching fields populated) and
    # re-derive the mode-specific view on the way out. Caching the Competition
    # view would bake blanked fields into the row and quietly break Learn mode for
    # everyone who hit that scenario afterwards.
    cache_row = built.model_copy(update={
        "mode": "learn",
        "criteria": [_criterion_view(c, "learn") for c in criteria],
    })
    scenario_id = await scenario_cache.store(
        cache_key=cache_key,
        level=req.level,
        event_id=req.event,
        domain_ids=interp["domain_ids"],
        criteria_ids=[c["id"] for c in criteria],
        industry_hint=context,
        sampling_signature=sampled["signature"] if sampled else "",
        scenario_json=cache_row.model_dump(),
    )
    built.scenario_id = scenario_id
    background.add_task(stats.bump, "scenario")  # freshly written, not a cache reuse
    return built


def _score_one(c: dict, raw: dict) -> CriterionScore:
    """Build one validated CriterionScore from a model entry, clamping to the band."""
    level, points = rubric.clamp_points(str(raw.get("level", "novice")), raw.get("points", 0))
    return CriterionScore(
        criterion_id=c["id"],
        name=c["name"],
        domain=c["domain"],
        topic=c["topic"],
        level=level,  # type: ignore[arg-type]
        points=points,
        max_points=rubric.criterion_max(),
        headline=str(raw.get("headline", "")).strip(),
        feedback=str(raw.get("feedback", "")).strip(),
        evidence=[str(q) for q in raw.get("evidence", []) if str(q).strip()],
        gaps=[str(g).strip() for g in raw.get("gaps", []) if str(g).strip()],
        suggestion=str(raw.get("suggestion", "")).strip(),
    )


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _sub_score(raw: dict) -> SubScore:
    """One 1-4 analytical sub-criterion, clamped to the valid band."""
    try:
        s = int(round(float(raw.get("score", 2))))
    except (TypeError, ValueError):
        s = 2  # default to the middle of the scale, per the global grading rules
    ev = raw.get("evidence")
    ev = str(ev).strip() if ev not in (None, "", "null") else None
    return SubScore(score=int(_clamp(s, 1, 4)), justification=str(raw.get("justification", "")).strip(), evidence=ev)


def _quoted(evidence: str | None, haystack: str) -> bool:
    """Whether a cited quote actually appears in the participant's own words.

    The model is asked for verbatim substrings; this checks it. Loose on whitespace
    and case (transcripts and the model both normalize unpredictably) but strict
    about the words themselves, a quote we can't find is a quote they didn't say.
    """
    if not evidence:
        return False
    norm = lambda s: " ".join(s.lower().replace("’", "'").split())  # noqa: E731
    hay = norm(haystack)
    # An ellipsis joins two real passages; each side has to be theirs.
    parts = [p for p in (norm(p).strip(" .") for p in re.split(r"\.{3,}|…", evidence)) if p]
    return bool(parts) and all(p in hay for p in parts)


def _own_words(sub: SubScore, said: str) -> SubScore:
    """Drop a sub-score's quote when it isn't something the participant said. The
    feedback screen prints it inside quotation marks as their words."""
    if sub.evidence and said and not _quoted(sub.evidence, said):
        return sub.model_copy(update={"evidence": None})
    return sub


def _build_depth(raw: dict, response_text: str, offered: dict[str, dict]) -> DepthScore:
    """Section 2's depth bonus: credit for genuinely APPLYING a related study term.

    Three deterministic gates, because the prompt alone can't be trusted with the
    one rule that matters here, mention must not pay:
      1. the cited terms must be ones we actually offered (no inventing);
      2. the quote must be findable in the participant's own text (no hallucinating
         the evidence for a term they never used);
      3. no surviving term or no quote => no bonus.
    Bonus-only and capped by the caller, so the worst case is a lost +0.5, never a
    penalty on an honest answer.
    """
    if not offered:
        return DepthScore()
    try:
        bonus = float(raw.get("bonus", 0.0))
    except (TypeError, ValueError):
        bonus = 0.0
    bonus = min((0.0, 0.25, 0.5), key=lambda b: abs(b - bonus))

    cited = [str(t).strip() for t in raw.get("terms", []) if str(t).strip() in offered]
    ev = raw.get("evidence")
    ev = str(ev).strip() if ev not in (None, "", "null") else None
    if not cited or not _quoted(ev, response_text):
        return DepthScore(terms=cited, justification=str(raw.get("justification", "")).strip())
    return DepthScore(
        bonus=bonus,
        terms=cited,
        justification=str(raw.get("justification", "")).strip(),
        evidence=ev,
    )


def _build_analytical(raw: dict, response_text: str = "", depth_offered: dict[str, dict] | None = None) -> AnalyticalSection:
    """Section 2: take the model's 1-4 sub-scores + creativity/depth bonuses, then
    compute the roll-up arithmetic DETERMINISTICALLY (the model is never trusted to
    do the weighting or the min())."""
    framing = _own_words(_sub_score(raw.get("framing", {})), response_text)
    solution = _own_words(_sub_score(raw.get("solution_quality", {})), response_text)
    pi_app = _own_words(_sub_score(raw.get("pi_application", {})), response_text)

    craw = raw.get("creativity", {}) or {}
    try:
        bonus = float(craw.get("bonus", 0.0))
    except (TypeError, ValueError):
        bonus = 0.0
    # Snap to the allowed rungs and gate on solution quality (no bonus unless 2b >= 3).
    bonus = min((0.0, 0.25, 0.5), key=lambda b: abs(b - bonus))
    if solution.score < 3:
        bonus = 0.0
    cev = craw.get("evidence")
    cev = str(cev).strip() if cev not in (None, "", "null") else None
    if cev and response_text and not _quoted(cev, response_text):
        cev = None
    creativity = CreativityScore(bonus=bonus, justification=str(craw.get("justification", "")).strip(), evidence=cev)
    depth = _build_depth(raw.get("depth", {}) or {}, response_text, depth_offered or {})

    core = framing.score * 0.30 + solution.score * 0.45 + pi_app.score * 0.25
    # The clamp is what makes both bonuses safe: they can lift a good answer toward
    # the ceiling but can never push it past one, so vocabulary cannot paper over
    # weak analysis.
    section = _clamp(core + bonus + depth.bonus, 0.0, 4.0)
    return AnalyticalSection(
        framing=framing,
        solution_quality=solution,
        pi_application=pi_app,
        creativity=creativity,
        depth=depth,
        core_score=round(core, 3),
        section_score=round(section, 3),
        section_percent=round(section / 4 * 100, 1),
    )


def _build_presentation(raw: dict, spoken: bool, delivery_score: int | None) -> PresentationSection:
    """Section 3: the model's 1-4 read of presentation, blended with the objective
    delivery score when the run was spoken (60% metric / 40% model read). Typed
    runs use the model's read alone."""
    try:
        model_score = int(round(float(raw.get("score", 2))))
    except (TypeError, ValueError):
        model_score = 2
    model_score = int(_clamp(model_score, 1, 4))
    model_percent = model_score / 4 * 100

    if spoken and delivery_score is not None:
        percent = round(0.6 * delivery_score + 0.4 * model_percent, 1)
    else:
        percent = round(model_percent, 1)
    return PresentationSection(
        section_score=round(percent / 25, 3),
        section_percent=percent,
        notes=str(raw.get("notes", "")).strip(),
    )


@app.post("/api/score-content", response_model=ScoreResponse, dependencies=[Depends(rate_limit_completion), Depends(daily_cap_completion)])
def score_content(req: ScoreRequest, background: BackgroundTasks) -> ScoreResponse:
    """Grade a response against the selected framework criteria using the weighted
    three-section rubric (60% performance indicators, 25% analytical, 15% presentation)."""
    # Resolve criteria from our framework, never trust the client for their text.
    criteria = framework.get_criteria(req.criteria_ids)
    if not criteria:
        raise HTTPException(status_code=400, detail="Unknown evaluation criteria.")

    # Re-derive server-side whether this event needs deterministic math checks.
    quantitative = events.is_quantitative(events.get_event(req.event)) if req.event else False

    # Related study terms this role-play does NOT grade, offered so that reaching
    # beyond the criteria can be credited (Section 2 depth bonus, bonus-only).
    depth_vocab = terms.depth_vocab_for(criteria)

    system, user = prompts.build_scoring_prompt(
        req.scenario, criteria, req.response, req.followup_questions, req.followup_answer,
        quantitative, req.spoken, req.delivery_score, depth_vocab=depth_vocab,
    )
    try:
        # 8192, not 4096: the reply carries a full paragraph of feedback plus
        # verbatim evidence quotes for every criterion, and a wordy run on a long
        # transcript could brush the old ceiling, at which point the JSON came
        # back cut in half and the student lost a rep they had already recorded.
        # A ceiling is not a bill; unused headroom costs nothing.
        data = llm.complete_json(system, user, model=config.SCORING_MODEL, max_tokens=8192)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        # The technical reason goes to the log, not to a high-schooler staring at
        # a failed rep. "Could not parse model JSON: Expecting ',' delimiter" used
        # to render verbatim in the app's error banner.
        log.warning("SCORING failed: %s", e)
        raise HTTPException(
            status_code=502,
            detail=(
                "We couldn't finish grading this response. Your recording and "
                "delivery feedback are safe. Try grading again in a moment."
            ),
        )

    # --- Section 1: Performance Indicators (60%) ---
    entries = {str(e.get("criterion_id", "")): e for e in data.get("performance_indicators", [])}
    scores = [_score_one(c, entries.get(c["id"], {})) for c in criteria]
    total = sum(s.points for s in scores)
    max_points = sum(s.max_points for s in scores)
    pi_percent = (total / max_points) * 100 if max_points else 0.0

    # --- Section 2: Analytical & Problem-Solving (25%) ---
    # Evidence for the depth bonus is checked against what the participant actually
    # said, main response and follow-up both count, since either can carry it.
    said = f"{req.response}\n{req.followup_answer}"
    analytical = _build_analytical(data.get("analytical", {}) or {}, said, {t["id"]: t for t in depth_vocab})

    # --- Section 3: Professional Presentation (15%) ---
    presentation = _build_presentation(data.get("presentation", {}) or {}, req.spoken, req.delivery_score)

    # --- Final weighted roll-up (deterministic; the model never does the math) ---
    final_percent = round(
        pi_percent * 0.60 + analytical.section_percent * 0.25 + presentation.section_percent * 0.15, 1
    )
    fraw = data.get("final", {}) or {}
    final = FinalScore(
        percent=final_percent,
        top_strength=str(fraw.get("top_strength", "")).strip(),
        biggest_weakness=str(fraw.get("biggest_weakness", "")).strip(),
        one_key_fix=str(fraw.get("one_key_fix", "")).strip(),
    )
    overall = round(final_percent)

    # Deterministically recompute every calculation the model flagged. Python's
    # result is authoritative, the model is never trusted for arithmetic.
    math_checks = mathcheck.verify_all(data.get("math_checks", [])) if quantitative else []

    background.add_task(stats.bump, "roleplay")
    return ScoreResponse(
        scores=scores,
        total_points=total,
        max_points=max_points,
        overall_percent=overall,
        overall_level=rubric.overall_level(overall),  # type: ignore[arg-type]
        summary=str(data.get("summary", "")).strip(),
        strengths=[str(x) for x in data.get("strengths", []) if str(x).strip()],
        improvements=[str(x) for x in data.get("improvements", []) if str(x).strip()],
        followup_feedback=str(data.get("followup_feedback", "")).strip(),
        math_checks=math_checks,  # type: ignore[arg-type]
        pi_section_score=round(pi_percent / 25, 3),
        pi_section_percent=round(pi_percent, 1),
        analytical=analytical,
        presentation=presentation,
        final=final,
    )


class SeenScenario(BaseModel):
    scenario_id: str = ""


@app.post("/api/scenario/seen")
async def mark_scenario_seen(
    req: SeenScenario, user: dict | None = Depends(optional_user)
) -> dict[str, str]:
    """Confirm that a scenario was actually put on screen.

    Separate from serving it, because the client PREFETCHES: it requests a
    scenario the moment an event is picked, before the student has committed. If
    serving marked it seen, every browse through the event list would burn pool
    entries for role-plays nobody ever read, permanently, since seen is forever.
    So the client tells us when it really showed one.

    Anonymous callers are a no-op here (there is no server-side history to write);
    their never-repeat list lives in localStorage.
    """
    if user and req.scenario_id:
        await scenario_cache.mark_seen(req.scenario_id, user["id"])
    return {"status": "ok"}


@app.get("/api/scenario/{scenario_id}", response_model=ScenarioResponse, dependencies=[Depends(rate_limit)])
async def get_scenario_by_id(
    scenario_id: str,
    background: BackgroundTasks,
    mode: Mode = "competition",
) -> ScenarioResponse:
    """Serve one pooled scenario by id, the shared-challenge deep link.

    This is how a Gauntlet card closes its loop: the card's URL carries the
    scenario_id, and whoever opens it gets the SAME role-play their friend played,
    so the score on the card is actually comparable.

    No `daily_cap` dependency: this spends no model tokens (the scenario already
    exists in the pool). The rep it leads to is metered where the tokens are
    actually spent, scoring, and by the client-side signed-out roleplay cap.
    """
    hit = await scenario_cache.get_by_id(scenario_id)
    if hit is None:
        raise HTTPException(status_code=404, detail="That challenge link has expired or was never valid.")

    background.add_task(scenario_cache.record_served, hit["id"])
    scenario = ScenarioResponse(**hit["scenario"])
    scenario.scenario_id = hit["id"]
    # Mode is a per-request view, exactly as on the cache-hit path above: rows are
    # pooled in the Learn view and the requested view is re-derived from OUR
    # framework rather than trusting whatever mode the row was stored under.
    scenario.mode = mode
    scenario.criteria = [
        _criterion_view(c, mode)
        for c in framework.get_criteria([c.id for c in scenario.criteria])
    ]
    return scenario


@app.get("/api/usage")
async def get_usage(user: dict | None = Depends(optional_user)) -> dict:
    """This caller's tier and remaining monthly allowance.

    Fetched BEFORE a session starts so the UI can show what's left up front,
    nobody should discover a cap halfway through a rep they've already prepped
    for. Anonymous callers get the anonymous tier's numbers, which the client
    also enforces (see app/usage.py for why that one is client-side)."""
    return await usage.summary(user)


@app.get("/api/stats", response_model=PublicStats)
async def get_stats() -> PublicStats:
    """Site-wide totals for the landing page. Public and anonymous: counts only,
    cached in-process for a few minutes (app/stats.py)."""
    return PublicStats(**await stats.snapshot())


@app.post("/api/stats/report", dependencies=[Depends(rate_limit)])
async def report_stat(req: StatReport, background: BackgroundTasks) -> dict:
    """A finished quiz round or a flipped-through deck, reported by the browser so
    the site-wide totals include it. Anonymous on purpose: both work signed out,
    and those are exactly the students no other table sees. Counts only, clamped
    in app/stats.py."""
    background.add_task(stats.report, req.kind, req.count)
    return {"ok": True}


@app.post("/api/score-delivery", response_model=DeliveryResponse, dependencies=[Depends(rate_limit_completion), Depends(daily_cap_completion)])
async def score_delivery(
    audio: UploadFile = File(...),
    target_seconds: int = Form(delivery.DEFAULT_TARGET_SECONDS),
    diarize: bool = Form(False),
    user: dict | None = Depends(optional_user),
) -> DeliveryResponse:
    """Transcribe a spoken response and compute deterministic delivery metrics.

    For team events (`diarize=true`) we also request speaker labels and add a
    per-speaker talk breakdown + turn-by-turn transcript, so the app can show who
    dominated and attribute each turn. Audio is processed and discarded here, we
    keep only the transcript + numbers (minors' data minimization; the browser
    holds the recording for playback, deleting it unless the user opts to keep it).
    """
    raw = await audio.read()
    if not raw:
        # Nothing was captured (mic blocked, or "stop" hit before any audio),
        # a client problem, so a clear 422 rather than a scary gateway-style 5xx.
        raise HTTPException(
            status_code=422,
            detail="Nothing was recorded: no audio reached the server. Record your response, then submit again.",
        )

    # Claim the voice session AFTER the empty-audio check (a failed upload must
    # not cost the student an allowance) and BEFORE the paid transcription call.
    # For signed-in users this is atomic and server-enforced; anonymous callers
    # are metered client-side, see app/usage.py for that tradeoff.
    receipt = await usage.claim(user, "voice")

    try:
        # Off the event loop, and this is the one that mattered most: `transcribe`
        # uploads the audio and then POLLS the provider with a blocking
        # `time.sleep(2)` until the transcript is ready, tens of seconds on a
        # normal rep. Awaiting that inline in an `async def` pinned the single
        # worker's event loop for the whole poll, so every other request (another
        # student's grade, the SPA's own assets, Render's health check) simply
        # queued behind it. transcription.py's docstring already assumed a
        # threadpool; this is what actually puts it in one.
        result = await run_in_threadpool(transcription.transcribe, raw, diarize=diarize)
    except transcription.TranscriptionNotConfigured as e:
        await usage.release(receipt, "voice")
        raise HTTPException(status_code=503, detail=str(e))
    except transcription.TranscriptionError:
        # The session produced nothing, so it shouldn't be charged for.
        await usage.release(receipt, "voice")
        # Almost always a silent, too-short, or unintelligible clip the provider
        # can't decode. Give the likely cause and a next step, not a raw 502.
        raise HTTPException(
            status_code=502,
            detail=(
                "We couldn't transcribe that recording. It may have been silent, too "
                "short, or picked up no clear speech. Check your microphone, then "
                "record and submit again."
            ),
        )

    metrics = delivery.compute_delivery(result.words, result.audio_duration_s, target_seconds=target_seconds)
    utterances: list[Utterance] = []
    if diarize:
        spk = delivery.compute_speakers(result.words)
        metrics["speakers"] = spk["speakers"]
        metrics["dominated_by"] = spk["dominated_by"]
        metrics["balance_note"] = spk["balance_note"]
        utterances = [
            Utterance(speaker=u.speaker, text=u.text,
                      start_seconds=round(u.start_ms / 1000, 1), end_seconds=round(u.end_ms / 1000, 1))
            for u in result.utterances if u.text
        ]
    return DeliveryResponse(transcript=result.text, metrics=DeliveryMetrics(**metrics), utterances=utterances)


@app.post("/api/score-video", response_model=VideoMetrics, dependencies=[Depends(rate_limit_completion), Depends(daily_cap_completion)])
async def score_video(req: VideoRequest, user: dict = Depends(current_user)) -> VideoMetrics:
    """Analyze sampled frames for observable eye contact and expression.

    REQUIRES AN ACCOUNT, deliberately. Video is the cost driver (roughly 2-3x an
    audio-only session), and an account is what makes the cap enforceable
    server-side. It is also always optional: the audio-only path is a first-class
    route through the whole loop and is never degraded by this endpoint existing.

    Nothing is retained. Frames arrive in the request body, are analyzed, and are
    gone when this returns; the full video is never recorded or uploaded at all
    (the client samples stills from the live camera preview). See app/video.py for
    the claim rules, every number here is an observable check, never an inferred
    internal state.
    """
    if not req.frames:
        raise HTTPException(
            status_code=422,
            detail="No frames were captured. Check your camera permission and try again.",
        )

    receipt = await usage.claim(user, "video")
    try:
        metrics = await run_in_threadpool(
            video.analyze, [(f.media_type, f.data) for f in req.frames]
        )
    except video.VideoNotConfigured as e:
        await usage.release(receipt, "video")
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError:
        # The student got nothing, so their video allowance shouldn't be spent.
        await usage.release(receipt, "video")
        raise HTTPException(
            status_code=502,
            detail="We couldn't analyze your video this time. Your voice feedback is unaffected.",
        )

    if metrics["checks"] == 0:
        # Every batch failed to read, no usable checks means no honest numbers to
        # report, so refund rather than show a panel of zeroes.
        await usage.release(receipt, "video")

    # Fold the observable checks into the delivery score. Done HERE rather than on
    # the client because it is grading arithmetic: the client already knows the
    # audio score, but the weighting, the sample-size floor, and the cap are rules
    # about how much a handful of frames is allowed to be worth, and those belong
    # server-side where they can't drift per browser. See delivery.apply_video.
    extras: dict = {}
    if req.delivery_score is not None:
        adjusted, components, delta, reason = delivery.apply_video(
            req.delivery_score,
            [],  # only the video row is returned; the client holds the audio ones
            checks=metrics["checks"],
            eye_contact_count=metrics["eye_contact_count"],
        )
        extras = {
            "delivery_adjustment": delta,
            "adjusted_delivery_score": adjusted,
            "adjustment_reason": reason,
            "delivery_component": components[-1] if components else None,
        }

    return VideoMetrics(**metrics, **extras, disclaimer=video.DISCLAIMER)


# --- Mastery Blitz (Phase 5) -----------------------------------------------
# A rapid drill over the flashcard terms. The loop is model-free; the ONLY model
# call is the single batched scoring pass below (fast/cheap Haiku). Everything is
# session-local on the client, no accounts, no persistence.


@app.get("/api/blitz/scenarios", response_model=list[BlitzScenario])
def blitz_scenarios() -> list[BlitzScenario]:
    """The static pool of short drill scenarios (the client picks one per round)."""
    return [BlitzScenario(**s) for s in blitz.scenarios()]


@app.get("/api/quiz", response_model=QuizResponse)
def get_quiz(
    response: Response,
    level: Literal["", "district", "state", "icdc"] = "",
    ids: str = "",
    domains: str = "",
    exam: str = "",
    cluster: str = "",  # deprecated alias for `exam`, kept so older clients work
    count: int = Query(10, ge=1, le=40)) -> QuizResponse:
    """A drawn set of multiple-choice questions from the pre-generated bank.

    Filters: `level` (district | state | icdc), `ids` (comma list of term ids, a
    deck, a course unit, the student's weak terms), `domains` (comma list of domain
    ids), `exam` (a written exam name, expanded server-side to every domain its
    events touch). Everything is optional; with none of them the draw is the whole
    bank. `exam` is resolved here rather than on the client because the widest one
    covers nine domains, more than fits comfortably in a query string.

    The exam grouping is NOT the role-play cluster: every Principles event sits the
    Business Administration Core paper, whatever cluster its role-play belongs to.
    `cluster` stays as a deprecated alias so a client cached from before the rename
    still resolves.

    No model call happens here, the bank is written offline by scripts/gen_quiz.py
    and this is a file read (app/quiz.py). That is why the quiz is open to anonymous
    callers and carries no daily cap: a quiz round costs nothing to serve. The
    answer key and each option's rationale ship with the question so the client can
    grade the pick and teach the miss instantly; see app/quiz.py for that trade-off.

    Questions are original, written from our own study cards. No competition
    organization's exam items or indicator wording is reproduced anywhere here."""
    response.headers["Cache-Control"] = "no-store"  # a fresh draw every round
    term_ids = [x.strip() for x in ids.split(",") if x.strip()]
    domain_ids = [x.strip() for x in domains.split(",") if x.strip()]
    wanted_exam = (exam or cluster).strip()
    if wanted_exam:
        # An unknown name resolves to nothing, and an empty domain filter means
        # "the whole bank", which is the wrong answer to a typo. Fail loudly.
        expanded = events.domains_for_cluster(wanted_exam)
        if not expanded:
            raise HTTPException(status_code=404, detail=f"Unknown exam: {wanted_exam}")
        domain_ids = sorted(set(domain_ids) | set(expanded)) if domain_ids else expanded
    drawn = quiz.select(level=level, domain_ids=domain_ids, term_ids=term_ids, count=count)
    # Counts describe the POOL this filter reaches, not the draw. The client shows
    # them on the tier pills, and reporting the draw size made a Finance round look
    # like 14 questions when 312 sit behind it.
    available = quiz.counts(domain_ids=domain_ids, term_ids=term_ids)
    return QuizResponse(questions=[QuizQuestion(**q) for q in drawn], counts=available)


@app.post("/api/transcribe", response_model=TranscribeResponse, dependencies=[Depends(rate_limit_completion), Depends(daily_cap_completion)])
def transcribe(audio: UploadFile = File(...)) -> TranscribeResponse:
    """Transcript only (no delivery metrics), used for spoken blitz answers, which
    are graded on content, not delivery. Each recording is transcribed as it's
    captured so the drill never waits."""
    raw = audio.file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="Nothing was recorded.")
    try:
        result = transcription.transcribe(raw, diarize=False)
    except transcription.TranscriptionNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except transcription.TranscriptionError:
        raise HTTPException(status_code=502, detail="Couldn't transcribe that recording. Try again or type your answer.")
    return TranscribeResponse(transcript=result.text)


@app.post("/api/blitz-score", response_model=BlitzScoreResponse, dependencies=[Depends(rate_limit_completion), Depends(daily_cap_completion)])
def blitz_score(req: BlitzScoreRequest, background: BackgroundTasks) -> BlitzScoreResponse:
    """Grade a whole drill in ONE batched call: for each term, 'used correctly and
    in context?' -> correct | partial | missed + a one-line note. Term text is
    re-pinned server-side by id (never trusted from the client)."""
    # Resolve each answer's term server-side: plain definition + the card's 'Connect'
    # beat as the gold-standard "correct use" reference. Drills run over study terms,
    # so this reads terms.json, a drilled term may have no graded criterion at all.
    items: list[dict] = []
    order: list[str] = []
    for a in req.answers:
        t = terms.get_term(a.term_id)
        if not t:
            continue  # unknown id, skip rather than fail the whole drill
        good = (t.get("example") or {}).get("connect", "")
        items.append({"name": t["name"], "definition": t.get("definition", ""), "good_example": good, "response": a.response})
        order.append(a.term_id)

    if not items:
        raise HTTPException(status_code=400, detail="No known terms to grade.")

    system, user = prompts.build_blitz_prompt(req.scenario, items)
    try:
        data = llm.complete_json(system, user, model=config.BLITZ_MODEL, max_tokens=2048)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Map the model's per-index verdicts back onto criterion ids; default to
    # "missed" for anything the model skipped, so the client always gets N results.
    by_index: dict[int, dict] = {}
    raw = [r for r in data.get("results", []) if isinstance(r, dict)]
    for r in raw:
        try:
            by_index[int(r.get("index"))] = r
        except (TypeError, ValueError):
            continue
    # A model that numbers from 1, or drops the index, would otherwise shift or
    # lose every verdict and the whole round would read "missed". When the indexes
    # don't cover the items but the count does, trust the order instead.
    if set(by_index) != set(range(len(order))) and len(raw) == len(order):
        by_index = dict(enumerate(raw))
    valid = {"correct", "partial", "missed"}
    results: list[BlitzResult] = []
    for i, tid in enumerate(order):
        r = by_index.get(i, {})
        verdict = str(r.get("verdict", "missed")).lower()
        results.append(BlitzResult(
            term_id=tid,
            verdict=verdict if verdict in valid else "missed",  # type: ignore[arg-type]
            note=str(r.get("note", "")).strip(),
        ))
    background.add_task(stats.bump, "blitz")
    return BlitzScoreResponse(results=results)


# --- account: persist sessions + cross-session progress --------------------
# These are the ONLY authenticated endpoints. They require a Supabase access
# token (Depends(current_user)); the practice loop above stays fully anonymous.

@app.post("/api/sessions", response_model=SessionSaved)
async def save_session(req: SessionSaveRequest, user: dict = Depends(current_user)) -> SessionSaved:
    """Persist a completed session for the signed-in user. Stores the full
    bundles (to re-render feedback exactly) plus a few flattened columns (to make
    progress queries cheap). Raw audio is never sent or stored."""
    d = req.delivery
    criterion_results = [
        {"criterion_id": s.criterion_id, "name": s.name, "domain": s.domain, "level": s.level, "points": s.points}
        for s in req.score.scores
    ]
    row = {
        "user_id": user["id"],
        "scenario": req.scenario.model_dump(),
        "response": req.response,
        "followup_answer": req.followup_answer,
        "score": req.score.model_dump(),
        "delivery": d.model_dump() if d else None,
        # Counts + notes only; frames were never persisted anywhere.
        "video": req.video.model_dump() if req.video else None,
        "utterances": [u.model_dump() for u in req.utterances],
        "event": req.event_id or req.scenario.event,
        "content_score": int(req.score.overall_percent),
        "criterion_results": criterion_results,
        "filler_per_min": d.filler_per_min if d else None,
        "pace_wpm": d.pace_wpm if d else None,
        "long_pause_count": len(d.long_pauses) if d else None,
        "duration_seconds": d.duration_seconds if d else None,
        "retry_of_session_id": req.retry_of_session_id,
    }
    try:
        created = await db.insert_session(row)
    except httpx.HTTPError as exc:
        log.warning("session insert failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't save your session. Try again.") from exc
    return SessionSaved(id=str(created.get("id")))


@app.get("/api/sessions", response_model=list[SessionSummary])
async def list_sessions_endpoint(user: dict = Depends(current_user)) -> list[SessionSummary]:
    """The signed-in user's recent sessions (compact), newest first."""
    try:
        rows = await db.list_sessions(user["id"], limit=50)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't load your sessions.") from exc
    return [
        SessionSummary(
            id=str(r["id"]),
            created_at=r.get("created_at", ""),
            topic=r.get("topic") or "",
            event=r.get("event") or "",
            content_score=int(r.get("content_score") or 0),
            level=r.get("level") or "novice",
            mode=r.get("mode") or "",
            filler_per_min=r.get("filler_per_min"),
            pace_wpm=r.get("pace_wpm"),
            retry_of_session_id=r.get("retry_of_session_id"),
        )
        for r in rows
    ]


@app.get("/api/sessions/{session_id}", response_model=SessionDetail)
async def get_session_endpoint(session_id: str, user: dict = Depends(current_user)) -> SessionDetail:
    """One stored session, enough to re-render the feedback screen."""
    try:
        row = await db.get_session(user["id"], session_id)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't load that session.") from exc
    if not row:
        raise HTTPException(status_code=404, detail="Session not found.")
    return SessionDetail(
        id=str(row["id"]),
        created_at=row.get("created_at", ""),
        scenario=ScenarioResponse(**row["scenario"]),
        score=ScoreResponse(**row["score"]),
        response=row.get("response", ""),
        followup_answer=row.get("followup_answer", ""),
        delivery=DeliveryMetrics(**row["delivery"]) if row.get("delivery") else None,
        video=VideoMetrics(**row["video"]) if row.get("video") else None,
        utterances=[Utterance(**u) for u in (row.get("utterances") or [])],
        retry_of_session_id=row.get("retry_of_session_id"),
    )


@app.get("/api/progress", response_model=ProgressResponse)
async def get_progress(user: dict = Depends(current_user)) -> ProgressResponse:
    """Cross-session progress payload for the home page (deterministic math)."""
    try:
        rows = await db.list_sessions(user["id"], limit=200, select=db.PROGRESS_SELECT)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't load your progress.") from exc
    return ProgressResponse(**progress.compute_progress(rows))


# --- study courses ---------------------------------------------------------
# The course is the summer half of the funnel: pick your event, work an ordered path
# through the terms it exercises, arrive in the fall knowing them. GET is
# deliberately anonymous-friendly (browse any event's path without an account);
# only remembering your place needs a login.

@app.get("/api/course/{event_id}", response_model=CourseResponse)
async def get_course(event_id: str, user: dict | None = Depends(optional_user)) -> CourseResponse:
    """One event's study path, with the user's progress overlaid when signed in.

    Renders fully for anonymous visitors, every term shows as "new", so a student
    can see exactly what they'd be committing to before making an account."""
    course = courses.course_for(event_id)
    if not course:
        raise HTTPException(status_code=404, detail="Unknown event.")

    marks: dict[str, str] = {}
    enrolled = False
    if user and config.has_supabase():
        try:
            rows = await db.list_study_progress(user["id"])
            marks = {r["term_id"]: r["status"] for r in rows}
            prof = await db.get_study_profile(user["id"])
            enrolled = bool(prof and prof.get("event_id") == event_id)
        except httpx.HTTPError as exc:
            # Progress is an overlay, not the point, show the path rather than 502.
            log.warning("course progress load failed: %s", exc)

    return CourseResponse(**courses.summarize(course, marks), enrolled=enrolled)


@app.get("/api/course", response_model=CourseResponse)
async def get_my_course(user: dict = Depends(current_user)) -> CourseResponse:
    """The course the signed-in user enrolled in. 404 until they pick an event."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    try:
        prof = await db.get_study_profile(user["id"])
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't load your course.") from exc
    if not prof:
        raise HTTPException(status_code=404, detail="No course yet: pick an event to start one.")
    return await get_course(prof["event_id"], user)


@app.post("/api/course/enroll", response_model=CourseResponse)
async def enroll_course(req: EnrollRequest, user: dict = Depends(current_user)) -> CourseResponse:
    """Start (or switch) the signed-in user's study path.

    Switching events never clears study_progress: progress is per TERM, and events
    share domains, so a student who moves from one marketing event to another keeps
    everything they already proved."""
    if not events.get_event(req.event_id):
        raise HTTPException(status_code=404, detail="Unknown event.")
    try:
        await db.set_study_profile(user["id"], req.event_id)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't start your course.") from exc
    return await get_course(req.event_id, user)


@app.post("/api/study/mark", response_model=StudyMarkResponse)
async def mark_study(req: StudyMarkRequest, user: dict = Depends(current_user)) -> StudyMarkResponse:
    """Fold study events (a flip, a Blitz round, a graded role-play) into progress.

    Read-modify-write: the transition rules are a pure function (app/study.py) and
    mastery can go DOWN, so we need the current row to fold onto. Unknown term ids
    are dropped rather than 400, a stale client shouldn't fail a whole Blitz."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")

    known = [m for m in req.marks if terms.get_term(m.term_id)]
    if not known:
        return StudyMarkResponse(updated=0)

    ids = [m.term_id for m in known]
    try:
        current = {r["term_id"]: r for r in await db.list_study_progress(user["id"], ids)}
        rows = [study.apply(current.get(m.term_id), m.term_id, m.evidence, m.verdict) for m in known]
        updated = await db.upsert_study_progress(user["id"], rows)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't save your progress.") from exc
    return StudyMarkResponse(updated=updated)


# --- study plans -----------------------------------------------------------
# The schedule is recomputed from inputs + current progress on every request
# (app/plan.py); the only computed state stored is today's frozen task list.

def _plan_day(local_date: str, tz_offset: int) -> tuple[date, int]:
    """The student's calendar day, from their browser. Trusted only within a day of
    the server's UTC date, so a wrong client clock can't shift a plan by weeks."""
    tz = max(-14 * 60, min(14 * 60, tz_offset))
    server = datetime.now(timezone.utc)
    fallback = (server - timedelta(minutes=tz)).date()
    try:
        day = date.fromisoformat(local_date) if local_date else fallback
    except ValueError:
        day = fallback
    if abs((day - server.date()).days) > 1:
        day = fallback
    return day, tz


async def _plan_context(user: dict, tz: int) -> tuple[dict, list[dict], list[date], list[date]]:
    """Progress map, weak criteria, role-play dates, and the dates of role-plays
    done with a real person: everything the planner reads."""
    rows, sessions, acts = await asyncio.gather(
        db.list_study_progress(user["id"]),
        db.list_sessions(user["id"], limit=200, select=db.PROGRESS_SELECT),
        db.list_activity([user["id"]]),
    )
    weak = plan.weak_criteria(progress.compute_progress(sessions)["criterion_mastery"])
    return plan.progress_map(rows, tz), weak, plan.session_dates(sessions, tz), plan.live_dates(acts, tz)


def _plan_out(built: dict, prog: dict, sessions: list[date], day: date, *, saved: bool,
              history: list[dict], live: list[date] | None = None) -> PlanResponse:
    today_tasks = plan.overlay_status(built["today"]["tasks"], prog, sessions, day, live)
    built["today"]["tasks"] = today_tasks
    if built["days"] and built["days"][0]["date"] == day.isoformat():
        built["days"][0]["tasks"] = today_tasks
    return PlanResponse(**built, saved=saved, history=history)


@app.post("/api/plan/preview", response_model=PlanResponse, dependencies=[Depends(rate_limit)])
async def preview_plan(
    req: PlanInputs,
    local_date: str = Query(default="", max_length=10),
    tz_offset: int = Query(default=0),
    user: dict | None = Depends(optional_user),
) -> PlanResponse:
    """Build a plan without saving it. Anyone can see what their summer would look
    like, the same pitch as the course rendering signed-out. Signed-in previews use
    real progress, so editing a saved plan shows honest numbers before committing."""
    day, tz = _plan_day(local_date, tz_offset)
    inputs = req.model_dump(mode="json")
    if err := plan.validate_inputs(inputs, day):
        raise HTTPException(status_code=422, detail=err)

    prog: dict = {}
    weak: list[dict] = []
    sessions: list[date] = []
    live: list[date] = []
    if user and config.has_supabase():
        try:
            prog, weak, sessions, live = await _plan_context(user, tz)
        except httpx.HTTPError as exc:
            log.warning("plan preview progress load failed: %s", exc)
    built = plan.build_plan(inputs, prog, weak, day, last_roleplay=sessions[-1] if sessions else None, live=live)
    return _plan_out(built, prog, sessions, day, saved=False, history=[], live=live)


@app.get("/api/plan", response_model=PlanResponse)
async def get_plan(
    local_date: str = Query(default="", max_length=10),
    tz_offset: int = Query(default=0),
    user: dict = Depends(current_user),
) -> PlanResponse:
    """The signed-in user's plan, recomputed for today. 404 until they save one."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    day, tz = _plan_day(local_date, tz_offset)
    try:
        row, (prog, weak, sessions, live) = await asyncio.gather(
            db.get_study_plan(user["id"]), _plan_context(user, tz)
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't load your study plan.") from exc
    if not row:
        raise HTTPException(status_code=404, detail="No study plan yet.")

    inputs = {k: row[k] for k in ("event_id", "stages", "day_minutes", "goal")}
    last_rp = sessions[-1] if sessions else None
    history = row.get("history") or []
    frozen = row.get("today_tasks") if row.get("today_date") == day.isoformat() else None

    if frozen is None:
        # First load of a new day: score the day that just ended, then freeze today.
        # Last-roleplay excludes today's sessions, or doing today's rep early would
        # make the freshly-frozen list think it wasn't due.
        prior = [s for s in sessions if s < day]
        built = plan.build_plan(inputs, prog, weak, day, last_roleplay=prior[-1] if prior else None, live=live)
        if not built:
            raise HTTPException(status_code=404, detail="Your plan's event no longer exists.")
        old_date = row.get("today_date")
        history = plan.rollover(history, date.fromisoformat(old_date) if old_date else None,
                                row.get("today_tasks"), prog, sessions, live)
        try:
            await db.upsert_study_plan(user["id"], {
                "event_id": inputs["event_id"],
                "day_minutes": inputs["day_minutes"],
                "today_date": day.isoformat(),
                "today_tasks": built["today"]["tasks"],
                "history": history,
            })
        except httpx.HTTPError as exc:
            # Unfrozen just means today may reshuffle, still show the plan.
            log.warning("plan snapshot save failed: %s", exc)
    else:
        built = plan.build_plan(inputs, prog, weak, day, frozen_today=frozen, last_roleplay=last_rp, live=live)
        if not built:
            raise HTTPException(status_code=404, detail="Your plan's event no longer exists.")
    return _plan_out(built, prog, sessions, day, saved=True, history=history, live=live)


@app.put("/api/plan", response_model=PlanResponse)
async def save_plan(
    req: PlanInputs,
    local_date: str = Query(default="", max_length=10),
    tz_offset: int = Query(default=0),
    user: dict = Depends(current_user),
) -> PlanResponse:
    """Save (or replace) the plan's inputs. Also enrolls the course for that event,
    so the Study page and the plan can never disagree about what's being studied.
    Clearing today's snapshot makes the next load freeze a list built from the new
    inputs; history is left alone."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    day, _ = _plan_day(local_date, tz_offset)
    inputs = req.model_dump(mode="json")
    if err := plan.validate_inputs(inputs, day):
        raise HTTPException(status_code=422, detail=err)
    try:
        await db.set_study_profile(user["id"], req.event_id)
        await db.upsert_study_plan(user["id"], {**inputs, "today_date": None, "today_tasks": None})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't save your study plan.") from exc
    return await get_plan(local_date=local_date, tz_offset=tz_offset, user=user)


@app.delete("/api/plan")
async def delete_plan(user: dict = Depends(current_user)) -> dict:
    """Remove the plan. Study progress is untouched, it belongs to the terms."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    try:
        await db.delete_study_plan(user["id"])
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't delete your study plan.") from exc
    return {"deleted": True}


# --- chapters --------------------------------------------------------------
# A school club. Managers (advisor, officers) see their students' practice, post
# to a feed, assign homework that completes itself from real activity, and send
# reminders. Every access decision runs through app/chapters.py first; the tables
# themselves are service-key-only, so nothing here is reachable any other way.

def _name(p: dict | None) -> str:
    return f"{p.get('first_name', '')} {p.get('last_name', '')}".strip() if p else ""


def _event_name(event_id: str) -> str:
    ev = events.get_event(event_id) if event_id else None
    return ev["name"] if ev else ""


def _domain_name(domain_id: str | None) -> str:
    if not domain_id:
        return ""
    return next((d["name"] for d in framework.domains() if d["id"] == domain_id), "")


def _chapter_info(ch: dict, role: str) -> ChapterInfo:
    manager = role == "manager"
    return ChapterInfo(
        id=str(ch["id"]),
        name=ch["name"],
        school_name=ch["school_name"],
        status=ch["status"],
        join_code=ch["join_code"] if manager else None,
        manager_code=ch["manager_code"] if manager else None,
    )


def _db_error(what: str):
    def wrap(exc: Exception) -> HTTPException:
        log.warning("chapter %s failed: %s", what, exc)
        return HTTPException(status_code=502, detail=f"Couldn't {what}. Try again.")
    return wrap


async def _my_rows(user: dict) -> list[dict]:
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    try:
        return await db.list_memberships(user["id"])
    except httpx.HTTPError as exc:
        raise _db_error("load your chapters")(exc) from exc


async def _active_chapter(chapter_id: str) -> dict:
    ch = await db.get_chapter(chapter_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return ch


async def _gated(user: dict, chapter_id: str, check, *reads):
    """Run the access check and the page's reads in ONE round of parallel queries.

    Checking first and then reading costs two network round trips; this fetches
    the caller's memberships alongside the data, then applies `check` before
    anything is looked at, so a refused caller still gets the 403 and never the
    data (and a read that failed for them is never surfaced either)."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    rows, *results = await asyncio.gather(db.list_memberships(user["id"]), *reads, return_exceptions=True)
    if isinstance(rows, BaseException):
        raise _db_error("load your chapters")(rows)
    me = check(rows, chapter_id)
    for r in results:
        if isinstance(r, BaseException):
            raise r
    return me, results


async def _unread(user_id: str, chapter_id: str, role: str) -> tuple[int, int]:
    """(unread feed posts, unread messages) for one person in one chapter."""
    reads, posts, msgs = await asyncio.gather(
        db.list_reads(user_id, chapter_id),
        db.list_posts(chapter_id, limit=50),
        db.list_messages(chapter_id, None if role == "manager" else user_id),
    )
    visible = [p for p in posts if chapters.visible_to(p, user_id, role)]
    feed = chapters.unread_count(visible, reads.get("feed"), exclude_author=user_id)
    if role == "manager":
        # A thread is unread when its student wrote after this manager last opened it.
        by_thread: dict[str, list[dict]] = {}
        for m in msgs:
            if str(m.get("sender_id")) == str(m.get("student_id")):
                by_thread.setdefault(str(m["student_id"]), []).append(m)
        unread = sum(chapters.unread_count(ms, reads.get(f"thread:{sid}")) for sid, ms in by_thread.items())
    else:
        unread = chapters.unread_count(msgs, reads.get(f"thread:{user_id}"), exclude_author=user_id, author_key="sender_id")
    return feed, unread


@app.get("/api/me", response_model=MeResponse)
async def get_me(user: dict = Depends(current_user)) -> MeResponse:
    """The signed-in person's name and chapters, with unread counts for the badge.

    Also finishes sign-up, once: a name entered on the sign-up form, and a chapter
    registered there, arrive as user_metadata (an email-confirm sign-up has no
    session to call us with until later), and are written as rows the first time
    they're seen here. Both writes are idempotent, so a retry can't duplicate."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    meta = user.get("meta") or {}
    try:
        # Independent reads in parallel: each is a network round trip, and in
        # sequence they were most of this endpoint's latency.
        rows, prof = await asyncio.gather(db.list_memberships(user["id"]), db.get_profile(user["id"]))
        first, last = str(meta.get("first_name") or "").strip()[:40], str(meta.get("last_name") or "").strip()[:40]
        if not prof and first and last:
            await db.upsert_profile(user["id"], first, last)
            prof = {"first_name": first, "last_name": last}

        pending = meta.get("pending_chapter")
        if isinstance(pending, dict) and not await db.list_chapters_created_by(user["id"]):
            try:
                req = ChapterCreate(**pending)
            except ValueError:
                req = None
            if req:
                await _create_chapter(req, user["id"])
                rows = await db.list_memberships(user["id"])

        chs = {str(c["id"]): c for c in await db.list_chapters([str(r["chapter_id"]) for r in rows])}
        live = [r for r in rows if str(r["chapter_id"]) in chs]

        async def counts(r: dict) -> tuple[int, int]:
            ch = chs[str(r["chapter_id"])]
            if r["status"] == "active" and ch["status"] == "active":
                return await _unread(user["id"], str(ch["id"]), r["role"])
            return 0, 0

        unread = await asyncio.gather(*(counts(r) for r in live))
        out: list[Membership] = []
        for r, (feed, msgs) in zip(live, unread):
            ch = chs[str(r["chapter_id"])]
            out.append(Membership(chapter=_chapter_info(ch, r["role"]), role=r["role"], status=r["status"],
                                  unread_feed=feed, unread_messages=msgs))
    except httpx.HTTPError as exc:
        raise _db_error("load your account")(exc) from exc
    return MeResponse(profile=ProfileOut(**prof) if prof else None, memberships=out)


@app.put("/api/profile", response_model=ProfileOut)
async def put_profile(req: ProfileIn, user: dict = Depends(current_user)) -> ProfileOut:
    first, last = req.first_name.strip(), req.last_name.strip()
    if not first or not last:
        raise HTTPException(status_code=422, detail="Enter your first and last name.")
    try:
        await db.upsert_profile(user["id"], first, last)
    except httpx.HTTPError as exc:
        raise _db_error("save your name")(exc) from exc
    return ProfileOut(first_name=first, last_name=last)


# A person can register a handful of chapters (an advisor with two schools), but
# not an unbounded number of pending rows for the owner to wade through.
MAX_CHAPTERS_PER_CREATOR = 3


async def _create_chapter(req: ChapterCreate, user_id: str) -> dict:
    for _ in range(5):  # a code collision is astronomically rare; retry anyway
        try:
            ch = await db.insert_chapter({
                "name": req.name.strip(),
                "school_name": req.school_name.strip(),
                "contact_email": req.contact_email.strip(),
                "join_code": chapters.new_code(chapters.JOIN_CODE_LEN),
                "manager_code": chapters.new_code(chapters.MANAGER_CODE_LEN),
                "status": "pending",
                "created_by": user_id,
            })
            break
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 409:
                raise
    else:
        raise HTTPException(status_code=502, detail="Couldn't create the chapter. Try again.")
    await db.insert_member({"chapter_id": ch["id"], "user_id": user_id, "role": "manager",
                            "status": "active", "approved_at": "now()", "consented_at": "now()"})
    return ch


@app.post("/api/chapters", response_model=ChapterInfo, dependencies=[Depends(rate_limit)])
async def create_chapter(req: ChapterCreate, user: dict = Depends(current_user)) -> ChapterInfo:
    """Register a chapter. It starts pending until the owner approves it in /admin,
    so a made-up school can't start collecting students."""
    await _my_rows(user)
    try:
        if len(await db.list_chapters_created_by(user["id"])) >= MAX_CHAPTERS_PER_CREATOR:
            raise HTTPException(status_code=409, detail="You've already registered the maximum number of chapters.")
        ch = await _create_chapter(req, user["id"])
    except httpx.HTTPError as exc:
        raise _db_error("create the chapter")(exc) from exc
    return _chapter_info(ch, "manager")


@app.post("/api/chapters/join", response_model=Membership, dependencies=[Depends(rate_limit)])
async def join_chapter(req: ChapterJoin, user: dict = Depends(current_user)) -> Membership:
    """Use a code. A student code files a request that a manager approves; a
    manager code (only ever handed out by an existing manager) joins as a manager
    straight away. Rate-limited, so codes can't be guessed by brute force."""
    rows = await _my_rows(user)
    code = chapters.normalize_code(req.code)
    try:
        ch, kind = await db.find_chapter_by_code(code)
        if not ch or ch["status"] == "rejected":
            raise HTTPException(status_code=404, detail="That code doesn't match a chapter. Check it with your advisor.")
        if ch["status"] != "active":
            raise HTTPException(status_code=409, detail="That chapter is still being reviewed. Try again soon.")
        existing = next((r for r in rows if str(r["chapter_id"]) == str(ch["id"])), None)
        if existing:
            return Membership(chapter=_chapter_info(ch, existing["role"]), role=existing["role"], status=existing["status"])
        if not await db.get_profile(user["id"]):
            raise HTTPException(status_code=422, detail="Add your name first, so your chapter knows who you are.")
        if kind == "student":
            if not req.consent:
                raise HTTPException(status_code=422, detail="Please confirm what your chapter will be able to see.")
            if any(r["role"] == "student" for r in rows):
                raise HTTPException(status_code=409, detail="You're already in a chapter. Leave it first to join another.")
            await db.insert_member({"chapter_id": ch["id"], "user_id": user["id"], "role": "student",
                                    "status": "pending", "consented_at": "now()"})
            return Membership(chapter=_chapter_info(ch, "student"), role="student", status="pending")
        await db.insert_member({"chapter_id": ch["id"], "user_id": user["id"], "role": "manager",
                                "status": "active", "approved_at": "now()", "consented_at": "now()"})
        return Membership(chapter=_chapter_info(ch, "manager"), role="manager", status="active")
    except httpx.HTTPError as exc:
        raise _db_error("join that chapter")(exc) from exc


@app.post("/api/chapters/{chapter_id}/leave")
async def leave_chapter(chapter_id: str, user: dict = Depends(current_user)) -> dict:
    """Leave (or withdraw a pending request). Managers lose access to the
    student's data the moment the row is gone."""
    rows = await _my_rows(user)
    mine = next((r for r in rows if str(r["chapter_id"]) == chapter_id), None)
    if not mine:
        raise HTTPException(status_code=404, detail="You're not in that chapter.")
    try:
        if mine["role"] == "manager":
            members = await db.list_chapter_members(chapter_id)
            if sum(1 for m in members if m["role"] == "manager" and m["status"] == "active") <= 1:
                raise HTTPException(status_code=409, detail="You're the only manager. Add another manager before leaving.")
        await db.delete_member(chapter_id, user["id"])
    except httpx.HTTPError as exc:
        raise _db_error("leave the chapter")(exc) from exc
    return {"left": True}


@app.post("/api/chapters/{chapter_id}/members/{member_id}/approve")
async def approve_member(chapter_id: str, member_id: str, user: dict = Depends(current_user)) -> dict:
    chapters.require_manager(await _my_rows(user), chapter_id)
    try:
        updated = await db.update_member(chapter_id, member_id, {"status": "active", "approved_at": "now()"})
    except httpx.HTTPError as exc:
        raise _db_error("approve that student")(exc) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="That request is gone.")
    return {"approved": True}


@app.delete("/api/chapters/{chapter_id}/members/{member_id}")
async def remove_member(chapter_id: str, member_id: str, user: dict = Depends(current_user)) -> dict:
    """Remove a student or co-manager, or decline a pending request."""
    chapters.require_manager(await _my_rows(user), chapter_id)
    if member_id == user["id"]:
        raise HTTPException(status_code=422, detail="Use Leave chapter to remove yourself.")
    try:
        n = await db.delete_member(chapter_id, member_id)
    except httpx.HTTPError as exc:
        raise _db_error("remove that member")(exc) from exc
    return {"removed": n > 0}


@app.post("/api/chapters/{chapter_id}/codes/rotate", response_model=ChapterInfo)
async def rotate_code(chapter_id: str, req: CodeRotate, user: dict = Depends(current_user)) -> ChapterInfo:
    """Issue a new code; the old one stops working immediately (a leaked code)."""
    chapters.require_manager(await _my_rows(user), chapter_id)
    field, n = ("join_code", chapters.JOIN_CODE_LEN) if req.which == "join" else ("manager_code", chapters.MANAGER_CODE_LEN)
    try:
        ch = await db.update_chapter(chapter_id, {field: chapters.new_code(n)})
    except httpx.HTTPError as exc:
        raise _db_error("rotate the code")(exc) from exc
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return _chapter_info(ch, "manager")


def _recent_avg(sessions: list[dict], n: int = 5) -> int | None:
    scores = [int(s.get("content_score") or 0) for s in sessions[:n]]
    return round(sum(scores) / len(scores)) if scores else None


def _follow_through(history: list[dict], days: int = 7) -> int | None:
    recent = sorted(history, key=lambda h: h.get("date", ""))[-days:]
    planned = sum(int(h.get("planned") or 0) for h in recent)
    return round(100 * sum(int(h.get("done") or 0) for h in recent) / planned) if planned else None


@app.get("/api/chapters/{chapter_id}/roster", response_model=RosterResponse)
async def chapter_roster(chapter_id: str, user: dict = Depends(current_user)) -> RosterResponse:
    """Every student with the numbers an advisor scans for: their event, when they
    last practiced, how much this week, recent average, weakest skill, and how
    closely they're following their plan. Pending requests are listed too."""
    now = datetime.now(timezone.utc)
    try:
        _, (ch, members) = await _gated(user, chapter_id, chapters.require_manager,
                                        db.get_chapter(chapter_id), db.list_chapter_members(chapter_id))
        if not ch:
            raise HTTPException(status_code=404, detail="Chapter not found.")
        ids = [str(m["user_id"]) for m in members]
        student_ids = [str(m["user_id"]) for m in members if m["role"] == "student" and m["status"] == "active"]
        since = (now - timedelta(days=90)).isoformat()
        names, evs, plans, sess, acts = await asyncio.gather(
            db.list_profiles(ids),
            db.list_study_profiles(student_ids),
            db.list_plan_history(student_ids),
            db.list_sessions_for(student_ids, since=since),
            db.list_activity(student_ids, since=since),
        )
    except httpx.HTTPError as exc:
        raise _db_error("load the roster")(exc) from exc

    by_user_s: dict[str, list[dict]] = {}
    for s in sess:
        by_user_s.setdefault(str(s["user_id"]), []).append(s)
    by_user_a: dict[str, list[dict]] = {}
    for a in acts:
        by_user_a.setdefault(str(a["user_id"]), []).append(a)

    students: list[RosterStudent] = []
    managers: list[RosterManager] = []
    for m in members:
        uid = str(m["user_id"])
        p = names.get(uid) or {}
        if m["role"] == "manager":
            if m["status"] == "active":
                managers.append(RosterManager(user_id=uid, first_name=p.get("first_name", ""),
                                              last_name=p.get("last_name", ""), is_you=uid == user["id"]))
            continue
        if m["status"] != "active":
            students.append(RosterStudent(user_id=uid, first_name=p.get("first_name", ""), last_name=p.get("last_name", ""),
                                          status="pending", requested_at=m.get("requested_at") or ""))
            continue
        ss, aa = by_user_s.get(uid, []), by_user_a.get(uid, [])
        weak = progress.compute_progress(list(reversed(ss))).get("weakest_criterion") if ss else None
        ev = evs.get(uid, "")
        students.append(RosterStudent(
            user_id=uid,
            first_name=p.get("first_name", ""),
            last_name=p.get("last_name", ""),
            event_id=ev,
            event=_event_name(ev),
            status="active",
            requested_at=m.get("requested_at") or "",
            last_active=chapters.last_active(ss, aa),
            roleplays_7d=chapters.recent_count(ss, now),
            study_runs_7d=chapters.recent_count(aa, now),
            avg_score_recent=_recent_avg(ss),
            weakest=(weak or {}).get("name", ""),
            has_plan=uid in plans,
            plan_follow_through=_follow_through(plans[uid]) if uid in plans else None,
        ))
    return RosterResponse(chapter=_chapter_info(ch, "manager"), students=students, managers=managers)


async def _plan_readonly(student_id: str, day: date, tz: int) -> PlanResponse | None:
    """A student's plan as of today, for their manager. Same math as GET /api/plan
    but it never writes: a manager looking must not freeze or roll over the
    student's day, that only happens when the student opens it themselves."""
    row = await db.get_study_plan(student_id)
    if not row:
        return None
    prog, weak, sessions, live = await _plan_context({"id": student_id}, tz)
    inputs = {k: row[k] for k in ("event_id", "stages", "day_minutes", "goal")}
    frozen = row.get("today_tasks") if row.get("today_date") == day.isoformat() else None
    prior = [s for s in sessions if s < day] if frozen is None else sessions
    built = plan.build_plan(inputs, prog, weak, day, frozen_today=frozen,
                            last_roleplay=prior[-1] if prior else None, live=live)
    if not built:
        return None
    return _plan_out(built, prog, sessions, day, saved=True, history=row.get("history") or [], live=live)


def _summary(r: dict) -> SessionSummary:
    return SessionSummary(
        id=str(r["id"]),
        created_at=r.get("created_at", ""),
        topic=r.get("topic") or "",
        event=r.get("event") or "",
        content_score=int(r.get("content_score") or 0),
        level=r.get("level") or "novice",
        mode=r.get("mode") or "",
        filler_per_min=r.get("filler_per_min"),
        pace_wpm=r.get("pace_wpm"),
        retry_of_session_id=r.get("retry_of_session_id"),
    )


@app.get("/api/chapters/{chapter_id}/students/{student_id}", response_model=StudentProfile)
async def student_profile(
    chapter_id: str,
    student_id: str,
    local_date: str = Query(default="", max_length=10),
    tz_offset: int = Query(default=0),
    user: dict = Depends(current_user),
) -> StudentProfile:
    """One student's full profile for their manager: the Home panels (skills,
    recent role-plays, trends) plus their course and study plan."""
    day, tz = _plan_day(local_date, tz_offset)
    try:
        _, (members,) = await _gated(user, chapter_id, chapters.require_manager, db.list_chapter_members(chapter_id))
        chapters.require_student_in(members, student_id)
        prof, sp, summaries, prog_rows, plan_out = await asyncio.gather(
            db.get_profile(student_id),
            db.get_study_profile(student_id),
            db.list_sessions(student_id, limit=50),
            db.list_sessions(student_id, limit=200, select=db.PROGRESS_SELECT),
            _plan_readonly(student_id, day, tz),
        )
        ev = (sp or {}).get("event_id", "")
        course = await get_course(ev, {"id": student_id}) if ev and courses.course_for(ev) else None
    except httpx.HTTPError as exc:
        raise _db_error("load that student")(exc) from exc
    return StudentProfile(
        user_id=student_id,
        first_name=(prof or {}).get("first_name", ""),
        last_name=(prof or {}).get("last_name", ""),
        event_id=ev,
        event=_event_name(ev),
        progress=ProgressResponse(**progress.compute_progress(prog_rows)),
        sessions=[_summary(r) for r in summaries],
        course=course,
        plan=plan_out,
    )


@app.get("/api/chapters/{chapter_id}/students/{student_id}/sessions/{session_id}", response_model=SessionDetail)
async def student_session(chapter_id: str, student_id: str, session_id: str, user: dict = Depends(current_user)) -> SessionDetail:
    """One of a student's role-plays, for their manager to read the feedback."""
    chapters.require_manager(await _my_rows(user), chapter_id)
    try:
        chapters.require_student_in(await db.list_chapter_members(chapter_id), student_id)
    except httpx.HTTPError as exc:
        raise _db_error("load that session")(exc) from exc
    return await get_session_endpoint(session_id, {"id": student_id})


# feed: announcements + assignments

def _post_out(p: dict, names: dict[str, dict]) -> PostOut:
    return PostOut(
        id=str(p["id"]),
        kind=p["kind"],
        title=p["title"],
        body=p.get("body") or "",
        author_name=_name(names.get(str(p.get("author_id")))),
        created_at=p["created_at"],
        assignment_kind=p.get("assignment_kind"),
        target=AssignmentTarget(**p["target"]) if p.get("target") else None,
        domain=_domain_name((p.get("target") or {}).get("domain_id")),
        due_at=p.get("due_at"),
        audience_size=len(p["audience"]) if p.get("audience") else None,
    )


async def _work_since(user_ids: list[str], posts: list[dict]) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """Sessions and study runs per student since the oldest assignment shown, all
    an assignment's status is computed from."""
    assigned = [p for p in posts if p["kind"] == "assignment"]
    if not assigned or not user_ids:
        return {}, {}
    since = min(p["created_at"] for p in assigned)
    sess, acts = await asyncio.gather(db.list_sessions_for(user_ids, since=since), db.list_activity(user_ids, since=since))
    s_by: dict[str, list[dict]] = {}
    for s in sess:
        s_by.setdefault(str(s["user_id"]), []).append(s)
    a_by: dict[str, list[dict]] = {}
    for a in acts:
        a_by.setdefault(str(a["user_id"]), []).append(a)
    return s_by, a_by


@app.get("/api/chapters/{chapter_id}/posts", response_model=list[PostOut])
async def list_chapter_posts(chapter_id: str, user: dict = Depends(current_user)) -> list[PostOut]:
    """The chapter feed, newest first. A student sees their own progress on each
    assignment; a manager sees how many assigned students have finished."""
    now = datetime.now(timezone.utc)
    try:
        me, (all_posts, members) = await _gated(user, chapter_id, chapters.require_member,
                                                db.list_posts(chapter_id), db.list_chapter_members(chapter_id))
        role = me["role"]
        posts = [p for p in all_posts if chapters.visible_to(p, user["id"], role)]
        student_ids = [str(m["user_id"]) for m in members if m["role"] == "student" and m["status"] == "active"]
        names, (s_by, a_by) = await asyncio.gather(
            db.list_profiles(list({str(p.get("author_id")) for p in posts if p.get("author_id")})),
            _work_since(student_ids if role == "manager" else [user["id"]], posts),
        )
    except httpx.HTTPError as exc:
        raise _db_error("load the feed")(exc) from exc

    out: list[PostOut] = []
    for p in posts:
        o = _post_out(p, names)
        if p["kind"] == "assignment":
            if role == "manager":
                who = chapters.assignees(p, student_ids)
                o.assigned_count = len(who)
                o.done_count = sum(
                    1 for uid in who
                    if chapters.assignment_status(p, s_by.get(uid, []), a_by.get(uid, []), now)["status"] == "done"
                )
            else:
                o.mine = AssignmentStatus(**chapters.assignment_status(p, s_by.get(user["id"], []), a_by.get(user["id"], []), now))
        out.append(o)
    return out


@app.post("/api/chapters/{chapter_id}/posts", response_model=PostOut)
async def create_chapter_post(chapter_id: str, req: PostCreate, user: dict = Depends(current_user)) -> PostOut:
    chapters.require_manager(await _my_rows(user), chapter_id)
    row: dict = {"chapter_id": chapter_id, "author_id": user["id"], "kind": req.kind,
                 "title": req.title.strip(), "body": req.body.strip()}
    if req.kind == "assignment":
        target = (req.target or AssignmentTarget()).model_dump(exclude_none=True)
        if not req.assignment_kind:
            raise HTTPException(status_code=422, detail="Pick what kind of assignment this is.")
        if err := chapters.validate_assignment(req.assignment_kind, target):
            raise HTTPException(status_code=422, detail=err)
        if target.get("domain_id") and not _domain_name(target["domain_id"]):
            raise HTTPException(status_code=422, detail="Unknown skill area.")
        row.update(assignment_kind=req.assignment_kind, target=target,
                   due_at=req.due_at.isoformat() if req.due_at else None)
    try:
        if req.audience:
            members = await db.list_chapter_members(chapter_id)
            for sid in req.audience:
                chapters.require_student_in(members, sid)
            row["audience"] = list(dict.fromkeys(req.audience))
        created = await db.insert_post(row)
        names = await db.list_profiles([user["id"]])
    except httpx.HTTPError as exc:
        raise _db_error("post that")(exc) from exc
    return _post_out(created, names)


@app.delete("/api/chapters/{chapter_id}/posts/{post_id}")
async def delete_chapter_post(chapter_id: str, post_id: str, user: dict = Depends(current_user)) -> dict:
    chapters.require_manager(await _my_rows(user), chapter_id)
    try:
        n = await db.delete_post(chapter_id, post_id)
    except httpx.HTTPError as exc:
        raise _db_error("delete that post")(exc) from exc
    return {"deleted": n > 0}


@app.get("/api/chapters/{chapter_id}/posts/{post_id}/status", response_model=list[AssignmentRow])
async def assignment_breakdown(chapter_id: str, post_id: str, user: dict = Depends(current_user)) -> list[AssignmentRow]:
    """Who has and hasn't finished one assignment, unfinished first."""
    chapters.require_manager(await _my_rows(user), chapter_id)
    now = datetime.now(timezone.utc)
    try:
        post = next((p for p in await db.list_posts(chapter_id, limit=500) if str(p["id"]) == post_id), None)
        if not post or post["kind"] != "assignment":
            raise HTTPException(status_code=404, detail="Assignment not found.")
        members = await db.list_chapter_members(chapter_id)
        who = chapters.assignees(post, [str(m["user_id"]) for m in members if m["role"] == "student" and m["status"] == "active"])
        names = await db.list_profiles(who)
        s_by, a_by = await _work_since(who, [post])
    except httpx.HTTPError as exc:
        raise _db_error("load that assignment")(exc) from exc
    rows = [
        AssignmentRow(user_id=uid, name=_name(names.get(uid)) or "Unnamed student",
                      status=AssignmentStatus(**chapters.assignment_status(post, s_by.get(uid, []), a_by.get(uid, []), now)))
        for uid in who
    ]
    order = {"overdue": 0, "not_started": 1, "in_progress": 2, "done": 3}
    return sorted(rows, key=lambda r: (order[r.status.status], r.name.lower()))


# messages: one thread per student, shared by the chapter's managers

@app.get("/api/chapters/{chapter_id}/threads", response_model=list[ThreadSummary])
async def list_threads(chapter_id: str, user: dict = Depends(current_user)) -> list[ThreadSummary]:
    """The managers' inbox: every student with a conversation, newest first."""
    try:
        _, (members, msgs, reads) = await _gated(
            user, chapter_id, chapters.require_manager,
            db.list_chapter_members(chapter_id), db.list_messages(chapter_id), db.list_reads(user["id"], chapter_id),
        )
        student_ids = {str(m["user_id"]) for m in members if m["role"] == "student" and m["status"] == "active"}
        names = await db.list_profiles(list(student_ids))
    except httpx.HTTPError as exc:
        raise _db_error("load messages")(exc) from exc
    by: dict[str, list[dict]] = {}
    for m in msgs:
        if str(m["student_id"]) in student_ids:
            by.setdefault(str(m["student_id"]), []).append(m)
    out = [
        ThreadSummary(
            student_id=sid,
            name=_name(names.get(sid)) or "Unnamed student",
            last_body=ms[-1]["body"][:140],
            last_at=ms[-1]["created_at"],
            unread=chapters.unread_count([m for m in ms if str(m.get("sender_id")) == sid], reads.get(f"thread:{sid}")),
        )
        for sid, ms in by.items()
    ]
    return sorted(out, key=lambda t: t.last_at or "", reverse=True)


@app.get("/api/chapters/{chapter_id}/messages", response_model=list[MessageOut])
async def get_messages(chapter_id: str, student: str = Query(default=""), user: dict = Depends(current_user)) -> list[MessageOut]:
    """One thread. Opening it marks it read for the caller."""
    rows = await _my_rows(user)
    sid = chapters.thread_access(rows, chapter_id, user["id"], student or None)
    try:
        members, msgs = await asyncio.gather(db.list_chapter_members(chapter_id), db.list_messages(chapter_id, sid))
        if sid != user["id"]:
            chapters.require_student_in(members, sid)
        names, _ = await asyncio.gather(
            db.list_profiles(list({str(m.get("sender_id")) for m in msgs if m.get("sender_id")})),
            db.mark_read(user["id"], chapter_id, f"thread:{sid}"),
        )
    except httpx.HTTPError as exc:
        raise _db_error("load messages")(exc) from exc
    return [
        MessageOut(
            id=str(m["id"]),
            student_id=sid,
            sender_name=_name(names.get(str(m.get("sender_id")))),
            from_manager=str(m.get("sender_id")) != sid,
            mine=str(m.get("sender_id")) == user["id"],
            body=m["body"],
            created_at=m["created_at"],
        )
        for m in msgs
    ]


@app.post("/api/chapters/{chapter_id}/messages", dependencies=[Depends(rate_limit)])
async def send_message(chapter_id: str, req: MessageIn, user: dict = Depends(current_user)) -> dict:
    """A manager writes to one or more students (each in their own thread); a
    student can only reply in their own thread, to the managers."""
    rows = await _my_rows(user)
    me = chapters.require_member(rows, chapter_id)
    body = req.body.strip()
    if not body:
        raise HTTPException(status_code=422, detail="Write something first.")
    try:
        if me["role"] == "manager":
            if not req.student_ids:
                raise HTTPException(status_code=422, detail="Pick at least one student.")
            members = await db.list_chapter_members(chapter_id)
            targets = list(dict.fromkeys(req.student_ids))
            for sid in targets:
                chapters.require_student_in(members, sid)
        else:
            targets = [user["id"]]
        for sid in targets:
            await db.insert_message({"chapter_id": chapter_id, "student_id": sid, "sender_id": user["id"], "body": body})
            await db.mark_read(user["id"], chapter_id, f"thread:{sid}")
    except httpx.HTTPError as exc:
        raise _db_error("send that")(exc) from exc
    return {"sent": len(targets)}


@app.post("/api/chapters/{chapter_id}/read")
async def mark_chapter_read(chapter_id: str, req: ReadMark, user: dict = Depends(current_user)) -> dict:
    chapters.require_member(await _my_rows(user), chapter_id)
    if req.scope != "feed":
        raise HTTPException(status_code=422, detail="Unknown scope.")
    try:
        await db.mark_read(user["id"], chapter_id, "feed")
    except httpx.HTTPError as exc:
        raise _db_error("update that")(exc) from exc
    return {"ok": True}


@app.post("/api/activity")
async def record_activity(req: ActivityIn, user: dict = Depends(current_user)) -> dict:
    """A finished quiz, Blitz run, or flashcard set: the completion record that
    assignments are checked against. Domains are derived here from the term ids,
    never taken from the client. Kind "live" is a role-play the student did with a
    real person, which the study plan counts (app/plan.py)."""
    if not config.has_supabase():
        raise HTTPException(status_code=503, detail="Accounts are not enabled on this server.")
    domains = sorted({t["domain_id"] for t in terms.get_terms(req.term_ids) if t.get("domain_id")})
    try:
        await db.insert_activity({"user_id": user["id"], "kind": req.kind, "domain_ids": domains,
                                  "score": min(req.score, req.total) if req.total else req.score, "total": req.total})
    except httpx.HTTPError as exc:
        raise _db_error("record that")(exc) from exc
    return {"ok": True}


# --- admin QA page (owner-only, secret passphrase) -------------------------

class AdminVerify(BaseModel):
    passphrase: str = ""


@app.post("/api/admin/verify")
def admin_verify(req: AdminVerify) -> dict:
    """Check the admin passphrase server-side (so the secret never ships in the
    SPA bundle). 404 when no passphrase is configured, the admin page is off."""
    import hmac

    if not config.ADMIN_PASSPHRASE:
        raise HTTPException(status_code=404, detail="Not found.")
    ok = hmac.compare_digest(req.passphrase or "", config.ADMIN_PASSPHRASE)
    return {"ok": ok}


def require_admin(x_admin_passphrase: str = Header(default="")) -> None:
    """The owner, by passphrase. Chapter review needs more than "signed in": any
    account can sign in, and approving a chapter is what lets it collect students."""
    import hmac

    if not config.ADMIN_PASSPHRASE:
        raise HTTPException(status_code=404, detail="Not found.")
    if not hmac.compare_digest(x_admin_passphrase or "", config.ADMIN_PASSPHRASE):
        raise HTTPException(status_code=403, detail="Wrong passphrase.")


@app.get("/api/admin/chapters", response_model=list[AdminChapter], dependencies=[Depends(require_admin)])
async def admin_list_chapters(status: Literal["pending", "active", "rejected"] = Query(default="pending")) -> list[AdminChapter]:
    try:
        rows = await db.list_chapters_by_status(status)
        names = await db.list_profiles([str(c["created_by"]) for c in rows if c.get("created_by")])
    except httpx.HTTPError as exc:
        raise _db_error("load chapters")(exc) from exc
    return [
        AdminChapter(id=str(c["id"]), name=c["name"], school_name=c["school_name"], contact_email=c["contact_email"],
                     status=c["status"], created_at=c["created_at"], creator_name=_name(names.get(str(c.get("created_by")))))
        for c in rows
    ]


@app.post("/api/admin/chapters/{chapter_id}/status", dependencies=[Depends(require_admin)])
async def admin_set_chapter_status(chapter_id: str, req: AdminChapterStatus) -> dict:
    try:
        ch = await db.update_chapter(chapter_id, {"status": req.status})
    except httpx.HTTPError as exc:
        raise _db_error("update that chapter")(exc) from exc
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found.")
    return {"status": ch["status"]}


@app.get("/api/admin/cache-stats")
async def admin_cache_stats(user: dict = Depends(current_user)) -> dict:
    """Scenario-cache effectiveness since this process started.

    The savings claim for the cache is only as good as this number, "we cache
    scenarios" means nothing without a hit rate to check it against. It's also
    the number that decides whether a background pool-warmer is ever worth
    building: if the hit rate is already high, warming would spend money to buy
    something the natural growth already provides.
    """
    return {**scenario_cache.stats(), "enabled": scenario_cache.enabled()}


@app.post("/api/admin/seed")
async def admin_seed(user: dict = Depends(current_user)) -> dict:
    """Seed the caller's account with backdated CANNED sample sessions (no LLM
    tokens) so the home page / progress graphs render with realistic data. Rows
    are tagged so they can be cleared again."""
    rows = admin_samples.build_sample_rows(user["id"])
    try:
        n = await db.insert_sessions(rows)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't seed sample sessions.") from exc
    return {"seeded": n}


@app.delete("/api/admin/sample")
async def admin_clear_sample(user: dict = Depends(current_user)) -> dict:
    """Delete the caller's sample sessions (the ones seeded above)."""
    try:
        n = await db.delete_where(user["id"], admin_samples.SAMPLE_EVENT)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't clear sample sessions.") from exc
    return {"deleted": n}


# --- serve the built SPA (production) --------------------------------------
# In dev, Vite serves the frontend and proxies /api here. In production we ship
# one service: the built SPA is mounted at "/" (after all /api routes, so they
# win), giving a single origin, no CORS, keys in one place. Skipped when the
# build isn't present (local dev, tests), so this stays a no-op there.
import os  # noqa: E402
from pathlib import Path  # noqa: E402

from fastapi.staticfiles import StaticFiles  # noqa: E402

from fastapi.responses import FileResponse  # noqa: E402

_DIST = os.getenv("FRONTEND_DIST", str(Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if Path(_DIST).is_dir():
    _INDEX = str(Path(_DIST) / "index.html")

    # Clean URL for the marketing demo. StaticFiles(html=True) only serves
    # index.html at directory roots, so this client route needs an explicit
    # fallback to the SPA shell; React then renders the demo from the path.
    @app.get("/demo", include_in_schema=False)
    def _demo() -> FileResponse:
        return FileResponse(_INDEX)

    # Same explicit fallback for the owner-only admin QA page.
    @app.get("/admin", include_in_schema=False)
    def _admin() -> FileResponse:
        return FileResponse(_INDEX)

    # The onboarding tour, viewable without signing up (analytics stays off on
    # this route, so reviewing it can't skew the real onboarding funnel).
    @app.get("/tour", include_in_schema=False)
    def _tour() -> FileResponse:
        return FileResponse(_INDEX)

    # Privacy policy and terms. These have to answer on the bare path, not just
    # via a client-side hash: Google fetches both URLs when verifying the OAuth
    # consent screen's branding (DEPLOY.md §6b), and a 404 fails that check.
    @app.get("/privacy", include_in_schema=False)
    def _privacy() -> FileResponse:
        return FileResponse(_INDEX)

    @app.get("/terms", include_in_schema=False)
    def _terms() -> FileResponse:
        return FileResponse(_INDEX)

    # The app's own tabs each have an address (App.tsx VIEW_PATHS), so a refresh
    # or a shared link lands on the right page instead of a 404.
    def _spa() -> FileResponse:
        return FileResponse(_INDEX)

    for _path in ("/practice", "/study", "/chapter", "/account", "/tips", "/faq"):
        app.add_api_route(_path, _spa, methods=["GET"], include_in_schema=False)

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
