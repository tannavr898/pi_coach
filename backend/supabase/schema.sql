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


-- ---------------------------------------------------------------------------
-- Scenario cache: `cached_scenario` (a reusable generated role-play) and
-- `seen_scenario` (which scenarios a signed-in user has already been served).
--
-- WHY: every fresh scenario is a paid generation call AND ~4-8s the user spends
-- watching a loader before their first rep. Both are pure friction for a visitor
-- who hasn't decided we're worth their time yet. Reusing a scenario another user
-- already paid for makes the common path instant and free.
--
-- THE CACHE KEY IS THE WHOLE DESIGN. The user types free text ("marketing for a
-- restaurant" / "restaurant marketing"), so the raw string is a terrible key —
-- near-zero hit rate. We key on the INTERPRETED result instead, and only on the
-- parts that are known BEFORE generation runs:
--
--     level | sorted(domain_ids) | event_id
--
-- The criteria set is deliberately NOT in the key even though the brief lists it:
-- the criteria are chosen by the model DURING generation, so they can't be known
-- when we go looking for a cache hit. They're stored as an attribute
-- (`criteria_ids`) for auditing and invalidation instead. The domain pool the
-- criteria are drawn from IS in the key, which is the part that actually
-- determines whether two requests are interchangeable.
--
-- `industry_hint` is a secondary attribute, not part of the key: a "restaurant"
-- request prefers a restaurant-flavored cached scenario, but a no-focus request
-- happily takes any scenario matching domain+level. See app/scenario_cache.py
-- for the serving gate that decides which of those two modes applies.
--
-- `sampling_signature` records the taxonomy combination that shaped a scenario.
-- Different samples under the same key are exactly what makes the pool deep and
-- varied rather than 25 near-identical role-plays.
-- ---------------------------------------------------------------------------

create table if not exists public.cached_scenario (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  cache_key           text not null,          -- level|domains|event (see above)
  level               text not null,
  event_id            text not null default '',
  domain_ids          text[] not null default '{}',
  criteria_ids        text[] not null default '{}',  -- attribute, NOT part of the key
  industry_hint       text not null default '',      -- normalized; secondary preference
  sampling_signature  text not null default '',

  scenario_json       jsonb not null,         -- the full ScenarioResponse payload
  times_served        int  not null default 0
);

-- The only read pattern: "unseen scenarios for this key, freshest-first".
create index if not exists cached_scenario_key_idx
  on public.cached_scenario (cache_key, times_served);

-- Cached scenarios are shared inventory, not user rows: they contain no personal
-- data and are read by every user. RLS stays ON with a read-only policy so the
-- anon key can never write here — only the backend's service key can.
alter table public.cached_scenario enable row level security;

drop policy if exists "public read" on public.cached_scenario;
create policy "public read" on public.cached_scenario for select using (true);


create table if not exists public.seen_scenario (
  user_id     uuid not null references auth.users(id) on delete cascade,
  scenario_id uuid not null references public.cached_scenario(id) on delete cascade,
  seen_at     timestamptz not null default now(),
  primary key (user_id, scenario_id)
);

create index if not exists seen_scenario_user_idx on public.seen_scenario (user_id);

alter table public.seen_scenario enable row level security;

drop policy if exists "own rows" on public.seen_scenario;
create policy "own rows" on public.seen_scenario
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- Atomic serve counter. PostgREST can't express `times_served = times_served + 1`
-- in a PATCH, and a read-modify-write would lose counts under concurrency — which
-- would quietly corrupt the one number we use to measure whether the cache is
-- working. A tiny function keeps it correct.
create or replace function public.bump_scenario_served(sid uuid)
returns void language sql as $$
  update public.cached_scenario set times_served = times_served + 1 where id = sid;
$$;


-- ---------------------------------------------------------------------------
-- Usage counters: one row per (user, month, session kind).
--
-- Caps are enforced SERVER-side for signed-in users — the client is never
-- trusted with a limit that protects the bill. Anonymous voice usage is capped
-- client-side instead, and that is a deliberate, documented tradeoff: the only
-- server-side identifier available for a signed-out visitor is the IP, and our
-- users are students on school networks where hundreds of people share one. A
-- per-IP cap would lock out an entire school the moment one class started
-- practicing. The per-IP RATE limiter still runs as an abuse backstop, video
-- requires an account (so it is always server-enforced), and the real fix is
-- that the expensive path is behind a login.
--
-- Counting rows rather than logging events: we only ever need "how many this
-- month", the increment is atomic in Postgres, and it stores nothing about WHAT
-- a student practiced. For a product used by minors, a counter that can't
-- reconstruct behavior is the better default.
-- ---------------------------------------------------------------------------

create table if not exists public.usage_counter (
  user_id    uuid not null references auth.users(id) on delete cascade,
  period     text not null,               -- 'YYYY-MM', UTC (see app/tiers.py)
  kind       text not null,               -- 'voice' | 'video'
  count      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period, kind)
);

