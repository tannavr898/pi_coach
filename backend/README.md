# PI Coach — Backend

FastAPI service. Holds the PI/event data, prompt construction (Phase 2), and
provider API keys. The frontend talks only to `/api/*`; keys never leave here.

## Setup

```bash
cd backend
uv sync
cp .env.example .env   # put your key in ANTHROPIC_API_KEY (needed for Phase 2)
```

## Run

```bash
uv run uvicorn app.main:app --reload --port 8000
# health check:
curl localhost:8000/api/health   # -> {"status":"ok"}
```

## API (Phase 2 — rubric-based content loop)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/events` | Events the picker can offer (with `cluster_label` for grouping). |
| `GET /api/events/{code}/areas` | Instructional areas in that event's PI pool, for the focus-area picker. |
| `GET /api/rubric` | The DECA 2026 District rubric (levels, criteria, point bands). |
| `POST /api/scenario` | Generate an original scenario. Body: `{event_code, level, area?, pi_ids?, seed?}`. Returns the PIs, solution criteria, career competencies, procedures, the **participant-facing situation** (no judge text), and the judge's follow-up questions. |
| `POST /api/score-content` | Grade a response against the rubric. Body: `{event_code, scenario, pi_ids, response, followup_questions, followup_answer}`. Returns per-criterion `scores` (level + points + feedback + verbatim evidence quotes), the 100-point total, strengths/improvements, and follow-up feedback. |
| `POST /api/score-delivery` | Transcribe a spoken response and return deterministic delivery metrics. Multipart `audio` upload (+ optional `target_seconds`). Returns the `transcript` plus `metrics` (pace WPM, fillers, pauses, time use, reading signal, coaching notes). Audio is processed and discarded; only the transcript + numbers are returned. |

The judge's instructions are generated for grading only and are **never**
returned to the client — `/api/scenario` returns just the participant-facing
situation plus the follow-up questions (surfaced after the response).

Module map (all under `app/`): `selection.py` picks the PIs, `rubric.py` loads
`data/rubric.json` and clamps scores into their level bands, `prompts.py` builds
the §7 prompts, `llm.py` wraps Anthropic + defensive JSON parsing, `transcription.py`
calls the transcription provider (AssemblyAI) for word timestamps + fillers,
`delivery.py` computes the §8 delivery metrics deterministically from those
timestamps, `config.py` holds the model choice (`ANTHROPIC_MODEL`, default
`claude-sonnet-4-6`) and injects the OS trust store, `ratelimit.py` is the per-IP
guard. Keys never leave the backend.

Voice needs `TRANSCRIPTION_API_KEY` (AssemblyAI). Set a provider spend cap first
(roadmap §9). Without it, typed practice works and `/api/score-delivery` returns
a friendly 503. Delivery metrics are pure arithmetic on word timestamps — pace,
fillers, pauses, time use — never tone/confidence (roadmap §2).

`reference/` holds DECA's official career-cluster Performance Indicator PDFs
(`reference/pis/`, the source for the cluster/pathway PIs) and per-event sample
role-plays (`reference/samples/`, used to calibrate scenario style and the
rubric). It is **gitignored** (copyright) — local reference only, never shipped.

Without `ANTHROPIC_API_KEY` set, the two LLM endpoints return a friendly 503;
everything else (events, data, tests) works offline.

On networks that do TLS inspection (corporate proxy / AV), the Anthropic SDK
would otherwise fail with a connection error because Python's bundled certs
don't trust the intercepting CA. `config.py` injects the OS trust store
(`truststore`) at startup to fix this automatically — no flag needed.

## Phase 1 data lookup (acceptance check)

```bash
uv run python scripts/pi_lookup.py PMK
```

Prints the event's instructional areas and full PI pool.

## Tests

```bash
uv run pytest
```

## Data

- `app/data/events.json` — the 17 role-play events. Each carries `cluster`
  (career-cluster id, `null` for Principles), `pathway`, `cluster_label`, and
  `pi_count`. An event's PI pool is derived from PI membership tags, not a
  hardcoded area list.
- `app/data/pis.json` — 25 instructional areas → 1806 performance indicators.
  Each PI carries its official `id` (e.g. `BL:163`), verbatim `text`, `level`
  (PQ/CS/SP/MN), an optional `definition` (study-aid gloss), and a `membership`
  list of tags: `core` (Business Administration Core), `cluster:<id>` (a career
  cluster core), and `pathway:<id>:<name>` (a career pathway). Cluster/pathway
  PIs were parsed from DECA's official Performance Indicator PDFs.
- `app/data_loader.py` — `get_event`, `get_instructional_areas` (filters PIs by
  the event's `allowed_tokens`), `get_pi_pool`, `get_pis_by_ids`. Reuse these
  everywhere; don't re-read the JSON elsewhere.
