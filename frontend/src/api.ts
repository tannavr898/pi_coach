// Typed client for the backend. The SPA only ever talks to /api/* (Vite proxies
// it to FastAPI in dev); keys live on the backend, never here. The judge's
// instructions never cross this boundary — only participant-facing content does.

export type Level = "district" | "state" | "icdc";

export type EventSummary = {
  code: string;
  name: string;
  level: string;
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
  feedback: string;
  evidence: string[];
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export function getEvents(): Promise<EventSummary[]> {
  return request<EventSummary[]>("/api/events");
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
