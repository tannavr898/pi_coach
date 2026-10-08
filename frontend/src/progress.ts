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
  Usage,
  Utterance,
  VideoFrame,
  VideoMetrics,
} from "./api";
import { getAccessToken } from "./supabase";
import { cached, invalidate } from "./cache";

// Every GET below goes through the cache (cache.ts): a return visit renders at
// once and refreshes in the background. Every write invalidates the reads it
// changes, by path prefix, so nothing a student just did shows as undone.
const PROGRESS_READS = ["/api/sessions", "/api/progress", "/api/course", "/api/plan"];

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
    // The status rides along so a caller can tell "you don't have one yet" (404)
    // from a real failure without matching on message text.
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.json() as Promise<T>;
}

// Like authFetch, but anonymous is a valid answer rather than an error. The study
// path renders for anyone, a token only adds "where you got to" on top of it, so
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
  // Observable video counts, when they opted into video. Counts + notes only.
  video?: VideoMetrics | null;
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
  video: VideoMetrics | null;
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

/**
 * Confirm a scenario was actually shown, so it is never served to this user
 * again, even on a different device.
 *
 * Deliberately separate from requesting it: the app PREFETCHES a scenario as
 * soon as an event is picked, and marking that as seen would burn pool entries
 * for role-plays the student never read. Anonymous is a no-op server-side (their
 * list lives in localStorage), so this uses `maybeAuthFetch` and is fire-and-forget.
 */
export function confirmScenarioSeen(scenarioId: string): Promise<{ status: string }> {
  return maybeAuthFetch<{ status: string }>("/api/scenario/seen", {
    method: "POST",
    body: JSON.stringify({ scenario_id: scenarioId }),
  });
}

export async function saveSession(body: SaveSessionBody): Promise<SessionSaved> {
  const saved = await authFetch<SessionSaved>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
  invalidate(...PROGRESS_READS, "/api/chapters", "/api/me");
  return saved;
}

export function getSessions(): Promise<SessionSummary[]> {
  return cached("/api/sessions", () => authFetch<SessionSummary[]>("/api/sessions"));
}

export function getSession(id: string): Promise<SessionDetail> {
  const path = `/api/sessions/${id}`;
  return cached(path, () => authFetch<SessionDetail>(path));
}

export function getProgress(): Promise<ProgressResponse> {
  return cached("/api/progress", () => authFetch<ProgressResponse>("/api/progress"));
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
  // Seen but not yet proven, scoped to the core tier for the same reason.
  core_learning: number;
  core_total: number;
  done: boolean;
};

export type Course = {
  event_id: string;
  event: string;
  cluster: string;
  // The written exam this event sits. Not the cluster: every Principles event
  // sits Business Administration Core.
  exam: string;
  units: CourseUnit[];
  core_count: number;
  extended_count: number;
  total: number;
  known_count: number;
  // Terms started but not proven. Flipping a card moves a term here, never to
  // known -- only a Blitz or a role-play can do that (see backend study.py).
  learning_count: number;
  core_known: number;
  core_learning: number;
  // Core = every skill we actually grade for this event. Tracked separately from
  // `percent` because it's the finishable promise, not just a fraction.
  core_percent: number;
  percent: number;
  enrolled: boolean;
};

export type StudyEvidence = "flip" | "quiz" | "blitz" | "roleplay";
export type StudyMark = { term_id: string; evidence: StudyEvidence; verdict?: BlitzVerdict | "" };

// Browsable without an account: progress comes back all-zero when signed out.
export function getCourse(eventId: string): Promise<Course> {
  const path = `/api/course/${encodeURIComponent(eventId)}`;
  return cached(path, () => maybeAuthFetch<Course>(path));
}

