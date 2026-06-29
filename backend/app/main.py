"""FastAPI application — content loop (rubric-based, DECA 2026 District format).

Endpoints:
- GET  /api/health         liveness
- GET  /api/events         events the UI can offer
- GET  /api/rubric         the rubric structure (levels, criteria, point bands)
- POST /api/scenario       generate an original scenario (participant-facing only)
- POST /api/score-content  grade a typed response + follow-up against the rubric

The Vite dev server proxies /api/* here, so no CORS in development. Provider
keys stay server-side (roadmap §5/§9); the frontend only ever talks to /api/*.
The judge's instructions are never returned to the client — only the
participant-facing situation and (after the response) the follow-up questions.
"""

from __future__ import annotations

import logging

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile

from . import config, delivery, llm, notify, prompts, rubric, transcription
from .data_loader import (
    EventNotFoundError,
    get_event,
    get_instructional_areas,
    get_pis_by_ids,
    load_events,
)
from .ratelimit import daily_cap, rate_limit
from .schemas import (
    AreaSummary,
    DeliveryMetrics,
    DeliveryResponse,
    EventSummary,
    FeedbackRequest,
    PI,
    PublicConfig,
    RubricCriterion,
    RubricScore,
    ScenarioRequest,
    ScenarioResponse,
    ScoreRequest,
    ScoreResponse,
)
from .selection import select_pis

app = FastAPI(title="PI Coach", version="0.4.0")

# Standard participant-facing procedures (our own wording — not DECA copyright).
PROCEDURES = [
    "You have up to 10 minutes to review the situation and prepare. You may make notes to use during your presentation.",
    "You then have up to 10 minutes to present to the judge.",
    "You are evaluated on your solution, how you incorporate the performance indicators, and how you demonstrate the career competencies.",
    "The judge will ask you follow-up questions after your presentation.",
]


