// Typed client for the backend. The SPA only ever talks to /api/* (Vite proxies
// it to FastAPI in dev); keys live on the backend, never here. The judge's
// instructions never cross this boundary — only participant-facing content does.

export type Level = "district" | "state" | "icdc";
export type Mode = "learn" | "competition";

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
  followup_questions: string[];
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

export type ScoreResponse = {
  scores: CriterionScore[];
  total_points: number;
  max_points: number;
  overall_percent: number;
  overall_level: RubricLevel;
  summary: string;
  strengths: string[];
  improvements: string[];
  followup_feedback: string;
  math_checks: MathCheck[];
};

export type FillerCount = { word: string; count: number };
export type CrutchCount = { phrase: string; count: number };
export type LongPause = { at_seconds: number; length_seconds: number };

export type DeliveryComponent = {
  label: string;
  score: number;
  hint: string;
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
}): Promise<ScenarioResponse> {
  return request<ScenarioResponse>("/api/scenario", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postScore(body: {
  scenario: string;
  criteria_ids: string[];
  response: string;
  followup_questions: string[];
  followup_answer: string;
  event?: string;
}): Promise<ScoreResponse> {
  return request<ScoreResponse>("/api/score-content", {
    method: "POST",
    body: JSON.stringify(body),
  });
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
  await throwIfError(res);
  return res.json() as Promise<DeliveryResponse>;
}