// The course the user enrolled in. Rejects with a 404 detail until they pick one.
// "No course yet" is cached too (as null), or every Home visit would pay a round
// trip just to be told the same thing.
export function myCourseOrNull(): Promise<Course | null> {
  return cached<Course | null>("/api/course", async () => {
    try {
      return await authFetch<Course>("/api/course");
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  });
}

export async function getMyCourse(): Promise<Course> {
  const c = await myCourseOrNull();
  if (!c) throw Object.assign(new Error("No course yet: pick an event to start one."), { status: 404 });
  return c;
}

export async function enrollCourse(eventId: string): Promise<Course> {
  const c = await authFetch<Course>("/api/course/enroll", {
    method: "POST",
    body: JSON.stringify({ event_id: eventId }),
  });
  invalidate("/api/course", "/api/plan", "/api/chapters");
  return c;
}

// Fire-and-forget, and deliberately never throws. Anonymous users study too, and a
// missing token just means there's nowhere to record it, recording progress must
// never be able to break a drill or a flip.
export async function markStudy(marks: StudyMark[]): Promise<{ updated: number }> {
  if (!marks.length) return { updated: 0 };
  const token = await getAccessToken().catch(() => null);
  if (!token) return { updated: 0 };
  try {
    const r = await authFetch<{ updated: number }>("/api/study/mark", {
      method: "POST",
      body: JSON.stringify({ marks }),
    });
    invalidate("/api/course", "/api/plan");
    return r;
  } catch {
    return { updated: 0 };
  }
}

// --- study plans ------------------------------------------------------------
// A plan is recomputed server-side from these inputs on every load (backend
// plan.py), so the inputs are all the client ever sends.

export type PlanGoal = "core" | "all";
export type PlanStageInput = { name: string; date: string };
export type PlanInputs = {
  event_id: string;
  stages: PlanStageInput[];
  // Minutes per weekday, Sunday first, the same order as Date.getDay().
  day_minutes: number[];
  goal: PlanGoal;
};

export type PlanTaskKind = "learn" | "weak" | "review" | "roleplay" | "mock" | "quiz" | "live";
export type PlanTask = {
  id: string;
  kind: PlanTaskKind;
  title: string;
  detail: string;
  minutes: number;
  term_ids: string[];
  unit_id: string;
  criterion_name: string;
  tier: string;
  // Derived from real progress, never self-reported. All zero in a preview.
  done: boolean;
  progress_done: number;
  progress_total: number;
  seen: number;
};

export type PlanPhase = "learn" | "sharpen" | "taper" | "competition" | "done";
export type PlanDay = {
  date: string;
  weekday: number;
  budget: number;
  planned: number;
  phase: PlanPhase;
  stage: string;
  tasks: PlanTask[];
};
export type PlanWeek = {
  start: string;
  end: string;
  phase: PlanPhase;
  new_terms: number;
  reviews: number;
  roleplays: number;
  live: number;
  minutes: number;
  stages: string[];
};
export type PlanStage = { name: string; date: string; days_left: number; past: boolean };
export type PlanFeasibility = {
  status: "on_track" | "tight" | "behind" | "done";
  message: string;
  core_remaining: number;
  core_by_first_stage: number;
  core_finish_date: string | null;
  needed_minutes_per_day: number | null;
  full_finish_date: string | null;
};
export type PlanPhaseRun = { phase: PlanPhase; start_day: number; end_day: number };
export type PlanCalendarDay = { date: string; kind: "study" | "competition"; minutes: number; summary: string };
export type PlanHistoryDay = { date: string; planned: number; done: number };

export type StudyPlan = {
  event_id: string;
  event: string;
  goal: PlanGoal;
  day_minutes: number[];
  stages: PlanStage[];
  feasibility: PlanFeasibility;
  today: PlanDay;
  days: PlanDay[];
  weeks: PlanWeek[];
  phases: PlanPhaseRun[];
  calendar: PlanCalendarDay[];
  history: PlanHistoryDay[];
  // Role-plays with a real person: reported so far, and the number the plan is
  // aiming for before the first competition still ahead.
  live_done: number;
  live_target: number;
  saved: boolean;
};

// "Today" is the student's calendar day, not the server's. Sending the browser's
// date + offset keeps a 11pm study session on the right day's checklist.
function localDayQuery(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `local_date=${local}&tz_offset=${d.getTimezoneOffset()}`;
}

// Anyone can preview: seeing your season laid out is the pitch for saving it.
export function previewPlan(inputs: PlanInputs): Promise<StudyPlan> {
  return maybeAuthFetch<StudyPlan>(`/api/plan/preview?${localDayQuery()}`, {
    method: "POST",
    body: JSON.stringify(inputs),
  });
}

// The saved plan, or null when the student hasn't made one yet.
// Keyed by the student's local date, so a new day is a new entry, never a stale one.
export function planKey(): string {
  return `/api/plan?${localDayQuery()}`;
}

export function getMyPlan(): Promise<StudyPlan | null> {
  const path = planKey();
  return cached(path, async () => {
    try {
      return await authFetch<StudyPlan>(path);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  });
}

export async function savePlan(inputs: PlanInputs): Promise<StudyPlan> {
  const p = await authFetch<StudyPlan>(`/api/plan?${localDayQuery()}`, { method: "PUT", body: JSON.stringify(inputs) });
  invalidate("/api/plan", "/api/course", "/api/chapters");
  return p;
}

export async function deletePlan(): Promise<{ deleted: boolean }> {
  const r = await authFetch<{ deleted: boolean }>("/api/plan", { method: "DELETE" });
  invalidate("/api/plan", "/api/chapters");
  return r;
}

// Admin QA: seed / clear canned sample sessions in the logged-in account.
export function seedSamples(): Promise<{ seeded: number }> {
  return authFetch<{ seeded: number }>("/api/admin/seed", { method: "POST" });
}

export function clearSamples(): Promise<{ deleted: number }> {
  return authFetch<{ deleted: number }>("/api/admin/sample", { method: "DELETE" });
}

// --- usage caps + video (Phase 6) ------------------------------------------

/**
 * This caller's tier and remaining monthly allowance.
 *
 * Anonymous is a valid answer, a signed-out visitor gets the anonymous tier's
 * numbers rather than an error, so this uses `maybeAuthFetch`. We fetch it
 * BEFORE a session starts so the UI can show what's left up front; discovering a
 * cap halfway through a rep you've already prepped for is exactly the surprise
 * this is meant to prevent.
 */
export function fetchUsage(): Promise<Usage> {
  return maybeAuthFetch<Usage>("/api/usage");
}

/**
 * Analyze the frames sampled during a rep.
 *
 * Requires an account (`authFetch`): video is the cost driver, and an account is
 * what makes its cap enforceable server-side. Only the already-downscaled stills
 * go over the wire, the full video is never recorded or uploaded, and the
 * backend discards them as soon as it has the counts.
 */
/**
 * `deliveryScore` is the audio-only score for this rep. It goes up so the SERVER
 * can compute how much the sampled frames are allowed to move it, the cap and
 * the sample-size floor are grading rules, and grading rules don't live in the
 * client. Omit it on a typed rep, where there's no delivery score to adjust.
 */
export function scoreVideo(frames: VideoFrame[], deliveryScore?: number | null): Promise<VideoMetrics> {
  return authFetch<VideoMetrics>("/api/score-video", {
    method: "POST",
    body: JSON.stringify({ frames, delivery_score: deliveryScore ?? null }),
  });
}

// --- chapters ---------------------------------------------------------------
// A school club: managers follow their students, post to a feed, assign work that
// completes itself from real activity, and message students one thread at a time.
// Every access rule is enforced server-side (backend chapters.py); the client only
// decides what to show.

export type Profile = { first_name: string; last_name: string };

export type ChapterInfo = {
  id: string;
  name: string;
  school_name: string;
  status: "pending" | "active" | "rejected";
  join_code: string | null;
  manager_code: string | null;
};

export type Membership = {
  chapter: ChapterInfo;
  role: "manager" | "student";
  status: "pending" | "active";
  unread_feed: number;
  unread_messages: number;
};

export type Me = { profile: Profile | null; memberships: Membership[] };

export type RosterStudent = {
  user_id: string;
  first_name: string;
  last_name: string;
  event_id: string;
  event: string;
  status: "pending" | "active";
  requested_at: string;
  last_active: string | null;
  roleplays_7d: number;
  study_runs_7d: number;
  avg_score_recent: number | null;
  weakest: string;
  has_plan: boolean;
  plan_follow_through: number | null;
};

export type RosterManager = { user_id: string; first_name: string; last_name: string; is_you: boolean };
export type Roster = { chapter: ChapterInfo; students: RosterStudent[]; managers: RosterManager[] };

export type StudentProfileData = {
  user_id: string;
  first_name: string;
  last_name: string;
  event_id: string;
  event: string;
  progress: ProgressResponse;
  sessions: SessionSummary[];
  course: Course | null;
  plan: StudyPlan | null;
};

export type AssignmentKind = "roleplay" | "quiz" | "blitz" | "flashcards";
export type AssignmentTarget = { count: number; min_score?: number | null; min_pct?: number | null; domain_id?: string | null };
export type AssignmentState = { done: number; count: number; status: "done" | "in_progress" | "not_started" | "overdue" };

export type ChapterPost = {
  id: string;
  kind: "announcement" | "assignment";
  title: string;
  body: string;
  author_name: string;
  created_at: string;
  assignment_kind: AssignmentKind | null;
  target: AssignmentTarget | null;
  domain: string;
  due_at: string | null;
  audience_size: number | null;
  mine: AssignmentState | null;
  done_count: number | null;
  assigned_count: number | null;
};

export type PostDraft = {
  kind: "announcement" | "assignment";
  title: string;
  body: string;
  assignment_kind?: AssignmentKind;
  target?: AssignmentTarget;
  due_at?: string | null;
  audience?: string[];
};

export type AssignmentRow = { user_id: string; name: string; status: AssignmentState };

export type ChapterMessage = {
  id: string;
  student_id: string;
  sender_name: string;
  from_manager: boolean;
  mine: boolean;
  body: string;
  created_at: string;
};

export type ThreadSummary = { student_id: string; name: string; last_body: string; last_at: string | null; unread: number };

// Read helper for the chapter endpoints: cached by path.
function cachedGet<T>(path: string): Promise<T> {
  return cached(path, () => authFetch<T>(path));
}

// A write inside one chapter: everything shown for that chapter, plus the
// memberships and unread counts in /api/me, may have changed.
async function chapterWrite<T>(id: string, p: Promise<T>): Promise<T> {
  const r = await p;
  invalidate(`/api/chapters/${id}`, "/api/me");
  return r;
}

export function getMe(): Promise<Me> {
  return cachedGet<Me>("/api/me");
}

export async function saveProfile(p: Profile): Promise<Profile> {
  const r = await authFetch<Profile>("/api/profile", { method: "PUT", body: JSON.stringify(p) });
  invalidate("/api/me", "/api/chapters");
  return r;
}

export async function createChapter(body: { name: string; school_name: string; contact_email: string }): Promise<ChapterInfo> {
  const r = await authFetch<ChapterInfo>("/api/chapters", { method: "POST", body: JSON.stringify(body) });
  invalidate("/api/me");
  return r;
}

export async function joinChapter(code: string, consent: boolean): Promise<Membership> {
  const r = await authFetch<Membership>("/api/chapters/join", { method: "POST", body: JSON.stringify({ code, consent }) });
  invalidate("/api/me");
  return r;
}

export function leaveChapter(id: string): Promise<{ left: boolean }> {
  return chapterWrite(id, authFetch(`/api/chapters/${id}/leave`, { method: "POST" }));
}

export function getRoster(id: string): Promise<Roster> {
  return cachedGet<Roster>(`/api/chapters/${id}/roster`);
}

export function approveMember(id: string, uid: string): Promise<{ approved: boolean }> {
  return chapterWrite(id, authFetch(`/api/chapters/${id}/members/${uid}/approve`, { method: "POST" }));
}

export function removeMember(id: string, uid: string): Promise<{ removed: boolean }> {
  return chapterWrite(id, authFetch(`/api/chapters/${id}/members/${uid}`, { method: "DELETE" }));
}

export function rotateCode(id: string, which: "join" | "manager"): Promise<ChapterInfo> {
  return chapterWrite(id, authFetch<ChapterInfo>(`/api/chapters/${id}/codes/rotate`, { method: "POST", body: JSON.stringify({ which }) }));
}

export function studentProfileKey(id: string, uid: string): string {
  return `/api/chapters/${id}/students/${uid}?${localDayQuery()}`;
}

export function getStudentProfile(id: string, uid: string): Promise<StudentProfileData> {
  return cachedGet<StudentProfileData>(studentProfileKey(id, uid));
}

export function getStudentSession(id: string, uid: string, sid: string): Promise<SessionDetail> {
  return cachedGet<SessionDetail>(`/api/chapters/${id}/students/${uid}/sessions/${sid}`);
}

export function getPosts(id: string): Promise<ChapterPost[]> {
  return cachedGet<ChapterPost[]>(`/api/chapters/${id}/posts`);
}

export function createPost(id: string, draft: PostDraft): Promise<ChapterPost> {
  return chapterWrite(id, authFetch<ChapterPost>(`/api/chapters/${id}/posts`, { method: "POST", body: JSON.stringify(draft) }));
}

export function deletePost(id: string, pid: string): Promise<{ deleted: boolean }> {
  return chapterWrite(id, authFetch(`/api/chapters/${id}/posts/${pid}`, { method: "DELETE" }));
}

export function getAssignmentStatus(id: string, pid: string): Promise<AssignmentRow[]> {
  return cachedGet<AssignmentRow[]>(`/api/chapters/${id}/posts/${pid}/status`);
}

export function getThreads(id: string): Promise<ThreadSummary[]> {
  return cachedGet<ThreadSummary[]>(`/api/chapters/${id}/threads`);
}

export function messagesKey(id: string, studentId?: string | null): string {
  return `/api/chapters/${id}/messages${studentId ? `?student=${encodeURIComponent(studentId)}` : ""}`;
}

export function getMessages(id: string, studentId?: string | null): Promise<ChapterMessage[]> {
  return cachedGet<ChapterMessage[]>(messagesKey(id, studentId));
}

export function sendMessage(id: string, body: string, studentIds: string[] = []): Promise<{ sent: number }> {
  return chapterWrite(id, authFetch(`/api/chapters/${id}/messages`, { method: "POST", body: JSON.stringify({ body, student_ids: studentIds }) }));
}

// Only /api/me changes (the unread badge); the feed itself is the same.
export async function markFeedRead(id: string): Promise<{ ok: boolean }> {
  const r = await authFetch<{ ok: boolean }>(`/api/chapters/${id}/read`, { method: "POST", body: JSON.stringify({ scope: "feed" }) });
  invalidate("/api/me");
  return r;
}

// A finished quiz, Blitz run, or flashcard set: what chapter assignments are
// checked against. Same posture as markStudy: fire-and-forget, never throws, and
// a no-op when signed out.
export async function postActivity(a: { kind: "quiz" | "blitz" | "flashcards"; term_ids: string[]; score: number; total: number }): Promise<void> {
  if (!a.term_ids.length) return;
  const token = await getAccessToken().catch(() => null);
  if (!token) return;
  try {
    await authFetch("/api/activity", { method: "POST", body: JSON.stringify(a) });
    invalidate("/api/chapters");
  } catch {
    /* recording must never break a drill */
  }
}

// A role-play done with a real person. The plan cannot see it happen, so this is
// the one task a student reports themselves. Unlike postActivity it reports
// failure: the button that calls it has to know whether to stay ticked.
export async function markLiveRoleplay(): Promise<boolean> {
  try {
    await authFetch("/api/activity", { method: "POST", body: JSON.stringify({ kind: "live", term_ids: [], score: 1, total: 1 }) });
    invalidate("/api/plan", "/api/chapters");
    return true;
  } catch {
    return false;
  }
}

// Owner-only chapter review, gated by the admin passphrase rather than a login.
export type AdminChapter = {
  id: string;
  name: string;
  school_name: string;
  contact_email: string;
  status: string;
  created_at: string;
  creator_name: string;
};

async function adminFetch<T>(path: string, passphrase: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Admin-Passphrase": passphrase, ...(init?.headers || {}) },
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

export function adminListChapters(passphrase: string, status: "pending" | "active" | "rejected"): Promise<AdminChapter[]> {
  return adminFetch<AdminChapter[]>(`/api/admin/chapters?status=${status}`, passphrase);
}

export function adminSetChapterStatus(passphrase: string, id: string, status: "active" | "rejected" | "pending"): Promise<{ status: string }> {
  return adminFetch(`/api/admin/chapters/${id}/status`, passphrase, { method: "POST", body: JSON.stringify({ status }) });
}
