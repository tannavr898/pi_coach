# DECA Roleplay Trainer — Backend

FastAPI service. Holds the PI/event data, prompt construction (Phase 2), and
provider API keys. The frontend talks only to `/api/*`; keys never leave here.

## Setup

```bash
cd backend
uv sync
cp .env.example .env   # fill in keys later; none are needed for this step
```

## Run

```bash
uv run uvicorn app.main:app --reload --port 8000
# health check:
curl localhost:8000/api/health   # -> {"status":"ok"}
```

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
