// Account features client (logged-in only): persist sessions + read progress.
// These are the only calls that carry an auth token; the anonymous practice loop
// in api.ts is untouched. Types mirror the backend schemas (schemas.py) and reuse
// the base scoring types from api.ts.

import type {
  DeliveryMetrics,
  RubricLevel,
  ScenarioResponse,
  ScoreResponse,
  Utterance,
} from "./api";
import { getAccessToken } from "./supabase";

async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Please sign in to continue.");
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
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

export type SaveSessionBody = {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followup_answer: string;
  delivery: DeliveryMetrics | null;
  utterances: Utterance[];
  event_id: string;
  retry_of_session_id?: string | null;
};

export type SessionSaved = { id: string };

export type SessionSummary = {
  id: string;
  created_at: string;
  topic: string;
  event: string;
  content_score: number;
  level: RubricLevel;
  mode: string;
  filler_per_min: number | null;
  pace_wpm: number | null;
  retry_of_session_id: string | null;
};

export type SessionDetail = {
  id: string;
  created_at: string;
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followup_answer: string;
  delivery: DeliveryMetrics | null;
  utterances: Utterance[];
  retry_of_session_id: string | null;
};

export type DeliveryTrend = {
  available: boolean;
  note: string;
  metric: string;
  early: number | null;
  recent: number | null;
  recent_wpm: number | null;
  spoken_sessions: number;
};

export type CriterionMastery = {
  criterion_id: string;
  name: string;
  domain: string;
  sessions: number;
  recent_level: RubricLevel;
  consistent_level: RubricLevel;
  avg_rank: number;
};

export type WeakestCriterion = {
  criterion_id: string;
  name: string;
  domain: string;
  consistent_level: RubricLevel;
  note: string;
};

export type ScoreTrendPoint = { created_at: string; score: number };

export type ScoreTrend = {
  available: boolean;
  points: ScoreTrendPoint[];
  direction: string;
  note: string;
};

export type ProgressResponse = {
  sessions_count: number;
  delivery_trend: DeliveryTrend;
  criterion_mastery: CriterionMastery[];
  weakest_criterion: WeakestCriterion | null;
  score_trend: ScoreTrend;
};

export function saveSession(body: SaveSessionBody): Promise<SessionSaved> {
  return authFetch<SessionSaved>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
}

export function getSessions(): Promise<SessionSummary[]> {
  return authFetch<SessionSummary[]>("/api/sessions");
}

export function getSession(id: string): Promise<SessionDetail> {
  return authFetch<SessionDetail>(`/api/sessions/${id}`);
}

export function getProgress(): Promise<ProgressResponse> {
  return authFetch<ProgressResponse>("/api/progress");
}

// Admin QA: seed / clear canned sample sessions in the logged-in account.
export function seedSamples(): Promise<{ seeded: number }> {
  return authFetch<{ seeded: number }>("/api/admin/seed", { method: "POST" });
}

export function clearSamples(): Promise<{ deleted: number }> {
  return authFetch<{ deleted: number }>("/api/admin/sample", { method: "DELETE" });
}
