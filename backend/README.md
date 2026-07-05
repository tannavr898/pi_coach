# PI Coach — Backend

FastAPI service. Holds the independent evaluation framework, prompt construction,
and provider API keys. The frontend talks only to `/api/*`; keys never leave here.

## Setup

```bash
cd backend
uv sync
cp .env.example .env   # put your key in ANTHROPIC_API_KEY (needed for scenario/scoring)
```

## Run

```bash
uv run uvicorn app.main:app --reload --port 8000
# health check:
curl localhost:8000/api/health   # -> {"status":"ok"}
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/framework` | Our business domains (id, name, blurb, criterion count) — for UI hints/examples. |
| `GET /api/rubric` | The scoring levels (labels, descriptions, per-criterion band). |
| `POST /api/scenario` | Interpret a free-text request, select the fitting framework criteria, and generate an original scenario built to require them. Body: `{request, level, mode}` (`mode` = `learn` \| `competition`). Returns the interpreted `topic`/`industry`/`domain_focus`, the selected `criteria` (teaching fields populated in Learn mode, names-only in Competition mode), `procedures`, the **participant-facing situation** (no judge text), and the judge's follow-up questions. Out-of-scope (non-business) requests return a friendly `422`. |
| `POST /api/score-content` | Grade a response against the selected framework criteria. Body: `{scenario, criteria_ids, response, followup_questions, followup_answer}`. Returns per-criterion `scores` (level + points/10 + feedback + verbatim evidence quotes + gaps), the total, the overall percentage/level, strengths/improvements, and follow-up feedback. |
| `POST /api/score-delivery` | Transcribe a spoken response and return deterministic delivery metrics. Multipart `audio` upload (+ optional `target_seconds`). Returns the `transcript` plus `metrics` (pace WPM, fillers, pauses, time use, reading signal, coaching notes). Audio is processed and discarded; only the transcript + numbers are returned. |

The judge's instructions are generated for grading only and are **never** returned
to the client — `/api/scenario` returns just the participant-facing situation plus
the follow-up questions (surfaced after the response).

The consistency guarantee: the criteria selected during `/api/scenario` are the
exact criteria the response is graded against by `/api/score-content` — the client
passes their ids back, and their text is re-pinned from the framework server-side
(the client is never trusted for criterion wording).

Module map (all under `app/`): `framework.py` loads `data/framework.json` (our
criteria) and exposes lookups, `interpret.py` maps a free-text request to domains
+ an industry and resolves the model's criteria selection, `rubric.py` loads
`data/rubric.json` and clamps scores into their level bands, `prompts.py` builds
the interpret / generate / score prompts, `llm.py` wraps Anthropic + defensive
JSON parsing, `transcription.py` calls the transcription provider (AssemblyAI) for
word timestamps + fillers, `delivery.py` computes delivery metrics deterministically
from those timestamps, `config.py` holds the model choice (`ANTHROPIC_MODEL`,
default `claude-sonnet-4-6`) and injects the OS trust store, `ratelimit.py` is the
per-IP guard. Keys never leave the backend.

Voice needs `TRANSCRIPTION_API_KEY` (AssemblyAI). Without it, typed practice works
and `/api/score-delivery` returns a friendly 503. Delivery metrics are pure
arithmetic on word timestamps — pace, fillers, pauses, time use — never
tone/confidence.

Without `ANTHROPIC_API_KEY` set, the LLM endpoints return a friendly 503;
everything else (framework, rubric, tests) works offline.

On networks that do TLS inspection (corporate proxy / AV), the Anthropic SDK would
otherwise fail with a connection error because Python's bundled certs don't trust
the intercepting CA. `config.py` injects the OS trust store (`truststore`) at
startup to fix this automatically — no flag needed.

## Tests

```bash
uv run pytest
```

## Data

- `app/data/framework.json` — the **independent evaluation framework**: 13 business
  domains and 282 authored criteria (id, domain, topic, name, a coaching-question
  `definition`, `strong_looks_like` / `weak_looks_like` bars, and `coaches`). This
  is the single source of truth for what the app generates against and grades on.
  Authored from public-domain business concepts in our own wording, structure, and
  id scheme — see `app/data/framework-notes.md` for the domain map, grain logic,
  and independence audit.
- `app/data/rubric.json` — the scoring scale: four generic quality levels
  (Novice / Developing / Proficient / Exemplary) and a 0–10 band per criterion.
- `reference/pis-core-reference.json` — DECA's Business Administration Core PI list,
  **kept only as an authoring reference** to check topic coverage while writing the
  framework. It lives under `backend/reference/`, which is **git- and docker-ignored**,
  so it never enters the repo or ships in the image. It is **not read by any runtime
  code path** and none of its text is reproduced in `framework.json`. See
  `framework-notes.md` for the two hard rules that keep this clean.
