// Typed client for the backend. The SPA only ever talks to /api/* (Vite proxies
// it to FastAPI in dev); keys live on the backend, never here.

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

export type Level = "district" | "state" | "icdc";

export type ScenarioResponse = {
  event: EventSummary;
  level: Level;
  performance_indicators: PI[];
  scenario: string;
};

export type Coverage = "hit" | "partial" | "missed";

export type PIResult = {
  id: string;
  text: string;
  coverage: Coverage;
  evidence: string;
  improvement: string;
};

export type ScoreResponse = {
  pi_results: PIResult[];
  structure_feedback: string;
  addressed_task: boolean;
  overall_notes: string;
  pi_coverage_summary: { hit: number; partial: number; missed: number };
  followup_question: string;
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
  scenario: string;
  pi_ids: string[];
  response: string;
}): Promise<ScoreResponse> {
  return request<ScoreResponse>("/api/score-content", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
