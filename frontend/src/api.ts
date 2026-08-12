// Typed client for the backend. The SPA only ever talks to /api/* (Vite proxies
// it to FastAPI in dev); keys live on the backend, never here. The judge's
// instructions never cross this boundary — only participant-facing content does.

export type Level = "district" | "state" | "icdc";
export type Mode = "learn" | "competition";

// What the app GRADES: one criterion on a scenario's cover sheet (/api/scenario).
export type Criterion = {
  id: string;
  domain: string;
  topic: string;
  name: string;
  // Teaching fields — populated in Learn mode, empty in Competition mode.
  definition: string;
  strong_looks_like: string;
  weak_looks_like: string;
  coaches: string;
};

// What a student STUDIES: one flashcard / course term (/api/terms). Distinct from
// Criterion — the study corpus is larger than the framework we grade against, so a
// term need not have a criterion at all. `criterion_id` is set on the graded ones
// (tier "core"), which is what weak-term highlighting keys off.
export type Term = {
  id: string;
  criterion_id: string | null;
  tier: "core" | "extended";
  domain_id: string;
  domain: string;
  topic: string;
  name: string;
  coaches: string;
  // The plain, student-facing definition (not Criterion's grading question).
  definition: string;
  example?: FlashcardExample | null;
  mistake?: string;
};

// A worked example run through the four DECA beats (the Tips-page method).
export type FlashcardExample = {
  define: string;
  explain: string;
  connect: string;
  above: string;
};

export type DomainSummary = {
  id: string;
  name: string;
  blurb: string;
  criteria_count: number;
};

export type EventKind = "principles" | "individual" | "team";

export type EventSummary = {
  id: string;
  name: string;
  cluster: string;
  kind: EventKind;
  quantitative: boolean;
  blurb: string;
  suggestions: string[];
};

export type Timing = {
  prep_seconds: number;
  present_seconds: number;
  target_seconds: number;
};

export type ScenarioResponse = {
  topic: string;
  industry: string;
  event: string;
  event_kind: string;
  quantitative: boolean;
  team: boolean;
  timing: Timing;
  domain_focus: string[];
  level: Level;
  mode: Mode;
  criteria: Criterion[];
  procedures: string[];
  situation: string;
  // One-sentence challenge framing of the situation — the headline on the shareable
  // results card. Optional: scenarios pooled before this field existed have none, so
  // the card falls back to `topic`.
  hook?: string;
  followup_questions: string[];
  // Phase 3: the scenario-variety combination the backend sampled + injected
  // (null when the event has no taxonomy yet or a free-text focus was used).
  sampling?: Sampling | null;
  // Shared-pool id when this scenario came from (or was added to) the scenario
  // cache. Recorded locally so we're never served the same role-play twice.
  scenario_id?: string | null;
};

// The variety combo that shaped a scenario. `signature` is an opaque id the client
// records to avoid immediate repeats; `labels` is for display/QA.
export type Sampling = {
  signature: string;
  labels: Record<string, string>;
};

export type RubricLevel = "novice" | "developing" | "proficient" | "exemplary";

export type CriterionScore = {
  criterion_id: string;
  name: string;
  domain: string;
  topic: string;
  level: RubricLevel;
  points: number;
  max_points: number;
  headline: string;
  feedback: string;
  evidence: string[];
  gaps: string[];
  suggestion: string;
};

export type MathCheck = {
  label: string;
  expression: string;
  unit: string;
  claimed: number | null;
  computed: number | null;
  ok: boolean | null;
  note: string;
};

// --- Section 2 (Analytical & Problem-Solving) ---
export type SubScore = {
  score: number; // 1-4
  justification: string;
  evidence: string | null;
};

export type CreativityScore = {
  bonus: number; // 0, 0.25, 0.5
  justification: string;
  evidence: string | null;
};

// Bonus-only credit for bringing in a related study term and actually applying it.
// `terms` are the study-term ids the grader credited — they feed study progress as
// the strongest evidence there is.
export type DepthScore = {
  bonus: number; // 0, 0.25, 0.5
  terms: string[];
  justification: string;
  evidence: string | null;
};

export type AnalyticalSection = {
  weight: number;
  framing: SubScore;
  solution_quality: SubScore;
  pi_application: SubScore;
  creativity: CreativityScore;
  depth: DepthScore;
  core_score: number;
  section_score: number; // 0-4
  section_percent: number;
};

// --- Section 3 (Professional Presentation) ---
export type PresentationSection = {
  weight: number;
  section_score: number; // 0-4
  section_percent: number;
  notes: string;
};

