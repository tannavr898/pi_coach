# PI Coach

An AI trainer that lets a DECA competitor practice a role-play end to end:
generate an original scenario in DECA's format, prep against a real timer,
respond (typed or spoken), and get honest feedback on **content** (PI coverage +
structure) and **delivery** (pace, fillers, pauses — from your actual voice).
Output is always labeled "PI coverage + delivery feedback," never a judge score.

See [`roadmap.txt`](./roadmap.txt) for the full plan and the reasoning behind
every decision.

## Repo layout

```
backend/   FastAPI (Python, uv) — data, prompts, Anthropic calls, provider keys
frontend/  Vite + React + TS + Tailwind SPA — talks only to /api/*
```

## Current status: Phase 3 — Voice (delivery metrics)

The full loop works typed **or spoken**: pick an event (and optionally a focus
instructional area) → generate an original DECA-format scenario → **ready
screen** with prep tips → 10-min prep timer → **type or 🎙️ speak** your
presentation → answer the judge's **two follow-up questions** (typed or spoken)
→ tabbed **feedback** (score out of 100, per-criterion level + one-line headline
that expands to detail, a **What was missing** list, transcript highlighted
where each criterion saw evidence, and — for spoken takes — a **Delivery** tab
with pace, fillers, pauses, time use, and playback).

- **Events (all qualitative individual series):** 17 events across Principles,
  Marketing (AAM, ASM, BSM, FMS, MCS, RMS, SEM), Hospitality & Tourism (HLM,
  QSRM, RFSM), Entrepreneurship (ENT), and Human Resources Management (HRM).
  Each PI is tagged `core` / `cluster:<id>` / `pathway:<id>:<name>`, so an
  event's pool is the Business Administration Core plus its career-cluster core
  and pathway (1806 PIs across 25 instructional areas). Principles events stay
  strictly core-only. Quantitative events (Accounting, Business Finance, PFL)
  are deferred.

- **Voice (Phase 3):** record with the browser, transcribe via AssemblyAI, and
  compute delivery metrics (pace WPM, filler rate, long pauses, time use,
  reading signal) deterministically from word timestamps. Audio is processed and
  discarded; the browser keeps the take for playback. Delivery measures timing
  only — never tone or confidence (roadmap §2).

- **Data:** the official DECA **Business Administration Core** (13 areas, 367
  PIs) plus the Marketing, Hospitality & Tourism, Business Management &
  Administration, and Entrepreneurship career-cluster PIs, parsed from DECA's
  published Performance Indicator PDFs — 1806 PIs across 25 instructional areas.
- **Rubric:** scoring mirrors DECA's **2026 District** evaluation form — four
  Performance Indicators (0–12 each), three Solution criteria (0–8), three
  Career Competencies (0–6), and Overall Impression (0–10) = 100 points, on four
  levels (Novice / Developing / Proficient / Exemplary). Structure stored in
  `backend/app/data/rubric.json`.
- **Endpoints:** `POST /api/scenario` (participant-facing only — judge
  instructions never leave the backend), `POST /api/score-content`,
  `POST /api/score-delivery` (voice), plus `GET /api/events`,
  `GET /api/events/{code}/areas` (the focus-area picker), and `GET /api/rubric`.
  Backed by the Anthropic API (Sonnet 4.6 by default) and a transcription
  provider (AssemblyAI) for voice.
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
