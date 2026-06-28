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
backend/   FastAPI (Python, uv) — data, prompts, Anthropic calls, provider keys
frontend/  Vite + React + TS + Tailwind SPA — talks only to /api/*
```

## Current status: Phase 2 — Content loop (rubric-based, typed)

The full typed loop works: pick an event → generate an original DECA-format
scenario → **ready screen** with prep tips → 10-min prep timer → type a
presentation → answer the judge's **two follow-up questions** → **rubric
feedback** (score out of 100, per-criterion levels + comments, and your
transcript highlighted where each criterion saw evidence).

- **Data (Phase 1):** the full official DECA **Business Administration Core** —
  13 instructional areas, 367 PIs (verbatim text + level), behind all five
  Principles events (PMK, PBM, PEN, PFN, PHT).
- **Rubric:** scoring mirrors DECA's **2026 District** evaluation form — four
  Performance Indicators (0–12 each), three Solution criteria (0–8), three
  Career Competencies (0–6), and Overall Impression (0–10) = 100 points, on four
  levels (Novice / Developing / Proficient / Exemplary). Structure stored in
  `backend/app/data/rubric.json`.
- **Endpoints:** `POST /api/scenario` (participant-facing only — judge
  instructions never leave the backend), `POST /api/score-content`, plus
  `GET /api/events` and `GET /api/rubric`. Backed by the Anthropic API (Sonnet
  4.6 by default).
- **Guardrails:** keys stay server-side; per-IP rate limit on the paid
  endpoints; original clean-room scenarios; output labelled practice coaching,
  never an official competition score.

## Run it (two terminals)

```bash
# Terminal 1 — backend (needs an Anthropic key)
cd backend
uv sync
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
uv run uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend (proxies /api -> :8000)
cd frontend && npm install && npm run dev
```

Open the Vite URL and run a full typed loop. Without a key the scenario/scoring
endpoints return a clear 503; the rest of the UI still works.

> DECA's official sample role-plays (used privately to calibrate the rubric and
> prompts) live under `backend/reference/` and are **gitignored** — copyright;
> never committed or shipped. Our generated scenarios stay clean-room.

> **Note (this machine):** `npm install` here hits a TLS-inspection cert error
> (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Run it as
> `NODE_OPTIONS=--use-system-ca npm install` so Node trusts the Windows CA store.

Backend details (lookup script, tests) are in
[`backend/README.md`](./backend/README.md).
