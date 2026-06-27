# DECA Roleplay Trainer — Backend

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

## API (Phase 2 — content loop)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/events` | Events the picker can offer. |
| `POST /api/scenario` | Generate an original DECA-format scenario for an event. Body: `{event_code, level, area?, pi_ids?, seed?}`. Returns the selected PIs + scenario text. |
| `POST /api/score-content` | Score a typed response. Body: `{scenario, pi_ids, response}`. Returns PI-by-PI coverage, structure feedback, and one judge follow-up. |

Module map (all under `app/`): `selection.py` picks the PIs, `prompts.py`
builds the §7 prompts, `llm.py` wraps Anthropic + defensive JSON parsing,
`config.py` holds the model choice (`ANTHROPIC_MODEL`, default `claude-sonnet-4-6`),
`ratelimit.py` is the per-IP guard. Keys never leave the backend.

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

- `app/data/events.json` — events → instructional-area ids.
- `app/data/pis.json` — the 13 official DECA **Business Administration Core**
  (Tier 1) instructional areas → performance indicators (367 in total). Each PI
  carries its official `id` (e.g. `BL:163`), verbatim `text`, `level`
  (PQ/CS/SP), `performance_element` (the official grouping it sits under), and a
  plain-language `definition`. Definitions are study-aid glosses (not official
  wording): ~138 sourced from a community study list, the rest authored to fit
  each PI's instructional area and performance element.
- `app/data_loader.py` — `get_event`, `get_instructional_areas`, `get_pi_pool`.
  Reuse these everywhere; don't re-read the JSON elsewhere.
