# DECA Roleplay Trainer

An AI trainer that lets a DECA competitor practice a roleplay end to end:
generate an original scenario in DECA's format, prep against a real timer,
respond, and get honest feedback on **content** (PI coverage + structure) and,
later, **delivery** (pace, fillers, pauses — from your actual voice). Output is
always labeled "PI coverage + delivery feedback," never a judge score.

See [`roadmap.txt`](./roadmap.txt) for the full plan and the reasoning behind
every decision.

## Repo layout

```
backend/   FastAPI (Python, uv) — data, prompts (later), provider keys
frontend/  Vite + React + TS + Tailwind SPA — talks only to /api/*
```

## Current status: Step 1 — Scaffold + Phase 1 data foundation

- Health endpoint + frontend that proves the SPA→backend wire works.
- Phase 1 data layer: `event code → instructional areas + PI pool` for all five
  Principles events (PMK, PBM, PEN, PFN, PHT), backed by the full official DECA
  **Business Administration Core** — 13 instructional areas, 367 performance
  indicators with verbatim text + level (PQ/CS/SP).

## Run it (two terminals)

```bash
# Terminal 1 — backend
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend (proxies /api -> :8000)
cd frontend && npm install && npm run dev
```

Open the Vite URL; the page should show the backend as connected.

Backend details (lookup script, tests) are in
[`backend/README.md`](./backend/README.md).
