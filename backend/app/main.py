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

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile

from . import config, delivery, framework, interpret, llm, notify, prompts, rubric, transcription
from .ratelimit import daily_cap, rate_limit
from .schemas import (
    Criterion,
    CriterionScore,
    DeliveryMetrics,
    DeliveryResponse,
    DomainSummary,
    FeedbackRequest,
    Mode,
    PublicConfig,
    ScenarioRequest,
    ScenarioResponse,
    ScoreRequest,
    ScoreResponse,
)

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
    """Client-safe runtime config (the public PostHog key, if configured)."""
    return PublicConfig(posthog_key=config.POSTHOG_KEY, posthog_host=config.POSTHOG_HOST)


@app.get("/api/framework", response_model=list[DomainSummary])
def get_domains() -> list[DomainSummary]:
    """Our business domains (with criterion counts) — for UI hints/examples."""
    return [DomainSummary(**d) for d in framework.domain_summaries()]


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
    """Interpret the free-text request, select framework criteria, and generate an
    original scenario built to require exactly those criteria."""
    # 1) Interpret the free text -> domains + industry (or a friendly redirect).
    try:
        interp = interpret.interpret_request(req.request)
    except interpret.OutOfScope as e:
        raise HTTPException(status_code=422, detail=e.message)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    pool = interpret.candidate_pool(interp["domain_ids"])

    # 2) Generate: the model selects the criteria from the pool AND writes the scenario.
    system, user = prompts.build_scenario_prompt(interp["topic"], interp["industry"], req.level, pool)
    try:
        raw = llm.complete(system, user, max_tokens=1600)
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
        domain_focus=domain_focus,
        level=req.level,
        mode=req.mode,
        criteria=[_criterion_view(c, req.mode) for c in criteria],
        procedures=PROCEDURES,
        situation=situation,
        followup_questions=followups,
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
    )


@app.post("/api/score-content", response_model=ScoreResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def score_content(req: ScoreRequest) -> ScoreResponse:
    """Grade a typed response against the selected framework criteria."""
    # Resolve criteria from our framework — never trust the client for their text.
    criteria = framework.get_criteria(req.criteria_ids)
    if not criteria:
        raise HTTPException(status_code=400, detail="Unknown evaluation criteria.")

    system, user = prompts.build_scoring_prompt(
        req.scenario, criteria, req.response, req.followup_questions, req.followup_answer
    )
    try:
        raw = llm.complete(system, user, max_tokens=4096)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    entries = {str(e.get("criterion_id", "")): e for e in data.get("criteria", [])}
    scores = [_score_one(c, entries.get(c["id"], {})) for c in criteria]

    total = sum(s.points for s in scores)
    max_points = sum(s.max_points for s in scores)
    percent = round((total / max_points) * 100) if max_points else 0
    return ScoreResponse(
        scores=scores,
        total_points=total,
        max_points=max_points,
        overall_percent=percent,
        overall_level=rubric.overall_level(percent),  # type: ignore[arg-type]
        summary=str(data.get("summary", "")).strip(),
        strengths=[str(x) for x in data.get("strengths", []) if str(x).strip()],
        improvements=[str(x) for x in data.get("improvements", []) if str(x).strip()],
        followup_feedback=str(data.get("followup_feedback", "")).strip(),
    )


@app.post("/api/score-delivery", response_model=DeliveryResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def score_delivery(
    audio: UploadFile = File(...),
    target_seconds: int = Form(delivery.DEFAULT_TARGET_SECONDS),
) -> DeliveryResponse:
    """Transcribe a spoken response and compute deterministic delivery metrics.

    Audio is processed and discarded here — we keep only the transcript + numbers
    (minors' data minimization; the browser holds the recording for playback,
    deleting it unless the user opts to keep it).
    """
    raw = audio.file.read()
    try:
        result = transcription.transcribe(raw)
    except transcription.TranscriptionNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except transcription.TranscriptionError as e:
        raise HTTPException(status_code=502, detail=str(e))

    metrics = delivery.compute_delivery(result.words, result.audio_duration_s, target_seconds=target_seconds)
    return DeliveryResponse(transcript=result.text, metrics=DeliveryMetrics(**metrics))


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

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
