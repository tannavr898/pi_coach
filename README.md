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

## Current status: Phase 2 — Content loop MVP (typed)

The full typed loop works: pick an event → generate an original DECA-format
scenario → 10-min prep timer → type a response → PI-by-PI feedback + structure +
one judge follow-up.

- **Data (Phase 1):** the full official DECA **Business Administration Core** —
  13 instructional areas, 367 PIs (verbatim text + level), behind all five
  Principles events (PMK, PBM, PEN, PFN, PHT).
- **Endpoints:** `POST /api/scenario` and `POST /api/score-content`, built from
  the roadmap §7 prompts and backed by the Anthropic API (Sonnet 4.6 by
  default). `GET /api/events` feeds the picker.
- **Guardrails:** keys stay server-side; per-IP rate limit on the paid
  endpoints; output labelled "PI coverage feedback," never a judge score.

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

> **Note (this machine):** `npm install` here hits a TLS-inspection cert error
> (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Run it as
> `NODE_OPTIONS=--use-system-ca npm install` so Node trusts the Windows CA store.

Backend details (lookup script, tests) are in
[`backend/README.md`](./backend/README.md).
