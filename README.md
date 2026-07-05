# PI Coach

An AI trainer that lets a DECA competitor practice a role-play end to end: say
what you want to work on, get an original scenario built around it, prep against a
real timer, respond (typed or spoken), and get honest feedback on **content**
(the business skills you demonstrate + structure) and **delivery** (pace, fillers,
pauses — from your actual voice). Output is always practice coaching, never a
judge score.

The app trains the substance DECA judges reward using our **own independent
evaluation framework** (`backend/app/data/framework.json`) — authored from
public-domain business concepts, not DECA's licensed performance-indicator list.
See [`backend/app/data/framework-notes.md`](./backend/app/data/framework-notes.md)
for how the framework was built and why it is independent.

See [`roadmap.txt`](./roadmap.txt) for the full plan and the reasoning behind
every decision.

## Repo layout

```
backend/   FastAPI (Python, uv) — data, prompts, Anthropic calls, provider keys
frontend/  Vite + React + TS + Tailwind SPA — talks only to /api/*
```

## How the loop works

The full loop works typed **or spoken**: type a free-text practice request
("marketing for a restaurant") and pick a **mode** (Competition or Learn) →
we interpret it, select the fitting framework criteria, and generate an original
scenario built to require them → **ready screen** with prep tips → 10-min prep
timer → **type or 🎙️ speak** your presentation → answer the judge's **two
follow-up questions** (typed or spoken) → tabbed **feedback** (overall percentage,
per-criterion level + one-line headline that expands to detail, a **What was
missing** list, transcript highlighted where each criterion saw evidence, and —
for spoken takes — a **Delivery** tab with pace, fillers, pauses, time use, and
playback).

- **Free-text request + modes:** no event/area dropdowns — you describe what to
  practice. **Competition mode** shows only the names of the skills assessed
  (like a real role-play sheet); **Learn mode** also shows each skill's coaching
  question and what a strong answer looks like, and gives more tutorial feedback.
  Both use the same scenario, criteria, and scoring engine — mode only changes
  what's revealed.

- **The evaluation framework:** `backend/app/data/framework.json` — **282
  independently authored criteria** across 13 business domains, at a grain a
  student can explain in their allotted time. A role-play draws 4–6, so the ideas
  that come up feel like a real competition's while remaining our own IP.
  Generation and scoring share the exact same criteria set. See
  `framework-notes.md` for the domain map, grain logic, and independence audit.

- **Voice:** record with the browser, transcribe via AssemblyAI, and compute
  delivery metrics (pace WPM, filler rate, long pauses, time use, reading signal)
  deterministically from word timestamps. Audio is processed and discarded; the
  browser keeps the take for playback. Delivery measures timing only — never tone
  or confidence.

- **Scoring scale:** each selected criterion is graded Novice / Developing /
  Proficient / Exemplary against its own strong/weak bar on a 0–10 band; the
  overall result is shown as a percentage. Generic quality levels — not any
  organization's proprietary rubric. Structure in `backend/app/data/rubric.json`.
- **Endpoints:** `POST /api/scenario` (interpret + select + generate;
  participant-facing only — judge instructions never leave the backend),
  `POST /api/score-content` (grade against the selected framework criteria),
  `POST /api/score-delivery` (voice), plus `GET /api/framework` (our domains) and
  `GET /api/rubric` (scoring levels). Backed by the Anthropic API and a
  transcription provider (AssemblyAI) for voice.
- **Guardrails:** contains **zero** DECA performance-indicator text, codes, or
  event-to-PI mapping; keys stay server-side; per-IP rate limit on the paid
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
