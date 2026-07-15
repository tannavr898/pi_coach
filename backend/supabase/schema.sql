-- PI Coach — Supabase schema. Run this once in the Supabase SQL editor
-- (Dashboard → SQL → New query → paste → Run).
--
-- One table: `sessions`. It stores each COMPLETED practice run for a logged-in
-- user, so we can show cross-session progress and re-render past feedback. The
-- anonymous practice loop never writes here — login is optional and additive.
--
-- Data minimization (users are minors): we store the participant's own written/
-- transcribed answer and the computed scores, but NEVER raw audio (that stays
-- ephemeral in the browser, per existing policy).
--
-- Row-Level Security is enabled as defense-in-depth. The FastAPI backend writes
-- with the service_role key and always scopes queries by user_id itself, but RLS
-- guarantees a row can only ever be read/written by its owner even if a user
-- token were used directly.

create table if not exists public.sessions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  created_at           timestamptz not null default now(),

  -- Full bundles → re-render the feedback screen exactly, and re-run a scenario.
  scenario             jsonb not null,   -- full ScenarioResponse (situation, criteria, followups, event/level/mode/timing)
  response             text  not null,   -- the participant's answer (their own words; no raw audio)
  followup_answer      text  not null default '',
  score                jsonb not null,   -- full ScoreResponse
  delivery             jsonb,            -- DeliveryMetrics, or null for typed runs
  utterances           jsonb not null default '[]'::jsonb,

  -- Flattened columns for cheap progress queries (mirrors data inside the jsonb).
  event                text,
  content_score        int  not null,    -- score.overall_percent
  criterion_results    jsonb not null,   -- [{criterion_id, level, points}]
  filler_per_min       real,             -- null when typed (delivery is voice-only)
  pace_wpm             int,
  long_pause_count     int,
  duration_seconds     real,

  -- Powers the "Try this again" before/after comparison.
  retry_of_session_id  uuid references public.sessions(id) on delete set null
);

create index if not exists sessions_user_created_idx
  on public.sessions (user_id, created_at desc);

alter table public.sessions enable row level security;

drop policy if exists "own rows" on public.sessions;
create policy "own rows" on public.sessions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- Study courses: `study_profile` (which event you're studying for) and
-- `study_progress` (one row per term you've touched).
--
-- These exist because the study path is a SUMMER-TO-FALL commitment. Flags live in
-- localStorage and Blitz stats live in sessionStorage, which is fine for a single
-- sitting and useless for a path you work for three months across a phone and a
-- laptop. A course you lose in July is not a course.
--
-- `term_id` is text with NO foreign key on purpose: terms live in
-- backend/app/data/terms.json, not in Postgres, so the app can regenerate and
-- reshape the study corpus without a migration. A term that disappears leaves an
-- orphan row, which the API simply ignores — cheaper than coupling the content
-- pipeline to the database.
--
-- `best_evidence` ranks flip < blitz < roleplay: a term only reaches 'known' on
-- blitz-or-better, so tapping through cards can't fake a finished course. The rules
-- live in app/study.py; this column just stores the result.
-- ---------------------------------------------------------------------------

create table if not exists public.study_profile (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  event_id    text not null,               -- events.json id (our own catalog)
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.study_profile enable row level security;

drop policy if exists "own rows" on public.study_profile;
create policy "own rows" on public.study_profile
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


create table if not exists public.study_progress (
  user_id       uuid not null references auth.users(id) on delete cascade,
  term_id       text not null,             -- terms.json id (FW-* or T-*); no FK, see above
  status        text not null default 'new',    -- new | learning | known
  best_evidence text not null default 'flip',   -- flip | blitz | roleplay
  seen_count    int  not null default 0,
  correct_count int  not null default 0,
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, term_id)
);

-- The only read pattern: "this user's whole progress map", to overlay on a course.
create index if not exists study_progress_user_idx on public.study_progress (user_id);

alter table public.study_progress enable row level security;

drop policy if exists "own rows" on public.study_progress;
create policy "own rows" on public.study_progress
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
