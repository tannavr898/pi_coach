"""FastAPI application — content loop (independent evaluation framework).

Endpoints:
- GET  /api/health         liveness
- GET  /api/config         client-safe runtime config
- GET  /api/framework      our business domains (for UI hints)
- GET  /api/rubric         the scoring levels (labels + descriptions) for the UI
- POST /api/feedback       record a piece of user feedback
- POST /api/scenario       interpret a free-text request, select framework
                           criteria, and generate an original scenario
- POST /api/score-content  grade a response against the selected criteria
- POST /api/score-delivery transcribe audio + compute deterministic delivery metrics

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

from . import admin_samples, blitz, config, db, delivery, events, flashcards, framework, interpret, llm, notify, progress, prompts, rubric, taxonomy, transcription
from .auth import current_user
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
    Sampling,
    ScenarioRequest,
    ScenarioResponse,
    ScoreRequest,
    ScoreResponse,
    SessionDetail,
    SessionSaveRequest,
    SessionSaved,
    SessionSummary,
    SubScore,
    Timing,
    TranscribeResponse,
    Utterance,
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


@app.get("/api/criteria", response_model=list[Criterion])
def get_criteria(ids: str = "") -> list[Criterion]:
    """Flashcard content for framework criteria. With `ids` (comma list) returns just
    those (a user's weak-criterion deck); with no `ids` returns the WHOLE framework
    (the library). Each card carries a plain definition, a term-specific worked
    example run through the four DECA beats, and one common-mistake line (Phase 4);
    the old strong/weak fields are still sent for back-compat but no longer shown."""
    fields = ("id", "domain", "topic", "name", "definition", "strong_looks_like", "weak_looks_like", "coaches")
    wanted = [x.strip() for x in ids.split(",") if x.strip()]
    source = framework.get_criteria(wanted) if wanted else framework.all_criteria()
    out: list[Criterion] = []
    for c in source:
        base = {k: c.get(k, "") for k in fields}
        content = flashcards.content_for(c["id"])
        if content:
            # The flashcard definition is the plain, student-facing one — it overrides
            # the grading-question definition on this (display-only) path.
            base["definition"] = content.get("definition") or base["definition"]
            ex = content.get("example") or {}
            base["example"] = {k: ex.get(k, "") for k in ("define", "explain", "connect", "above")}
            base["mistake"] = content.get("mistake", "")
        out.append(Criterion(**base))
    return out


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
def scenario(req: ScenarioRequest) -> ScenarioResponse:
    """Plan the session from the chosen event (+ optional focus), select framework
    criteria, and generate an original scenario built to require exactly those."""
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

    return ScenarioResponse(
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


def _build_analytical(raw: dict) -> AnalyticalSection:
    """Section 2: take the model's 1-4 sub-scores + creativity bonus, then compute
    the roll-up arithmetic DETERMINISTICALLY (the model is never trusted to do the
    weighting or the min())."""
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

    core = framing.score * 0.30 + solution.score * 0.45 + pi_app.score * 0.25
    section = _clamp(core + bonus, 0.0, 4.0)
    return AnalyticalSection(
        framing=framing,
        solution_quality=solution,
        pi_application=pi_app,
        creativity=creativity,
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

    system, user = prompts.build_scoring_prompt(
        req.scenario, criteria, req.response, req.followup_questions, req.followup_answer,
        quantitative, req.spoken, req.delivery_score,
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
    analytical = _build_analytical(data.get("analytical", {}) or {})

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


@app.post("/api/score-delivery", response_model=DeliveryResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def score_delivery(
    audio: UploadFile = File(...),
    target_seconds: int = Form(delivery.DEFAULT_TARGET_SECONDS),
    diarize: bool = Form(False),
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
    try:
        result = transcription.transcribe(raw, diarize=diarize)
    except transcription.TranscriptionNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except transcription.TranscriptionError:
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
    in context?' -> correct | partial | missed + a one-line note. Criterion text is
    re-pinned server-side by id (never trusted from the client)."""
    # Resolve each answer's term server-side: plain definition + the flashcard's
    # 'Connect' beat as the gold-standard "correct use" reference.
    items: list[dict] = []
    order: list[str] = []
    for a in req.answers:
        crit = framework.get_criteria([a.criterion_id])
        if not crit:
            continue  # unknown id — skip rather than fail the whole drill
        c = crit[0]
        content = flashcards.content_for(a.criterion_id) or {}
        definition = content.get("definition") or c.get("definition", "")
        good = (content.get("example") or {}).get("connect", "")
        items.append({"name": c["name"], "definition": definition, "good_example": good, "response": a.response})
        order.append(a.criterion_id)

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
    for i, cid in enumerate(order):
        r = by_index.get(i, {})
        verdict = str(r.get("verdict", "missed")).lower()
        results.append(BlitzResult(
            criterion_id=cid,
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
