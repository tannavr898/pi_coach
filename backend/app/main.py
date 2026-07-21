"""FastAPI application — content loop (independent evaluation framework).

Endpoints:
- GET  /api/health         liveness
- GET  /api/config         client-safe runtime config
- GET  /api/framework      our business domains (for UI hints)
- GET  /api/rubric         the scoring levels (labels + descriptions) for the UI
- GET  /api/terms          the study corpus (flashcards / course units)
- POST /api/feedback       record a piece of user feedback
- POST /api/scenario       interpret a free-text request, select framework
                           criteria, and generate an original scenario
- POST /api/score-content  grade a response against the selected criteria
- POST /api/score-delivery transcribe audio + compute deterministic delivery metrics
- POST /api/score-video    observable eye-contact/expression checks on sampled frames
- GET  /api/usage          this caller's tier + remaining monthly allowance
- GET  /api/course/{id}    an event's study path (anonymous-friendly)
- POST /api/course/enroll  start/switch the signed-in user's path
- POST /api/study/mark     fold a flip/blitz/role-play result into progress

The Vite dev server proxies /api/* here, so no CORS in development. Provider keys
stay server-side; the frontend only ever talks to /api/*. The judge's instructions
are never returned to the client — only the participant-facing situation and (after
the response) the follow-up questions.

The evaluation layer references OUR framework (framework.json) only: no DECA
performance-indicator text, codes, or event-to-PI mapping exists anywhere here.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile

from . import admin_samples, blitz, config, courses, db, delivery, events, framework, interpret, llm, notify, progress, prompts, rubric, scenario_cache, study, taxonomy, terms, transcription, usage, video
from .auth import current_user, optional_user
from pydantic import BaseModel
from .ratelimit import daily_cap, rate_limit
from .schemas import (
    AnalyticalSection,
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

app = FastAPI(title="PI Coach", version="1.0.0")

# Standard participant-facing procedures (our own wording — original material).
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
def get_domains() -> list[DomainSummary]:
    """Our business domains (with criterion counts) — for UI hints/examples."""
    return [DomainSummary(**d) for d in framework.domain_summaries()]


@app.get("/api/events", response_model=list[EventSummary])
def get_events() -> list[EventSummary]:
    """The role-play events students pick from (our own catalog), in file order.
    Each carries its cluster (for grouping) and original focus suggestions."""
    return [EventSummary(**e) for e in events.event_summaries()]


@app.get("/api/terms", response_model=list[Term])
def get_terms(ids: str = "") -> list[Term]:
    """Study terms. With `ids` (comma list) returns just those (a weak-term deck, a
    flagged set, or a course unit); with no `ids` returns the whole corpus (the
    library). Each term carries a plain definition, a worked example run through the
    four DECA beats, and one term-specific common mistake.

    These are study content, NOT the grading criteria — see app/terms.py. Terms that
    map to a graded criterion carry `criterion_id` and tier="core"; the rest are
    study-only. Grading reads framework.json and never touches this path."""
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
    another user already paid for, instantly and for free — see app/scenario_cache.py
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
        interp = interpret.plan_session(event, req.request)
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
        raw = llm.complete(system, user, model=config.SCENARIO_MODEL, max_tokens=1600)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    situation = str(data.get("situation", "")).strip()
    if not situation:
        raise HTTPException(status_code=502, detail="The model returned an empty scenario.")

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
        followup_questions=followups,
        sampling=Sampling(signature=sampled["signature"], labels=sampled["labels"]) if sampled else None,
    )

    # 3) Pool it, so the next student with this key gets it instantly and free.
    #
    # Only scenarios that reached this point are stored: a non-empty situation and
    # exactly the required criteria count are both already enforced above. That
    # matters more here than elsewhere because a cached scenario is served to many
    # users — a bad one gets amplified instead of absorbed.
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
    about the words themselves — a quote we can't find is a quote they didn't say.
    """
    if not evidence:
        return False
    norm = lambda s: " ".join(s.lower().split())  # noqa: E731
    return norm(evidence) in norm(haystack)