log = logging.getLogger("picoach")


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness check used by the frontend to prove the wire works."""
    return {"status": "ok"}


@app.get("/api/config", response_model=PublicConfig)
def public_config() -> PublicConfig:
    """Client-safe runtime config (the public PostHog key, if configured)."""
    return PublicConfig(posthog_key=config.POSTHOG_KEY, posthog_host=config.POSTHOG_HOST)


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


def _event_summary(e: dict) -> EventSummary:
    return EventSummary(
        code=e["code"],
        name=e["name"],
        level=e["level"],
        pi_count=e["pi_count"],
        cluster_label=e.get("cluster_label", ""),
    )


@app.get("/api/events", response_model=list[EventSummary])
def events() -> list[EventSummary]:
    """Events the picker can offer."""
    return [_event_summary(e) for e in load_events()]


@app.get("/api/events/{code}/areas", response_model=list[AreaSummary])
def event_areas(code: str) -> list[AreaSummary]:
    """Instructional areas the picker can offer for one event (with PI counts)."""
    _event_or_404(code)
    return [
        AreaSummary(id=a["id"], name=a["name"], pi_count=len(a["performance_indicators"]))
        for a in get_instructional_areas(code)
    ]


@app.get("/api/rubric")
def get_rubric() -> dict:
    """The rubric structure (levels, criteria, point bands) for the UI to render."""
    return rubric.load_rubric()


def _solution_criteria() -> list[RubricCriterion]:
    mx = rubric.max_points("solution")
    return [RubricCriterion(key=i["key"], label=i["label"], desc=i["desc"], max_points=mx) for i in rubric.solution_items()]


def _competency_criteria() -> list[RubricCriterion]:
    mx = rubric.max_points("career_competency")
    return [RubricCriterion(key=i["key"], label=i["label"], desc=i["desc"], max_points=mx) for i in rubric.competency_items()]


def _event_or_404(code: str) -> dict:
    try:
        return get_event(code)
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail=f"Unknown event code: {code!r}")


@app.post("/api/scenario", response_model=ScenarioResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def scenario(req: ScenarioRequest) -> ScenarioResponse:
    """Generate an original DECA-format scenario (participant-facing only)."""
    event = _event_or_404(req.event_code)
    pis = select_pis(event["code"], area=req.area, pi_ids=req.pi_ids, seed=req.seed)
    if not pis:
        raise HTTPException(status_code=400, detail="No performance indicators matched this request.")
    area_name = pis[0].get("area_name", "")

    system, user = prompts.build_scenario_prompt(event, req.level, area_name, pis)
    try:
        raw = llm.complete(system, user, max_tokens=1500)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    situation = str(data.get("situation", "")).strip()
    if not situation:
        raise HTTPException(status_code=502, detail="The model returned an empty scenario.")
    followups = [str(q).strip() for q in data.get("followup_questions", []) if str(q).strip()]

    return ScenarioResponse(
        event=_event_summary(event),
        level=req.level,
        instructional_area=area_name,
        performance_indicators=[PI(**pi) for pi in pis],
        solution_criteria=_solution_criteria(),
        career_competencies=_competency_criteria(),
        procedures=PROCEDURES,
        situation=situation,
        followup_questions=followups,
    )


def _score_one(category: str, key: str, label: str, raw: dict, *, pi_id: str | None = None) -> RubricScore:
    """Build one validated RubricScore from a model entry, clamping to the band."""
    level, points = rubric.clamp_points(category, str(raw.get("level", "novice")), raw.get("points", 0))
    evidence = [str(q) for q in raw.get("evidence", []) if str(q).strip()]
    return RubricScore(
        key=key,
        category=category,  # type: ignore[arg-type]
        label=label,
        pi_id=pi_id,
        level=level,  # type: ignore[arg-type]
        points=points,
        max_points=rubric.max_points(category),
        headline=str(raw.get("headline", "")).strip(),
        feedback=str(raw.get("feedback", "")).strip(),
        evidence=evidence,
        gaps=[str(g).strip() for g in raw.get("gaps", []) if str(g).strip()],
    )


@app.post("/api/score-content", response_model=ScoreResponse, dependencies=[Depends(rate_limit), Depends(daily_cap)])
def score_content(req: ScoreRequest) -> ScoreResponse:
    """Grade a typed response + follow-up against the full DECA rubric."""
    # Resolve PI text from our authoritative data — never trust the client for it.
    pis = select_pis(req.event_code, pi_ids=req.pi_ids)
    if not pis:
        # Fall back to the full catalog so any valid PI id still resolves.
        pis = get_pis_by_ids(req.pi_ids)
    if not pis:
        raise HTTPException(status_code=400, detail="Unknown performance indicators.")
    pi_text = {pi["id"]: pi["text"] for pi in pis}

    system, user = prompts.build_scoring_prompt(
        req.scenario, pis, req.response, req.followup_questions, req.followup_answer
    )
    try:
        raw = llm.complete(system, user, max_tokens=4096)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    scores: list[RubricScore] = []

    # 1) Performance Indicators (in assigned order), text pinned to our wording.
    pi_entries = {str(e.get("pi_id", "")): e for e in data.get("performance_indicators", [])}
    for pi in pis:
        entry = pi_entries.get(pi["id"], {})
        scores.append(
            _score_one("performance_indicator", f"pi:{pi['id']}", pi_text[pi["id"]], entry, pi_id=pi["id"])
        )

    # 2) Solution criteria, 3) Career competencies (fixed order from the rubric).
    sol = data.get("solution", {}) or {}
    for item in rubric.solution_items():
        scores.append(_score_one("solution", f"solution:{item['key']}", item["label"], sol.get(item["key"], {})))
    comp = data.get("career_competencies", {}) or {}
    for item in rubric.competency_items():
        scores.append(
            _score_one("career_competency", f"competency:{item['key']}", item["label"], comp.get(item["key"], {}))
        )

    # 4) Overall impression.
    scores.append(
        _score_one("overall_impression", "overall", "Overall Impression", data.get("overall_impression", {}) or {})
    )

    total = sum(s.points for s in scores)
    return ScoreResponse(
        scores=scores,
        total_points=total,
        max_points=rubric.total_max(),
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
    (roadmap §2 minors' data minimization; the browser holds the recording for
    playback, deleting it unless the user opts to keep it).
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

_DIST = os.getenv("FRONTEND_DIST", str(Path(__file__).resolve().parents[2] / "frontend" / "dist"))
if Path(_DIST).is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
