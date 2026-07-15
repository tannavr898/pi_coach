// Account features client (logged-in only): persist sessions + read progress.
// These are the only calls that carry an auth token; the anonymous practice loop
// in api.ts is untouched. Types mirror the backend schemas (schemas.py) and reuse
// the base scoring types from api.ts.

import type {
  BlitzVerdict,
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

// Like authFetch, but anonymous is a valid answer rather than an error. The study
// path renders for anyone — a token only adds "where you got to" on top of it — so
// this attaches the header when we have one and just omits it when we don't.
async function maybeAuthFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken().catch(() => null);
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

// --- study courses --------------------------------------------------------

export type CourseUnit = {
  id: string;
  domain_id: string;
  domain: string;
  topic: string;
  core_ids: string[];
  extended_ids: string[];
  known: number;
  learning: number;
  total: number;
  // Core counted separately, so a unit's progress matches the tier being viewed.
  core_known: number;
  core_total: number;
  done: boolean;
};

export type Course = {
  event_id: string;
  event: string;
  cluster: string;
  units: CourseUnit[];
  core_count: number;
  extended_count: number;
  total: number;
  known_count: number;
  core_known: number;
  // Core = every skill we actually grade for this event. Tracked separately from
  // `percent` because it's the finishable promise, not just a fraction.
  core_percent: number;
  percent: number;
  enrolled: boolean;
};

export type StudyEvidence = "flip" | "blitz" | "roleplay";
export type StudyMark = { term_id: string; evidence: StudyEvidence; verdict?: BlitzVerdict | "" };

// Browsable without an account: progress comes back all-zero when signed out.
export function getCourse(eventId: string): Promise<Course> {
  return maybeAuthFetch<Course>(`/api/course/${encodeURIComponent(eventId)}`);
}

// The course the user enrolled in. Rejects with a 404 detail until they pick one.
export function getMyCourse(): Promise<Course> {
  return authFetch<Course>("/api/course");
}

export function enrollCourse(eventId: string): Promise<Course> {
  return authFetch<Course>("/api/course/enroll", {
    method: "POST",
    body: JSON.stringify({ event_id: eventId }),
  });
}

// Fire-and-forget, and deliberately never throws. Anonymous users study too, and a
// missing token just means there's nowhere to record it — recording progress must
// never be able to break a drill or a flip.
export async function markStudy(marks: StudyMark[]): Promise<{ updated: number }> {
  if (!marks.length) return { updated: 0 };
  const token = await getAccessToken().catch(() => null);
  if (!token) return { updated: 0 };
  try {
    return await authFetch<{ updated: number }>("/api/study/mark", {
      method: "POST",
      body: JSON.stringify({ marks }),
    });
  } catch {
    return { updated: 0 };
  }
}

// Admin QA: seed / clear canned sample sessions in the logged-in account.
export function seedSamples(): Promise<{ seeded: number }> {
  return authFetch<{ seeded: number }>("/api/admin/seed", { method: "POST" });
}

export function clearSamples(): Promise<{ deleted: number }> {
  return authFetch<{ deleted: number }>("/api/admin/sample", { method: "DELETE" });
}
