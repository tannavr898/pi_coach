"""FastAPI application — Phase 2 content loop.

Endpoints:
- GET  /api/health         liveness
- GET  /api/events         events the UI can offer
- POST /api/scenario       generate an original scenario for an event
- POST /api/score-content  score a typed response against the assigned PIs

The Vite dev server proxies /api/* here, so no CORS in development. Provider
keys stay server-side (roadmap §5/§9); the frontend only ever talks to /api/*.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException

from . import llm, prompts
from .data_loader import EventNotFoundError, get_event, load_events
from .ratelimit import rate_limit
from .schemas import (
    EventSummary,
    PI,
    PIResult,
    ScenarioRequest,
    ScenarioResponse,
    ScoreRequest,
    ScoreResponse,
)
from .selection import select_pis

app = FastAPI(title="DECA Roleplay Trainer", version="0.2.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness check used by the frontend to prove the wire works."""
    return {"status": "ok"}


@app.get("/api/events", response_model=list[EventSummary])
def events() -> list[EventSummary]:
    """Events the picker can offer."""
    return [
        EventSummary(code=e["code"], name=e["name"], level=e["level"], pi_count=e["pi_count"])
        for e in load_events()
    ]


def _event_or_404(code: str) -> dict:
    try:
        return get_event(code)
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail=f"Unknown event code: {code!r}")


@app.post("/api/scenario", response_model=ScenarioResponse, dependencies=[Depends(rate_limit)])
def scenario(req: ScenarioRequest) -> ScenarioResponse:
    """Generate an original DECA-format scenario for an event."""
    event = _event_or_404(req.event_code)
    pis = select_pis(event["code"], area=req.area, pi_ids=req.pi_ids, seed=req.seed)
    if not pis:
        raise HTTPException(status_code=400, detail="No performance indicators matched this request.")

    system, user = prompts.build_scenario_prompt(event, req.level, pis)
    try:
        text = llm.complete(system, user, max_tokens=2048)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    if not text:
        raise HTTPException(status_code=502, detail="The model returned an empty scenario.")

    return ScenarioResponse(
        event=EventSummary(code=event["code"], name=event["name"], level=event["level"], pi_count=event["pi_count"]),
        level=req.level,
        performance_indicators=[PI(**pi) for pi in pis],
        scenario=text,
    )


@app.post("/api/score-content", response_model=ScoreResponse, dependencies=[Depends(rate_limit)])
def score_content(req: ScoreRequest) -> ScoreResponse:
    """Score a typed response against the assigned PIs (PI coverage + structure)."""
    # Resolve PI text from our authoritative data — never trust the client for it.
    # pi_ids belong to the same Principles core regardless of event, so PMK covers all.
    pis = select_pis("PMK", pi_ids=req.pi_ids)
    if not pis:
        raise HTTPException(status_code=400, detail="Unknown performance indicators.")
    pi_text = {pi["id"]: pi["text"] for pi in pis}

    system, user = prompts.build_scoring_prompt(req.scenario, pis, req.response)
    try:
        raw = llm.complete(system, user, max_tokens=3072)
        data = llm.parse_json_object(raw)
    except llm.LLMNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Pin each result's PI text back to our official wording (credibility).
    results: list[PIResult] = []
    for r in data.get("pi_results", []):
        pid = r.get("id", "")
        try:
            results.append(
                PIResult(
                    id=pid,
                    text=pi_text.get(pid, r.get("text", "")),
                    coverage=r.get("coverage", "missed"),
                    evidence=r.get("evidence", ""),
                    improvement=r.get("improvement", ""),
                )
            )
        except Exception:  # skip a malformed entry rather than fail the whole score
            continue

    try:
        return ScoreResponse(
            pi_results=results,
            structure_feedback=data.get("structure_feedback", ""),
            addressed_task=bool(data.get("addressed_task", True)),
            overall_notes=data.get("overall_notes", ""),
            pi_coverage_summary=data.get("pi_coverage_summary", {}) or {},
            followup_question=data.get("followup_question", ""),
        )
    except Exception as e:  # pydantic validation of the assembled object
        raise HTTPException(status_code=502, detail=f"Malformed score from model: {e}")