create index if not exists usage_counter_user_period_idx
  on public.usage_counter (user_id, period);

alter table public.usage_counter enable row level security;

drop policy if exists "own rows" on public.usage_counter;
create policy "own rows" on public.usage_counter
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- Claim one session against a cap, atomically.
--
-- The check and the increment MUST happen in the same statement. Read-then-write
-- from the application would let two concurrent requests both read count=2
-- against a cap of 3 and both proceed — the exact race a paying-for-vision
-- endpoint cannot afford. The `where` clause makes the cap a condition of the
-- write itself, so at most one of them commits.
--
-- Returns the new count on success, or NULL when the cap is already reached.
-- p_limit < 0 means unlimited.
create or replace function public.claim_usage(
  p_user_id uuid, p_period text, p_kind text, p_limit int
) returns int language plpgsql as $$
declare new_count int;
begin
  insert into public.usage_counter (user_id, period, kind, count, updated_at)
  values (p_user_id, p_period, p_kind, 1, now())
  on conflict (user_id, period, kind) do update
    set count = public.usage_counter.count + 1, updated_at = now()
    where p_limit < 0 or public.usage_counter.count < p_limit
  returning count into new_count;
  return new_count;  -- NULL when the ON CONFLICT where-clause blocked the update
end;
$$;


-- Release a claimed session back to the user's allowance.
--
-- A cap should only be spent on work the student actually received. If the
-- transcription provider dies after we claimed the slot, charging them for a
-- session that produced nothing is the kind of small unfairness that erodes
-- trust in every other number the product shows them.
create or replace function public.release_usage(
  p_user_id uuid, p_period text, p_kind text
) returns void language sql as $$
  update public.usage_counter set count = greatest(0, count - 1), updated_at = now()
  where user_id = p_user_id and period = p_period and kind = p_kind;
$$;


-- ---------------------------------------------------------------------------
-- Video results on a saved session.
--
-- Without this column a video rep loses its Video tab the moment the student
-- reopens it from their history — the whole point of saving a session is that
-- the feedback is still there later, and video feedback is no different.
--
-- Still no video and no frames: this stores only the observable COUNTS
-- (eye contact, expression, off-frame) plus the derived coaching notes. There
-- is nothing here that could reconstruct what the camera saw.
-- ---------------------------------------------------------------------------
alter table public.sessions add column if not exists video jsonb;


-- ---------------------------------------------------------------------------
-- Study plans: `study_plan` (one row per user).
--
-- A plan turns the event course into a dated daily schedule toward the student's
-- competitions. Only the INPUTS are stored — event, competition dates, minutes per
-- weekday, goal — because the schedule itself is recomputed from current progress
-- on every load (app/plan.py). That is what lets a missed day reschedule itself
-- instead of turning into a backlog, with nothing here to migrate or repair.
--
-- The one piece of computed state is today's task list (`today_tasks`, keyed by
-- the student's local `today_date`). It is frozen on the first load of the day so
-- the checklist doesn't reshuffle while they're working through it. When the day
-- rolls over, the old list is scored into `history` ({date, planned, done}) — a
-- count, not a log of what they did, in keeping with the usage_counter posture.
-- ---------------------------------------------------------------------------

create table if not exists public.study_plan (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  event_id     text not null,                        -- events.json id
  stages       jsonb not null default '[]'::jsonb,   -- [{name, date}]
  day_minutes  int[] not null,                       -- 7 entries, Sunday first
  goal         text not null default 'core',         -- core | all
  today_date   date,
  today_tasks  jsonb,
  history      jsonb not null default '[]'::jsonb,   -- last 60 days: [{date, planned, done}]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.study_plan enable row level security;

drop policy if exists "own rows" on public.study_plan;
create policy "own rows" on public.study_plan
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
