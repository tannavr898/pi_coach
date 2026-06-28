// Typed client for the backend. The SPA only ever talks to /api/* (Vite proxies
// it to FastAPI in dev); keys live on the backend, never here. The judge's
// instructions never cross this boundary — only participant-facing content does.

export type Level = "district" | "state" | "icdc";

export type EventSummary = {
  code: string;
  name: string;
  level: string;
  pi_count: number;
  cluster_label: string;
};

export type AreaSummary = {
  id: string;
  name: string;
  pi_count: number;
};

export type PI = {
  id: string;
  text: string;
  area: string;
  area_name: string;
  level: string;
  definition: string;
};

export type RubricCriterion = {
  key: string;
  label: string;
  desc: string;
  max_points: number;
};

export type ScenarioResponse = {
  event: EventSummary;
  level: Level;
  instructional_area: string;
  performance_indicators: PI[];
  solution_criteria: RubricCriterion[];
  career_competencies: RubricCriterion[];
  procedures: string[];
  situation: string;
  followup_questions: string[];
};

export type RubricLevel = "novice" | "developing" | "proficient" | "exemplary";

export type RubricCategory =
  | "performance_indicator"
  | "solution"
  | "career_competency"
  | "overall_impression";

export type RubricScore = {
  key: string;
  category: RubricCategory;
  label: string;
  pi_id?: string | null;
  level: RubricLevel;
  points: number;
  max_points: number;
  headline: string;
  feedback: string;
  evidence: string[];
  gaps: string[];
};

export type ScoreResponse = {
  scores: RubricScore[];
  total_points: number;
  max_points: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  followup_feedback: string;
};

export type FillerCount = { word: string; count: number };
export type CrutchCount = { phrase: string; count: number };
export type LongPause = { at_seconds: number; length_seconds: number };

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
};

export type DeliveryResponse = {
  transcript: string;
  metrics: DeliveryMetrics;
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

export function getEvents(): Promise<EventSummary[]> {
  return request<EventSummary[]>("/api/events");
}

export function getEventAreas(code: string): Promise<AreaSummary[]> {
  return request<AreaSummary[]>(`/api/events/${encodeURIComponent(code)}/areas`);
}

export function postScenario(body: {
  event_code: string;
  level: Level;
  area?: string | null;
}): Promise<ScenarioResponse> {
  return request<ScenarioResponse>("/api/scenario", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postScore(body: {
  event_code: string;
  scenario: string;
  pi_ids: string[];
  response: string;
  followup_questions: string[];
  followup_answer: string;
}): Promise<ScoreResponse> {
  return request<ScoreResponse>("/api/score-content", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Upload a recording for transcription + delivery metrics. FormData sets its own
// multipart Content-Type (with boundary), so we don't pass headers here.
export async function postDelivery(audio: Blob, targetSeconds = 450): Promise<DeliveryResponse> {
  const ext = audio.type.includes("webm") ? "webm" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "mp4" : "dat";
  const fd = new FormData();
  fd.append("audio", audio, `take.${ext}`);
  fd.append("target_seconds", String(targetSeconds));
  const res = await fetch("/api/score-delivery", { method: "POST", body: fd });
  await throwIfError(res);
  return res.json() as Promise<DeliveryResponse>;
}