export type FinalScore = {
  percent: number;
  top_strength: string;
  biggest_weakness: string;
  one_key_fix: string;
};

export type ScoreResponse = {
  scores: CriterionScore[];
  total_points: number;
  max_points: number;
  overall_percent: number; // now the final weighted percent (rounded)
  overall_level: RubricLevel;
  summary: string;
  strengths: string[];
  improvements: string[];
  followup_feedback: string;
  math_checks: MathCheck[];
  // 3-section weighted rubric
  pi_section_score: number; // 0-4
  pi_section_percent: number; // Section 1 (60%)
  analytical: AnalyticalSection | null; // Section 2 (25%)
  presentation: PresentationSection | null; // Section 3 (15%)
  final: FinalScore | null;
};

export type FillerCount = { word: string; count: number };
export type CrutchCount = { phrase: string; count: number };
export type LongPause = { at_seconds: number; length_seconds: number };

export type DeliveryComponent = {
  label: string;
  score: number;
  hint: string;
  /** Shown but weighted lightly — currently only the sampled video eye-contact row. */
  advisory?: boolean;
};

export type SpeakerStat = {
  speaker: string;
  talk_seconds: number;
  talk_share: number;
  word_count: number;
  filler_count: number;
  pace_wpm: number;
};

export type Utterance = {
  speaker: string;
  text: string;
  start_seconds: number;
  end_seconds: number;
};

export type DeliveryMetrics = {
  duration_seconds: number;
  word_count: number;
  pace_wpm: number;
  pace_flag: "slow" | "good" | "fast";
  filler_count: number;
  filler_per_min: number;
  fillers: FillerCount[];
  crutch_phrases: CrutchCount[];
  pause_count: number;
  long_pauses: LongPause[];
  longest_pause_seconds: number;
  time_used_seconds: number;
  time_target_seconds: number;
  time_flag: "short" | "good" | "long";
  reading_signal: boolean;
  notes: string[];
  delivery_score: number;
  delivery_components: DeliveryComponent[];
  speakers: SpeakerStat[];
  dominated_by: string;
  balance_note: string;
};

export type DeliveryResponse = {
  transcript: string;
  metrics: DeliveryMetrics;
  utterances: Utterance[];
};

async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.detail) detail = String(body.detail);
  } catch {
    /* non-JSON error body */
  }
  throw new Error(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  await throwIfError(res);
  return res.json() as Promise<T>;
}

export function getDomains(): Promise<DomainSummary[]> {
  return request<DomainSummary[]>("/api/framework");
}

export function getEvents(): Promise<EventSummary[]> {
  return request<EventSummary[]>("/api/events");
}

// Study terms by id — a weak-term deck, a flagged set, or a course unit. Graded
// terms share their criterion's id, so a criterion id resolves here directly.
export function getTerms(ids: string[]): Promise<Term[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return request<Term[]>(`/api/terms?ids=${encodeURIComponent(ids.join(","))}`);
}

// The whole study corpus — powers the flashcard library.
export function getAllTerms(): Promise<Term[]> {
  return request<Term[]>("/api/terms");
}

// Admin QA page: verify the secret passphrase server-side (throws 404 when the
// admin page is disabled, i.e. no ADMIN_PASSPHRASE configured).
export function adminVerify(passphrase: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/admin/verify", {
    method: "POST",
    body: JSON.stringify({ passphrase }),
  });
}

