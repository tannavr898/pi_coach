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
- `app/data/pis.json` — instructional areas → performance indicators.
  **Currently placeholder text** (marked `[PLACEHOLDER]`, ids suffixed `-P##`).
  Replace with the verbatim official DECA PI wording.
- `app/data_loader.py` — `get_event`, `get_instructional_areas`, `get_pi_pool`.
  Reuse these everywhere; don't re-read the JSON elsewhere.