def _build_depth(raw: dict, response_text: str, offered: dict[str, dict]) -> DepthScore:
    """Section 2's depth bonus: credit for genuinely APPLYING a related study term.

    Three deterministic gates, because the prompt alone can't be trusted with the
    one rule that matters here — mention must not pay:
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
    framing = _sub_score(raw.get("framing", {}))
    solution = _sub_score(raw.get("solution_quality", {}))
    pi_app = _sub_score(raw.get("pi_application", {}))

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


@app.post("/api/score-content", response_model=ScoreResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def score_content(req: ScoreRequest) -> ScoreResponse:
    """Grade a response against the selected framework criteria using the weighted
    three-section rubric (60% performance indicators, 25% analytical, 15% presentation)."""
    # Resolve criteria from our framework — never trust the client for their text.
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
        raw = llm.complete(system, user, model=config.SCORING_MODEL, max_tokens=4096)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # --- Section 1: Performance Indicators (60%) ---
    entries = {str(e.get("criterion_id", "")): e for e in data.get("performance_indicators", [])}
    scores = [_score_one(c, entries.get(c["id"], {})) for c in criteria]
    total = sum(s.points for s in scores)
    max_points = sum(s.max_points for s in scores)
    pi_percent = (total / max_points) * 100 if max_points else 0.0

    # --- Section 2: Analytical & Problem-Solving (25%) ---
    # Evidence for the depth bonus is checked against what the participant actually
    # said — main response and follow-up both count, since either can carry it.
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
    # result is authoritative — the model is never trusted for arithmetic.
    math_checks = mathcheck.verify_all(data.get("math_checks", [])) if quantitative else []

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
    entries for role-plays nobody ever read — permanently, since seen is forever.
    So the client tells us when it really showed one.

    Anonymous callers are a no-op here (there is no server-side history to write);
    their never-repeat list lives in localStorage.
    """
    if user and req.scenario_id:
        await scenario_cache.mark_seen(req.scenario_id, user["id"])
    return {"status": "ok"}


@app.get("/api/usage")
async def get_usage(user: dict | None = Depends(optional_user)) -> dict:
    """This caller's tier and remaining monthly allowance.

    Fetched BEFORE a session starts so the UI can show what's left up front —
    nobody should discover a cap halfway through a rep they've already prepped
    for. Anonymous callers get the anonymous tier's numbers, which the client
    also enforces (see app/usage.py for why that one is client-side)."""
    return await usage.summary(user)


