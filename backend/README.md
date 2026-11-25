# PI Coach, Backend

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
| `GET /api/framework` | Our business domains (id, name, blurb, criterion count), for UI hints/examples. |
| `GET /api/events` | The role-play events students pick from (our own catalog), each with its cluster, `kind` (principles/individual/team), a `quantitative` flag, and original focus suggestions. |
| `GET /api/rubric` | The scoring levels (labels, descriptions, per-criterion band). |
| `POST /api/scenario` | Plan a session from the chosen `event` (+ optional free-text `request` focus), select the fitting framework criteria, and generate an original scenario built to require them. Body: `{event, request, level, mode}` (`mode` = `learn` \| `competition`; `request` optional, blank ⇒ a random scenario within the event's scope). The event drives which framework **domains** feed generation; the focus only refines `topic`/`industry`. Returns the `event`/`topic`/`industry`/`domain_focus`, the event's `timing` (team events get a longer prep/present window), `quantitative`/`team` flags, the selected `criteria` (teaching fields populated in Learn mode, names-only in Competition mode), `procedures`, the **participant-facing situation** (no judge text), and the judge's follow-up questions. Quantitative events are told to state raw figures only (never pre-computed results). Unknown event ⇒ `400`; a non-business free-text focus with no event ⇒ friendly `422`. |
| `POST /api/score-content` | Grade a response against the selected framework criteria. Body: `{scenario, criteria_ids, response, followup_questions, followup_answer, event}`. Returns per-criterion `scores` (level + points/10 + feedback + verbatim evidence quotes + gaps), the total, the overall percentage/level, strengths/improvements, and follow-up feedback. For **quantitative events** (`event` resolves to a `quantitative` catalog entry) it also returns `math_checks`: every calculation the model flagged, **recomputed deterministically by the backend** (`mathcheck.py`), Python's result is authoritative, so the app never trusts the model's arithmetic. |
| `GET /api/quiz` | Multiple-choice questions from the pre-generated bank (`app/data/quiz_bank.json`). Query: `level` (`district`\|`state`\|`icdc`), `ids` (comma list of term ids, a deck, a course unit, a weak-term set), `domains`, `count` (≤40). Returns the drawn `questions` plus per-level `counts`. **No model call runs behind this endpoint**, it is a file read, so a quiz round costs nothing, needs no key, and is open to anonymous callers. Each option ships with its `correct` flag and a `rationale` naming the misconception it represents, so the client grades the pick and teaches the miss with no round trip. |
| `POST /api/score-delivery` | Transcribe a spoken response and return deterministic delivery metrics. Multipart `audio` upload (+ optional `target_seconds`, `diarize`). Returns the `transcript` plus `metrics` (pace WPM, fillers, pauses, time use, reading signal, coaching notes). For **team events** (`diarize=true`) it also returns a per-speaker breakdown (`metrics.speakers`, `dominated_by`, `balance_note`) and the transcript split into speaker `utterances`. Audio is processed and discarded; only the transcript + numbers are returned. |

The judge's instructions are generated for grading only and are **never** returned
to the client, `/api/scenario` returns just the participant-facing situation plus
the follow-up questions (surfaced after the response).

The consistency guarantee: the criteria selected during `/api/scenario` are the
exact criteria the response is graded against by `/api/score-content`, the client
passes their ids back, and their text is re-pinned from the framework server-side
(the client is never trusted for criterion wording).

Module map (all under `app/`): `framework.py` loads `data/framework.json` (our
criteria) and exposes lookups, `events.py` loads `data/events.json` (our role-play
event catalog) and maps each event to our framework domains, `interpret.py` plans a
session from the chosen event + optional focus (domains from the event, topic/industry
from the focus) and resolves the model's criteria selection, `rubric.py` loads
`data/rubric.json` and clamps scores into their level bands, `mathcheck.py` is a
tiny safe arithmetic evaluator that recomputes quantitative calculations
deterministically (the model sets up the formula, Python does the math),
`prompts.py` builds the interpret / generate / score prompts, `llm.py` wraps Anthropic + defensive
JSON parsing, `transcription.py` calls the transcription provider (AssemblyAI) for
word timestamps + fillers, `delivery.py` computes delivery metrics deterministically
from those timestamps, `config.py` holds the model choice (`ANTHROPIC_MODEL`,
default `claude-sonnet-4-6`) and injects the OS trust store, `ratelimit.py` is the
per-IP guard. Keys never leave the backend.

Voice needs `TRANSCRIPTION_API_KEY` (AssemblyAI). Without it, typed practice works
and `/api/score-delivery` returns a friendly 503. Delivery metrics are pure
arithmetic on word timestamps, pace, fillers, pauses, time use, never
tone/confidence.

Without `ANTHROPIC_API_KEY` set, the LLM endpoints return a friendly 503;
everything else (framework, rubric, tests) works offline.

On networks that do TLS inspection (corporate proxy / AV), the Anthropic SDK would
otherwise fail with a connection error because Python's bundled certs don't trust
the intercepting CA. `config.py` injects the OS trust store (`truststore`) at
startup to fix this automatically, no flag needed.

## Tests

```bash
uv run pytest
```

## Data

- `app/data/framework.json`, the **independent evaluation framework**: 13 business
  domains and 282 authored criteria (id, domain, topic, name, a coaching-question
  `definition`, `strong_looks_like` / `weak_looks_like` bars, and `coaches`). This
  is the single source of truth for what the app generates against and grades on.
  Authored from public-domain business concepts in our own wording, structure, and
  id scheme, see `app/data/framework-notes.md` for the domain map, grain logic,
  and independence audit.
- `app/data/events.json`, our own catalog of the role-play **events** students
  practice for. Each event carries its cluster, a short blurb, original focus
  suggestions, and a list of our framework `domain_ids`. That event→domain mapping
  is the obvious business-discipline mapping any educator would make (a marketing
  event exercises the Marketing domain); it is **not** DECA's licensed
  event-to-performance-indicator blueprint, contains no PI text or codes, and only
  selects which of our domains feed generation. Event names are used descriptively
  so students can pick what they compete in. A `kind` (principles/individual/team)
  drives the presentation clock (team events get a longer prep/present window,
  `events.timing_for`), and a `quantitative` flag turns on deterministic math
  verification and speaker diarization is enabled for team events.
- `app/data/quiz_bank.json`, the **quiz bank**: original multiple-choice questions
  written from our own study cards by `scripts/gen_quiz.py`, one batch per (domain,
  topic, difficulty). Difficulty is structural, not cosmetic: `district` is one
  concept recognized, `state` is one concept applied to a fresh situation, `icdc`
  holds two or three concepts that genuinely interact (and carries the break test
  that proves it). The generator rejects rather than repairs, four options, exactly
  one correct, a rationale on every option, concepts that resolve to cards in the
  batch, no giveaway-longest key, and shuffles the options on the way in, so the
  answer's position carries no signal. `python -m scripts.gen_quiz audit` re-checks
  the shipped file and reports tier/position/padding drift.
- `app/data/rubric.json`, the scoring scale: four generic quality levels
  (Novice / Developing / Proficient / Exemplary) and a 0-10 band per criterion.
- `app/data/pis.json`, the official DECA performance indicators (built by
  `scripts/build_pis.py` from `reference/pis-core-reference.json`, used with DECA's
  permission). `pis.py` serves them in criterion shape, so scoring, caching and feedback
  treat a PI like any other criterion; `framework.get_criteria` resolves both id shapes.
  `events.json` ids map to PI pools via `pis.json` `event_tags`; events without a list
  (Finance, Personal Financial Literacy) keep the framework path.
- `app/data/sample_roleplays.json`, official samples (built by `scripts/build_samples.py`),
  used only as few-shot style guides in `prompts.build_pi_scenario_prompt` and to
  calibrate length. Never returned to a student.
- `app/data/scenario_bank.json`, hand-written official-format role-plays (about 10 per event,
  district/state/ICDC), served first by `/api/scenario` with no model call and never repeated
  while unseen ones remain. Author them as plain text in `scripts/scenario_bank_src/<event>.txt`
  (PIs by official id) and build with `scripts/build_scenario_bank.py <event>`, which checks every
  PI is in that event's pool, the PI and question counts, and the dash rule.
- `scripts/build_exam_bank.py` extracts the official sample exams into a local, git-ignored reference file
  used only to audit our own quiz questions. Exam items are never shipped or served.
- `framework.json` and the study corpus stay our own and are what the study side uses.