export function postFeedback(body: {
  message: string;
  rating?: number | null;
  email?: string;
  page?: string;
}): Promise<{ status: string }> {
  return request<{ status: string }>("/api/feedback", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postScenario(body: {
  event: string;
  request?: string;
  level: Level;
  mode: Mode;
  // Recent variety-combo signatures for this user+event (newest last) so the
  // backend can skip immediate repeats. Ignored on the free-text focus path.
  avoid?: string[];
  // Cached-scenario ids we've already been served, so the cache never repeats a
  // role-play for this browser. Signed-in users are also de-duped server-side.
  seen?: string[];
}): Promise<ScenarioResponse> {
  return request<ScenarioResponse>("/api/scenario", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Fetch one pooled scenario by id — the shared-challenge deep link (?s=<id>).
 *
 * Serves that exact role-play regardless of what this browser has already seen,
 * which is the point: a challenge is only fair if both people played the same one.
 * Throws on 404 when the link is stale.
 */
export function getScenarioById(scenarioId: string, mode: Mode): Promise<ScenarioResponse> {
  return request<ScenarioResponse>(
    `/api/scenario/${encodeURIComponent(scenarioId)}?mode=${encodeURIComponent(mode)}`,
  );
}

export function postScore(body: {
  scenario: string;
  criteria_ids: string[];
  response: string;
  followup_questions: string[];
  followup_answer: string;
  event?: string;
  // Section 3 (presentation) blends objective delivery metrics when spoken.
  spoken?: boolean;
  delivery_score?: number | null;
}): Promise<ScoreResponse> {
  return request<ScoreResponse>("/api/score-content", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Mastery Blitz (Phase 5) ----------------------------------------------

export type BlitzScenario = { id: string; text: string };
export type BlitzVerdict = "correct" | "partial" | "missed";
export type BlitzResult = { term_id: string; verdict: BlitzVerdict; note: string };

export function getBlitzScenarios(): Promise<BlitzScenario[]> {
  return request<BlitzScenario[]>("/api/blitz/scenarios");
}

export function postBlitzScore(body: {
  scenario: string;
  answers: { term_id: string; response: string }[];
}): Promise<{ results: BlitzResult[] }> {
  return request<{ results: BlitzResult[] }>("/api/blitz-score", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Transcript only (no delivery metrics) — for spoken blitz answers, graded on content.
export async function postTranscribe(audio: Blob): Promise<string> {
  const ext = audio.type.includes("webm") ? "webm" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "mp4" : "dat";
  const fd = new FormData();
  fd.append("audio", audio, `blitz.${ext}`);
  const res = await fetch("/api/transcribe", { method: "POST", body: fd });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || "Couldn't transcribe that recording.");
  }
  const body = (await res.json()) as { transcript: string };
  return body.transcript;
}

// Upload a recording for transcription + delivery metrics. FormData sets its own
// multipart Content-Type (with boundary), so we don't pass headers here.
export async function postDelivery(audio: Blob, targetSeconds = 450, diarize = false): Promise<DeliveryResponse> {
  const ext = audio.type.includes("webm") ? "webm" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "mp4" : "dat";
  const fd = new FormData();
  fd.append("audio", audio, `take.${ext}`);
  fd.append("target_seconds", String(targetSeconds));
  fd.append("diarize", String(diarize));
  const res = await fetch("/api/score-delivery", { method: "POST", body: fd });
  if (!res.ok) {
    // Prefer the backend's specific reason (e.g. "silent or too short"); fall back
    // to a plain-English message when the body isn't JSON — which is what a raw
    // gateway 502/504 (proxy timeout, cold start) looks like, and where the bare
    // "HTTP 502" used to leak through to the user.
    let detail = "";
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON error body (HTML gateway page) */
    }
    throw new Error(
      detail ||
        "We couldn't process your recording. It may have been silent, too short, or unclear. Find a quiet spot and record again.",
    );
  }
  return res.json() as Promise<DeliveryResponse>;
}

// --- usage caps + tiers ----------------------------------------------------
// Fetched before a session starts so the UI can show what's left up front —
// nobody should discover a cap halfway through a rep they've already prepped for.

export type Tier = "anonymous" | "free" | "pro";

// `limit: -1` means unlimited (render as "Unlimited", not as a number).
export type Allowance = { used: number; limit: number; remaining: number };

export type Usage = {
  tier: Tier;
  period: string; // "YYYY-MM"
  resets_on: string; // ISO date the allowance refills
  voice: Allowance;
  video: Allowance;
  typed_unlimited: boolean;
  video_beta: boolean;
  // Founding-user reward: signed up before the cutoff AND actually used the app.
  founder_eligible: boolean;
  founder_reward: string;
  founder_min_roleplays: number;
};

export const UNLIMITED = -1;

// --- video analysis (beta) -------------------------------------------------
// Observable checks only: eye contact, positive expression, off-frame. There is
// deliberately no confidence/charisma/emotion score in this shape — those can't
// be observed from sampled frames, and telling a nervous student they "seemed
// unconfident" is harmful feedback, not coaching.

export type VideoMetrics = {
  checks: number;
  eye_contact_count: number;
  eye_contact_percent: number;
  positive_expression_count: number;
  positive_expression_percent: number;
  off_frame_count: number;
  off_frame_percent: number;
  notes: string[];
  disclaimer: string;
  // How much the sampled frames moved the delivery score (signed, capped at ±4
  // server-side and scaled by how many frames we actually read). 0 when the
  // sample was too small to say anything — see delivery.video_adjustment.
  delivery_adjustment: number;
  adjusted_delivery_score: number | null;
  adjustment_reason: string;
  delivery_component: DeliveryComponent | null;
};

export type VideoFrame = { media_type: string; data: string };

// The calls themselves live in progress.ts — they carry an auth token, and this
// module is deliberately the anonymous-only surface. Only the types live here,
// next to the rest of the response shapes.