@app.post("/api/score-delivery", response_model=DeliveryResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
async def score_delivery(
    audio: UploadFile = File(...),
    target_seconds: int = Form(delivery.DEFAULT_TARGET_SECONDS),
    diarize: bool = Form(False),
    user: dict | None = Depends(optional_user),
) -> DeliveryResponse:
    """Transcribe a spoken response and compute deterministic delivery metrics.

    For team events (`diarize=true`) we also request speaker labels and add a
    per-speaker talk breakdown + turn-by-turn transcript, so the app can show who
    dominated and attribute each turn. Audio is processed and discarded here — we
    keep only the transcript + numbers (minors' data minimization; the browser
    holds the recording for playback, deleting it unless the user opts to keep it).
    """
    raw = audio.file.read()
    if not raw:
        # Nothing was captured (mic blocked, or "stop" hit before any audio) —
        # a client problem, so a clear 422 rather than a scary gateway-style 5xx.
        raise HTTPException(
            status_code=422,
            detail="Nothing was recorded — no audio reached the server. Record your response, then submit again.",
        )

    # Claim the voice session AFTER the empty-audio check (a failed upload must
    # not cost the student an allowance) and BEFORE the paid transcription call.
    # For signed-in users this is atomic and server-enforced; anonymous callers
    # are metered client-side — see app/usage.py for that tradeoff.
    receipt = await usage.claim(user, "voice")

    try:
        result = transcription.transcribe(raw, diarize=diarize)
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
                "short, or picked up no clear speech — check your microphone, then "
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


@app.post("/api/score-video", response_model=VideoMetrics, dependencies=[Depends(rate_limit), Depends(daily_cap)])
async def score_video(req: VideoRequest, user: dict = Depends(current_user)) -> VideoMetrics:
    """Analyze sampled frames for observable eye contact and expression.

    REQUIRES AN ACCOUNT — deliberately. Video is the cost driver (roughly 2-3x an
    audio-only session), and an account is what makes the cap enforceable
    server-side. It is also always optional: the audio-only path is a first-class
    route through the whole loop and is never degraded by this endpoint existing.

    Nothing is retained. Frames arrive in the request body, are analyzed, and are
    gone when this returns; the full video is never recorded or uploaded at all
    (the client samples stills from the live camera preview). See app/video.py for
    the claim rules — every number here is an observable check, never an inferred
    internal state.
    """
    if not req.frames:
        raise HTTPException(
            status_code=422,
            detail="No frames were captured — check your camera permission and try again.",
        )

    receipt = await usage.claim(user, "video")
    try:
        metrics = video.analyze([(f.media_type, f.data) for f in req.frames])
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
        # Every batch failed to read — no usable checks means no honest numbers to
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
# session-local on the client — no accounts, no persistence.


@app.get("/api/blitz/scenarios", response_model=list[BlitzScenario])
def blitz_scenarios() -> list[BlitzScenario]:
    """The static pool of short drill scenarios (the client picks one per round)."""
    return [BlitzScenario(**s) for s in blitz.scenarios()]


@app.post("/api/transcribe", response_model=TranscribeResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def transcribe(audio: UploadFile = File(...)) -> TranscribeResponse:
    """Transcript only (no delivery metrics) — used for spoken blitz answers, which
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
        raise HTTPException(status_code=502, detail="Couldn't transcribe that recording — try again or type your answer.")
    return TranscribeResponse(transcript=result.text)


@app.post("/api/blitz-score", response_model=BlitzScoreResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def blitz_score(req: BlitzScoreRequest) -> BlitzScoreResponse:
    """Grade a whole drill in ONE batched call: for each term, 'used correctly and
    in context?' -> correct | partial | missed + a one-line note. Term text is
    re-pinned server-side by id (never trusted from the client)."""
    # Resolve each answer's term server-side: plain definition + the card's 'Connect'
    # beat as the gold-standard "correct use" reference. Drills run over study terms,
    # so this reads terms.json — a drilled term may have no graded criterion at all.
    items: list[dict] = []
    order: list[str] = []
    for a in req.answers:
        t = terms.get_term(a.term_id)
        if not t:
            continue  # unknown id — skip rather than fail the whole drill
        good = (t.get("example") or {}).get("connect", "")
        items.append({"name": t["name"], "definition": t.get("definition", ""), "good_example": good, "response": a.response})
        order.append(a.term_id)

    if not items:
        raise HTTPException(status_code=400, detail="No known terms to grade.")

    system, user = prompts.build_blitz_prompt(req.scenario, items)
    try:
        raw = llm.complete(system, user, model=config.BLITZ_MODEL, max_tokens=1024)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Map the model's per-index verdicts back onto criterion ids; default to
    # "missed" for anything the model skipped, so the client always gets N results.
    by_index: dict[int, dict] = {}
    for r in data.get("results", []):
        try:
            by_index[int(r.get("index"))] = r
        except (TypeError, ValueError):
            continue
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
        raise HTTPException(status_code=502, detail="Couldn't save your session — try again.") from exc
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

    Renders fully for anonymous visitors — every term shows as "new" — so a student
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
            # Progress is an overlay, not the point — show the path rather than 502.
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
        raise HTTPException(status_code=404, detail="No course yet — pick an event to start one.")
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
    are dropped rather than 400 — a stale client shouldn't fail a whole Blitz."""
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


# --- admin QA page (owner-only, secret passphrase) -------------------------

class AdminVerify(BaseModel):
    passphrase: str = ""


@app.post("/api/admin/verify")
def admin_verify(req: AdminVerify) -> dict:
    """Check the admin passphrase server-side (so the secret never ships in the
    SPA bundle). 404 when no passphrase is configured — the admin page is off."""
    import hmac

    if not config.ADMIN_PASSPHRASE:
        raise HTTPException(status_code=404, detail="Not found.")
    ok = hmac.compare_digest(req.passphrase or "", config.ADMIN_PASSPHRASE)
    return {"ok": ok}


@app.get("/api/admin/cache-stats")
async def admin_cache_stats(user: dict = Depends(current_user)) -> dict:
    """Scenario-cache effectiveness since this process started.

    The savings claim for the cache is only as good as this number — "we cache
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
# win), giving a single origin — no CORS, keys in one place. Skipped when the
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

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
