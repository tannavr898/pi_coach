import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  type Criterion,
  type CriterionScore,
  type DeliveryMetrics,
  type DeliveryResponse,
  type EventSummary,
  type Level,
  type MathCheck,
  type Mode,
  type RubricLevel,
  type ScenarioResponse,
  type ScoreResponse,
  type SubScore,
  type Term,
  type Usage,
  type Utterance,
  type VideoMetrics,
  UNLIMITED,
  adminVerify,
  getEvents,
  getScenarioById,
  postDelivery,
  postFeedback,
  postScenario,
  postScore,
} from "./api";
import { identifyEmail, PH_MASK, track, trackBeacon } from "./analytics";
import { BrandMark } from "./ui";
import { GauntletCard, GauntletCardModal } from "./sharecard";
import { FEATURE_INTROS, FeatureIntro, NavDot, TourShell, type TourStep } from "./tour";
import { useVisited, type Surface } from "./visited";
import { DEMO_DELIVERY, DEMO_FOLLOWUP, DEMO_RESPONSE, DEMO_SCENARIO, DEMO_SCORE } from "./demoData";
import { ONBOARDING_SCENARIO } from "./onboardingData";
import { PreSessionScreen } from "./onboarding";
import { AuthModal, useAuth } from "./auth";
import { clearSamples, confirmScenarioSeen, fetchUsage, getSession, markStudy, saveSession, scoreVideo, seedSamples, type SaveSessionBody } from "./progress";
import { CAN_CAPTURE_VIDEO, GazeAnchor, VideoIndicator, VideoOptIn, VideoPanel, useFrameSampler, type VideoGate } from "./video";
import { HomePage } from "./home";
import { StudyCourse } from "./course";
import { Flashcards, FlashcardLibrary } from "./flashcards";
import { MasteryBlitz } from "./blitz";
import { useFlags } from "./flags";

type ResponseMode = "type" | "speak";

// A compact snapshot of a completed run, used to show a before/after when the
// same scenario is re-attempted ("Try this again"). Because it's the SAME
// scenario, the improvement is directly attributable — no difficulty confound.
type RunSnapshot = {
  percent: number;
  criteriaHit: number; // criteria at proficient or above
  criteriaTotal: number;
  fillerPerMin: number | null;
  wpm: number | null;
};

function snapshotOf(s: ScoreResponse, d: DeliveryMetrics | null): RunSnapshot {
  const hit = s.scores.filter((c) => c.level === "proficient" || c.level === "exemplary").length;
  return {
    percent: Math.round(s.overall_percent),
    criteriaHit: hit,
    criteriaTotal: s.scores.length,
    fillerPerMin: d ? d.filler_per_min : null,
    wpm: d ? d.pace_wpm : null,
  };
}
// "home" is the scroll-based marketing landing page (the default). "practice" is
// the role-play flow, whose first screen is now just the setup form — the hero and
// how-it-works copy moved to the landing page.
type View = "home" | "practice" | "tips" | "faq" | "flashcards" | "course";
// What the flashcard study overlay is showing: either ids to fetch, or preloaded
// cards (from the library), optionally opened at a specific card.
type FlashcardTarget = { ids?: string[]; cards?: Term[]; startId?: string; title?: string };
const CAN_RECORD = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

// Presentation timing now comes per-event from scenario.timing (team events get a
// longer prep/present window). The presentation budget is shared by the response
// and the judge's questions: the response clock counts it down, the follow-up
// inherits the rest.

type Stage = "presession" | "pick" | "loading" | "ready" | "prep" | "walkin" | "respond" | "followup" | "scoring" | "feedback";

// Stage ids read fine in code but are opaque in a PostHog breakdown, so the
// abandonment funnel reports these instead. Two worth calling out: "respond" is
// the speak-out-loud step (the one that asks for a microphone), and a live rep
// can only be sitting on "feedback" while the content grade is still in flight —
// they submitted successfully and were reading the delivery screen, which is a
// wait, not a bail.
const STEP_LABEL: Record<Stage, string> = {
  presession: "intro",
  pick: "pick",
  loading: "loading",
  ready: "scenario",
  prep: "prep",
  walkin: "walkin",
  respond: "present",
  followup: "followup",
  scoring: "scoring",
  feedback: "grading_wait",
};

// How long the participant can sit on the response/follow-up screen without
// starting before the 5-second auto-start countdown kicks in.
const IDLE_GRACE_MS = 40000;

// Signed-out visitors get this many free graded role-plays (the landing "2-minute
// rep" counts too) before we ask them to make a free account. Every graded run
// spends LLM tokens, so this caps anonymous spend; logged-in users are unlimited.
const FREE_ROLEPLAYS = 3;

// Phase 3: remember the last few scenario-variety combinations per event (locally,
// per browser) so the backend can avoid handing the same user immediate repeats.
// Session-local only — no backend/account involved.
const RECENT_COMBOS_MAX = 10;
function recentCombos(eventId: string): string[] {
  if (!eventId) return [];
  try {
    const raw = localStorage.getItem(`pic-combos-${eventId}`);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
function recordCombo(eventId: string, signature: string) {
  if (!eventId || !signature) return;
  try {
    const list = recentCombos(eventId).filter((s) => s !== signature);
    list.push(signature); // newest last
    localStorage.setItem(`pic-combos-${eventId}`, JSON.stringify(list.slice(-RECENT_COMBOS_MAX)));
  } catch {
    /* private mode / quota — variety just falls back to random */
  }
}

// Scenario cache: the ids this browser has already been served, so the shared
// pool never hands the same role-play to the same person twice. Signed-in users
// are ALSO de-duped server-side (which survives a new device) — this list is
// what makes the guarantee hold for anonymous visitors, who have no server-side
// history to join against. Capped to match the backend's payload limit.
const SEEN_SCENARIOS_MAX = 200;
function seenScenarios(): string[] {
  try {
    const raw = localStorage.getItem("pic-seen-scenarios");
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
function recordSeenScenario(id: string | null | undefined) {
  if (!id) return;
  try {
    const list = seenScenarios().filter((s) => s !== id);
    list.push(id); // newest last, so the slice below drops the oldest
    localStorage.setItem("pic-seen-scenarios", JSON.stringify(list.slice(-SEEN_SCENARIOS_MAX)));
  } catch {
    /* private mode / quota — worst case we may see a scenario twice */
  }
}

// A shared Gauntlet card links back as `/?s=<scenario_id>`. Read once at startup;
// consuming it strips the param so a refresh doesn't silently restart the run.
function readChallengeId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("s");
  } catch {
    return null;
  }
}
function clearChallengeParam() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("s");
    window.history.replaceState({}, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {
    /* history API unavailable — harmless, the param just lingers */
  }
}

export default function App() {
  const [stage, setStage] = useState<Stage>("pick");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventId, setEventId] = useState(""); // the chosen role-play event
  const [request, setRequest] = useState(""); // optional free-text focus
  const [practiceMode, setPracticeMode] = useState<Mode>("competition");
  const [level, setLevel] = useState<Level>("district");
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);
  const [mode, setMode] = useState<ResponseMode>("type");
  const [responseText, setResponseText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  // Presentation clock: a shared window (response + judge's questions) that only
  // counts down while `clockRunning` — it starts when the participant actually
  // begins, and pauses between screens. `autoCountdown` is the 5-second nudge that
  // auto-starts it if they idle too long.
  const [presentRemaining, setPresentRemaining] = useState(0);
  const [clockRunning, setClockRunning] = useState(false);
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null);
  const [followupMode, setFollowupMode] = useState<ResponseMode>("type");
  const [followupAnswer, setFollowupAnswer] = useState("");
  const [followupAudio, setFollowupAudio] = useState<Blob | null>(null);
  const [score, setScore] = useState<ScoreResponse | null>(null);
  const [delivery, setDelivery] = useState<DeliveryMetrics | null>(null);
  // Video (beta): opt-in per session. `videoOn` is the user's choice for THIS
  // rep — it deliberately does not persist, so the camera is never on because of
  // a decision made days ago. `videoMetrics` is null on every voice-only rep,
  // which is the normal case and renders identically to before this shipped.
  const [videoOn, setVideoOn] = useState(false);
  const [videoMetrics, setVideoMetrics] = useState<VideoMetrics | null>(null);
  // The in-flight video analysis. Video and content scoring run in parallel, so
  // without this the save could fire first and persist the session with no video
  // — the student would see a Video tab now and lose it when they reopened the
  // rep from history. The save awaits this promise, which normally costs nothing
  // (video is the faster of the two) but makes the ordering guaranteed instead
  // of lucky.
  const videoRunRef = useRef<Promise<VideoMetrics | null> | null>(null);
  const sampler = useFrameSampler();
  // Tier allowance, fetched up front so the UI can show what's left BEFORE a
  // session starts rather than surfacing a cap mid-flow.
  const [usage, setUsage] = useState<Usage | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("home");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const nudge = useLandingNudge();
  // Any entry into the practice flow retires the landing nudge — enterPractice,
  // the 2-minute rep, a challenge deep link, the tour handoff. Keyed on `view`
  // rather than patched into each entry point, so a future one can't miss it.
  useEffect(() => {
    if (view === "practice") nudge.consume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  const { user: authUser, ready: authReady, signOut } = useAuth();
  // Login dialog (optional; opened after a session, from the header, or the
  // landing page — never before the user has experienced the product).
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState<"signup" | "login">("signup");
  const [authReason, setAuthReason] = useState<string | undefined>(undefined);
  function openAuth(tab: "signup" | "login", reason?: string) {
    setAuthTab(tab);
    setAuthReason(reason);
    setAuthOpen(true);
  }
  // Which parts of the product this account has opened, and whether it has seen
  // the tour. Keyed by user id so two accounts on one browser don't share it.
  const visited = useVisited(authUser?.id ?? null);
  const [tourOpen, setTourOpen] = useState(false);

  // Where to go after a successful auth:
  //  - if they just finished a rep (on the feedback screen), stay put so it
  //    attaches to the new account;
  //  - a brand-new sign-up gets the guided tour, which hands off to the first rep;
  //  - a returning login goes to their Home dashboard.
  function handleAuthed(mode: "signup" | "login") {
    const onFeedback = view === "practice" && stage === "feedback";
    if (onFeedback) return;
    if (mode === "signup") {
      track("tour_started", { trigger: "signup" });
      setTourOpen(true);
    } else setView("home");
  }

  // Leaving the tour, whichever way they leave it. Marking it done means it never
  // reappears uninvited; the account menu can replay it on demand.
  function closeTour(reason: "skipped" | "completed", index?: number) {
    setTourOpen(false);
    visited.setTourDone(true);
    track(reason === "skipped" ? "tour_skipped" : "tour_completed", { index });
  }

  // Opening a surface for the first time clears its nav dot.
  function goToView(v: View) {
    setView(v);
    if (v === "course" || v === "flashcards" || v === "tips" || v === "faq" || v === "home") {
      visited.markVisited(v);
    }
  }
  // Session persistence (logged-in only). `pendingSession` holds a just-completed
  // anonymous run so we can attach it the moment the user signs up ("your first
  // rep isn't lost"). `currentSessionId` is the saved id of the on-screen run,
  // used to link a "Try this again" retry back to it.
  const [pendingSession, setPendingSession] = useState<SaveSessionBody | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [retryOf, setRetryOf] = useState<string | null>(null);
  // When set, the current run is a re-attempt of the same scenario; the feedback
  // screen shows a before→after comparison against this snapshot.
  const [priorSnapshot, setPriorSnapshot] = useState<RunSnapshot | null>(null);

  // Phase 2a: content scoring runs in the BACKGROUND while the delivery-first
  // feedback screen is already showing. This token invalidates a stale grade if
  // the user restarts / retries / regenerates before it lands.
  const scoreRunRef = useRef(0);
  // Phase 2b: prefetch the scenario the moment event + level are chosen (while
  // the user is still in the optional focus box). Keyed on the no-focus combo;
  // consumed by generate() only when the focus box is still empty.
  const prefetchRef = useRef<{ key: string; promise: Promise<ScenarioResponse> } | null>(null);

  // Flashcards: the study overlay target (ids or preloaded cards), plus the
  // per-account flag store shared by the overlay and the library.
  const [flashcard, setFlashcard] = useState<FlashcardTarget | null>(null);
  // Mastery Blitz (Phase 5): the term set to drill, or null when closed.
  const [blitzCards, setBlitzCards] = useState<Term[] | null>(null);
  // Bumped whenever a study surface closes. Flipping a card or finishing a Blitz
  // writes progress on the SERVER, but the course on screen was fetched when the
  // view mounted and has no idea -- so without this the counters sit unchanged
  // until a full page reload, which reads as "studying does nothing". That was
  // true of Blitz results too, not just flips.
  const [studyEpoch, setStudyEpoch] = useState(0);
  const endStudy = () => setStudyEpoch((n) => n + 1);
  const flags = useFlags(authUser?.id ?? null);

  // Refresh the allowance when auth settles and after each completed session, so
  // "2 video sessions left" is never stale by the time they act on it.
  useEffect(() => {
    if (!authReady) return;
    let live = true;
    fetchUsage()
      .then((u) => { if (live) setUsage(u); })
      .catch(() => { /* allowance display is additive; never block the loop on it */ });
    return () => { live = false; };
  }, [authReady, authUser?.id, score]);

  // What the video opt-in is allowed to offer right now. Kept as one derived
  // value so the response screen doesn't re-derive the gating rules inline.
  const videoGate: VideoGate = !CAN_CAPTURE_VIDEO
    ? { kind: "unsupported" }
    : !authUser
      // Video requires an account — that's what makes its cap enforceable
      // server-side, and video is the expensive path.
      ? { kind: "needs-account" }
      : usage && usage.video.limit !== UNLIMITED && usage.video.remaining <= 0
        ? { kind: "capped", resetsOn: usage.resets_on }
        : { kind: "ready" };

  // --- Signed-out usage cap ------------------------------------------------
  // Every graded role-play (scenario gen + transcription + grading) spends LLM
  // tokens, so signed-out visitors get FREE_ROLEPLAYS reps before we ask them to
  // make a free account. Tracked per-browser; the per-IP limiter in the backend
  // is the abuse backstop. Only enforced when accounts are actually available
  // (authReady) — with Supabase off there's nothing to upgrade to, so we fall
  // back to the backend limiter instead of walling everyone.
  const [anonRoleplays, setAnonRoleplays] = useState<number>(() => {
    try {
      return Math.max(0, Number(localStorage.getItem("pic-anon-roleplays")) || 0);
    } catch {
      return 0;
    }
  });
  // True when a signed-out visitor has spent all their free reps (and accounts
  // are available to upgrade to). Also suppresses the speculative prefetch so a
  // capped visitor never pays for a scenario they can't run.
  const roleplayCapReached = authReady && !authUser && anonRoleplays >= FREE_ROLEPLAYS;
  // Consume one free rep (no-op for logged-in users / when accounts are off).
  function bumpAnonRoleplays() {
    if (authUser || !authReady) return;
    setAnonRoleplays((n) => {
      const next = n + 1;
      try {
        localStorage.setItem("pic-anon-roleplays", String(next));
      } catch {
        /* private mode — the in-memory count still gates this session */
      }
      return next;
    });
  }
  // Gate the start of a graded role-play. Returns true if it may proceed;
  // otherwise opens the sign-up wall and returns false.
  function guardRoleplay(): boolean {
    if (authUser || !authReady) return true;
    if (anonRoleplays >= FREE_ROLEPLAYS) {
      track("roleplay_cap_hit", { used: anonRoleplays });
      openAuth(
        "signup",
        `You've used your ${FREE_ROLEPLAYS} free role-plays. Create a free account to keep practicing — it's unlimited and saves your progress.`,
      );
      return false;
    }
    return true;
  }
  // Mastery Blitz is account-only (it also spends grading tokens). Gate every
  // entry point centrally; when accounts are off there's no login to require, so
  // it stays open.
  function startBlitz(cards: Term[], extra?: Record<string, unknown>) {
    if (!authUser && authReady) {
      track("blitz_gated", { ...extra });
      openAuth(
        "login",
        "Mastery Blitz is free with an account. Log in or sign up to drill your terms against the clock.",
      );
      return;
    }
    track("blitz_started", { count: cards.length, ...extra });
    visited.markVisited("blitz"); // an overlay, not a view — no route change to hook
    setBlitzCards(cards);
  }

  // Open a stored session's feedback (from the home "recent sessions" list).
  async function loadSession(id: string) {
    setError(null);
    scoreRunRef.current++; // a stored session's score is authoritative; drop any pending grade
    try {
      const d = await getSession(id);
      setScenario(d.scenario);
      setScore(d.score);
      setResponseText(d.response);
      setFollowupAnswer(d.followup_answer);
      setDelivery(d.delivery);
      setVideoMetrics(d.video); // stored counts + notes; frames never were
      setUtterances(d.utterances);
      setAudioBlob(null); // audio is never persisted
      setPriorSnapshot(null);
      setRetryOf(null);
      setCurrentSessionId(d.id);
      setOnboarding(false);
      setView("practice");
      setStage("feedback");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errMsg(e));
    }
  }

  // Targeted practice for a weak criterion: pre-fill the focus and open setup.
  function practiceCriterion(name: string) {
    setRequest(`Focus on: ${name}`);
    enterPractice();
  }

  // Re-run the SAME scenario so the user can apply the feedback immediately.
  function tryAgain() {
    if (!scenario || !score) return;
    if (!guardRoleplay()) return; // re-running the same scenario is still a graded (paid) run
    scoreRunRef.current++; // cancel any background grade in flight
    bumpAnonRoleplays();
    track("try_again", { event: eventId });
    setPriorSnapshot(snapshotOf(score, delivery));
    setRetryOf(currentSessionId); // link the retry to the saved run (null if anon/unsaved)
    setResponseText("");
    setAudioBlob(null);
    setPresentRemaining(0);
    setClockRunning(false);
    setAutoCountdown(null);
    setFollowupAnswer("");
    setFollowupAudio(null);
    setScore(null);
    setDelivery(null);
    setUtterances([]);
    sampler.cancel();
    setVideoOn(false);
    setVideoMetrics(null); // a retry must not show the previous attempt's video
    setError(null);
    setStage("ready");
  }

  // Restore any stash left by an anonymous completion in a previous page load
  // (e.g. the user left to confirm their email, then came back).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("pic-pending-session");
      if (raw) setPendingSession(JSON.parse(raw) as SaveSessionBody);
    } catch {
      /* ignore malformed/absent stash */
    }
  }, []);

  // Save immediately when logged in; otherwise stash (in memory + localStorage)
  // so it can be attached on sign-up.
  async function saveOrStash(body: SaveSessionBody) {
    if (authUser) {
      try {
        const saved = await saveSession(body);
        setCurrentSessionId(saved.id);
      } catch {
        /* saving is best-effort — never block the feedback screen on it */
      }
      // Terms the grader confirmed were genuinely APPLIED in a graded role-play —
      // the strongest evidence of mastery there is, so it outranks a Blitz verdict
      // in study progress. Only credited terms arrive here: the bonus is zeroed
      // server-side unless a real quote backs it, so this can't be gamed.
      const applied = body.score.analytical?.depth?.terms ?? [];
      if (applied.length) {
        void markStudy(applied.map((term_id) => ({ term_id, evidence: "roleplay", verdict: "correct" })));
      }
    } else if (authReady) {
      setPendingSession(body);
      try {
        localStorage.setItem("pic-pending-session", JSON.stringify(body));
      } catch {
        /* storage disabled — the in-memory copy still attaches this session */
      }
    }
  }

  // Attach a stashed anonymous session once the user is authenticated.
  useEffect(() => {
    if (!authUser || !pendingSession) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await saveSession(pendingSession);
        if (!cancelled) setCurrentSessionId(saved.id);
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) {
          setPendingSession(null);
          try {
            localStorage.removeItem("pic-pending-session");
          } catch {
            /* ignore */
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUser, pendingSession]);
  // `onboarding` marks the current run as the guided "first rep" (the hardcoded
  // scenario shown to brand-new accounts).
  const [onboarding, setOnboarding] = useState(false);

  // Enter the practice flow at the normal setup form. Everyone uses this now —
  // anonymous visitors included — so nobody is forced through the intro. Guarded
  // by the signed-out cap so a capped visitor hits the sign-up wall here, before
  // the setup screen speculatively prefetches (and pays for) a scenario.
  function enterPractice() {
    if (!guardRoleplay()) return;
    setError(null);
    setOnboarding(false);
    setView("practice");
    setStage("pick");
  }

  // --- shared challenge deep link ------------------------------------------
  // Someone opened a friend's Gauntlet card link (/?s=<scenario_id>). Serve them
  // that EXACT role-play — a "score to beat" only means something if both people
  // answered the same prompt. Runs once, before any event has been picked.
  const challengeRef = useRef<string | null>(readChallengeId());
  // The scenario carries its event's display NAME, not its id; we resolve the id
  // from the event list once it loads (needed for math checks + session save).
  const challengeEventName = useRef<string | null>(null);

  useEffect(() => {
    const id = challengeRef.current;
    if (!id) return;
    challengeRef.current = null; // consume exactly once, even under StrictMode
    clearChallengeParam();
    track("challenge_opened");
    // Capped signed-out visitor: guardRoleplay has already opened the sign-up
    // wall, so leave them on the landing page rather than a blank practice screen.
    if (!guardRoleplay()) return;
    setView("practice");
    setStage("loading");
    (async () => {
      try {
        const s = await getScenarioById(id, practiceMode);
        challengeEventName.current = s.event || null;
        recordSeenScenario(s.scenario_id);
        if (s.scenario_id) void confirmScenarioSeen(s.scenario_id).catch(() => {});
        bumpAnonRoleplays(); // an accepted challenge is a graded run like any other
        track("challenge_accepted", { event: s.event, level: s.level });
        setScenario(s);
        setResponseText("");
        setAudioBlob(null);
        setPresentRemaining(0);
        setClockRunning(false);
        setAutoCountdown(null);
        setFollowupAnswer("");
        setFollowupAudio(null);
        setScore(null);
        setDelivery(null);
        setUtterances([]);
        setPriorSnapshot(null);
        setRetryOf(null);
        setStage("ready");
      } catch (e) {
        // Stale or bad link: say so plainly and drop them into normal setup
        // rather than showing a dead end.
        track("challenge_failed");
        setError(
          "That challenge link is no longer available. Pick an event below to start a fresh role-play.",
        );
        setStage("pick");
      }
    })();
    // Mount-only: the link is read from the URL once at startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the challenge scenario's event id once the event list arrives.
  useEffect(() => {
    const name = challengeEventName.current;
    if (!name || eventId || events.length === 0) return;
    const match = events.find((e) => e.name === name);
    if (match) setEventId(match.id);
    challengeEventName.current = null;
  }, [events, eventId]);

  // --- 2-minute rep: where do they bail? -----------------------------------
  // The landing "Try a 2-minute rep" is the top of the funnel, so the useful
  // question isn't how many finish — it's where the rest stop, and especially
  // whether it's the speak-out-loud step, the only one that asks for a mic.
  //
  // These are refs rather than state because every exit path runs inside an
  // event handler or the `pagehide` listener, where a state update would land
  // too late to read back. `endTwoMinRep` therefore touches nothing but refs,
  // which is also what makes the listener's empty dep array safe.
  const repLiveRef = useRef(false);
  // Trails `stage`/`mode` while a rep is live. By the time an exit handler runs,
  // `stage` may already have been reset (restart() → "pick") or may belong to a
  // different run entirely (goToView leaves `stage` untouched).
  const repStepRef = useRef<Stage>("presession");
  const repModeRef = useRef<ResponseMode>("type");
  const repRecordedRef = useRef(false);

  function armTwoMinRep(step: Stage, respMode: ResponseMode) {
    repLiveRef.current = true;
    repStepRef.current = step;
    repModeRef.current = respMode;
    repRecordedRef.current = false;
  }

  // The one exit. Everything that ends the rep goes through here and the first
  // call wins, so the event fires at most once per run — including under
  // StrictMode, where the second pass finds the flag already cleared.
  function endTwoMinRep(reachedScore: boolean, unloading = false) {
    if (!repLiveRef.current) return;
    repLiveRef.current = false;
    if (reachedScore) {
      // Fired here rather than beside `scored` so it counts the FIRST score of an
      // armed run and nothing else. tryAgain() deliberately leaves `onboarding`
      // set, so a naive `if (onboarding)` at the scoring call site would count
      // every retry as another completed 2-minute rep.
      track("two_min_rep_scored");
      return; // a completion is not an abandon
    }
    const props = {
      last_step: STEP_LABEL[repStepRef.current],
      // Without `mode`, recording_started:false can't distinguish a typed run
      // from someone who reached the mic and wouldn't press record — which is
      // the whole question this event exists to answer.
      mode: repModeRef.current,
      recording_started: repRecordedRef.current,
    };
    if (unloading) trackBeacon("two_min_rep_abandoned", props);
    else track("two_min_rep_abandoned", props);
  }

  // The guided first-rep intro (pre-session screen → hardcoded rep) is shown
  // ONLY to people who just created an account.
  function startFirstRep() {
    if (!guardRoleplay()) return; // signed-out cap: the 2-minute rep counts too
    // Armed after the guard on purpose: a capped visitor gets the sign-up wall
    // instead of a rep, so there is nothing for them to abandon.
    armTwoMinRep("presession", mode);
    setError(null);
    setOnboarding(true);
    setView("practice");
    setStage("presession");
  }

  // Seed the hardcoded onboarding scenario (no /api/scenario call) and jump into
  // the same session flow the full app uses. `source` separates the landing
  // funnel from the post-signup tour, which reaches this same function with an
  // already-signed-in user and would otherwise inflate landing conversion.
  function startOnboardingRep(respMode: ResponseMode, source: "landing" | "tour") {
    // Re-arm: the tour hands off straight to here, never passing through the
    // pre-session screen, so this is the only arming point on that path.
    armTwoMinRep("ready", respMode);
    track("onboarding_started", { mode: respMode });
    track("two_min_rep_started", { source });
    bumpAnonRoleplays(); // the 2-minute rep is a graded run — counts against the cap
    setScenario(ONBOARDING_SCENARIO);
    setMode(respMode);
    setFollowupMode(respMode);
    setResponseText("");
    setAudioBlob(null);
    setPresentRemaining(0);
    setClockRunning(false);
    setAutoCountdown(null);
    setFollowupAnswer("");
    setFollowupAudio(null);
    setScore(null);
    setDelivery(null);
    setUtterances([]);
    setPriorSnapshot(null);
    setRetryOf(null);
    setError(null);
    setStage("ready");
  }

  // Trail the live rep's step and mode. Guarded, so stages belonging to a later
  // non-onboarding run can never be reported as the abandon point.
  useEffect(() => {
    if (!repLiveRef.current) return;
    repStepRef.current = stage;
    repModeRef.current = mode;
  }, [stage, mode]);

  // A real score arrived → completed, not abandoned. Deliberately keyed on
  // `score` rather than `stage === "feedback"`: spoken runs land on "feedback"
  // with score === null while the grade is still in flight (DeliveryFirstScreen),
  // and grading can still fail from there.
  useEffect(() => {
    if (score) endTwoMinRep(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // The run stopped being the 2-minute rep: restart(), enterPractice(), skipping
  // the pre-session screen, or opening a stored session all clear `onboarding`.
  // A no-op if it already scored — that disarmed it in an earlier commit.
  useEffect(() => {
    if (!onboarding) endTwoMinRep(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding]);

  // In-app navigation out of the flow. goToView deliberately does NOT reset
  // `stage`, so without this a header click would leave the rep live forever and
  // mis-attribute some later exit to it.
  useEffect(() => {
    if (view !== "practice") endTwoMinRep(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Tab close, reload, or navigating off the site. `pagehide` rather than
  // `beforeunload`: it also fires on iOS Safari and doesn't disqualify the page
  // from the bfcache. Not `visibilitychange` — that fires on every tab switch,
  // so a student who alt-tabs to look something up mid-prep would be marked
  // abandoned with no way to undo it.
  useEffect(() => {
    const onHide = () => endTwoMinRep(false, true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the event catalog once, so the picker is ready on the first screen.
  useEffect(() => {
    getEvents().then(setEvents).catch(() => setEvents([]));
  }, []);

  const onClockScreen = stage === "respond" || stage === "followup";

  // Tick the shared presentation clock down, but only while it's running and we're
  // on a screen that uses it.
  useEffect(() => {
    if (!clockRunning || !onClockScreen) return;
    const id = window.setInterval(() => setPresentRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [clockRunning, onClockScreen]);

  // If the participant lingers without starting, nudge them: after a grace period,
  // run a 5-second countdown, then auto-start the clock so they can't stall forever.
  useEffect(() => {
    if (!onClockScreen || clockRunning) return;
    let tick: number | undefined;
    const grace = window.setTimeout(() => {
      setAutoCountdown(5);
      tick = window.setInterval(() => {
        setAutoCountdown((v) => {
          if (v === null) return null;
          if (v <= 1) {
            if (tick) clearInterval(tick);
            setClockRunning(true);
            return null;
          }
          return v - 1;
        });
      }, 1000);
    }, IDLE_GRACE_MS);
    return () => {
      clearTimeout(grace);
      if (tick) clearInterval(tick);
      setAutoCountdown(null);
    };
  }, [stage, clockRunning, onClockScreen]);

  const startClock = () => {
    setAutoCountdown(null);
    setClockRunning(true);
  };

  const prefetchKey = (ev: string, lv: Level, md: Mode) => `${ev}|${lv}|${md}`;

  // Fire the scenario request as soon as event + level (+ mode) are chosen, so it's
  // often already done by the time the user finishes the optional focus box. Only
  // the no-focus combo is prefetched; adding focus text simply isn't reused (see
  // generate). Debounced so flipping through events doesn't fire a request each.
  useEffect(() => {
    if (stage !== "pick" || !eventId || roleplayCapReached) return;
    const key = prefetchKey(eventId, level, practiceMode);
    if (prefetchRef.current?.key === key) return; // already prefetching this exact combo
    const t = window.setTimeout(() => {
      const promise = postScenario({ event: eventId, request: "", level, mode: practiceMode, avoid: recentCombos(eventId), seen: seenScenarios() });
      promise.catch(() => {}); // speculative: swallow; generate() re-requests on demand
      prefetchRef.current = { key, promise };
    }, 500);
    return () => window.clearTimeout(t);
  }, [stage, eventId, level, practiceMode]);

  async function generate() {
    if (!eventId) return;
    if (!guardRoleplay()) return; // signed-out cap: spending starts here (scenario gen)
    setError(null);
    scoreRunRef.current++; // cancel any background grade still in flight from a prior run
    setStage("loading");
    try {
      const focus = request.trim();
      const key = prefetchKey(eventId, level, practiceMode);
      let s: ScenarioResponse;
      if (!focus && prefetchRef.current?.key === key) {
        // Reuse the request fired while they filled the focus box; if that
        // speculative request errored, fall back to a fresh one.
        try {
          s = await prefetchRef.current.promise;
        } catch {
          s = await postScenario({ event: eventId, request: "", level, mode: practiceMode, avoid: recentCombos(eventId), seen: seenScenarios() });
        }
      } else {
        s = await postScenario({ event: eventId, request: focus, level, mode: practiceMode, avoid: recentCombos(eventId), seen: seenScenarios() });
      }
      prefetchRef.current = null; // consumed
      if (s.sampling) recordCombo(eventId, s.sampling.signature); // remember this combo to vary the next
      // Remember the cached-pool id so we're never served this role-play again.
      // Locally for anonymous visitors; confirmed server-side for signed-in ones
      // so it survives a new device. Fire-and-forget — this must not delay the
      // scenario appearing, and a failure only risks an eventual repeat.
      recordSeenScenario(s.scenario_id);
      if (s.scenario_id) void confirmScenarioSeen(s.scenario_id).catch(() => {});
      bumpAnonRoleplays(); // this graded run counts against the signed-out cap
      track("scenario_generated", { level, mode: practiceMode, event: eventId, focused: !!focus });
      setScenario(s);
      setResponseText("");
      setAudioBlob(null);
      setPresentRemaining(0);
      setClockRunning(false);
      setAutoCountdown(null);
      setFollowupAnswer("");
      setFollowupAudio(null);
      setScore(null);
      setDelivery(null);
      setUtterances([]);
      setPriorSnapshot(null); // fresh scenario, not a re-attempt
      setRetryOf(null);
      setStage("ready");
    } catch (e) {
      setError(errMsg(e));
      setStage("pick");
    }
  }

  // Grade the content (indicators + solution + presentation). Runs in the
  // BACKGROUND for spoken runs — the delivery-first screen is already visible —
  // so this only sets the score/stage when its run is still the active one.
  async function runScoring(
    runId: number,
    sc: ScenarioResponse,
    responseForScoring: string,
    deliveryMetrics: DeliveryMetrics | null,
    runUtterances: Utterance[],
  ) {
    try {
      // Spoken follow-up: transcribe it too (content only — its delivery isn't graded).
      let followupForScoring = followupAnswer;
      if (followupMode === "speak" && followupAudio) {
        const fd = await postDelivery(followupAudio, sc.timing.target_seconds);
        if (scoreRunRef.current !== runId) return;
        followupForScoring = fd.transcript;
        setFollowupAnswer(fd.transcript);
      }

      const result = await postScore({
        scenario: sc.situation,
        criteria_ids: sc.criteria.map((c) => c.id),
        response: responseForScoring,
        followup_questions: sc.followup_questions,
        followup_answer: followupForScoring,
        event: eventId, // lets the backend run math checks for quantitative events
        // Section 3 blends objective delivery metrics with the judge's read when spoken.
        spoken: !!deliveryMetrics,
        delivery_score: deliveryMetrics ? deliveryMetrics.delivery_score : null,
      });
      if (scoreRunRef.current !== runId) return; // a restart/retry superseded this grade
      setScore(result);
      setStage("feedback");
      track("scored", {
        total_points: result.total_points,
        pct: result.overall_percent,
        mode,
        practice_mode: sc.mode,
        has_delivery: !!deliveryMetrics,
        onboarding,
      });
      // Persist the completed run (logged in) or stash it to attach on sign-up.
      setCurrentSessionId(null);
      // Wait for video before saving, so a rep reopened from history keeps its
      // Video tab. Normally instant — video analysis is the faster of the two
      // background jobs — but awaiting makes it certain rather than probable.
      const videoForSave = await (videoRunRef.current ?? Promise.resolve(null));
      // `deliveryMetrics` is the snapshot taken before video ran, so re-apply the
      // adjustment here rather than reading it back off state — otherwise the
      // session would persist the audio-only score and a rep reopened from
      // history would disagree with the one the student just looked at.
      const deliveryForSave =
        deliveryMetrics && videoForSave?.adjusted_delivery_score != null
          ? {
              ...deliveryMetrics,
              delivery_score: videoForSave.adjusted_delivery_score,
              delivery_components: videoForSave.delivery_component
                ? [...deliveryMetrics.delivery_components, videoForSave.delivery_component]
                : deliveryMetrics.delivery_components,
            }
          : deliveryMetrics;
      void saveOrStash({
        scenario: sc,
        score: result,
        response: responseForScoring,
        followup_answer: followupForScoring,
        delivery: deliveryForSave,
        video: videoForSave,
        utterances: runUtterances,
        event_id: eventId,
        retry_of_session_id: retryOf,
      });
    } catch (e) {
      if (scoreRunRef.current !== runId) return;
      // Scoring itself failed (e.g. the grading call errored or timed out). Track
      // it so a run that submitted but never `scored` is visible, not silent.
      track("score_failed", { event: eventId, reason: errMsg(e).slice(0, 120) });
      setError(errMsg(e));
      setStage("followup");
    }
  }

  async function submit() {
    if (!scenario) return;
    setError(null);
    // Funnel: they hit submit. Pairs with `scored` to expose the gap between
    // "tried to submit" and "got a score" — i.e. transcription/scoring failures.
    track("response_submitted", { mode, event: eventId });
    const runId = ++scoreRunRef.current;
    const sc = scenario;

    // Spoken path: transcribe first (the slow step), then show delivery IMMEDIATELY
    // and grade the content in the background (Phase 2a).
    if (mode === "speak") {
      if (!audioBlob) {
        setError("No recording found: record your response first, then submit.");
        setStage("respond");
        return;
      }
      setStage("scoring"); // transcription loader: delivery metrics aren't ready yet

      // Stop the camera the moment they submit — the rep is over, so there is no
      // reason for it to stay on for a second longer. This also hands us the
      // sampled frames; the analysis itself is kicked off below, deliberately
      // NOT awaited, so video can never delay or fail the audio path.
      const frames = videoOn && sampler.state === "running" ? sampler.stop() : [];

      let d: DeliveryResponse;
      try {
        d = await postDelivery(audioBlob, sc.timing.target_seconds, sc.team);
      } catch (e) {
        // Transcription failed — silent/empty/unclear clip, or the provider was
        // unreachable. Send them back to re-record (not on to the questions) with
        // the reason shown, instead of the old bare "HTTP 502".
        track("transcription_failed", { event: eventId, reason: errMsg(e).slice(0, 120) });
        setError(errMsg(e));
        setStage("respond");
        return;
      }
      if (scoreRunRef.current !== runId) return;
      if (!d.transcript.trim()) {
        // Valid audio the provider heard as silence — comes back as empty text.
        track("recording_silent", { event: eventId });
        setError("We couldn't hear anything in that recording. It came through silent. Check your mic, then record again.");
        setStage("respond");
        return;
      }
      // Delivery metrics are deterministic and ready now — render them at once,
      // leaving the content score to stream in behind them.
      setUtterances(d.utterances); // team: speaker-labeled turns for the transcript
      setResponseText(d.transcript); // so the Transcript tab can highlight it
      setDelivery(d.metrics);
      setScore(null);
      setStage("feedback");
      void runScoring(runId, sc, d.transcript, d.metrics, d.utterances);

      // Video analysis runs in the background behind the already-visible
      // delivery feedback, exactly like content scoring does. It is strictly
      // additive: if it fails, the student keeps their full content and delivery
      // feedback and simply doesn't get a Video tab. A bonus feature must never
      // be able to break the rep.
      if (frames.length > 0) {
        track("video_submitted", { frames: frames.length, event: eventId });
        videoRunRef.current = scoreVideo(frames, d.metrics.delivery_score)
          .then((m) => {
            if (scoreRunRef.current !== runId) return null; // stale run — they moved on
            setVideoMetrics(m);
            // Fold the (small, server-capped) video adjustment into the delivery
            // metrics the Delivery tab renders and the session saves. Only the
            // delivery number moves: the content score sent to /api/score is
            // already in flight by now, and delaying content feedback to wait on
            // a bonus signal would trade the thing students value most for at
            // most four points of precision on one sub-score.
            if (m.adjusted_delivery_score !== null) {
              setDelivery((prev) =>
                prev
                  ? {
                      ...prev,
                      delivery_score: m.adjusted_delivery_score!,
                      delivery_components: m.delivery_component
                        ? [...prev.delivery_components, m.delivery_component]
                        : prev.delivery_components,
                    }
                  : prev,
              );
            }
            return m;
          })
          .catch((e) => {
            track("video_failed", { reason: errMsg(e).slice(0, 120) });
            return null; // resolve, never reject: the save awaits this
          });
      } else {
        videoRunRef.current = null;
      }
      return;
    }

    // Typed path: no delivery to show first, so keep the grading loader until the
    // content score lands.
    if (!responseText.trim()) {
      setError("Type your response first, then submit.");
      setStage("respond");
      return;
    }
    setDelivery(null);
    setScore(null);
    setStage("scoring");
    await runScoring(runId, sc, responseText, null, []);
  }

  function restart() {
    scoreRunRef.current++; // cancel any background grade in flight
    setScenario(null);
    setScore(null);
    setDelivery(null);
    // Release the camera and clear the opt-in: video is a per-rep choice, so a
    // new session must start with it off rather than inheriting the last one.
    sampler.cancel();
    setVideoOn(false);
    setVideoMetrics(null);
    setUtterances([]);
    setResponseText("");
    setAudioBlob(null);
    setPresentRemaining(0);
    setClockRunning(false);
    setAutoCountdown(null);
    setFollowupAnswer("");
    setFollowupAudio(null);
    setError(null);
    setOnboarding(false);
    setPriorSnapshot(null);
    setRetryOf(null);
    setCurrentSessionId(null);
    setStage("pick");
  }

  const wide = view === "home" || (view === "practice" && stage === "feedback") || view === "tips";

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        view={view}
        onView={goToView}
        onPractice={() => enterPractice()}
        onHome={() => goToView("home")}
        onFlashcards={() => goToView("flashcards")}
        theme={theme}
        onToggleTheme={toggleTheme}
        onFeedback={() => setFeedbackOpen(true)}
        authReady={authReady}
        userEmail={authUser?.email ?? null}
        onLogin={() => openAuth("login")}
        onSignup={() => openAuth("signup")}
        onSignOut={() => { void signOut(); setView("home"); }}
        // Dots only for signed-in accounts — a signed-out visitor has no account
        // to track, and marking up the nav for them is noise, not guidance.
        unvisited={authUser ? (s) => !visited.isVisited(s) : undefined}
        onReplayTour={authUser ? () => { track("tour_replayed"); setTourOpen(true); } : undefined}
      />
      <AuthModal open={authOpen} initialTab={authTab} reason={authReason} onClose={() => setAuthOpen(false)} onAuthed={handleAuthed} />
      {flashcard && (
        <Flashcards
          ids={flashcard.ids}
          cards={flashcard.cards}
          startId={flashcard.startId}
          title={flashcard.title}
          flags={flags}
          onClose={() => { setFlashcard(null); endStudy(); }}
        />
      )}
      {blitzCards && <MasteryBlitz cards={blitzCards} onClose={() => { setBlitzCards(null); endStudy(); }} />}
      {tourOpen && (
        <ProductTour
          onSkip={() => {
            closeTour("skipped");
            // Same landing spot as the old pre-session screen's skip link.
            setOnboarding(false);
            setView("practice");
            setStage("pick");
          }}
          onStartRep={(respMode) => {
            closeTour("completed");
            setOnboarding(true);
            setView("practice");
            startOnboardingRep(respMode, "tour");
          }}
        />
      )}
      <main className={`w-full flex-1 mx-auto px-5 pb-20 pt-8 ${view === "home" || view === "flashcards" ? "max-w-[88rem]" : view === "course" ? "max-w-5xl" : wide ? "max-w-6xl" : "max-w-3xl"}`}>
        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* One-time "what is this page for" card, on the first visit to a surface.
            Inline rather than a modal: it introduces the thing they're already
            looking at, so covering it up would defeat the point. */}
        {authUser && view !== "practice" && !visited.isVisited(view as Surface) && FEATURE_INTROS[view as Surface] && (
          <FeatureIntro
            title={FEATURE_INTROS[view as Surface].title}
            body={FEATURE_INTROS[view as Surface].body}
            onDismiss={() => {
              visited.markVisited(view as Surface);
              track("feature_intro_dismissed", { view });
            }}
          />
        )}

        {view === "home" && authUser ? (
          <HomePage
            onStart={() => { track("practice_cta_clicked", { from: "home" }); enterPractice(); }}
            onPracticeCriterion={practiceCriterion}
            onOpenFlashcards={(ids) => setFlashcard({ ids })}
            onOpenLibrary={() => goToView("flashcards")}
            onOpenSession={loadSession}
          />
        ) : view === "home" ? (
          <LandingPage
            onStart={() => {
              track("practice_cta_clicked", { from: "landing" });
              track("cta_clicked", { cta: "ready_to_practice" });
              enterPractice();
            }}
            onQuickRep={() => {
              track("quick_rep_clicked", { from: "landing" });
              track("cta_clicked", { cta: "two_min_rep" });
              startFirstRep();
            }}
            onTips={() => {
              track("cta_clicked", { cta: "new_to_deca" });
              goToView("tips");
            }}
            supabaseEnabled={authReady}
            onSignIn={() => openAuth("login", "Log in to pick up your progress and session history.")}
            onSignup={() => openAuth("signup", "Create a free account to start tracking your progress.")}
          />
        ) : view === "flashcards" ? (
          <FlashcardLibrary
            flags={flags}
            onStudy={(cards, startId, title) => setFlashcard({ cards, startId, title })}
            onBlitz={(cards) => startBlitz(cards)}
          />
        ) : view === "course" ? (
          <StudyCourse
            authed={!!authUser}
            refreshKey={studyEpoch}
            onStudy={(cards, startId, title) => setFlashcard({ cards, startId, title })}
            onBlitz={(cards, title) => startBlitz(cards, { from: "course", unit: title })}
          />
        ) : view === "tips" ? (
          <TipsPage onStart={() => enterPractice()} />
        ) : view === "faq" ? (
          <FAQPage onStart={() => enterPractice()} />
        ) : (
          <>
            {stage === "presession" && (
              <PreSessionScreen
                canRecord={CAN_RECORD}
                onStart={(respMode) => startOnboardingRep(respMode, "landing")}
                onSkip={() => {
                  setOnboarding(false);
                  setStage("pick");
                }}
              />
            )}

            {stage === "pick" && (
              <PickScreen
                events={events}
                eventId={eventId}
                request={request}
                practiceMode={practiceMode}
                level={level}
                onEvent={(id) => {
                  setEventId(id);
                  // Funnel entry: they committed to an event. Pairs with
                  // scenario_generated to expose "picked but never generated."
                  if (id) track("event_selected", { event: id });
                }}
                onRequest={setRequest}
                onPracticeMode={setPracticeMode}
                onLevel={setLevel}
                onGenerate={generate}
                onTips={() => goToView("tips")}
              />
            )}
            {stage === "pick" && usage && <AllowanceNotice usage={usage} onSignIn={() => openAuth("signup")} />}

            {stage === "loading" && (
              <LoadingScreen
                title="Building your role-play…"
                steps={[
                  "Reading what you want to practice",
                  "Choosing the indicators to assess",
                  "Setting the business & context",
                  "Writing the situation",
                  "Preparing the judge's questions",
                ]}
              />
            )}

            {stage === "ready" && scenario && (
              <ReadyScreen
                scenario={scenario}
                onStart={() => {
                  track("prep_started", { event: eventId });
                  setStage("prep");
                }}
              />
            )}

            {/* The judge to present to, fixed near the webcam, for exactly as long
                as the camera is on. Scoped to the two stages where the student is
                actually delivering — showing it during prep or feedback would be
                asking them to make eye contact with nothing. */}
            {videoOn && sampler.state === "running" && (stage === "respond" || stage === "followup") && (
              <GazeAnchor frameCount={sampler.frameCount} />
            )}

            {stage === "prep" && scenario && (
              <PrepScreen
                scenario={scenario}
                onStart={() => {
                  setPresentRemaining(scenario.timing.present_seconds);
                  setClockRunning(false);
                  setAutoCountdown(null);
                  setStage("walkin");
                }}
              />
            )}

            {stage === "walkin" && scenario && (
              <WalkinScreen
                scenario={scenario}
                onEnter={() => {
                  // They left the waiting room to face the judge — the last
                  // step before they actually present.
                  track("presentation_started", { event: eventId });
                  setStage("respond");
                }}
              />
            )}

            {stage === "respond" && scenario && (
              <RespondScreen
                scenario={scenario}
                remaining={presentRemaining}
                running={clockRunning}
                autoCountdown={autoCountdown}
                onStart={startClock}
                onRecordingStart={() => { repRecordedRef.current = true; }}
                mode={mode}
                onMode={setMode}
                value={responseText}
                onChange={setResponseText}
                audioBlob={audioBlob}
                onRecorded={setAudioBlob}
                videoGate={videoGate}
                videoSampler={sampler}
                videoOn={videoOn}
                videoRemaining={usage && usage.video.limit !== UNLIMITED ? usage.video.remaining : null}
                onEnableVideo={async () => {
                  // Only flip the opt-in once the camera actually starts — a
                  // failed permission prompt must not leave the UI claiming to
                  // be recording video it isn't.
                  if (await sampler.start()) setVideoOn(true);
                }}
                onDisableVideo={() => { sampler.cancel(); setVideoOn(false); }}
                onSignIn={() => openAuth("signup", "Create a free account to add video feedback to your reps — it's free while video is in beta.")}
                onContinue={() => {
                  setClockRunning(false); // pause the window while moving to the questions
                  setStage("followup");
                }}
              />
            )}

            {stage === "followup" && scenario && (
              <FollowupScreen
                scenario={scenario}
                remaining={presentRemaining}
                running={clockRunning}
                autoCountdown={autoCountdown}
                onStart={startClock}
                mode={followupMode}
                onMode={setFollowupMode}
                value={followupAnswer}
                onChange={setFollowupAnswer}
                audioBlob={followupAudio}
                onRecorded={setFollowupAudio}
                videoSampler={videoOn && sampler.state === "running" ? sampler : null}
                onDisableVideo={() => { sampler.cancel(); setVideoOn(false); }}
                onSubmit={submit}
              />
            )}

            {stage === "scoring" && (
              <LoadingScreen
                title="Grading your response…"
                steps={
                  mode === "speak"
                    ? [
                        "Transcribing your delivery",
                        ...(scenario?.team ? ["Separating the speakers"] : []),
                        "Measuring pace, fillers & timing",
                        "Matching your words to each indicator",
                        "Evaluating your solution",
                        ...(scenario?.quantitative ? ["Checking your math"] : []),
                        "Writing your feedback",
                      ]
                    : [
                        "Reading your response",
                        "Matching your words to each indicator",
                        "Evaluating your solution",
                        ...(scenario?.quantitative ? ["Checking your math"] : []),
                        "Writing your feedback",
                      ]
                }
              />
            )}

            {stage === "feedback" && scenario && !score && delivery && (
              <DeliveryFirstScreen scenario={scenario} delivery={delivery} audioBlob={audioBlob} />
            )}

            {stage === "feedback" && score && scenario && (
              <FeedbackScreen
                scenario={scenario}
                score={score}
                response={responseText}
                followupAnswer={followupAnswer}
                delivery={delivery}
                video={videoMetrics}
                utterances={utterances}
                audioBlob={audioBlob}
                onRestart={restart}
                onTryAgain={tryAgain}
                onStudyCriteria={(ids) => setFlashcard({ ids })}
                priorSnapshot={priorSnapshot}
                loggedIn={!!authUser}
                // Only ask when there's an account to create: `authReady` false
                // means Supabase isn't configured for this deployment.
                promptSource={
                  authReady && !authUser ? (onboarding ? "two_min_rep_score" : "roleplay_score") : undefined
                }
                onSignIn={() => openAuth("signup", "Want to see if you improve next time? Create an account to track your progress.")}
              />
            )}
          </>
        )}
      </main>
      <SiteFooter />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
      {/* Landing only: a signed-in visitor gets HomePage here, and this is
          cold-visitor copy. Suppressed for a capped visitor, whose "Try it"
          would open the sign-up wall instead of a rep — a broken promise.
          Outside <main> because it's fixed-position, which is also why
          LandingPage itself needs no changes. */}
      {nudge.open && view === "home" && !authUser && !roleplayCapReached && (
        <RepNudge
          onShown={nudge.markShown}
          onStart={() => {
            track("rep_nudge_clicked");
            startFirstRep(); // the view effect retires the nudge from here
          }}
          onDismiss={() => {
            track("rep_nudge_dismissed");
            nudge.dismiss();
          }}
        />
      )}
    </div>
  );
}

// --- marketing demo (/demo) ------------------------------------------------
// A no-API walkthrough of a finished session: the scenario + a sample response,
// then the full graded feedback (every tab live and clickable). Reuses the real
// screens with canned data so what visitors see is exactly what the app produces.
export function DemoApp() {
  const { theme, toggleTheme } = useTheme();
  const [step, setStep] = useState<"scenario" | "feedback">("scenario");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const exit = () => {
    window.location.href = "/";
  };
  useEffect(() => {
    if (step === "feedback") window.scrollTo({ top: 0 });
  }, [step]);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader view="practice" onView={exit} onPractice={exit} onHome={exit} onFlashcards={exit} theme={theme} onToggleTheme={toggleTheme} onFeedback={() => setFeedbackOpen(true)} />
      <DemoRibbon onExit={exit} />
      <main className={`w-full flex-1 mx-auto px-5 pb-20 pt-7 ${step === "feedback" ? "max-w-6xl" : "max-w-3xl"}`}>
        {step === "scenario" ? (
          <DemoScenarioStep onNext={() => setStep("feedback")} />
        ) : (
          <div className="space-y-5">
            <DemoStepHeader
              step={2}
              title="The graded feedback"
              blurb="Scored criterion by criterion against the framework. Open any tab; the Transcript even highlights the exact phrases that earned credit."
              backLabel="Back to the scenario"
              onBack={() => setStep("scenario")}
            />
            <FeedbackScreen
              scenario={DEMO_SCENARIO}
              score={DEMO_SCORE}
              response={DEMO_RESPONSE}
              followupAnswer={DEMO_FOLLOWUP}
              delivery={DEMO_DELIVERY}
              utterances={[]}
              audioBlob={null}
              onRestart={exit}
            />
          </div>
        )}
      </main>
      <SiteFooter />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}

function DemoRibbon({ onExit }: { onExit: () => void }) {
  return (
    <div className="border-b border-indigo-100 bg-indigo-50/80 backdrop-blur-sm dark:border-indigo-900/50 dark:bg-indigo-950/40">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-2 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-indigo-900 dark:text-indigo-200">
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-indigo-500">Demo</span>
          <span className="ml-2">A sample session with an example scenario and feedback, no account needed.</span>
        </p>
        <button
          onClick={onExit}
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700"
        >
          Try it for real →
        </button>
      </div>
    </div>
  );
}

// --- admin QA page (/admin) ------------------------------------------------
// Owner-only, gated by a secret passphrase verified server-side. Two jobs:
//  1. Mock previews of the new surfaces (no data, no tokens).
//  2. Seed/clear CANNED sample sessions in the logged-in account (no LLM tokens)
//     so the REAL home page + progress graphs can be eyeballed with data.
export function AdminApp() {
  const { theme, toggleTheme } = useTheme();
  const { user, ready } = useAuth();
  const flags = useFlags(user?.id ?? null);
  const [unlocked, setUnlocked] = useState(() => {
    try { return sessionStorage.getItem("pic-admin-ok") === "1"; } catch { return false; }
  });
  const [pass, setPass] = useState("");
  const [gateErr, setGateErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState<"live" | "feedback" | "beforeafter" | "onboarding">("live");
  const [flashOpen, setFlashOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "seed" | "clear">("");
  const [msg, setMsg] = useState<string | null>(null);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setGateErr(null);
    setChecking(true);
    try {
      const r = await adminVerify(pass);
      if (r.ok) {
        setUnlocked(true);
        try { sessionStorage.setItem("pic-admin-ok", "1"); } catch { /* ignore */ }
      } else {
        setGateErr("Wrong passphrase.");
      }
    } catch {
      setGateErr("The admin page isn't enabled on this server (no ADMIN_PASSPHRASE set).");
    } finally {
      setChecking(false);
    }
  }

  async function doSeed() {
    setBusy("seed"); setMsg(null);
    try { const r = await seedSamples(); setMsg(`✓ Seeded ${r.seeded} sample sessions. Open your real Home to see the graphs.`); }
    catch (e) { setMsg(errMsg(e)); }
    finally { setBusy(""); }
  }
  async function doClear() {
    setBusy("clear"); setMsg(null);
    try { const r = await clearSamples(); setMsg(`✓ Cleared ${r.deleted} sample sessions.`); }
    catch (e) { setMsg(errMsg(e)); }
    finally { setBusy(""); }
  }

  if (!unlocked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
        <form onSubmit={unlock} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-indigo-500">Admin QA</div>
          <h1 className="mt-2 font-display text-xl font-semibold text-slate-900 dark:text-slate-100">Enter the passphrase</h1>
          <input
            type="password"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Passphrase"
            className="mt-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          {gateErr && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{gateErr}</p>}
          <button type="submit" disabled={checking || !pass} className={`mt-4 w-full ${BTN_PRIMARY}`}>
            {checking ? "…" : "Unlock"}
          </button>
          <a href="/" className="mt-3 block text-center text-xs text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300">← back to the app</a>
        </form>
      </div>
    );
  }

  const noop = () => {};
  const before: RunSnapshot = { percent: 61, criteriaHit: 1, criteriaTotal: 4, fillerPerMin: 9.0, wpm: 108 };
  const tabs: { key: typeof tab; label: string }[] = [
    { key: "live", label: "Live data (graphs)" },
    { key: "feedback", label: "Feedback screen" },
    { key: "beforeafter", label: "Before / after" },
    { key: "onboarding", label: "Onboarding" },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="border-b border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-2.5">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-amber-600">Admin QA</span>
            <span className="ml-2">Owner-only preview. Sample data is fake and clearable.</span>
          </p>
          <div className="flex items-center gap-3">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <a href="/" className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-900 dark:bg-slate-200 dark:text-slate-900">Exit →</a>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 pt-6">
        <div className="mb-5 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-xl border px-3 py-1.5 text-sm font-medium transition ${
                tab === t.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setFlashOpen(true)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            Flashcards ↗
          </button>
        </div>

        {tab === "live" && (
          <div className="mx-auto max-w-2xl space-y-4">
            <Card>
              <Eyebrow>Live data. Your account</Eyebrow>
              <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Seed sample sessions, then view the real Home</h2>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                This writes 6 backdated, canned sessions into your account (no LLM tokens) so the real delivery trend,
                weakest-criterion nudge, and recent list render with data. Clear them any time.
              </p>
              {!ready ? (
                <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Supabase isn't configured on this server.</p>
              ) : !user ? (
                <button className={`mt-4 ${BTN_PRIMARY}`} onClick={() => setAuthOpen(true)}>Log in to seed data</button>
              ) : (
                <>
                  <p className={`mt-3 text-xs text-slate-500 dark:text-slate-400 ${PH_MASK}`}>Signed in as {user.email}</p>
                  <div className="mt-3 flex flex-wrap gap-2.5">
                    <button className={BTN_PRIMARY} disabled={busy !== ""} onClick={doSeed}>{busy === "seed" ? "Seeding…" : "Seed 6 sample sessions"}</button>
                    <button
                      className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      disabled={busy !== ""}
                      onClick={doClear}
                    >
                      {busy === "clear" ? "Clearing…" : "Clear sample data"}
                    </button>
                    <a href="/" className="inline-flex items-center justify-center rounded-xl border border-indigo-300 bg-indigo-50 px-5 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-900/60 dark:bg-indigo-950/50 dark:text-indigo-300">Open your real Home →</a>
                  </div>
                  {msg && <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{msg}</p>}
                </>
              )}
            </Card>
          </div>
        )}

        {tab === "feedback" && (
          <FeedbackScreen
            scenario={DEMO_SCENARIO}
            score={DEMO_SCORE}
            response={DEMO_RESPONSE}
            followupAnswer={DEMO_FOLLOWUP}
            delivery={DEMO_DELIVERY}
            utterances={[]}
            audioBlob={null}
            onRestart={noop}
            onStudyCriteria={(ids) => { void ids; setFlashOpen(true); }}
          />
        )}

        {tab === "beforeafter" && (
          <FeedbackScreen
            scenario={DEMO_SCENARIO}
            score={DEMO_SCORE}
            response={DEMO_RESPONSE}
            followupAnswer={DEMO_FOLLOWUP}
            delivery={DEMO_DELIVERY}
            utterances={[]}
            audioBlob={null}
            onRestart={noop}
            onTryAgain={noop}
            priorSnapshot={before}
          />
        )}

        {tab === "onboarding" && (
          <PreSessionScreen canRecord={CAN_RECORD} onStart={noop} onSkip={noop} />
        )}
      </main>

      {flashOpen && <Flashcards ids={["FW-164", "FW-041", "FW-280"]} flags={flags} title="Flashcards preview" onClose={() => setFlashOpen(false)} />}
      <AuthModal open={authOpen} initialTab="login" reason="Log in to seed sample data into your account." onClose={() => setAuthOpen(false)} />
    </div>
  );
}

function DemoStepHeader({ step, title, blurb, backLabel, onBack }: {
  step: number; title: string; blurb: string; backLabel?: string; onBack?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-500">Step {step} of 2</span>
        {onBack && (
          <button onClick={onBack} className="font-mono text-[11px] font-medium uppercase tracking-wider text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline dark:text-slate-500 dark:hover:text-slate-300">
            ← {backLabel}
          </button>
        )}
      </div>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">{blurb}</p>
    </div>
  );
}

function DemoScenarioStep({ onNext }: { onNext: () => void }) {
  const s = DEMO_SCENARIO;
  return (
    <div className="space-y-5">
      <DemoStepHeader
        step={1}
        title="The scenario, and a sample response"
        blurb="PI Coach writes an original scenario built around the skills you want to practice, then the competitor presents. Here's an example prompt with a strong (not perfect) typed response, the way a real session looks before grading."
      />
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{s.topic}</h2>
          <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">District · Learn mode</span>
        </div>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{scenarioSubtitle(s)}</p>
        <div className="mt-4">
          <SituationSheet text={s.situation} embedded />
        </div>
      </Card>

      <details className="group rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">Show what's graded (the evaluation criteria)</summary>
        <div className="mt-4">
          <CoverSheet scenario={s} embedded />
        </div>
      </details>

      <Card>
        <Eyebrow>The competitor's response</Eyebrow>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">{DEMO_RESPONSE}</p>
      </Card>

      <Card>
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">The judge follows up</h3>
        <ol className="mt-3 space-y-2">
          {s.followup_questions.map((q, i) => (
            <li key={i} className="flex gap-2 rounded-xl bg-indigo-50/60 px-3 py-2.5 text-sm text-slate-800 dark:bg-indigo-950/40 dark:text-slate-100">
              <span className="font-mono text-xs font-semibold text-indigo-500">Q{i + 1}</span>
              <span>{q}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 whitespace-pre-wrap border-t border-slate-100 pt-3 text-sm leading-relaxed text-slate-700 dark:border-slate-800 dark:text-slate-200">
          <span className="font-medium text-slate-800 dark:text-slate-100">Their answer: </span>
          {DEMO_FOLLOWUP}
        </p>
      </Card>

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Now see how PI Coach grades it, as a percentage, skill by skill.
        </p>
        <button className={`${BTN_PRIMARY} w-full sm:w-auto`} onClick={onNext}>
          See the graded feedback →
        </button>
      </div>
    </div>
  );
}

// Theme: persisted light/dark, applied as a class on <html>. Defaults to the
// system preference on first visit.
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = localStorage.getItem("pic-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    localStorage.setItem("pic-theme", theme);
  }, [theme]);
  return { theme, toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

// A sample of the server-rendered decks, by DECA event code. Two jobs: a student
// who competes in one of these gets there in one click, and a crawler that only
// ever reaches the homepage still finds real internal links into the study pages
// instead of a single link to a hub. The full set lives at /flashcards.
const FOOTER_DECKS: [slug: string, code: string][] = [
  ["principles-business-management", "PBM"],
  ["principles-marketing", "PMK"],
  ["principles-finance", "PFN"],
  ["business-law-ethics-team", "BLTDM"],
  ["human-resources-management", "HRM"],
  ["entrepreneurship-team", "ETDM"],
  ["marketing-management-team", "MTDM"],
  ["personal-financial-literacy", "PFL"],
];

function SiteFooter() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/50 dark:border-slate-800/80 dark:bg-slate-950/40">
      <div className="mx-auto max-w-5xl px-5 py-6 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        <div className="mb-3">
          <span className="font-display text-sm font-semibold text-slate-600 dark:text-slate-300">PI Coach</span>
        </div>
        <p>
          Trains the business skills and delivery that win DECA role-plays, using original practice scenarios and
          our own independent evaluation framework. Not official DECA materials, and not affiliated with DECA Inc.
          Feedback is practice coaching, never an official competition score.
        </p>
        <p className="mt-1.5">
          Recordings are transcribed to measure delivery, then discarded on our servers; your audio stays on your
          device unless you keep it. Delivery covers timing only (pace, fillers, pauses), never tone or confidence.
        </p>
        {/* Real <a href> links, not view switches. These point at the
            server-rendered study pages (backend/app/seo.py), which are the only
            pages on this site a crawler can read without executing the bundle —
            so this footer is also how Google finds them from the homepage. */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          <a className="font-medium transition hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/flashcards">
            Flashcards by event
          </a>
          <a className="font-medium transition hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/privacy">
            Privacy
          </a>
          <a className="font-medium transition hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/terms">
            Terms
          </a>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span className="text-slate-400 dark:text-slate-500">Study decks:</span>
          {FOOTER_DECKS.map(([slug, code]) => (
            <a
              key={slug}
              className="transition hover:text-slate-900 hover:underline dark:hover:text-slate-100"
              href={`/flashcards/${slug}`}
            >
              {code}
            </a>
          ))}
          <a className="font-medium transition hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/flashcards">
            all 28 →
          </a>
        </div>
      </div>
    </footer>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"editing" | "sending" | "done" | "error">("editing");

  async function send() {
    if (!message.trim()) return;
    setState("sending");
    try {
      await postFeedback({ message: message.trim(), rating, email: email.trim(), page: "app" });
      track("feedback_submitted", { rating, has_email: !!email.trim() });
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/40 p-4 dark:bg-black/60 sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        {state === "done" ? (
          <div className="py-4 text-center">
            <p className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Thanks! 🙌</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Your feedback helps make PI Coach better.</p>
            <button className={`mt-4 ${BTN_PRIMARY}`} onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Send feedback</h3>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300" aria-label="Close">✕</button>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Bugs, ideas, what felt off: all welcome. No account needed.</p>

            <div className="mt-4">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">How's it working for you?</span>
              <div className="mt-1.5 flex gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setRating(n)}
                    className={`h-9 w-9 rounded-lg border text-sm transition ${
                      rating !== null && n <= rating
                        ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                        : "border-slate-200 text-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-800"
                    }`}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            <textarea
              className={`mt-4 h-28 ${TEXTAREA_CLS}`}
              placeholder="What's on your mind?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            {/* type="email" is what puts this field inside the replay mask
                (see maskInputOptions in analytics.ts); an untyped input would
                record in the clear. Empty still validates, so it stays optional. */}
            <input
              type="email"
              className="mt-2 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:bg-slate-900 dark:text-slate-100"
              placeholder="Email (optional: only if you want a reply)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            {state === "error" && (
              <p className="mt-2 text-xs text-red-600">Couldn't send: check your connection and try again.</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700">
                Cancel
              </button>
              <button className={BTN_PRIMARY} onClick={send} disabled={!message.trim() || state === "sending"}>
                {state === "sending" ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- product tour ----------------------------------------------------------

/**
 * The guided walkthrough shown to new accounts.
 *
 * Every step renders a REAL screen driven by the demo fixtures — the same
 * fixtures behind the /demo route — rather than a mock-up, so the tour can't
 * quietly drift out of sync with the product. The shell (caption bar, keyboard
 * handling, progress) lives in tour.tsx; the steps are assembled here because
 * this is where the screens are defined.
 */
function ProductTour(props: {
  onSkip: () => void;
  onStartRep: (mode: ResponseMode) => void;
  initialStep?: number;
}) {
  // A real sampler that is never started: RespondScreen requires one, and this
  // way no camera is touched and no permission prompt can fire during the tour.
  const idleSampler = useFrameSampler();
  const noop = () => {};

  const demoStage = (node: ReactNode) => () => node;

  const steps: TourStep[] = [
    {
      id: "scenario",
      act: "The rep",
      caption:
        "Every role-play starts here: a real business situation, and the exact skills you'll be judged on. Read it twice — the actual ask is usually one sentence.",
      render: demoStage(<ReadyScreen scenario={DEMO_SCENARIO} onStart={noop} />),
    },
    {
      id: "respond",
      act: "The rep",
      caption:
        "After a prep window on a real clock, you present out loud — or type, if you'd rather. Speaking is what we recommend: it's the only way to get feedback on pace, filler words and pauses.",
      render: demoStage(
        <RespondScreen
          scenario={DEMO_SCENARIO}
          remaining={DEMO_SCENARIO.timing.present_seconds}
          running={false}
          autoCountdown={null}
          onStart={noop}
          mode="type"
          onMode={noop}
          value={DEMO_RESPONSE}
          onChange={noop}
          audioBlob={null}
          onRecorded={noop}
          videoGate={{ kind: "unsupported" }}
          videoSampler={idleSampler}
          videoOn={false}
          videoRemaining={null}
          onEnableVideo={noop}
          onDisableVideo={noop}
          onSignIn={noop}
          onContinue={noop}
        />,
      ),
    },
    {
      id: "followup",
      act: "The rep",
      caption:
        "Then the judge's follow-up questions. They're written before you speak, so they probe the situation itself — not whatever you happened to say.",
      render: demoStage(
        <FollowupScreen
          scenario={DEMO_SCENARIO}
          remaining={Math.round(DEMO_SCENARIO.timing.present_seconds / 3)}
          running={false}
          autoCountdown={null}
          onStart={noop}
          mode="type"
          onMode={noop}
          value={DEMO_FOLLOWUP}
          onChange={noop}
          audioBlob={null}
          onRecorded={noop}
          videoSampler={null}
          onDisableVideo={noop}
          onSubmit={noop}
        />,
      ),
    },
    ...FEEDBACK_TOUR_TABS.map((t) => ({
      id: `feedback-${t.tab}`,
      act: "Your feedback",
      caption: t.caption,
      // The feedback view is a two-column grid above `lg` — it needs the same wide
      // container the app shell gives it, or the tab strip clips.
      wide: true,
      render: () => <TourFeedback tab={t.tab} />,
    })),
    {
      id: "share",
      act: "Your feedback",
      caption:
        "And when a run goes well, hit “Challenge a friend” on your score to turn it into a card. One button shares it — your friend opens the same scenario, with your score to beat.",
      render: () => <TourShareStep />,
    },
    {
      // One summary card rather than a card per feature: each surface introduces
      // itself properly the first time it's opened (FeatureIntro), so spending
      // five more steps here before they've done a single rep is friction.
      id: "features",
      act: "The rest of the app",
      caption:
        "Practice tells you what's weak. These are where you go to fix it — each one explains itself the first time you open it.",
      render: () => <FeatureSummaryCard />,
    },
    {
      id: "start",
      act: "Your turn",
      caption:
        "That's the whole app. Your first rep is a short one — about two minutes — and it's graded exactly like the real thing.",
      render: () => (
        <FeatureTourCard
          title="Ready for your first rep?"
          body="A friend's coffee cart needs advice. Two minutes, three skills, real feedback at the end."
          points={[
            "Speaking gets you delivery feedback; typing doesn't.",
            "There's no penalty for a rough first attempt — that's the point of it.",
          ]}
        />
      ),
      footer: (
        <div className="flex flex-wrap gap-2">
          {CAN_RECORD && (
            <button className={`${BTN_PRIMARY} px-5 py-2`} onClick={() => props.onStartRep("speak")}>
              🎙️ Start out loud
            </button>
          )}
          <button className={`${BTN_SECONDARY} px-4 py-2`} onClick={() => props.onStartRep("type")}>
            ⌨️ Type it instead
          </button>
        </div>
      ),
    },
  ];

  return (
    <TourShell
      steps={steps}
      initialStep={props.initialStep}
      onSkip={props.onSkip}
      onStep={(index, step) => track("tour_step", { index, id: step.id, act: step.act })}
    />
  );
}

/**
 * The feedback tabs the tour stops on. Four of the six, deliberately: Analysis and
 * Scenario are named in the Indicators caption instead of costing a step each. The
 * tab strip is visible in every one of these shots, so the tabs we skip are still
 * on screen the whole time.
 */
const FEEDBACK_TOUR_TABS: { tab: FeedbackTab; caption: string }[] = [
  {
    tab: "overview",
    caption:
      "Feedback opens on the one-look read: your weighted score, your strongest moment, and the single thing costing you the most.",
  },
  {
    tab: "transcript",
    caption:
      "The transcript highlights the exact phrases that earned credit — so you can see which words scored, not just that they did.",
  },
  {
    tab: "delivery",
    caption:
      "Delivery measures pace, filler words and pauses from your recording. It never judges tone, confidence or charisma.",
  },
  {
    tab: "criteria",
    caption:
      "Indicators breaks down every skill you were assessed on, Novice to Exemplary, with a specific fix for each. Analysis and Scenario are up there too — your problem-solving score, and the original situation.",
  },
];

/** The real FeedbackScreen on demo data, with the tour driving which tab is open. */
function TourFeedback(props: { tab: FeedbackTab }) {
  return (
    <FeedbackScreen
      scenario={DEMO_SCENARIO}
      score={DEMO_SCORE}
      response={DEMO_RESPONSE}
      followupAnswer={DEMO_FOLLOWUP}
      delivery={DEMO_DELIVERY}
      utterances={[]}
      audioBlob={null}
      onRestart={() => {}}
      loggedIn
      tab={props.tab}
    />
  );
}

/**
 * The share card, shown inline rather than through GauntletCardModal.
 *
 * The modal is `fixed inset-0`, so inside the tour it covered the caption bar —
 * hiding Next and trapping the student on the step. Inline also lets the share
 * button be visibly inert: this is a walkthrough, and a real tap here would render
 * a PNG of demo data and open the OS share sheet.
 */
function TourShareStep() {
  return (
    <div className="flex flex-col items-center gap-4">
      {/* Where the card comes from — the same button that sits on their score. */}
      <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-2.5 text-sm font-semibold text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200">
        <BrandMark size={16} />
        Challenge a friend
      </div>
      <span aria-hidden className="text-lg leading-none text-slate-300 dark:text-slate-600">↓</span>

      {/* The real card at 0.62, so a 540x675 portrait fits above the caption bar. */}
      <div style={{ width: 540 * 0.62, height: 675 * 0.62 }}>
        <div
          style={{ width: 540, height: 675, transform: "scale(0.62)", transformOrigin: "top left" }}
          className="overflow-hidden rounded-2xl shadow-xl"
        >
          <GauntletCard scenario={DEMO_SCENARIO} score={DEMO_SCORE} />
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <button
          disabled
          className="inline-flex cursor-not-allowed items-center justify-center rounded-xl bg-indigo-600/60 px-5 py-2.5 text-sm font-semibold text-white"
        >
          Share the challenge
        </button>
        <p className="text-xs text-slate-500 dark:text-slate-400">Inactive during the tour</p>
      </div>
    </div>
  );
}

/** The four other surfaces, in one card. Depth lives in each page's FeatureIntro. */
const FEATURE_SUMMARY: { label: string; line: string }[] = [
  {
    label: "Study",
    line: "An ordered, finishable path through every skill your event is graded on.",
  },
  {
    label: "Flashcards",
    line: "The full term library, with the ones you keep scoring low on marked for you.",
  },
  {
    label: "Mastery Blitz",
    line: "Five terms, 45 seconds each — recall under the same pressure a judge applies.",
  },
  {
    label: "Tips & FAQ",
    line: "The four-beat method that structures a scoring answer, and how this sits with competition rules.",
  },
];

function FeatureSummaryCard() {
  return (
    <Card>
      <Eyebrow>There's more than the role-play</Eyebrow>
      <h2 className="mt-2 font-display text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Four more ways to move your score
      </h2>
      <ul className="mt-4 space-y-3">
        {FEATURE_SUMMARY.map((f) => (
          <li key={f.label} className="flex gap-3">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" aria-hidden />
            <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
              <strong className="font-semibold text-slate-900 dark:text-slate-100">{f.label}</strong>
              {" — "}
              {f.line}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        You'll see a dot in the nav next to the ones you haven't opened yet.
      </p>
    </Card>
  );
}

function FeatureTourCard(props: { title: string; body: string; points: string[] }) {
  return (
    <Card>
      <h2 className="font-display text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        {props.title}
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {props.body}
      </p>
      <ul className="mt-4 space-y-2">
        {props.points.map((p) => (
          <li key={p} className="flex gap-2 text-sm text-slate-700 dark:text-slate-200">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" aria-hidden />
            <span className="leading-relaxed">{p}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The tour on its own, for reviewing it without creating an account.
 *
 * Reachable at /tour (or ?tour / #tour) in the same way /demo is. main.tsx skips
 * analytics init entirely on this route, so walking the preview cannot fire tour
 * events into PostHog or pollute the funnel with a fake signup. It also touches no
 * localStorage: nothing here marks the tour done or any surface visited.
 */
export function TourPreview() {
  const params = new URLSearchParams(window.location.search);
  const [open, setOpen] = useState(!params.has("intros"));
  // ?step=N jumps straight to a step, so a specific beat can be reviewed or linked
  // without clicking through the whole thing.
  const initialStep = Number(params.get("step") || "0");
  return open ? (
    <ProductTour
      initialStep={Number.isFinite(initialStep) ? initialStep : 0}
      onSkip={() => setOpen(false)}
      onStartRep={() => setOpen(false)}
    />
  ) : (
    <IntroPreview onReplay={() => setOpen(true)} />
  );
}

/**
 * The other half of onboarding: the one-time card that greets a student the first
 * time they open each surface, and the nav dots that point them there.
 *
 * These normally only appear for a signed-in account on a genuine first visit, so
 * this is the only way to review the copy without making an account and burning
 * the real first-visit state.
 */
function IntroPreview(props: { onReplay: () => void }) {
  const [dismissed, setDismissed] = useState<Surface[]>([]);
  const order: Surface[] = ["course", "flashcards", "blitz", "tips", "faq", "home"];
  const label: Record<Surface, string> = {
    course: "Study",
    flashcards: "Flashcards",
    blitz: "Mastery Blitz",
    tips: "Tips",
    faq: "FAQ",
    home: "Home",
  };

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <Eyebrow>Onboarding preview</Eyebrow>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        First-visit cards
      </h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Each of these appears once, at the top of its page, the first time a signed-in student
        opens it. Dismissing one clears that page's nav dot for good. Nothing here writes to
        storage — dismissing below only affects this preview.
      </p>

      {/* The nav as a new account sees it: a dot on everything unopened. */}
      <div className="mt-6 flex flex-wrap items-center gap-5 rounded-xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Home</span>
        {(["course", "flashcards", "tips", "faq"] as Surface[]).map((s) => (
          <span key={s} className="text-sm font-medium text-slate-600 dark:text-slate-300">
            {label[s]}
            {!dismissed.includes(s) && <NavDot />}
          </span>
        ))}
      </div>

      <div className="mt-6 space-y-5">
        {order.map((s) => (
          <div key={s}>
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">
              {label[s]}
              {dismissed.includes(s) && " · dismissed"}
            </p>
            {dismissed.includes(s) ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                Card gone, dot cleared. This is what the page looks like from now on.
              </p>
            ) : (
              <FeatureIntro
                title={FEATURE_INTROS[s].title}
                body={FEATURE_INTROS[s].body}
                onDismiss={() => setDismissed((d) => [...d, s])}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <button className={BTN_PRIMARY} onClick={props.onReplay}>
          Replay the tour
        </button>
        {dismissed.length > 0 && (
          <button className={BTN_SECONDARY} onClick={() => setDismissed([])}>
            Reset cards
          </button>
        )}
      </div>
    </div>
  );
}

// --- brand / shell ---------------------------------------------------------

function SiteHeader({ view, onView, onPractice, onHome, onFlashcards, theme, onToggleTheme, onFeedback, authReady, userEmail, onLogin, onSignup, onSignOut, unvisited, onReplayTour }: {
  view: View;
  onView: (v: View) => void;
  onPractice: () => void;
  onHome: () => void;
  onFlashcards: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onFeedback: () => void;
  authReady?: boolean;
  userEmail?: string | null;
  onLogin?: () => void;
  onSignup?: () => void;
  onSignOut?: () => void;
  // Marks nav items this account hasn't opened yet. Absent (signed out) = no dots.
  unvisited?: (s: Surface) => boolean;
  onReplayTour?: () => void;
}) {
  // A dot only when we have a visited-tracker AND the surface is still unseen.
  const dot = (s: Surface) => (unvisited?.(s) ? <NavDot /> : null);
  // Below `md` the full nav can't fit a phone's width without overflowing (the
  // horizontal-scroll "bar"), so it collapses into a disclosure menu. The theme
  // toggle stays inline — it's a one-tap affordance students use constantly.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  // Any menu choice both runs the action and closes the sheet.
  const pick = (fn?: () => void) => () => { setMenuOpen(false); fn?.(); };

  return (
    <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-md dark:bg-slate-950/60">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-3.5">
        <button onClick={() => onView("home")} className="flex min-w-0 items-center gap-2.5 text-left">
          <BrandMark />
          <div className="min-w-0 leading-none">
            <div className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">PI Coach</div>
            <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">DECA role-play practice</div>
          </div>
        </button>

        {/* Desktop nav (md+): the full inline row. */}
        <nav className="hidden items-center gap-4 md:flex md:gap-5">
          {userEmail ? (
            <NavLink active={view === "home"} onClick={onHome}>Home</NavLink>
          ) : (
            <NavLink active={view === "practice"} onClick={onPractice}>Practice</NavLink>
          )}
          {/* Study is open to everyone: browsing your event's path is the whole
              pitch for making an account, so gating it behind one is backwards. */}
          <NavLink active={view === "course"} onClick={() => onView("course")}>Study{dot("course")}</NavLink>
          {userEmail && <NavLink active={view === "flashcards"} onClick={onFlashcards}>Flashcards{dot("flashcards")}</NavLink>}
          <NavLink active={view === "tips"} onClick={() => onView("tips")}>Tips{dot("tips")}</NavLink>
          <NavLink active={view === "faq"} onClick={() => onView("faq")}>FAQ{dot("faq")}</NavLink>
          <button
            onClick={onFeedback}
            aria-label="Send feedback"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-800"
          >
            <span className="text-sm leading-none">💬</span>
            <span>Feedback</span>
          </button>
          {authReady && (userEmail ? (
            <AccountMenu email={userEmail} onSignOut={onSignOut} onReplayTour={onReplayTour} />
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={onLogin}
                className="text-sm font-medium text-slate-600 transition hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
              >
                Log in
              </button>
              <button
                onClick={onSignup}
                className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
              >
                Sign up
              </button>
            </div>
          ))}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </nav>

        {/* Mobile cluster (< md): theme toggle + hamburger. */}
        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      <div className="h-px bg-gradient-to-r from-transparent via-indigo-400/50 to-transparent" />

      {/* Mobile disclosure sheet. Full-width stacked items with 44px+ hit areas. */}
      {menuOpen && (
        <nav className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-950 md:hidden">
          <div className="mx-auto flex max-w-5xl flex-col gap-1">
            {userEmail ? (
              <MobileNavItem active={view === "home"} onClick={pick(onHome)}>Home</MobileNavItem>
            ) : (
              <MobileNavItem active={view === "practice"} onClick={pick(onPractice)}>Practice</MobileNavItem>
            )}
            <MobileNavItem active={view === "course"} onClick={pick(() => onView("course"))}>Study{dot("course")}</MobileNavItem>
            {userEmail && <MobileNavItem active={view === "flashcards"} onClick={pick(onFlashcards)}>Flashcards{dot("flashcards")}</MobileNavItem>}
            <MobileNavItem active={view === "tips"} onClick={pick(() => onView("tips"))}>Tips{dot("tips")}</MobileNavItem>
            <MobileNavItem active={view === "faq"} onClick={pick(() => onView("faq"))}>FAQ{dot("faq")}</MobileNavItem>
            <MobileNavItem active={false} onClick={pick(onFeedback)}>💬 Feedback</MobileNavItem>
            {authReady && (userEmail ? (
              <>
                {onReplayTour && (
                  <MobileNavItem active={false} onClick={pick(onReplayTour)}>Replay the tour</MobileNavItem>
                )}
                <div className={`mt-1 truncate px-3 pt-2 text-xs text-slate-500 dark:text-slate-400 ${PH_MASK}`}>{userEmail}</div>
                <MobileNavItem active={false} onClick={pick(onSignOut)}>Sign out</MobileNavItem>
              </>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <button
                  onClick={pick(onLogin)}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Log in
                </button>
                <button
                  onClick={pick(onSignup)}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
                >
                  Sign up
                </button>
              </div>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}

// Small account control shown when signed in: the email initial, opening a menu
// with the address and a sign-out. (A "Home" entry is added once the logged-in
// home page exists.)
function AccountMenu({ email, onSignOut, onHome, onReplayTour }: { email: string; onSignOut?: () => void; onHome?: () => void; onReplayTour?: () => void }) {
  const [open, setOpen] = useState(false);
  const initial = (email[0] || "?").toUpperCase();
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account"
        className="tap inline-flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white transition hover:bg-indigo-700"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <div className={`truncate px-3 py-2 text-xs text-slate-500 dark:text-slate-400 ${PH_MASK}`}>{email}</div>
          {onHome && (
            <button
              onClick={() => { setOpen(false); onHome(); }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Home
            </button>
          )}
          {onReplayTour && (
            <button
              onClick={() => { setOpen(false); onReplayTour(); }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Replay the tour
            </button>
          )}
          <button
            onClick={() => { setOpen(false); onSignOut?.(); }}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function NavLink({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`group relative px-0.5 py-1 text-sm font-medium tracking-tight transition-colors ${
        active
          ? "text-indigo-600 dark:text-indigo-300"
          : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {children}
      <span
        className={`pointer-events-none absolute -bottom-0.5 left-0 right-0 h-0.5 origin-left rounded-full bg-indigo-500 transition-transform duration-300 ease-out dark:bg-indigo-400 ${
          active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
        }`}
      />
    </button>
  );
}

// Full-width row for the mobile disclosure menu — a comfortable 44px tap target.
function MobileNavItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center rounded-xl px-3 text-left text-sm font-medium transition ${
        active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  const dark = theme === "dark";
  return (
    <button
      onClick={onToggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="tap inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-500">{children}</p>
  );
}

const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40";

const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

// --- screens ---------------------------------------------------------------

/**
 * What's left this month, stated before the session rather than discovered
 * inside it.
 *
 * The messaging here is deliberately blunt about the future: video is beta and
 * free while it is, and paid tiers are coming. Saying that now, to someone who
 * hasn't paid us anything, is cheaper than a surprise paywall later — the whole
 * product trades on being honest about what it can and can't tell you, and that
 * has to extend to what it will and won't keep giving away.
 */
function AllowanceNotice({ usage, onSignIn }: { usage: Usage; onSignIn: () => void }) {
  const anon = usage.tier === "anonymous";
  const voice = usage.voice.limit === UNLIMITED ? "Unlimited" : `${usage.voice.remaining} left`;
  const video = usage.video.limit === UNLIMITED ? "Unlimited" : `${usage.video.remaining} left`;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="font-medium text-slate-700 dark:text-slate-200">This month</span>
        <span className="text-slate-600 dark:text-slate-300">
          Typed practice <strong className="font-semibold text-slate-800 dark:text-slate-100">Unlimited</strong>
        </span>
        <span className="text-slate-600 dark:text-slate-300">
          Voice <strong className="font-semibold text-slate-800 dark:text-slate-100">{voice}</strong>
        </span>
        <span className="text-slate-600 dark:text-slate-300">
          Video <strong className="font-semibold text-slate-800 dark:text-slate-100">{anon ? "Account needed" : video}</strong>
          <span className="ml-1.5 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Beta
          </span>
        </span>
        {usage.voice.limit !== UNLIMITED && (
          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">resets {usage.resets_on}</span>
        )}
      </div>

      <p className="mt-3 leading-relaxed text-slate-600 dark:text-slate-300">
        {anon ? (
          <>
            <button onClick={onSignIn} className="font-semibold text-indigo-700 underline dark:text-indigo-300">
              Create a free account
            </button>{" "}
            for more voice reps, video feedback, and saved progress. Typed practice stays unlimited either way.
          </>
        ) : (
          <>
            Video is a <strong className="font-semibold text-slate-800 dark:text-slate-100">beta feature</strong>, free
            while it's in beta. Paid tiers are coming — and if you're{" "}
            {usage.founder_eligible ? (
              <>using it now, you've already earned <strong className="font-semibold text-slate-800 dark:text-slate-100">{usage.founder_reward}</strong> when they launch.</>
            ) : (
              <>here before launch and complete {usage.founder_min_roleplays} role-plays, you'll get{" "}
                <strong className="font-semibold text-slate-800 dark:text-slate-100">{usage.founder_reward}</strong>.</>
            )}
          </>
        )}
      </p>
    </div>
  );
}

function PickScreen(props: {
  events: EventSummary[];
  eventId: string;
  request: string;
  practiceMode: Mode;
  level: Level;
  onEvent: (id: string) => void;
  onRequest: (v: string) => void;
  onPracticeMode: (m: Mode) => void;
  onLevel: (l: Level) => void;
  onGenerate: () => void;
  onTips: () => void;
}) {
  // Ordered, de-duplicated cluster names (events arrive grouped by cluster).
  const clusters = useMemo(
    () => [...new Set(props.events.map((e) => e.cluster))],
    [props.events],
  );
  const selected = props.events.find((e) => e.id === props.eventId) || null;
  const suggestions = selected?.suggestions ?? [];

  return (
    <div className="space-y-6">
      <section className="pt-4">
        <Eyebrow>Set up your role-play</Eyebrow>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-[1.1] tracking-tight text-slate-900 dark:text-slate-100 sm:text-4xl">
          Build your role-play
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
          Pick your event and we'll write an original scenario built around it, then prep against a real
          timer, present out loud, and get honest, per-criterion feedback.
        </p>
        <button
          onClick={props.onTips}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          New to DECA role-plays? Read the competition tips →
        </button>
      </section>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 dark:border-slate-800 px-6 py-4">
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Set up a role-play</h2>
        </div>
        <div className="space-y-5 px-6 py-5">
          <Field label="Which event are you practicing for?">
            <div className="relative">
              <select
                className={SELECT_CLS}
                value={props.eventId}
                onChange={(e) => props.onEvent(e.target.value)}
              >
                <option value="">Choose your event…</option>
                {clusters.map((cluster) => (
                  <optgroup key={cluster} label={cluster}>
                    {props.events
                      .filter((e) => e.cluster === cluster)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">▾</span>
            </div>
            {selected ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="mr-1.5 inline-block rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
                  {selected.kind}
                </span>
                {selected.quantitative && (
                  <span className="mr-1.5 inline-block rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
                    🧮 math-checked
                  </span>
                )}
                {selected.blurb}
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {props.events.length ? "Grouped by cluster. Pick the one you compete in." : "Loading events…"}
              </p>
            )}
          </Field>

          <Field label="Anything specific you want to focus on? (optional)">
            <textarea
              className={`h-20 ${TEXTAREA_CLS}`}
              placeholder={
                selected
                  ? `e.g. "${suggestions[0] ?? "a challenge you want to practice"}", or leave blank for a surprise scenario`
                  : "Pick your event above first"
              }
              value={props.request}
              onChange={(e) => props.onRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) props.onGenerate();
              }}
              maxLength={400}
              disabled={!selected}
            />
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {suggestions.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => props.onRequest(ex)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-indigo-800"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Leave it blank and we'll write a realistic scenario for your event. Add a focus to steer it.
            </p>
          </Field>

          <Field label="Mode">
            <Segmented
              value={props.practiceMode}
              onChange={(v) => props.onPracticeMode(v as Mode)}
              options={[
                { value: "competition", label: "Competition" },
                { value: "learn", label: "Learn" },
              ]}
            />
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {props.practiceMode === "competition"
                ? "Like the real room: you see the skill names being assessed, but not the answer key."
                : "Teaches as you go: see each skill, what “good” looks like, and coaching in your feedback."}
            </p>
          </Field>

          <Field label="Level">
            <Segmented
              value={props.level}
              onChange={(v) => props.onLevel(v as Level)}
              options={[
                { value: "district", label: "District" },
                { value: "state", label: "State" },
                { value: "icdc", label: "ICDC" },
              ]}
            />
          </Field>

          <div className="flex flex-col items-stretch gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
            <HonestyNote />
            <button
              className={`${BTN_PRIMARY} w-full whitespace-nowrap sm:w-auto`}
              onClick={props.onGenerate}
              disabled={!props.eventId}
            >
              Generate scenario →
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// A short subtitle for a scenario: the event (when it isn't already the heading),
// the industry, and the domains it exercises.
function scenarioSubtitle(s: ScenarioResponse): string {
  const parts: string[] = [];
  if (s.event && s.event !== s.topic) parts.push(s.event);
  if (s.industry) parts.push(s.industry);
  if (s.domain_focus.length) parts.push(s.domain_focus.join(" · "));
  return parts.join(": ");
}

function ProcessStrip() {
  const steps = [
    { n: "01", label: "Prep", desc: "10-min timer, notes allowed" },
    { n: "02", label: "Present", desc: "Type or speak it out loud" },
    { n: "03", label: "Feedback", desc: "Per-criterion score + fixes" },
  ];
  // A connected sequence, not three cards: numbered nodes threaded on a single
  // line (the order carries meaning, so the numbers earn their place). Horizontal
  // on desktop, a vertical thread on mobile.
  return (
    <ol className="relative grid gap-8 sm:grid-cols-3 sm:gap-6">
      {/* The connector spans only between the first and last node centers (each
          node is centered in its column on sm+), so the line terminates on the
          nodes instead of trailing past the last one. */}
      <div
        aria-hidden
        className="absolute left-[16.667%] right-[16.667%] top-5 hidden h-px bg-slate-200 dark:bg-slate-700 sm:block"
      />
      {steps.map((s) => (
        <li key={s.n} className="relative flex flex-col sm:items-center sm:text-center">
          <div className="flex items-center gap-3 sm:flex-col sm:gap-4">
            <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white font-mono text-sm font-semibold text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-400">
              {s.n}
            </span>
            <span className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{s.label}</span>
          </div>
          <p className="mt-2 max-w-[15rem] text-sm leading-relaxed text-slate-600 dark:text-slate-300 sm:mx-auto">{s.desc}</p>
        </li>
      ))}
    </ol>
  );
}

// --- landing page (/, view="home") -----------------------------------------
// A scroll-based marketing page. A cold visitor lands here — hero, how it works,
// what the feedback looks like, then an email capture — and is one click away from
// the setup form (onStart → view="practice").

// --- landing nudge ---------------------------------------------------------
// A corner toast offered once per session to a visitor who has been reading the
// landing page a while without starting anything.
const NUDGE_KEY = "pic-landing-nudge";
const NUDGE_DELAY_MS = 30000;

function nudgeSpent(): boolean {
  try {
    return sessionStorage.getItem(NUDGE_KEY) === "1";
  } catch {
    return false; // private mode — the nudge just isn't sticky across reloads
  }
}

function spendNudge(): void {
  try {
    sessionStorage.setItem(NUDGE_KEY, "1");
  } catch {
    /* private mode — worst case it can offer itself again after a reload */
  }
}

// Called from App, never from LandingPage: LandingPage unmounts on every nav
// away (home → tips → home), which would take its timer with it and re-arm the
// nudge each time they came back. App never unmounts, so one timeout covers the
// whole visit. sessionStorage carries the "already offered" flag across a
// reload — and only a reload, which is the intent: a new tab is a new visit.
function useLandingNudge() {
  const [open, setOpen] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    if (nudgeSpent()) return;
    const t = window.setTimeout(() => {
      if (nudgeSpent()) return; // they started a rep while we were waiting
      spendNudge(); // burn it the moment it's offered, seen or not
      setOpen(true);
    }, NUDGE_DELAY_MS);
    // StrictMode runs this twice in dev; the cleanup clears the first timeout,
    // so exactly one timer is ever pending.
    return () => window.clearTimeout(t);
  }, []);

  return {
    open,
    // Fired from the toast's own mount rather than from the timer, so the event
    // means "they saw it" and not "it became eligible" — the 30s can elapse
    // while they're off on /tips, where the toast doesn't render. One-shot:
    // navigating away and back remounts the toast, which is not a second view.
    markShown: () => {
      if (shownRef.current) return;
      shownRef.current = true;
      track("rep_nudge_shown");
    },
    dismiss: () => setOpen(false),
    // Starting a rep retires the nudge for the session and hides it if it's
    // already up. Storage is the cancel channel: a pending timer re-reads the
    // flag when it fires, so this also cancels a nudge that hasn't landed yet.
    consume: () => {
      spendNudge();
      setOpen(false);
    },
  };
}

// Non-blocking by construction: fixed to a corner, no backdrop, no focus trap,
// and `role="status"` rather than a dialog so it's announced without stealing
// focus. z-40 sits above the sticky header (z-20) and the video gaze anchor
// (z-30) but below modals (z-50), so it can never cover the auth dialog.
function RepNudge({ onStart, onDismiss, onShown }: { onStart: () => void; onDismiss: () => void; onShown: () => void }) {
  useEffect(() => {
    onShown();
    // Mount-only: onShown is idempotent, and re-running on identity changes
    // would count re-renders as impressions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      role="status"
      className="fixed right-4 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-lg dark:border-slate-800 dark:bg-slate-900"
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      >
        ✕
      </button>
      <p className="pr-6 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
        See what it catches — get an honest score on one 2-minute rep.
      </p>
      <button onClick={onStart} className={`${BTN_PRIMARY} mt-3 w-full`}>
        Try it (2 min)
      </button>
    </div>
  );
}


function LandingPage({ onStart, onQuickRep, onTips, supabaseEnabled, onSignIn, onSignup }: { onStart: () => void; onQuickRep: () => void; onTips: () => void; supabaseEnabled?: boolean; onSignIn?: () => void; onSignup?: () => void }) {
  return (
    <div className="pb-10">
      <HeroSection onStart={onStart} onQuickRep={onQuickRep} onTips={onTips} />
      {/* Rhythm varies around an 8rem base (6 → 8 → 10 → 8rem) so the page feels
          paced by hand rather than stamped on a uniform grid. */}
      <div className="mt-24 sm:mt-32">
        <HowItWorksSection />
      </div>
      <div className="mt-28 sm:mt-40">
        <FeedbackExplainerSection />
      </div>
      <div className="mt-24 sm:mt-32">
        {supabaseEnabled && onSignup ? (
          <SignupCTA onSignup={onSignup} onStart={onStart} onSignIn={onSignIn} />
        ) : (
          <WaitlistCTA onStart={onStart} />
        )}
      </div>
    </div>
  );
}

// Bottom-of-landing conversion: sign up to start tracking progress (replaces the
// email waitlist once accounts are live).
function SignupCTA({ onSignup, onStart, onSignIn }: { onSignup: () => void; onStart: () => void; onSignIn?: () => void }) {
  return (
    <section className="overflow-hidden rounded-3xl border border-indigo-100 bg-indigo-50/70 px-6 py-12 dark:border-indigo-900/50 dark:bg-indigo-950/30 sm:px-10 sm:py-14">
      <div className="max-w-xl">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-balance text-slate-900 dark:text-slate-100 sm:text-4xl">
          Keep every rep — and watch yourself get ready.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-slate-300">
          A free account saves your sessions and shows how your delivery and your weakest skills improve over time.
          You can keep practicing without one — signing up just remembers your reps.
        </p>
        <div className="mt-7 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <button onClick={onSignup} className={`${BTN_PRIMARY} px-6 py-3 text-base`}>
            Sign up free →
          </button>
          <button onClick={onStart} className="text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300">
            or just start practicing →
          </button>
        </div>
        {onSignIn && (
          <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
            Already have an account?{" "}
            <button onClick={onSignIn} className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
              Log in
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

// No eyebrow: a section heading carries itself. Kickers are rationed to one
// deliberate spot (the hero), so H2s here lead with the headline.
function SectionHeading({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="font-display text-3xl font-semibold tracking-tight text-balance text-slate-900 dark:text-slate-100 sm:text-4xl">
        {title}
      </h2>
      {blurb && <p className="mt-4 text-base leading-relaxed text-pretty text-slate-600 dark:text-slate-300">{blurb}</p>}
    </div>
  );
}

// A branded first-frame fallback shown before the loop plays (or if it can't).
// Matches the clip's native 1920×1080 so there's no letterboxing on load.
const HERO_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1920 1080'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23e0e7ff'/%3E%3Cstop offset='1' stop-color='%23ede9fe'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='1920' height='1080' fill='url(%23g)'/%3E%3Ctext x='960' y='520' font-family='system-ui,sans-serif' font-size='64' font-weight='600' fill='%234f46e5' text-anchor='middle'%3EPI Coach demo%3C/text%3E%3Ctext x='960' y='600' font-family='system-ui,sans-serif' font-size='38' fill='%236366f1' text-anchor='middle'%3Ea scenario, presented, and graded%3C/text%3E%3C/svg%3E";

// One-shot IntersectionObserver for scroll-depth markers. Fires `onFire` at most
// once and then disconnects: these are funnel milestones, not live state, so
// there's nothing to keep watching afterwards.
//
// `when: "scrolled-past"` is a LEAVE event, and `!isIntersecting` alone can't
// express it — that's equally true of an element below the fold that was never
// reached. Two conditions disambiguate: the element must have exited off the TOP
// (`boundingClientRect.bottom <= rootBounds.top`), and we must have seen it
// intersect at least once. A visitor who never scrolls fires nothing at all,
// which is the honest answer — so never use such an event as a denominator.
type InViewOpts = {
  threshold?: number;
  /** Shrinks the viewport, e.g. "-15% 0px" to require the element to come well in. */
  rootMargin?: string;
  when?: "enters" | "scrolled-past";
};

function useInView(
  ref: RefObject<Element | null>,
  onFire: () => void,
  { threshold = 0, rootMargin, when = "enters" }: InViewOpts = {},
) {
  // Call sites pass inline arrows, so `onFire` is a new identity every render.
  // Holding it in a ref keeps the observer's deps stable — otherwise it would be
  // torn down and rebuilt on every render of the page.
  const cb = useRef(onFire);
  cb.current = onFire;
  const firedRef = useRef(false); // one-shot, and StrictMode's remount re-observes
  const seenRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    // No polyfill: these markers are optional, so an unsupported browser simply
    // doesn't report rather than breaking the page.
    if (!el || typeof IntersectionObserver === "undefined") return;

    const fire = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      io.disconnect();
      cb.current();
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            seenRef.current = true;
            if (when === "enters") fire();
          } else if (
            when === "scrolled-past" &&
            seenRef.current &&
            // rootBounds is null in a few older engines; the root here IS the
            // viewport, whose top is 0.
            e.boundingClientRect.bottom <= (e.rootBounds?.top ?? 0)
          ) {
            fire();
          }
        }
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold, rootMargin, when]);
}

function HeroSection({ onStart, onQuickRep, onTips }: { onStart: () => void; onQuickRep: () => void; onTips: () => void }) {
  // Honor prefers-reduced-motion like the rest of the app: don't autoplay the
  // looping demo; show the poster and expose native controls so a reduced-motion
  // viewer can still choose to play it.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  // Scroll-depth marker. Fires on the LEAVE, not the enter: the hero is on
  // screen at load, so an enter event would just be a second pageview.
  const heroRef = useRef<HTMLElement>(null);
  useInView(heroRef, () => track("hero_scrolled_past"), { when: "scrolled-past" });
  return (
    // Asymmetric, left-aligned composition: a narrower copy column (5/12) paired
    // with a wider media column (7/12), and the two are deliberately staggered on
    // the vertical axis — copy nudged down, media held at the top — so the hero
    // reads as hand-placed rather than centered on a symmetric grid.
    <section ref={heroRef} className="grid items-start gap-12 pt-2 lg:grid-cols-12 lg:gap-10">
      <div className="lg:col-span-5 lg:pt-10">
        <Eyebrow>DECA role-play practice</Eyebrow>
        <h1 className="mt-4 font-display text-4xl font-semibold leading-[1.06] tracking-tight text-balance text-slate-900 dark:text-slate-100 sm:text-5xl">
          Practice DECA role-plays out loud, then{" "}
          {/* Emphasis by a real mark, not a gradient fill: a concise straight
              underline with a thinner, lighter second rule beneath it. Painted as
              two stacked linear-gradient layers so both follow the phrase onto a
              second line (box-decoration-break: clone) instead of detaching when
              the text wraps. */}
          <span
            className="text-indigo-600 dark:text-indigo-400"
            style={{
              WebkitBoxDecorationBreak: "clone",
              boxDecorationBreak: "clone",
              backgroundImage:
                "linear-gradient(#6366f1, #6366f1), linear-gradient(#a5b4fc, #a5b4fc)",
              backgroundRepeat: "no-repeat, no-repeat",
              backgroundPosition: "left 100%, left calc(100% - 3px)",
              backgroundSize: "100% 2px, 100% 1px",
              paddingBottom: "0.1em",
            }}
          >
            see exactly where you stand
          </span>
          .
        </h1>
        <p className="mt-5 font-display text-lg font-medium text-slate-500 dark:text-slate-400">
          Rehearse the room before you're in it.
        </p>
        <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600 dark:text-slate-300">
          Pick your event, get an original scenario built around it, prep against a real timer,
          present out loud, and get honest, per-criterion feedback on content and delivery.
        </p>
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <button onClick={onStart} className={`${BTN_PRIMARY} px-6 py-3 text-base`}>
            Ready to practice? →
          </button>
          <button onClick={onQuickRep} className={`${BTN_SECONDARY} px-6 py-3 text-base`}>
            Try a 2-minute rep →
          </button>
        </div>
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          No account needed — your first {FREE_ROLEPLAYS} role-plays are free.{" "}
          <button
            onClick={onTips}
            className="font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            New to DECA role-plays? →
          </button>
        </p>
      </div>

      {/* Native 16:9 mockup, no letterbox, so object-cover fills with no crop.
          Kept under ~960px CSS so at 2x DPR it downscales from the 1920px source. */}
      <div className="lg:col-span-7">
        <div
          className="relative w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-[0_20px_45px_-15px_rgba(79,70,229,0.35)] dark:border-slate-800"
          style={{ aspectRatio: "16 / 9" }}
        >
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src="/demo-loop.mp4"
            poster={HERO_POSTER}
            autoPlay={!reduceMotion}
            controls={reduceMotion}
            loop
            muted
            playsInline
            preload="metadata"
            aria-label="A short, silent demo of PI Coach: an original role-play scenario and its graded feedback"
          />
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  return (
    <section>
      <SectionHeading
        title="Three steps, start to score"
        blurb="The same shape as the real event: prep against the clock, present it live, then read exactly where you stood."
      />
      <div className="mt-10 sm:mt-12">
        <ProcessStrip />
      </div>
    </section>
  );
}

type FbSection = "pi" | "analysis" | "present";

// The internal keys are abbreviations; these are what the funnel reports. Kept
// separate from `feedback_section_viewed`, which still sends the raw key, so the
// pre-existing event's history stays continuous.
const FB_BAND_LABEL: Record<FbSection, string> = {
  pi: "indicators",
  analysis: "analytical",
  present: "presentation",
};

function FeedbackExplainerSection() {
  const [active, setActive] = useState<FbSection>("pi");
  const blocks: { key: FbSection; weight: number; short: string; title: string; body: string; looksFor: string }[] = [
    {
      key: "pi",
      weight: 60,
      short: "Performance Indicators",
      title: "Performance Indicators",
      body: "The specific business skills the event lists. For each one we judge whether you actually demonstrated it or only name-dropped it, then score it Novice to Exemplary and highlight the exact phrase in your transcript that earned the credit.",
      looksFor: "using customer data to drive loyalty, not just saying “good service”",
    },
    {
      key: "analysis",
      weight: 25,
      short: "Analytical",
      title: "Analytical & Problem-Solving",
      body: "How you think, not just what you cite. We look at how sharply you framed the real problem, whether your solution is specific and realistic, and whether you de-risked it instead of hand-waving.",
      looksFor: "a clear target audience, a sound plan, a pilot before a full rollout",
    },
    {
      key: "present",
      weight: 15,
      short: "Presentation",
      title: "Professional Presentation",
      body: "How it lands as a presentation. When you speak, we measure objective delivery signals against the clock. We never judge tone, confidence, or charisma.",
      looksFor: "structure, pace, filler words, and using your time well",
    },
  ];
  const activeBlock = blocks.find((b) => b.key === active)!;
  // The landing page's mid-funnel milestone: this block renders the app's real
  // graded feedback rather than a mockup, so reaching it is the strongest signal
  // short of starting a rep.
  //
  // rootMargin rather than a ratio threshold, deliberately. This section embeds a
  // full CriteriaTab and can be taller than a phone viewport, at which point
  // `intersectionRatio` can never reach a threshold like 0.25 and the event would
  // silently never fire — a bug invisible on desktop and universal on mobile.
  const showcaseRef = useRef<HTMLElement>(null);
  useInView(showcaseRef, () => track("feedback_showcase_reached"), { rootMargin: "-15% 0px" });
  return (
    <section ref={showcaseRef}>
      <SectionHeading
        title="Graded on the same weighted rubric a judge uses"
        blurb="Most tools hand you a vibe. PI Coach splits your score into the three things that actually decide a role-play — weighted exactly like the real sheet — and shows its work on each. Tap a band to see the feedback it produces."
      />

      {/* The weighting IS the story, so the control shows the proportion: one bar
          split 60 / 25 / 15 that doubles as the selector. No repeated card grid —
          the segment widths carry the data. */}
      <div
        className="mt-8 flex h-16 w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800"
        role="group"
        aria-label="Rubric weighting — pick a band to see its feedback"
      >
        {blocks.map((b, i) => {
          const on = b.key === active;
          return (
            <button
              key={b.key}
              aria-pressed={on}
              onClick={() => {
                setActive(b.key);
                track("feedback_section_viewed", { section: b.key });
                track("feedback_band_tapped", { band: FB_BAND_LABEL[b.key] });
              }}
              style={{ flexBasis: `${b.weight}%` }}
              className={`flex min-w-[4.5rem] flex-col items-start justify-center gap-0.5 px-3 text-left transition sm:min-w-0 sm:px-5 ${
                i > 0 ? "border-l border-slate-200 dark:border-slate-800" : ""
              } ${
                on
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              <span className="font-mono text-lg font-bold leading-none sm:text-2xl">{b.weight}%</span>
              <span className={`w-full truncate text-[11px] font-medium sm:text-xs ${on ? "text-indigo-100" : "text-slate-500 dark:text-slate-400"}`}>
                {b.short}
              </span>
            </button>
          );
        })}
      </div>

      {/* Detail for the selected band. */}
      <div className="mt-6 max-w-2xl">
        <h3 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">{activeBlock.title}</h3>
        <p className="mt-2 text-base leading-relaxed text-slate-600 dark:text-slate-300">{activeBlock.body}</p>
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-indigo-500">Looks for</span>
          <span>{activeBlock.looksFor}</span>
        </p>
      </div>

      {/* The revealed panel renders the app's ACTUAL feedback component for the
          selected section, fed with the sample session's real graded data, so this
          is exactly what a competitor sees after a run, not a mockup. */}
      <div className="mt-8" aria-live="polite">
        <p className="mb-3 text-sm font-medium text-slate-500 dark:text-slate-400">
          The real {activeBlock.title} feedback, from a sample session:
        </p>
        {active === "pi" && <CriteriaTab scores={DEMO_SCORE.scores} />}
        {active === "analysis" && <AnalysisTab score={DEMO_SCORE} />}
        {active === "present" && <DeliveryTab metrics={DEMO_DELIVERY} audioBlob={null} />}
      </div>

      <div className="mt-8">
        <a
          href="/demo"
          onClick={() => track("demo_opened", { from: "landing" })}
          className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-5 py-3 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-50 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/70"
        >
          See exactly what the feedback looks like →
        </a>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          A full sample session. Click through the scenario and every graded tab, no account needed.
        </p>
      </div>
    </section>
  );
}

// Email capture for an upcoming feature. Reuses the existing /api/feedback pipeline
// (page:"waitlist") so the address is logged server-side and emailed to the operator
// via Resend — no new backend. PostHog gets a `waitlist_signup` event and identifies
// the person by email so the list is exportable from the Persons view.
function WaitlistCTA({ onStart }: { onStart: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr || state === "sending") return;
    setState("sending");
    try {
      await postFeedback({ message: "Waitlist signup", email: addr, page: "waitlist" });
      identifyEmail(addr);
      track("waitlist_signup", { email: addr });
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-indigo-100 bg-indigo-50/70 px-6 py-12 dark:border-indigo-900/50 dark:bg-indigo-950/30 sm:px-10 sm:py-14">
      <div className="max-w-xl">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-balance text-slate-900 dark:text-slate-100 sm:text-4xl">
          Walk in ready.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600 dark:text-slate-300">
          Pick an event, get an original scenario, and find out exactly where you stand — no account needed.
        </p>
        <div className="mt-7">
          <button onClick={onStart} className={`${BTN_PRIMARY} px-6 py-3 text-base`}>
            Ready to practice? →
          </button>
        </div>

        {/* Secondary: launch updates, deliberately quieter than the practice CTA. */}
        <div className="mt-10 border-t border-indigo-100 pt-6 dark:border-indigo-900/50">
          {state === "done" ? (
            <p className="rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm font-medium text-indigo-800 dark:border-indigo-900/60 dark:bg-slate-900 dark:text-indigo-300">
              You're on the list. We'll email you the moment it ships.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-500 dark:text-slate-400">Want launch updates? Drop your email — no spam, just the launch.</p>
              <form onSubmit={submit} className="mt-3 flex flex-col gap-2.5 sm:max-w-md sm:flex-row">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@school.edu"
                  aria-label="Email address"
                  className="w-full flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={!email.trim() || state === "sending"}
                  className={`${BTN_SECONDARY} shrink-0 px-6 py-3`}
                >
                  {state === "sending" ? "Signing up…" : "Notify me"}
                </button>
              </form>
              {state === "error" && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">Couldn't sign you up: check your connection and try again.</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ReadyScreen(props: { scenario: ScenarioResponse; onStart: () => void }) {
  const s = props.scenario;
  const prepMin = Math.round(s.timing.prep_seconds / 60);
  const presentMin = Math.round(s.timing.present_seconds / 60);
  const targetMin = Math.round(s.timing.target_seconds / 60);
  return (
    <div className="space-y-4">
      <Card>
        <Eyebrow>Ready when you are</Eyebrow>
        <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {s.topic}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{scenarioSubtitle(s)}</p>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Your scenario is written. Take a breath: the prep clock only starts when you press the button.
        </p>
        {s.team && (
          <p className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-200">
            <strong className="font-semibold">Team event:</strong> you get more time: {prepMin} minutes to prep and {presentMin} to present.
            If you record, we'll pick up both partners' voices and show how the talking was split.
          </p>
        )}
        {s.quantitative && (
          <p className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
            <strong className="font-semibold">🧮 Numbers matter here:</strong> show your calculations. Any math you do is
            recomputed on our server, exactly, so your figures get checked, not guessed at.
          </p>
        )}

        <h3 className="mt-6 font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Before you start</h3>
        <ul className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-200">
          <Tip icon="✏️">Grab a pen and paper (or open notes). You'll outline your plan during prep.</Tip>
          <Tip icon="⏱️">
            <strong className="font-semibold">{prepMin} minutes</strong> to read and plan, then{" "}
            <strong className="font-semibold">{presentMin} to present</strong>, that window includes the judge's questions.
          </Tip>
          <Tip icon="🎯">
            Aim to wrap your pitch in about <strong className="font-semibold">{targetMin} minutes</strong>, leaving the rest for the follow-up.
          </Tip>
          <Tip icon="🗣️">Find a quiet spot and present out loud: type or use 🎙️ Speak.</Tip>
          <Tip icon="❓">
            At the end the judge asks {s.followup_questions.length === 1 ? "a follow-up question" : `${s.followup_questions.length} follow-up questions`}. You'll answer {s.followup_questions.length === 1 ? "it" : "those"} too.
          </Tip>
        </ul>

        <button className={`mt-6 ${BTN_PRIMARY}`} onClick={props.onStart}>
          I'm ready: start prep ({fmt(s.timing.prep_seconds)}) →
        </button>
      </Card>
      <RubricNote scenario={s} />
    </div>
  );
}

function Tip({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="select-none">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

function PrepScreen(props: { scenario: ScenarioResponse; onStart: () => void }) {
  const prep = props.scenario.timing.prep_seconds;
  const left = useCountdown(prep, true, props.onStart);
  return (
    <div className="space-y-4">
      <TimerBar label="Prep time" left={left} total={prep} tone="indigo" sticky />
      <CoverSheet scenario={props.scenario} />
      <SituationSheet text={props.scenario.situation} />
      <button className={BTN_PRIMARY} onClick={props.onStart}>
        I'm done prepping. I'm ready to present →
      </button>
    </div>
  );
}

// The shared presentation clock, shown on both the response and follow-up screens.
// It only counts down while `running`; before that it's paused, and if the
// participant idles too long an auto-start countdown appears.
function PresentClock({ remaining, running, total, autoCountdown }: {
  remaining: number; running: boolean; total: number; autoCountdown: number | null;
}) {
  const wrapUp = running && remaining > 0 && remaining <= 150;
  const label = !running
    ? autoCountdown !== null
      ? `Starting in ${autoCountdown}… (begin now to take control)`
      : "Clock paused. It starts the moment you begin"
    : remaining === 0
      ? "Time's up. You can still finish"
      : wrapUp
        ? "Wrap up soon: leave time for the questions"
        : "Presentation time (shared with the judge's questions)";
  const tone = !running
    ? autoCountdown !== null ? "amber" : "indigo"
    : remaining === 0 ? "red" : wrapUp ? "amber" : "slate";
  return <TimerBar label={label} left={remaining} total={total} tone={tone} sticky />;
}

// A quick breather between prep and presenting, so the participant walks in on
// their own cue instead of being dropped straight into the clock.
function WalkinScreen(props: { scenario: ScenarioResponse; onEnter: () => void }) {
  const s = props.scenario;
  return (
    <div className="space-y-4">
      <Card className="text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-indigo-50 dark:bg-indigo-950/50">
          <span className="text-3xl">🚪</span>
        </div>
        <h2 className="mt-4 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          You're up next
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Prep's done. Take a breath, gather your notes, and walk in when you're ready. The presentation clock
          <strong className="font-semibold text-slate-800 dark:text-slate-200"> won't start until you begin speaking or typing</strong>, so there's no rush to press this.
        </p>
        <div className="mx-auto mt-4 max-w-md rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-left text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
          Open with a greeting and a firm handshake energy, state who you are and your recommendation up front, then
          walk the judge through it. You've got {Math.round(s.timing.present_seconds / 60)} minutes for everything.
        </div>
        <button className={`mt-6 ${BTN_PRIMARY}`} onClick={props.onEnter}>
          Enter the room →
        </button>
      </Card>
    </div>
  );
}

function RespondScreen(props: {
  scenario: ScenarioResponse;
  remaining: number;
  running: boolean;
  autoCountdown: number | null;
  onStart: () => void;
  mode: ResponseMode;
  onMode: (m: ResponseMode) => void;
  value: string;
  onChange: (v: string) => void;
  audioBlob: Blob | null;
  onRecorded: (b: Blob | null) => void;
  // Distinct from `onStart`, which typing also triggers (see the onChange below).
  // This one fires only when the mic actually opens, which is what the
  // abandonment funnel needs to tell "froze at the record button" apart from
  // "recorded, then bailed".
  onRecordingStart?: () => void;
  // Video (beta). All optional-in-spirit: the screen is fully functional and
  // identical to before when the gate is "unsupported" or the user declines.
  videoGate: VideoGate;
  videoSampler: ReturnType<typeof useFrameSampler>;
  videoOn: boolean;
  videoRemaining: number | null;
  onEnableVideo: () => void;
  onDisableVideo: () => void;
  onSignIn: () => void;
  onContinue: () => void;
}) {
  const words = wordCount(props.value);
  const canContinue = props.mode === "type" ? !!props.value.trim() : !!props.audioBlob;
  // Starting to type or record starts the clock.
  const handleType = (v: string) => {
    if (!props.running && v.trim()) props.onStart();
    props.onChange(v);
  };
  return (
    <div className="space-y-4">
      <PresentClock remaining={props.remaining} running={props.running} total={props.scenario.timing.present_seconds} autoCountdown={props.autoCountdown} />

      <details className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">Show scenario &amp; what you're graded on</summary>
        <div className="mt-3 space-y-4">
          <SituationSheet text={props.scenario.situation} embedded />
          <CoverSheet scenario={props.scenario} embedded />
        </div>
      </details>

      <Card>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your presentation</h3>
          {CAN_RECORD && <ModeToggle mode={props.mode} onMode={props.onMode} />}
        </div>

        {props.mode === "type" ? (
          <>
            <textarea
              className={`mt-3 h-64 ${TEXTAREA_CLS}`}
              placeholder="Open with a greeting, address the situation and every skill you're assessed on, propose your solution, and close. Speak it out loud as you type. That's the rep."
              value={props.value}
              onChange={(e) => handleType(e.target.value)}
            />
            <div className="mt-2 font-mono text-xs text-slate-500 dark:text-slate-400">{words} words</div>
          </>
        ) : (
          <div className="mt-3">
            <VoiceRecorder
              audioBlob={props.audioBlob}
              onRecorded={props.onRecorded}
              onStart={props.onStart}
              onRecordingStart={props.onRecordingStart}
            />
            <div className="mt-3">
              <VideoOptIn
                gate={props.videoGate}
                sampler={props.videoSampler}
                enabled={props.videoOn}
                remaining={props.videoRemaining}
                onEnable={props.onEnableVideo}
                onDisable={props.onDisableVideo}
                onSignIn={props.onSignIn}
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Present out loud as if the judge is in front of you. We transcribe the audio and measure delivery
              pace, fillers, pauses, time: alongside the content score. Delivery covers timing only, not tone or
              confidence. Your recording stays on your device unless you keep it.
            </p>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button className={`${BTN_PRIMARY} w-full sm:w-auto`} onClick={props.onContinue} disabled={!canContinue}>
            Continue to the judge's questions →
          </button>
        </div>
      </Card>
    </div>
  );
}

function ModeToggle({ mode, onMode }: { mode: ResponseMode; onMode: (m: ResponseMode) => void }) {
  return (
    <div className="flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-0.5 text-xs font-medium">
      {(["type", "speak"] as const).map((m) => (
        <button
          key={m}
          className={`tap rounded-md px-3 py-1.5 transition ${mode === m ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300" : "text-slate-500 dark:text-slate-400"}`}
          onClick={() => onMode(m)}
        >
          {m === "type" ? "✍️ Type" : "🎙️ Speak"}
        </button>
      ))}
    </div>
  );
}

function VoiceRecorder({ audioBlob, onRecorded, onStart, onRecordingStart }: { audioBlob: Blob | null; onRecorded: (b: Blob | null) => void; onStart?: () => void; onRecordingStart?: () => void }) {
  const [state, setState] = useState<"idle" | "recording" | "recorded">(audioBlob ? "recorded" : "idle");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const previewUrl = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // iOS Safari records audio/mp4 (not webm); Chrome/Firefox prefer webm/opus.
      // Negotiate the first container the browser actually supports instead of
      // relying on the UA default, and label the blob with the SAME type the
      // recorder used (its mimeType, else our negotiated pick) so the upload's
      // extension matches the bytes.
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      const chosen = typeof MediaRecorder.isTypeSupported === "function"
        ? preferred.find((t) => MediaRecorder.isTypeSupported(t))
        : undefined;
      const mr = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || chosen || "audio/mp4" });
        onRecorded(blob);
        setState("recorded");
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      recorderRef.current = mr;
      setElapsed(0);
      setState("recording");
      onStart?.(); // starting to speak starts the presentation clock
      // Only reached once getUserMedia resolved, so a denied or failed mic
      // permission correctly does NOT count as having started recording.
      onRecordingStart?.();
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (e) {
      // Distinguish the common failures so the message is actionable on mobile.
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setErr("Microphone permission was blocked. Allow mic access for this site in your browser settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setErr("No microphone was found. Check that your device has a working mic and it isn't in use by another app.");
      } else if (typeof MediaRecorder === "undefined") {
        setErr("Recording isn't supported in this browser. Switch to Type mode, or try Safari/Chrome.");
      } else {
        setErr("We couldn't start recording. Close other apps using the mic and try again, or switch to Type mode.");
      }
    }
  }

  function stop() {
    recorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function reset() {
    onRecorded(null);
    setState("idle");
    setElapsed(0);
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 px-4 py-4">
      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
      {state === "idle" && (
        <button onClick={start} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700">
          <span className="h-2.5 w-2.5 rounded-full bg-white" /> Start recording
        </button>
      )}
      {state === "recording" && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-red-700">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Recording{" "}
            <span className="font-mono">{fmt(elapsed)}</span>
          </div>
          <button onClick={stop} className={BTN_PRIMARY}>Stop</button>
        </div>
      )}
      {state === "recorded" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">✓ Recorded: listen back below.</div>
          {previewUrl && <audio controls src={previewUrl} className="w-full" />}
          <button onClick={reset} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 font-mono text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">↺ Re-record</button>
        </div>
      )}
    </div>
  );
}

function FollowupScreen(props: {
  scenario: ScenarioResponse;
  remaining: number;
  running: boolean;
  autoCountdown: number | null;
  onStart: () => void;
  mode: ResponseMode;
  onMode: (m: ResponseMode) => void;
  value: string;
  onChange: (v: string) => void;
  audioBlob: Blob | null;
  onRecorded: (b: Blob | null) => void;
  // The camera keeps sampling through the judge's questions — they're part of
  // the same presentation window — so the indicator has to follow it here. A
  // camera that's on with nothing on screen saying so would break exactly the
  // transparency the consent screen promised. Null when video is off.
  videoSampler: ReturnType<typeof useFrameSampler> | null;
  onDisableVideo: () => void;
  onSubmit: () => void;
}) {
  const qs = props.scenario.followup_questions;
  const canSubmit = props.mode === "type" ? !!props.value.trim() : !!props.audioBlob;
  const handleType = (v: string) => {
    if (!props.running && v.trim()) props.onStart();
    props.onChange(v);
  };
  return (
    <div className="space-y-4">
      <PresentClock remaining={props.remaining} running={props.running} total={props.scenario.timing.present_seconds} autoCountdown={props.autoCountdown} />
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">The judge asks you</h2>
          {CAN_RECORD && <ModeToggle mode={props.mode} onMode={props.onMode} />}
        </div>
        <ol className="mt-3 space-y-2">
          {qs.map((q, i) => (
            <li key={i} className="flex gap-2 rounded-xl bg-indigo-50/60 px-3 py-2.5 text-sm text-slate-800 dark:bg-indigo-950/40 dark:text-slate-100">
              <span className="font-mono text-xs font-semibold text-indigo-500">Q{i + 1}</span>
              <span>{q}</span>
            </li>
          ))}
          {qs.length === 0 && <li className="text-sm text-slate-500 dark:text-slate-400">No follow-up questions for this scenario.</li>}
        </ol>

        {props.mode === "type" ? (
          <>
            <label className="mt-4 block text-sm font-medium text-slate-700 dark:text-slate-200">Your answer</label>
            <textarea
              className={`mt-2 h-40 ${TEXTAREA_CLS}`}
              placeholder="Answer the judge's questions directly. This is graded as part of your response."
              value={props.value}
              onChange={(e) => handleType(e.target.value)}
            />
            <div className="mt-2 font-mono text-xs text-slate-500 dark:text-slate-400">{wordCount(props.value)} words</div>
          </>
        ) : (
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Answer out loud</label>
            <div className="mt-2">
              <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} onStart={props.onStart} />
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              We transcribe your answer for grading. Delivery isn't scored on the follow-up: only your content.
            </p>
          </div>
        )}

        {/* The camera is still sampling through the judge's questions, whether
            they answer by voice or by typing — so this shows in both modes. */}
        {props.videoSampler && (
          <div className="mt-4">
            <VideoIndicator sampler={props.videoSampler} onDisable={props.onDisableVideo} />
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button className={`${BTN_PRIMARY} w-full sm:w-auto`} onClick={props.onSubmit} disabled={!canSubmit}>
            Submit for feedback →
          </button>
        </div>
      </Card>
    </div>
  );
}

// --- feedback --------------------------------------------------------------

// Delivery-first results (Phase 2a): shown the instant transcription lands, while
// the content score is still grading. Delivery metrics are deterministic (no model
// call), so the student reads real feedback — pace, fillers, pauses, timing — and
// can play their recording back during the wait instead of watching a spinner.
function DeliveryFirstScreen({ scenario, delivery, audioBlob }: { scenario: ScenarioResponse; delivery: DeliveryMetrics; audioBlob: Blob | null }) {
  return (
    <div className="space-y-5">
      <Card>
        <Eyebrow>Delivery: ready now</Eyebrow>
        <h2 className="mt-2 font-display text-xl font-semibold leading-snug tracking-tight text-slate-900 dark:text-slate-100">
          {scenario.topic}
        </h2>
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 dark:border-indigo-900/60 dark:bg-indigo-950/40">
          <span className="pic-spin h-4 w-4 shrink-0 rounded-full border-2 border-indigo-300 border-t-indigo-600 dark:border-indigo-800 dark:border-t-indigo-300" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">Grading your content…</p>
            <p className="text-xs leading-relaxed text-indigo-800/80 dark:text-indigo-300/80">
              Read your delivery below while we score your indicators and solution. Your full feedback drops in here in a few seconds.
            </p>
          </div>
        </div>
      </Card>
      <DeliveryTab metrics={delivery} audioBlob={audioBlob} />
    </div>
  );
}

function ScorePill({ label, value, weight }: { label: string; value: number; weight: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-2 py-1.5 dark:border-slate-800">
      <div className="font-mono text-[9px] uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-1">
        <span className="font-mono text-lg font-bold leading-none text-slate-900 dark:text-slate-100">
          {value}<span className="text-xs font-medium text-slate-400">%</span>
        </span>
        <span className="font-mono text-[9px] leading-none text-slate-500 dark:text-slate-400">{weight}</span>
      </div>
    </div>
  );
}

type FeedbackTab = "overview" | "transcript" | "delivery" | "video" | "analysis" | "criteria" | "scenario";

// How long on the score screen counts as "they've read it". Long enough that it
// can't land while they're still taking in the number, short enough to catch
// someone who reads the rail and never scrolls.
const SIGNUP_PROMPT_DWELL_MS = 20000;

// The shortest the prompt can ever wait, even when they scroll straight to the
// bottom. Without a floor, a short feedback screen on a tall monitor would have
// the sentinel already in view at mount and the modal would land on top of the
// score itself.
const SIGNUP_PROMPT_FLOOR_MS = 5000;

// Session-scoped, following the sessionStorage convention in blitz.tsx: a "maybe
// later" is an answer, and re-asking it on every rep in a sitting is how a
// prompt becomes noise. A new tab is a new session, so it can ask again then.
const SIGNUP_PROMPT_KEY = "pic-signup-prompt-dismissed";

function signupPromptDismissed(): boolean {
  try {
    return sessionStorage.getItem(SIGNUP_PROMPT_KEY) === "1";
  } catch {
    return false; // private mode — the prompt just isn't sticky across reloads
  }
}

function rememberSignupPromptDismissed(): void {
  try {
    sessionStorage.setItem(SIGNUP_PROMPT_KEY, "1");
  } catch {
    /* private mode — worst case it can ask again after a reload */
  }
}

// The one blocking moment in the product, and deliberately so: it appears only
// after a real score AND after they've read the feedback, and it gates nothing —
// everything behind it has already been seen and stays readable on dismiss.
// Escape and a backdrop click both dismiss, so it can't become a trap.
function SignupPromptModal({ onSignup, onDismiss }: { onSignup: () => void; onDismiss: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus trap + restore, matching MasteryBlitz (blitz.tsx:195-214) — the most
  // complete dialog a11y in the codebase.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); dismissRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = node.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) { e.preventDefault(); node.focus(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      onClick={onDismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signup-prompt-title"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl focus:outline-none dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="signup-prompt-title"
          className="font-display text-lg font-semibold leading-snug text-slate-900 dark:text-slate-100"
        >
          Save this and track your delivery over time — see if you're actually improving.
        </h2>
        <button className={`mt-5 w-full ${BTN_PRIMARY}`} onClick={onSignup}>
          Create free account
        </button>
        <button
          onClick={onDismiss}
          className="mt-3 w-full rounded-xl px-4 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

function FeedbackScreen(props: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followupAnswer: string;
  delivery: DeliveryMetrics | null;
  // Present only when the student opted into video for this rep. Absent is the
  // normal case, and the whole screen renders identically without it.
  video?: VideoMetrics | null;
  utterances: Utterance[];
  audioBlob: Blob | null;
  onRestart: () => void;
  onTryAgain?: () => void;
  onStudyCriteria?: (ids: string[]) => void;
  priorSnapshot?: RunSnapshot | null;
  loggedIn?: boolean;
  onSignIn?: () => void;
  // Set only when a signup prompt is actually warranted: signed out AND accounts
  // are configured. Carrying eligibility on the same prop as the source keeps the
  // screen from having to know about `authReady` at all — undefined means "don't
  // ask", which is also the right answer for the tour and the demo.
  promptSource?: "two_min_rep_score" | "roleplay_score";
  // Optional controlled tab, so the product tour can step through the tabs. Left
  // undefined everywhere else, in which case the screen owns its own tab as before.
  tab?: FeedbackTab;
}) {
  const { score } = props;
  const marks = buildMarks(score.scores);
  // The criteria worth studying: those below proficient (fall back to all).
  const weakIds = score.scores.filter((c) => c.level === "novice" || c.level === "developing").map((c) => c.criterion_id);
  const studyIds = weakIds.length > 0 ? weakIds : score.scores.map((c) => c.criterion_id);
  // The backend now returns the FINAL weighted percent (60% indicators + 25%
  // analysis + 15% presentation) directly, plus each section's own percentage.
  const pct = score.overall_percent;
  const level = score.overall_level;
  const [ownTab, setTab] = useState<FeedbackTab>("overview");
  const tab = props.tab ?? ownTab; // controlled only when the tour drives it
  const [activeMark, setActiveMark] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);

  // --- post-score signup prompt -------------------------------------------
  // Held back until they've actually read something, never shown before the
  // score. Two independent triggers, whichever comes first: reaching the bottom
  // of the feedback, or simply dwelling here long enough to have read it. The
  // scroll sentinel alone would miss anyone who reads the score rail and stops;
  // the timer alone would interrupt a fast scroller mid-scroll.
  const [promptOpen, setPromptOpen] = useState(false);
  const [reachedBottom, setReachedBottom] = useState(false);
  const promptFiredRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mountedAtRef = useRef(Date.now());
  const source = props.promptSource;

  function openPrompt() {
    if (promptFiredRef.current || !source) return;
    // A dismissal is remembered for the session: someone working through three
    // reps in a sitting has already answered this question once.
    if (signupPromptDismissed()) return;
    promptFiredRef.current = true;
    setPromptOpen(true);
    track("signup_prompt_shown", { source });
  }

  useInView(bottomRef, () => setReachedBottom(true), { rootMargin: "0px 0px -10% 0px" });

  // Reaching the end of the feedback is the strong signal and shortens the wait,
  // but it never skips the floor: on a tall viewport the bottom sentinel can
  // already be in view at mount, and the prompt must never land at the same
  // instant as the score. Measured from mount, so reaching the bottom late
  // fires immediately rather than restarting a countdown.
  useEffect(() => {
    if (!source) return;
    const target = reachedBottom ? SIGNUP_PROMPT_FLOOR_MS : SIGNUP_PROMPT_DWELL_MS;
    const t = window.setTimeout(openPrompt, Math.max(0, target - (Date.now() - mountedAtRef.current)));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, reachedBottom]);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "transcript", label: "Transcript" },
    ...(props.delivery ? [{ key: "delivery", label: "Delivery" }] : []),
    // Only when they opted into video — an empty Video tab on every voice rep
    // would read as a feature they're missing rather than one they declined.
    ...(props.video ? [{ key: "video", label: "Video", badge: "Beta" }] : []),
    { key: "analysis", label: "Analysis" },
    { key: "criteria", label: "Indicators", badge: `${score.total_points}/${score.max_points}` },
    // The situation they just answered. Feedback is unreadable without the prompt
    // in front of you, and the scenario is already in state here — no refetch.
    { key: "scenario", label: "Scenario" },
  ];

  return (
    <div className="lg:grid lg:grid-cols-[300px_1fr] lg:items-start lg:gap-6">
      {/* Score rail: sticks alongside the detail on wide screens. */}
      <div className="lg:sticky lg:top-24">
        <Card>
          <Eyebrow>Framework feedback</Eyebrow>
          <h2 className="mt-2 font-display text-xl font-semibold leading-snug tracking-tight text-slate-900 dark:text-slate-100">
            {props.scenario.topic}
          </h2>
          <div className="mt-5 flex items-end gap-1.5">
            <span className="font-mono text-5xl font-bold leading-none text-slate-900 dark:text-slate-100">{Math.round(pct)}</span>
            <span className="mb-1 font-mono text-lg font-medium text-slate-300 dark:text-slate-600">%</span>
          </div>
          <div className="mt-3"><LevelMeter level={level} /></div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <ScorePill label="Indicators" value={Math.round(score.pi_section_percent)} weight="60%" />
            <ScorePill label="Analysis" value={Math.round(score.analytical?.section_percent ?? 0)} weight="25%" />
            <ScorePill label="Present" value={Math.round(score.presentation?.section_percent ?? 0)} weight="15%" />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Weighted across {score.scores.length} performance indicators (60%), your problem-solving (25%),
            and presentation (15%){props.delivery ? ", blending your voice delivery into presentation" : ""}.
            Practice coaching, not an official competition score.
          </p>
          <button
            onClick={() => setShowCard(true)}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-950/70"
          >
            <BrandMark size={16} />
            Challenge a friend
          </button>
          <div className="mt-4 border-t border-slate-100 dark:border-slate-800 pt-3">
            <LevelLegend />
          </div>
        </Card>
      </div>

      {showCard && (
        <GauntletCardModal scenario={props.scenario} score={score} onClose={() => setShowCard(false)} />
      )}

      <div className="mt-5 space-y-5 lg:mt-0">
        {props.priorSnapshot && (
          <BeforeAfterCard before={props.priorSnapshot} after={snapshotOf(score, props.delivery)} />
        )}

        <TabBar tabs={tabs} active={tab} onChange={(k) => setTab(k as FeedbackTab)} />

        {tab === "overview" && <OverviewTab score={score} />}
        {tab === "analysis" && <AnalysisTab score={score} />}
        {tab === "transcript" && (
          <TranscriptTab
            response={props.response}
            followupAnswer={props.followupAnswer}
            marks={marks}
            scores={score.scores}
            active={activeMark}
            onSelect={setActiveMark}
            followupFeedback={score.followup_feedback}
            utterances={props.utterances}
          />
        )}
        {tab === "delivery" && props.delivery && <DeliveryTab metrics={props.delivery} audioBlob={props.audioBlob} />}
        {tab === "video" && props.video && <VideoPanel metrics={props.video} />}
        {tab === "criteria" && <CriteriaTab scores={score.scores} />}
        {tab === "scenario" && (
          <div className="space-y-4">
            <SituationSheet text={props.scenario.situation} />
            <CoverSheet scenario={props.scenario} />
          </div>
        )}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
          Your score weights <strong className="font-semibold text-slate-700 dark:text-slate-200">performance indicators</strong> (60%),
          your <strong className="font-semibold text-slate-700 dark:text-slate-200">analytical problem-solving</strong> (25%), and
          your <strong className="font-semibold text-slate-700 dark:text-slate-200">presentation</strong> (15%).{" "}
          {props.delivery ? (
            <>Presentation blends measured delivery, pace, fillers, pauses, timing, with how you handled the follow-up. It never judges tone, confidence, or charisma.</>
          ) : (
            <>Typed practice scores presentation from your written structure and follow-up. Switch to{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">🎙️ Speak</strong> to fold your voice delivery in too.</>
          )}
        </div>

        {!props.loggedIn && props.onSignIn && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-4 dark:border-indigo-900/60 dark:bg-indigo-950/40">
            <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
              Want to see if you improve next time?
            </p>
            <p className="mt-1 text-sm text-indigo-800/90 dark:text-indigo-300/90">
              Create a free account and we'll track your delivery and your weakest skills across sessions, and save this one.
            </p>
            <button className={`mt-3 ${BTN_PRIMARY}`} onClick={props.onSignIn}>
              Sign in to track my progress →
            </button>
          </div>
        )}

        <div className="flex flex-col gap-2.5 sm:flex-row">
          {props.onTryAgain && (
            <button className={`${BTN_PRIMARY} sm:flex-1`} onClick={props.onTryAgain}>
              🔁 Try this scenario again
            </button>
          )}
          <button
            className={`inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 ${props.onTryAgain ? "sm:flex-1" : "w-full"}`}
            onClick={props.onRestart}
          >
            Practice a new scenario →
          </button>
        </div>
        {props.onTryAgain && (
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">
            Re-running the same scenario is the fastest way to see your feedback pay off.
          </p>
        )}

        {props.onStudyCriteria && (
          <button
            onClick={() => props.onStudyCriteria?.(studyIds)}
            className="w-full text-center text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            📇 Study {weakIds.length > 0 ? "your weak criteria" : "these criteria"} →
          </button>
        )}

        {/* Scroll sentinel: reaching it means they read to the end of the
            feedback. Zero-height so it changes no layout. */}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {promptOpen && source && (
        <SignupPromptModal
          onSignup={() => {
            track("signup_prompt_clicked", { source });
            setPromptOpen(false);
            props.onSignIn?.();
          }}
          onDismiss={() => {
            track("signup_prompt_dismissed", { source });
            rememberSignupPromptDismissed();
            setPromptOpen(false);
          }}
        />
      )}
    </div>
  );
}

// A compact before→after when the same scenario is re-attempted. Improvement here
// is directly attributable (same scenario), so this is the most convincing signal.
function BeforeAfterCard({ before, after }: { before: RunSnapshot; after: RunSnapshot }) {
  const delta = after.percent - before.percent;
  const deltaTone = delta > 0 ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400";
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/40">
      <div className="flex items-center justify-between">
        <Eyebrow>Same scenario, before → after</Eyebrow>
        <span className={`font-mono text-sm font-semibold ${deltaTone}`}>
          {delta > 0 ? `+${delta}` : delta} pts
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <BeforeAfterStat label="Score" before={`${before.percent}%`} after={`${after.percent}%`} improved={after.percent >= before.percent} />
        <BeforeAfterStat
          label="Criteria hit"
          before={`${before.criteriaHit}/${before.criteriaTotal}`}
          after={`${after.criteriaHit}/${after.criteriaTotal}`}
          improved={after.criteriaHit >= before.criteriaHit}
        />
        <BeforeAfterStat
          label="Fillers/min"
          before={before.fillerPerMin != null ? before.fillerPerMin.toFixed(1) : ": "}
          after={after.fillerPerMin != null ? after.fillerPerMin.toFixed(1) : ": "}
          improved={after.fillerPerMin != null && before.fillerPerMin != null ? after.fillerPerMin <= before.fillerPerMin : true}
        />
        <BeforeAfterStat
          label="Pace (WPM)"
          before={before.wpm != null ? String(before.wpm) : ": "}
          after={after.wpm != null ? String(after.wpm) : ": "}
          improved
        />
      </div>
    </div>
  );
}

function BeforeAfterStat({ label, before, after, improved }: { label: string; before: string; after: string; improved: boolean }) {
  return (
    <div className="rounded-lg bg-white/70 px-3 py-2 dark:bg-slate-900/50">
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 text-sm">
        <span className="text-slate-400 line-through dark:text-slate-500">{before}</span>
        <span className="text-slate-300 dark:text-slate-600">→</span>
        <span className={`font-semibold ${improved ? "text-emerald-600 dark:text-emerald-400" : "text-slate-700 dark:text-slate-200"}`}>{after}</span>
      </div>
    </div>
  );
}

// Group criterion scores by our business domain, preserving first-seen order.
function groupByDomain(scores: CriterionScore[]): { domain: string; rows: CriterionScore[] }[] {
  const order: string[] = [];
  const by: Record<string, CriterionScore[]> = {};
  for (const s of scores) {
    const d = s.domain || "Other";
    if (!by[d]) {
      by[d] = [];
      order.push(d);
    }
    by[d].push(s);
  }
  return order.map((d) => ({ domain: d, rows: by[d] }));
}

function TabBar(props: {
  tabs: { key: string; label: string; badge?: string }[];
  active: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 pb-1">
      {props.tabs.map((t) => {
        const on = t.key === props.active;
        return (
          <button
            key={t.key}
            onClick={() => props.onChange(t.key)}
            className={`tap flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition ${
              on ? "border-indigo-600 bg-indigo-600 text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {t.label}
            {t.badge && (
              <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${on ? "bg-white/20 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"}`}>
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function OverviewTab({ score }: { score: ScoreResponse }) {
  const final = score.final;
  return (
    <div className="space-y-4">
      {score.math_checks.length > 0 && <MathChecksCard checks={score.math_checks} />}
      {score.summary && (
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Summary</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{score.summary}</p>
        </Card>
      )}
      {final && (final.top_strength || final.biggest_weakness || final.one_key_fix) && (
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">The one-look read</h3>
          <dl className="mt-3 space-y-2.5 text-sm">
            {final.top_strength && (
              <div className="flex gap-2.5">
                <dt className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Strength</dt>
                <dd className="text-slate-700 dark:text-slate-200">{final.top_strength}</dd>
              </div>
            )}
            {final.biggest_weakness && (
              <div className="flex gap-2.5">
                <dt className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Weakness</dt>
                <dd className="text-slate-700 dark:text-slate-200">{final.biggest_weakness}</dd>
              </div>
            )}
            {final.one_key_fix && (
              <div className="flex gap-2.5">
                <dt className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Key fix</dt>
                <dd className="text-slate-700 dark:text-slate-200">{final.one_key_fix}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}
      {(score.strengths.length > 0 || score.improvements.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {score.strengths.length > 0 && (
            <Card className="border-emerald-200 dark:border-emerald-900/60">
              <h3 className="font-display text-sm font-semibold text-emerald-800 dark:text-emerald-400">Strengths</h3>
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
                {score.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2"><span className="text-emerald-500">✓</span>{s}</li>
                ))}
              </ul>
            </Card>
          )}
          {score.improvements.length > 0 && (
            <Card className="border-amber-200 dark:border-amber-900/60">
              <h3 className="font-display text-sm font-semibold text-amber-800 dark:text-amber-400">Focus next time</h3>
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
                {score.improvements.map((s, i) => (
                  <li key={i} className="flex gap-2"><span className="text-amber-500">→</span>{s}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// A compact 1-4 pip meter for the analytical sub-scores.
function ScaleMeter({ score, max = 4 }: { score: number; max?: number }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 w-5 rounded-full ${i < score ? "bg-indigo-500" : "bg-slate-200 dark:bg-slate-700"}`}
          />
        ))}
      </div>
      <span className="font-mono text-[11px] font-medium text-slate-500 dark:text-slate-400">{fmtNum(score)}/{max}</span>
    </div>
  );
}

function AnalysisRow(props: { label: string; blurb: string; sub: SubScore }) {
  return (
    <div className="border-t border-slate-100 py-3 first:border-t-0 first:pt-0 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{props.label}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{props.blurb}</p>
        </div>
        <ScaleMeter score={props.sub.score} />
      </div>
      {props.sub.justification && (
        <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{props.sub.justification}</p>
      )}
      {props.sub.evidence && (
        <p className={`mt-1.5 border-l-2 border-indigo-200 pl-2.5 text-xs italic text-slate-500 dark:border-indigo-900/60 dark:text-slate-400 ${PH_MASK}`}>
          “{props.sub.evidence}”
        </p>
      )}
    </div>
  );
}

// Section 2 — how well the participant APPLIED business thinking to the scenario.
function AnalysisTab({ score }: { score: ScoreResponse }) {
  const a = score.analytical;
  if (!a) {
    return (
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">No analytical breakdown was returned for this run.</p>
      </Card>
    );
  }
  const c = a.creativity;
  // Optional: sessions stored before the depth award have no `depth` in their jsonb.
  const d = a.depth;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-slate-800">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Analytical &amp; problem-solving</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">How well you applied the skills to actually solve the scenario · 25% of the score</p>
          </div>
          <span className="font-mono text-sm font-semibold text-slate-500 dark:text-slate-400">{Math.round(a.section_percent)}%</span>
        </div>
        <div className="mt-1">
          <AnalysisRow label="Problem framing" blurb="Reading the real problem, its constraints and stakeholders" sub={a.framing} />
          <AnalysisRow label="Solution quality" blurb="A realistic, organized, implementable solution" sub={a.solution_quality} />
          <AnalysisRow label="Application of indicators" blurb="Weaving the assessed skills into the recommendation" sub={a.pi_application} />
        </div>
      </Card>

      <Card className={c.bonus > 0 ? "border-fuchsia-200 dark:border-fuchsia-900/60" : ""}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">✨ Creativity bonus</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">Bonus only: a plain, correct answer never loses points here</p>
          </div>
          <span className={`font-mono text-sm font-semibold ${c.bonus > 0 ? "text-fuchsia-600 dark:text-fuchsia-400" : "text-slate-500 dark:text-slate-400"}`}>
            {c.bonus > 0 ? `+${fmtNum(c.bonus)}` : "+0"}
          </span>
        </div>
        {c.justification && (
          <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{c.justification}</p>
        )}
        {c.evidence && (
          <p className={`mt-1.5 border-l-2 border-fuchsia-200 pl-2.5 text-xs italic text-slate-500 dark:border-fuchsia-900/60 dark:text-slate-400 ${PH_MASK}`}>
            “{c.evidence}”
          </p>
        )}
      </Card>

      {d && (
        <Card className={d.bonus > 0 ? "border-emerald-200 dark:border-emerald-900/60" : ""}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">📚 Depth bonus</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Bonus only: for bringing in a related term and actually using it: naming one earns nothing
              </p>
            </div>
            <span className={`font-mono text-sm font-semibold ${d.bonus > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"}`}>
              {d.bonus > 0 ? `+${fmtNum(d.bonus)}` : "+0"}
            </span>
          </div>
          {d.justification && (
            <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{d.justification}</p>
          )}
          {d.evidence && (
            <p className={`mt-1.5 border-l-2 border-emerald-200 pl-2.5 text-xs italic text-slate-500 dark:border-emerald-900/60 dark:text-slate-400 ${PH_MASK}`}>
              “{d.evidence}”
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

// Formats a number for display: trims trailing zeros, keeps it readable.
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function MathChecksCard({ checks }: { checks: MathCheck[] }) {
  const wrong = checks.filter((c) => c.ok === false).length;
  return (
    <Card className="border-indigo-200 dark:border-indigo-900/60">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
          🧮 Math check
        </h3>
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {wrong === 0 ? "all verified" : `${wrong} to fix`}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Every calculation is recomputed by our server, not the AI, so this is exact.
      </p>
      <div className="mt-3 space-y-2">
        {checks.map((c, i) => {
          const good = c.ok === true;
          const bad = c.ok === false;
          const tone = bad
            ? "border-red-200 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/30"
            : good
              ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/60 dark:bg-emerald-950/30"
              : "border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40";
          const icon = bad ? "✗" : good ? "✓" : "•";
          const iconTone = bad ? "text-red-600" : good ? "text-emerald-600" : "text-slate-400";
          const unit = c.unit ? ` ${c.unit}` : "";
          return (
            <div key={i} className={`rounded-xl border ${tone} px-3 py-2.5`}>
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 font-bold ${iconTone}`}>{icon}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.label || "Calculation"}</p>
                  {c.expression && (
                    <p className="mt-0.5 break-words font-mono text-xs text-slate-500 dark:text-slate-400">{c.expression}</p>
                  )}
                  <p className="mt-1 text-xs text-slate-700 dark:text-slate-200">
                    {c.computed === null ? (
                      c.note || "Couldn't verify this one."
                    ) : bad ? (
                      <>
                        You said <span className="font-semibold text-red-700 dark:text-red-300">{c.claimed}{unit}</span>: the correct value is{" "}
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">{fmtNum(c.computed)}{unit}</span>.
                      </>
                    ) : good ? (
                      <>Correct: <span className="font-semibold text-emerald-700 dark:text-emerald-300">{fmtNum(c.computed)}{unit}</span>.</>
                    ) : (
                      <>Verified value: <span className="font-semibold">{fmtNum(c.computed)}{unit}</span>.</>
                    )}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CriteriaTab({ scores }: { scores: CriterionScore[] }) {
  const groups = groupByDomain(scores);
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const p = g.rows.reduce((a, r) => a + r.points, 0);
        const m = g.rows.reduce((a, r) => a + r.max_points, 0);
        return (
          <Card key={g.domain}>
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
              <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">{g.domain}</h3>
              <span className="font-mono text-sm font-semibold text-slate-500 dark:text-slate-400">{p}/{m}</span>
            </div>
            <div className="mt-3 space-y-2.5">
              {g.rows.map((r) => (
                <CriterionRow key={r.criterion_id} r={r} />
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DeliveryTab({ metrics: m, audioBlob }: { metrics: DeliveryMetrics; audioBlob: Blob | null }) {
  const url = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <div className="space-y-4">
      {m.delivery_components.length > 0 && (
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Delivery score</h3>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">folds into your 15% presentation score</span>
          </div>
          <div className="mt-2 flex items-end gap-1.5">
            <span className="font-mono text-4xl font-bold leading-none text-slate-900 dark:text-slate-100">{m.delivery_score}</span>
            <span className="mb-0.5 font-mono text-base font-medium text-slate-300 dark:text-slate-600">/100</span>
          </div>
          <div className="mt-4 space-y-2.5">
            {m.delivery_components.map((c) => (
              <div key={c.label}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex shrink-0 items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                    {c.label}
                    {/* Sampled, not measured across the whole rep — say so on the row
                        itself rather than burying it, so the bar can't read as
                        carrying the same weight as the audio components. */}
                    {c.advisory && (
                      <span
                        title="Measured from sampled video frames, so it moves your score only slightly"
                        className="rounded-full border border-slate-300 px-1.5 py-px text-[10px] font-medium text-slate-500 dark:border-slate-600 dark:text-slate-400"
                      >
                        sampled
                      </span>
                    )}
                  </span>
                  <span className="text-right text-slate-500 dark:text-slate-400">{c.hint}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={`h-full rounded-full ${c.score >= 80 ? "bg-emerald-500" : c.score >= 55 ? "bg-amber-500" : "bg-red-500"}`}
                    style={{ width: `${c.score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {url && (
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Listen back</h3>
          <audio controls src={url} className="mt-2 w-full" />
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pace" value={String(m.pace_wpm)} unit="WPM" ok={m.pace_flag === "good"} />
        <Stat label="Fillers" value={String(m.filler_count)} unit={`${m.filler_per_min}/min`} ok={m.filler_count === 0} />
        <Stat label="Long pauses" value={String(m.long_pauses.length)} unit={m.longest_pause_seconds ? `max ${m.longest_pause_seconds}s` : "none"} ok={m.long_pauses.length === 0} />
        <Stat label="Time" value={fmt(Math.round(m.time_used_seconds))} unit={TIME_HINT[m.time_flag]} ok={m.time_flag === "good"} />
      </div>

      {m.speakers.length > 0 && <TalkBalance metrics={m} />}

      <Card>
        <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Coaching notes</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
          {m.notes.map((n, i) => (
            <li key={i} className="flex gap-2"><span className="text-indigo-400">•</span>{n}</li>
          ))}
        </ul>
      </Card>

      {(m.fillers.length > 0 || m.crutch_phrases.length > 0) && (
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Words to trim</h3>
          {m.fillers.length > 0 && (
            <div className="mt-2">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Fillers</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {m.fillers.map((f) => <Chip key={f.word}>{f.word} ×{f.count}</Chip>)}
              </div>
            </div>
          )}
          {m.crutch_phrases.length > 0 && (
            <div className="mt-3">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Crutch phrases (advisory)</span>
              <div className={`mt-1.5 flex flex-wrap gap-1.5 ${PH_MASK}`}>
                {m.crutch_phrases.map((f) => <Chip key={f.phrase}>{f.phrase} ×{f.count}</Chip>)}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
        Delivery is deterministic timing measured from your audio: accurate and honest. It does not judge tone,
        confidence, or accent.
      </div>
    </div>
  );
}

// Two-tone bars for the speaker labels, so A and B read distinctly.
const SPEAKER_BAR = ["bg-indigo-500", "bg-teal-500", "bg-amber-500", "bg-rose-500"];

function TalkBalance({ metrics: m }: { metrics: DeliveryMetrics }) {
  return (
    <Card className={m.dominated_by ? "border-amber-200 dark:border-amber-900/60" : ""}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">
          🎙️ Talk-time balance
        </h3>
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">team event</span>
      </div>

      {/* Single stacked bar showing each speaker's share of the talking. */}
      <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        {m.speakers.map((s, i) => (
          <div
            key={s.speaker}
            className={SPEAKER_BAR[i % SPEAKER_BAR.length]}
            style={{ width: `${Math.round(s.talk_share * 100)}%` }}
            title={`Speaker ${s.speaker}: ${Math.round(s.talk_share * 100)}%`}
          />
        ))}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {m.speakers.map((s, i) => (
          <div key={s.speaker} className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SPEAKER_BAR[i % SPEAKER_BAR.length]}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Speaker {s.speaker}
                <span className="ml-1.5 font-mono text-xs font-semibold text-slate-500 dark:text-slate-400">{Math.round(s.talk_share * 100)}%</span>
              </p>
              <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {fmt(Math.round(s.talk_seconds))} · {s.word_count} words · {s.pace_wpm} wpm · {s.filler_count} fillers
              </p>
            </div>
          </div>
        ))}
      </div>

      {m.balance_note && (
        <p className={`mt-3 text-xs leading-relaxed ${m.dominated_by ? "text-amber-800 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
          {m.dominated_by ? "⚠ " : "✓ "}{m.balance_note}
        </p>
      )}
    </Card>
  );
}

const TIME_HINT: Record<DeliveryMetrics["time_flag"], string> = {
  short: "under target",
  good: "on target",
  long: "near limit",
};

function Stat({ label, value, unit, ok }: { label: string; value: string; unit?: string; ok: boolean }) {
  const tone = ok
    ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/60 dark:bg-emerald-950/30"
    : "border-amber-200 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/30";
  return (
    <div className={`rounded-xl border ${tone} px-3 py-2.5`}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 font-mono text-xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
      {unit && <div className="text-xs text-slate-500 dark:text-slate-400">{unit}</div>}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 font-mono text-xs font-medium text-slate-600 dark:text-slate-300">{children}</span>;
}

function CriterionRow({ r }: { r: CriterionScore }) {
  const [open, setOpen] = useState(false);
  const tone = LEVEL_TONE[r.level];
  const headline = r.headline || truncate(r.feedback.replace(/\*\*/g, ""), 90);
  const hasDetail = !!r.feedback || r.evidence.length > 0 || r.gaps.length > 0;
  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg}`}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-start justify-between gap-3 px-3.5 py-3 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {r.name}
            {r.topic && <span className="ml-1 font-mono text-xs font-normal text-slate-500 dark:text-slate-400">· {r.topic}</span>}
          </p>
          {headline && <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{headline}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
          <span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">{r.points}/{r.max_points}</span>
          {hasDetail && <span className="text-xs text-slate-500 dark:text-slate-400">{open ? "▾" : "▸"}</span>}
        </div>
      </button>
      {open && hasDetail && (
        <div className="border-t border-black/5 px-3.5 pb-3 pt-2.5 dark:border-white/10">
          {r.feedback && <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{richText(r.feedback)}</p>}
          {r.evidence.length > 0 && (
            <div className={`mt-2 flex flex-wrap gap-1.5 ${PH_MASK}`}>
              {r.evidence.map((q, i) => (
                <span key={i} className="rounded bg-white/70 dark:bg-slate-800/60 px-1.5 py-0.5 text-xs italic text-slate-500 dark:text-slate-400 ring-1 ring-slate-200 dark:ring-slate-700">
                  “{truncate(q, 80)}”
                </span>
              ))}
            </div>
          )}
          {r.gaps.length > 0 && <GapList gaps={r.gaps} />}
        </div>
      )}
    </div>
  );
}

function GapList({ gaps }: { gaps: string[] }) {
  return (
    <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">To raise the level, add</p>
      <ul className="mt-1.5 space-y-1">
        {gaps.map((g, i) => (
          <li key={i} className="flex gap-1.5 text-xs text-amber-900 dark:text-amber-200"><span className="text-amber-500">+</span><span>{g}</span></li>
        ))}
      </ul>
    </div>
  );
}

// The transcript sidebar: one collapsible note per indicator. Collapsed, each
// shows the indicator, its level and points, and a one-line headline; expanded,
// it reveals the feedback, the phrases that earned credit, what was missing, and
// a stronger line the participant could have said. Tapping a highlight in the
// transcript opens the matching note (and vice-versa) via the shared `activeId`.
function TranscriptNotes({ scores, activeId, onSelect }: {
  scores: CriterionScore[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="space-y-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
      <Card>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Indicator notes</h3>
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{scores.length} skills</span>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Open any indicator, or tap a highlight in your transcript, to see what it earned, what was missing, and a
          stronger line you could’ve said.
        </p>
        <div className="mt-3 space-y-2">
          {scores.map((s) => {
            const open = activeId === s.criterion_id;
            const openId = s.evidence.length > 0 ? `${s.criterion_id}#0` : `${s.criterion_id}#note`;
            return (
              <TranscriptNoteRow
                key={s.criterion_id}
                r={s}
                open={open}
                onToggle={() => onSelect(open ? null : openId)}
              />
            );
          })}
        </div>
        <div className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3">
          <LevelLegend />
        </div>
      </Card>
    </div>
  );
}

function TranscriptNoteRow({ r, open, onToggle }: { r: CriterionScore; open: boolean; onToggle: () => void }) {
  const tone = LEVEL_TONE[r.level];
  const ref = useRef<HTMLDivElement>(null);
  const headline = r.headline || truncate(r.feedback.replace(/\*\*/g, ""), 70);
  const showGaps = r.gaps.length > 0 && r.level !== "exemplary";
  const showSuggestion = !!r.suggestion && r.level !== "exemplary";
  // When opened (e.g. by tapping a transcript highlight), bring the note into view
  // without yanking the page — matters most on mobile, where notes sit below.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  return (
    <div ref={ref} className={`rounded-xl border ${tone.border} ${tone.bg}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {r.name}
            {r.topic && <span className="ml-1 font-mono text-[11px] font-normal text-slate-500 dark:text-slate-400">· {r.topic}</span>}
          </p>
          {!open && headline && <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{headline}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tone.badge}`}>{tone.label}</span>
          <span className="font-mono text-[11px] font-semibold text-slate-600 dark:text-slate-300">{r.points}/{r.max_points}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">{open ? "▾" : "▸"}</span>
        </div>
      </button>
      {open && (
        <div className="space-y-2 border-t border-black/5 px-3 pb-3 pt-2.5 dark:border-white/10">
          {r.feedback && <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{richText(r.feedback)}</p>}
          {r.evidence.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${PH_MASK}`}>
              {r.evidence.map((q, i) => (
                <span key={i} className="rounded bg-white/70 dark:bg-slate-800/60 px-1.5 py-0.5 text-xs italic text-slate-500 dark:text-slate-400 ring-1 ring-slate-200 dark:ring-slate-700">
                  “{truncate(q, 80)}”
                </span>
              ))}
            </div>
          )}
          {showGaps && <GapList gaps={r.gaps} />}
          {showSuggestion && (
            <p className="rounded-lg border border-dashed border-indigo-300 bg-indigo-50/70 px-2.5 py-1.5 text-xs leading-relaxed text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">
              <span className="font-semibold">💡 Could’ve said:</span> <span className="italic">“{r.suggestion}”</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// --- transcript highlighting ----------------------------------------------

type Mark = {
  id: string;
  criterionId: string;
  quote: string;
  level: RubricLevel;
  label: string;
  feedback: string;
  points: number;
  maxPoints: number;
  suggestion: string;
};

function buildMarks(scores: CriterionScore[]): Mark[] {
  const marks: Mark[] = [];
  for (const s of scores) {
    s.evidence.forEach((q, i) => {
      if (q && q.trim().length > 3) {
        marks.push({
          id: `${s.criterion_id}#${i}`, criterionId: s.criterion_id, quote: q.trim(),
          level: s.level, label: s.name, feedback: s.feedback,
          points: s.points, maxPoints: s.max_points,
          // Only anchor a suggestion to the first evidence span of a non-exemplary criterion.
          suggestion: i === 0 && s.level !== "exemplary" ? s.suggestion : "",
        });
      }
    });
  }
  return marks;
}

// Stable color index for a speaker label (sorted first-appearance order), so the
// transcript badges line up with the talk-balance bars.
function speakerIndex(utterances: Utterance[], speaker: string): number {
  const labels = [...new Set(utterances.map((u) => u.speaker))].sort();
  return Math.max(0, labels.indexOf(speaker));
}

function TranscriptTab(props: {
  response: string;
  followupAnswer: string;
  marks: Mark[];
  scores: CriterionScore[];
  active: string | null;
  onSelect: (id: string | null) => void;
  followupFeedback: string;
  utterances: Utterance[];
}) {
  const activeCriterionId = props.active ? props.active.split("#")[0] : null;
  const hasTurns = props.utterances.length > 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your presentation</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {hasTurns
              ? "Split by speaker so you can see who said what. Highlighted phrases are where an indicator earned credit: color shows the level. Tap one to open its note."
              : "Highlighted phrases are where an indicator earned credit: the color is the level it reached. Tap one to open its note on the right."}
          </p>
          {hasTurns ? (
            <div className="mt-3 space-y-3">
              {props.utterances.map((u, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold text-white ${SPEAKER_BAR[speakerIndex(props.utterances, u.speaker) % SPEAKER_BAR.length]}`}>
                    {u.speaker}
                  </span>
                  <p className={`whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100 ${PH_MASK}`}>
                    {highlight(u.text, props.marks, props.active, props.onSelect)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className={`mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100 ${PH_MASK}`}>
              {highlight(props.response, props.marks, props.active, props.onSelect)}
            </p>
          )}
        </Card>

        {props.followupAnswer.trim() && (
          <Card>
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your follow-up answer</h3>
            <p className={`mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100 ${PH_MASK}`}>
              {highlight(props.followupAnswer, props.marks, props.active, props.onSelect)}
            </p>
            {props.followupFeedback && (
              <p className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium text-slate-700 dark:text-slate-200">On your follow-up:</span> {props.followupFeedback}
              </p>
            )}
          </Card>
        )}
      </div>

      <TranscriptNotes scores={props.scores} activeId={activeCriterionId} onSelect={props.onSelect} />
    </div>
  );
}

function highlight(text: string, marks: Mark[], active: string | null, onSelect: (id: string | null) => void): ReactNode {
  if (!text) return text;
  const lower = text.toLowerCase();
  const found: { start: number; end: number; mark: Mark }[] = [];
  const sorted = [...marks].filter((m) => m.quote.length > 3).sort((a, b) => b.quote.length - a.quote.length);
  for (const m of sorted) {
    const q = m.quote.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(q, from);
      if (idx === -1) break;
      const end = idx + q.length;
      const overlaps = found.some((f) => idx < f.end && end > f.start);
      if (!overlaps) {
        found.push({ start: idx, end, mark: m });
        break;
      }
      from = idx + 1;
    }
  }
  if (found.length === 0) return text;
  found.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  found.forEach((f, i) => {
    if (f.start > cursor) nodes.push(<span key={`t${i}`}>{text.slice(cursor, f.start)}</span>);
    const on = f.mark.id === active;
    nodes.push(
      <mark
        key={`m${i}`}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        aria-label={`${f.mark.label}: ${LEVEL_TONE[f.mark.level].label}. ${text.slice(f.start, f.end)}`}
        onClick={() => onSelect(on ? null : f.mark.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(on ? null : f.mark.id);
          }
        }}
        title={`${f.mark.label} · ${LEVEL_TONE[f.mark.level].label}`}
        className={`cursor-pointer rounded px-0.5 underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${LEVEL_TONE[f.mark.level].mark} ${on ? "ring-2 ring-indigo-500/50" : ""}`}
      >
        {text.slice(f.start, f.end)}
      </mark>,
    );
    cursor = f.end;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return nodes;
}

// --- shared bits -----------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {hint && <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const TEXTAREA_CLS =
  "w-full resize-y rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 p-3.5 text-sm leading-relaxed shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

const SELECT_CLS =
  "w-full appearance-none rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 px-3.5 py-2.5 pr-10 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

function Segmented<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-1">
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            onClick={() => props.onChange(o.value)}
            className={`tap rounded-lg px-4 py-1.5 text-sm font-medium transition ${on ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300" : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function CoverSheet({ scenario, embedded }: { scenario: ScenarioResponse; embedded?: boolean }) {
  const s = scenario;
  const learn = s.mode === "learn";
  const body = (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">
            What you're evaluated on ({s.criteria.length})
          </h3>
          <span className="font-mono text-[10px] uppercase tracking-wider text-indigo-500">
            {learn ? "Learn mode" : "Competition mode"}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {learn
            ? "The business skills this role-play assesses, with what a strong answer looks like, so you can aim for it."
            : "The business skills this role-play assesses, by name, just like a real role-play sheet. You supply the substance."}
        </p>
        <ul className="mt-3 space-y-2.5">
          {s.criteria.map((c) => (
            <CriterionBrief key={c.id} c={c} learn={learn} />
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Procedures</h3>
        <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
          {s.procedures.map((p, i) => (
            <li key={i} className="flex gap-2"><span className="text-slate-300 dark:text-slate-600">•</span>{p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
  return embedded ? body : <Card>{body}</Card>;
}

// One criterion on the cover sheet. Competition mode shows just the name +
// domain; Learn mode expands with the coaching question and what "good" looks
// like (the teaching layer).
function CriterionBrief({ c, learn }: { c: Criterion; learn: boolean }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white/60 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.name}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {c.domain}{c.topic ? ` · ${c.topic}` : ""}
        </span>
      </div>
      {learn && c.definition && (
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{c.definition}</p>
      )}
      {learn && c.strong_looks_like && (
        <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-emerald-800 dark:text-emerald-300">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-500">Strong</span>
          <span>{c.strong_looks_like}</span>
        </p>
      )}
    </li>
  );
}

function SituationSheet({ text, embedded }: { text: string; embedded?: boolean }) {
  const body = (
    <>
      <Eyebrow>Event situation</Eyebrow>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">{text}</p>
    </>
  );
  return embedded ? <div>{body}</div> : <Card>{body}</Card>;
}

function RubricNote({ scenario }: { scenario: ScenarioResponse }) {
  return (
    <Card className="border-slate-200 bg-white/60 dark:border-slate-800 dark:bg-slate-900/60">
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        You'll be graded on {scenario.criteria.length} business skills for this role-play, each scored
        Novice → Exemplary with specific feedback and the exact phrases that earned credit. Practice coaching
        against our own evaluation framework, not an official competition score.
      </p>
    </Card>
  );
}

function HonestyNote() {
  return (
    <p className="max-w-xs text-xs leading-relaxed text-slate-500 dark:text-slate-400">
      Original practice scenarios that train the skills DECA role-plays reward, not official DECA materials.
    </p>
  );
}

function TimerBar({ label, left, total, tone, sticky = false }: { label: string; left: number; total: number; tone: "indigo" | "amber" | "slate" | "red"; sticky?: boolean }) {
  const tones = {
    indigo: { box: "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200", num: "text-indigo-700 dark:text-indigo-300", bar: "bg-indigo-500" },
    amber: { box: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200", num: "text-amber-700 dark:text-amber-300", bar: "bg-amber-500" },
    slate: { box: "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200", num: "text-slate-900 dark:text-slate-100", bar: "bg-slate-400" },
    red: { box: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200", num: "text-red-600 dark:text-red-300", bar: "bg-red-500" },
  }[tone];
  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  const announce = useTimerMilestone(label, left);
  return (
    <div
      className={`rounded-2xl border px-4 py-3 shadow-sm ${tones.box} ${sticky ? "sticky top-[68px] z-10" : ""}`}
      role="timer"
      aria-label={`${label}: ${fmt(left)} remaining`}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{label}</div>
        <div className={`font-mono text-2xl font-bold tabular-nums ${tones.num}`} aria-hidden="true">{fmt(left)}</div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/5" aria-hidden="true">
        <div className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${tones.bar}`} style={{ width: `${pct}%` }} />
      </div>
      {/* Coarse spoken checkpoints: a per-second live region would flood a
          screen reader, so we only announce as the clock crosses a threshold. */}
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    </div>
  );
}

// Emits a spoken string only when a countdown crosses 60s / 30s / 10s / 0,
// so assistive tech hears meaningful checkpoints instead of every tick.
function useTimerMilestone(label: string, left: number) {
  const [msg, setMsg] = useState("");
  const lastBucket = useRef<number | null>(null);
  useEffect(() => {
    const bucket = left <= 0 ? 0 : left <= 10 ? 10 : left <= 30 ? 30 : left <= 60 ? 60 : 999;
    if (bucket === lastBucket.current) return;
    lastBucket.current = bucket;
    if (bucket === 999) return; // still early; nothing to say yet
    setMsg(
      bucket === 0
        ? `${label}: time's up.`
        : `${label}: ${bucket} seconds left.`,
    );
  }, [label, left]);
  return msg;
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_1px_2px_rgba(15,23,42,0.04)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(15,23,42,0.08)] dark:bg-slate-900 dark:shadow-none dark:hover:shadow-none ${className || "border-slate-200 dark:border-slate-800"}`}
    >
      {children}
    </div>
  );
}

// Animated loader built from the target logo: concentric "radar" rings pulse
// outward (like locking onto a target) while the mark gently bobs.
function LoadingScreen({ title, steps }: { title: string; steps: string[] }) {
  // Walk the checklist forward on a timer to give the wait a sense of progress.
  // We don't know the exact finish, so hold on the last step until the real
  // result swaps this screen out.
  const [active, setActive] = useState(0);
  const count = steps.length;
  const key = steps.join("|"); // stable across re-renders unless the steps change
  useEffect(() => {
    setActive(0);
    if (count <= 1) return;
    const id = window.setInterval(() => {
      setActive((i) => (i >= count - 1 ? i : i + 1));
    }, 1400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <Card>
      <div className="flex flex-col items-center gap-6 py-12">
        {/* The brand mark as a rippling target: 5 concentric layers (2 real rings
            + 2 background-colored "gap" rings + a glowing indigo dot) share one
            wave keyframe, staggered center→edge so the pulse travels outward. The
            gap rings are the card's own bg, which is what creates the ring
            illusion. Colors track BrandMark (#c7d2fe / #818cf8 / #4f46e5). Layers
            are centered with `inset-0 m-auto` (not transforms) so the scale
            animation is free to drive `transform`. */}
        <div className="relative grid place-items-center" style={{ width: 140, height: 140 }}>
          <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: 140, height: 140, background: "#c7d2fe", animationDelay: "0.6s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full bg-white dark:bg-slate-900" style={{ width: 116, height: 116, animationDelay: "0.4s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: 92, height: 92, background: "#818cf8", animationDelay: "0.2s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full bg-white dark:bg-slate-900" style={{ width: 72, height: 72, animationDelay: "0.07s" }} />
          <span className="pic-wave-dot absolute inset-0 m-auto rounded-full" style={{ width: 34, height: 34, background: "#4f46e5" }} />
        </div>

        <div className="text-center">
          <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{title}</p>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-500">PI Coach</p>
        </div>

        {/* Indeterminate progress sweep. */}
        <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="pic-sweep h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent" />
        </div>

        {/* Staged checklist: done steps check off, the current one spins. */}
        <ul className="w-full max-w-xs space-y-2.5">
          {steps.map((s, i) => {
            const done = i < active;
            const current = i === active;
            return (
              <li
                key={s}
                className={`flex items-center gap-2.5 text-sm transition-colors ${
                  done
                    ? "text-slate-500 dark:text-slate-400"
                    : current
                      ? "font-medium text-slate-900 dark:text-slate-100"
                      : "text-slate-300 dark:text-slate-600"
                }`}
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center">
                  {done ? (
                    <span className="text-emerald-500">✓</span>
                  ) : current ? (
                    <span className="pic-spin h-3.5 w-3.5 rounded-full border-2 border-indigo-500 border-t-transparent" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
                <span className={current ? "pic-step-in" : ""}>{s}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

// --- competition tips ------------------------------------------------------

// --- FAQ -------------------------------------------------------------------

function FAQItem({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition open:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="font-display text-[15px] font-semibold text-slate-900 dark:text-slate-100">{q}</span>
        <span className="shrink-0 text-slate-400 transition group-open:rotate-45 dark:text-slate-500">＋</span>
      </summary>
      <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</div>
    </details>
  );
}

function FAQGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-indigo-500">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function FAQPage({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-10">
      <section className="pt-2">
        <Eyebrow>Questions &amp; answers</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl">
          How PI Coach works
          <br />
          <span className="text-indigo-600 dark:text-indigo-400">and why it's different.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600 dark:text-slate-300">
          Honest answers about the AI, how we grade, how we compare to other tools, whether it's allowed, and how
          to actually get better with it.
        </p>
      </section>

      <FAQGroup title="Using the AI">
        <FAQItem q="How does the AI actually work?">
          <p>
            Two steps. When you pick an event and (optionally) a focus, an AI model writes an <strong className="font-semibold text-slate-800 dark:text-slate-200">original</strong> role-play
            built to exercise a handful of specific business skills. After you present, a second pass grades your
            response against those exact skills: quoting the phrases that earned credit and naming what was missing.
          </p>
          <p>
            If you speak your answer, your audio is transcribed and we compute delivery metrics (pace, fillers, pauses,
            timing) with plain arithmetic, no AI opinion involved there.
          </p>
        </FAQItem>
        <FAQItem q="Can I trust the score? Is the AI just making things up?">
          <p>
            The score is <strong className="font-semibold text-slate-800 dark:text-slate-200">practice coaching, not an official or predicted competition score</strong>, no tool
            can promise your real judge's number. We keep it honest in a few concrete ways: every skill is graded
            against a written “strong vs. weak” bar so name-dropping a term doesn't earn full marks, and the feedback
            has to cite exact quotes from what you said.
          </p>
          <p>
            For finance and accounting events, we go further: the AI is <em>not trusted to do arithmetic</em>. It hands
            each calculation to our server as a formula, and Python computes it, so a “Math check” either confirms your
            number or shows the correct one. It can't tell you you're wrong when you're right.
          </p>
        </FAQItem>
        <FAQItem q="What about my voice recording and privacy?">
          <p>
            Recordings are sent to a transcription service to measure delivery, then discarded on our servers. We keep
            only the transcript and the numbers. Your audio stays on your device unless you choose to keep it. Delivery
            covers timing only (pace, fillers, pauses), never tone, confidence, accent, or “charisma.”
          </p>
        </FAQItem>
        <FAQItem q="Do you record my screen?">
          <p>
            We record session replays — how people move through the app, so we can find where it gets confusing. A
            replay captures clicks, scrolling, and timing.
          </p>
          <p>
            <strong className="font-semibold text-slate-800 dark:text-slate-200">All text is masked in your browser before anything is sent.</strong>{" "}
            That means a replay shows the layout and where you clicked, never your response, your transcript, the
            scenario, or your feedback. The same rule as everywhere else here: the words you write stay between you and
            the grader.
          </p>
        </FAQItem>
      </FAQGroup>

      <FAQGroup title="How we're different">
        <FAQItem q="What makes PI Coach's feedback different?">
          <p>
            Most practice comes down to a number and some generic advice. We built PI Coach around feedback specific
            enough to actually change how you present next time:
          </p>
          <ul className="ml-4 list-disc space-y-1.5">
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Phrase-level grading.</strong> We transcribe your presentation and grade the actual phrases you
              said: highlighting the exact words that earned credit, and showing <em>“what you could have said”</em>
              right in your transcript where a stronger line would have raised your score.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Skill by skill, with the gaps.</strong> Every indicator is scored against a written “strong vs. weak”
              bar, so name-dropping a term doesn't fool it, and you get the concrete thing that was missing.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Delivery that counts.</strong> Present out loud and your pace, fillers, pauses, and timing are
              measured and folded into your score, for team events we even show who dominated the talking.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Math you can trust.</strong> On finance events, every calculation is recomputed on our server, so a
              wrong number is caught with the right one, never guessed at.
            </li>
          </ul>
          <p>
            It's all built on our own evaluation framework, authored from public business fundamentals (more on why
            below), so the coaching is ours, end to end.
          </p>
        </FAQItem>
        <FAQItem q="Why build your own framework instead of using DECA's performance indicators?">
          <p>
            DECA / MBA Research's performance-indicator lists are <strong className="font-semibold text-slate-800 dark:text-slate-200">licensed intellectual property</strong>. Rather than
            ship their exact wording, codes, and event-to-PI mapping, we authored our own framework of business skills
            from the underlying public concepts: the same fundamentals taught in any business course. It's the right
            thing legally and lets us keep improving the rubric ourselves. It also means the framework can travel beyond
            DECA later (FBLA, interview prep, and so on).
          </p>
        </FAQItem>
      </FAQGroup>

      <FAQGroup title="Is this allowed?">
        <FAQItem q="Is PI Coach affiliated with DECA? Is using it against the rules?">
          <p>
            No affiliation. PI Coach is an independent practice tool and is <strong className="font-semibold text-slate-800 dark:text-slate-200">not endorsed by or connected to DECA
            Inc.</strong> We use the name “DECA” only to describe the competition we help you prepare for.
          </p>
          <p>
            Practicing your own skills with original scenarios is ordinary prep, like a mock interview. What isn't okay
            is bringing prepared materials or outside help into the actual competition room. Use this to <em>train</em>
            beforehand, then compete on your own. When in doubt, follow your chapter advisor and DECA's guidelines.
          </p>
        </FAQItem>
      </FAQGroup>

      <FAQGroup title="Getting better">
        <FAQItem q="How do I use this to actually place at competition?">
          <ul className="ml-4 list-disc space-y-1.5">
            <li>Practice your <strong className="font-semibold text-slate-800 dark:text-slate-200">real event</strong>, and rotate the focus box so you hit different skills across sessions.</li>
            <li>Start in <strong className="font-semibold text-slate-800 dark:text-slate-200">Learn mode</strong> to see what “good” looks like; switch to <strong className="font-semibold text-slate-800 dark:text-slate-200">Competition mode</strong> once you want the real, blind test.</li>
            <li><strong className="font-semibold text-slate-800 dark:text-slate-200">Speak your answers.</strong> Reading in your head hides pace and filler habits the judge will notice.</li>
            <li>Use the prep timer for real, the pressure is the point, and always answer the follow-up questions.</li>
            <li>Read the <strong className="font-semibold text-slate-800 dark:text-slate-200">gaps</strong> in each criterion; they're the exact things that would raise your level next time.</li>
            <li>Climb the levels: <strong className="font-semibold text-slate-800 dark:text-slate-200">District → State → ICDC</strong> as the scenarios get harder.</li>
          </ul>
        </FAQItem>
        <FAQItem q="How do team events work here?">
          <p>
            Pick any “(Team)” event and you get a longer prep and presentation window, matching how team decision-making
            runs. If you record, we pick up both partners' voices and show a <strong className="font-semibold text-slate-800 dark:text-slate-200">talk-time balance</strong>, so you can see if
            one person dominated, and read the transcript split by speaker. Right now you present together on one
            device; there's no separate second-competitor simulation.
          </p>
        </FAQItem>
      </FAQGroup>

      <Card className="border-indigo-200 bg-indigo-50/70 dark:border-indigo-900/60 dark:bg-indigo-950/30">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Still have a question?</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Use the 💬 Feedback button up top. We read everything.</p>
          </div>
          <button className={BTN_PRIMARY} onClick={onStart}>Start practicing →</button>
        </div>
      </Card>
    </div>
  );
}


function TipsPage({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-14">
      {/* Hero */}
      <section className="pt-2">
        <Eyebrow>Competition tips</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl">
          Don't just mention the skill.<br />
          <span className="text-indigo-600 dark:text-indigo-400">Own it.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600 dark:text-slate-300">
          The competitors who place run every skill they're assessed on through the same four beats, and back it with a
          visual the judge can't forget. Here's the method, with a worked example you can copy.
        </p>
      </section>

      {/* The DECA method */}
      <section>
        <SectionHead eyebrow="The core skill" title="The method for nailing a skill">
          One running example: <strong className="font-semibold text-slate-700 dark:text-slate-200">channel strategy</strong> for
          BrightBean, a small coffee roaster: carried through all four beats.
        </SectionHead>
        {/* The four beats read as one connected sequence, not a wall of identical
            cards — a spine runs down through the numbered nodes so it's clear each
            beat builds on the last, and Connect (where the points live) is lifted. */}
        <ol className="relative mt-7 space-y-5 before:absolute before:bottom-5 before:left-[19px] before:top-5 before:w-px before:bg-slate-200 dark:before:bg-slate-800">
          <MethodStep
            n="1" accent="indigo" title="Define"
            todo="Clearly and confidently define the skill or any key terms right away. Skip the textbook jargon: keep it simple and conversational so the judge knows you grasp the core concept."
            example={<>“Channel strategy is just <em>how our product gets from us into the customer's hands</em>: the path it travels to reach them.”</>}
          />
          <MethodStep
            n="2" accent="violet" title="Explain"
            todo="Elaborate on why this skill matters to a business. Its broader impact, what it does, and why a company has to pay attention to it in the real world."
            example={<>“Get the mix right and you control both your <em>margins</em> and how many customers you can reach. Lean on one channel and you're exposed; spread too thin and you lose focus.”</>}
          />
          <MethodStep
            n="3" accent="fuchsia" title="Connect" highlight="Earns the most points"
            todo="Directly apply the skill to your specific role-play scenario. Weave the concept into your actual proposed solution, product, or strategy. That's the systems thinking judges reward."
            example={<>“For BrightBean, I'd add a <em>direct-to-consumer subscription</em> next to the coffee bar. It captures our regulars at full margin and gives us first-party data wholesale never will.”</>}
          />
          <MethodStep
            n="4" accent="amber" title="Above & Beyond"
            todo="Differentiate yourself. Add a creative element beyond the prompt: a quick chart, a real-world statistic, a famous brand case, or a niche business term."
            example={<>“Quick math: 200 regulars at $20/mo is <em>~$48K/yr recurring</em>, about what a second wholesale account brings but at double the margin. (then I'd sketch a bar comparing the two.)”</>}
          />
        </ol>
        <p className="mt-5 flex items-start gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3.5 text-sm leading-relaxed text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200">
          <span className="mt-0.5 shrink-0 font-mono text-xs font-bold uppercase tracking-wider text-indigo-500">Tip</span>
          <span>If your sentence about the skill could apply to <em>any</em> company, you've only <strong className="font-semibold">Defined</strong> it. The points live in <strong className="font-semibold">Connect</strong>: tie it to the scenario in front of you.</span>
        </p>
      </section>

      {/* Visuals */}
      <section>
        <SectionHead title="Use visuals to your advantage">
          You get pen and paper in prep: most competitors only scribble notes. Draw <em>one</em> clean visual, turn it
          toward the judge, and reference it out loud. Here's what to reach for and when.
        </SectionHead>
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <VisualCard chart={<ChartBars />} title="Bar chart" when="Comparing 2–3 options on cost, margin, or risk to justify your pick." />
          <VisualCard chart={<ChartLine />} title="Trend line" when="Anchoring the problem in data: a sales dip, a target, a before/after." />
          <VisualCard chart={<ChartMatrix />} title="2×2 matrix" when="Positioning choices on two axes (effort vs impact) to defend priorities." />
          <VisualCard chart={<ChartTimeline />} title="Timeline" when="Laying a rollout over weeks or quarters so the judge sees execution." />
        </div>
        <p className="mt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Keep it large and labeled, and <strong className="font-semibold text-slate-900 dark:text-slate-100">say it out loud</strong> as you point
          (“as you can see on my timeline…”). One confident visual beats a page of cramped notes.
        </p>
      </section>

      {/* Before & during */}
      <section>
        <SectionHead eyebrow="The playbook" title="Before & during the role-play" />
        {/* A numbered four-phase playbook (Prep → Delivery), not a wall of four
            identical feature cards: leading numbers + varied heights read as a
            sequence you move through. */}
        <div className="mt-7 grid items-start gap-4 sm:grid-cols-2">
          <TipCard n="01" phase="Prep time" title="Own your 10 minutes" items={[
            "Read the situation twice; underline the actual ask.",
            "Map each assessed skill to a moment in your plan.",
            "Draft your visual early, not at the last minute.",
            "Outline your open and close so you bookend strong.",
          ]} />
          <TipCard n="02" phase="Structure" title="A shape judges reward" items={[
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Open:</strong> greet, confirm your role, preview.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Body:</strong> walk the solution, hit every assessed skill through all four beats.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Close:</strong> restate the recommendation, invite questions.</>,
          ]} />
          <TipCard n="03" phase="Follow-up" title="Handle the questions" items={[
            "Take a beat: a short pause beats rambling.",
            "Answer directly, then tie back to your recommendation.",
            "If unsure, reason out loud; judges reward sound thinking.",
          ]} />
          <TipCard n="04" phase="Delivery" title="Sound like a pro" items={[
            "Steady pace (~130–160 wpm); trade “um” for a pause.",
            "Make eye contact and use the judge's name.",
            "Use the time, but leave room for the questions.",
          ]} />
        </div>
      </section>

      {/* Notebook */}
      <section>
        <SectionHead title="How to lay out your notebook page">
          Your prep paper is a map you'll present from, not an essay. Set it up the same way every time so, under
          pressure, your eyes always know where to look. Here's a layout that works.
        </SectionHead>
        <div className="mt-7 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <NotebookMock />
          <div className="space-y-3">
            <NotebookStep n="1" title="Company & your role" body="Top of the page: the company name and the exact role you're playing. It anchors everything and stops you slipping out of character." />
            <NotebookStep n="2" title="The problem, in one line" body="Force yourself to write the actual ask in a single sentence. If you can't, you haven't found it yet: reread the situation." />
            <NotebookStep n="3" title="Each indicator + your own definition" body="List the skills you're assessed on. Next to each, write a short definition in YOUR words. That's your Define beat, ready to go." />
            <NotebookStep n="4" title="A tie-back bullet per indicator" body="Under each, one bullet on how it applies to THIS scenario. That bullet is your Connect beat, where the points live." />
            <NotebookStep n="5" title="Open & close" body="Jot your first line and last line. Bookending strong is half the impression, and it saves you when nerves hit." />
          </div>
        </div>
      </section>

      {/* Fill the time */}
      <section>
        <SectionHead title="Acronyms, and how to fill the time">
          Two things separate a thin four-minute answer from a full, confident one: giving the judge a structure they
          can follow, and having enough depth to actually use the window.
        </SectionHead>
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          <Card className="border-indigo-200 dark:border-indigo-900/60">
            <Eyebrow>Use an acronym</Eyebrow>
            <h3 className="mt-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">Give the judge a handle</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              When you explain a process or plan, coin a simple acronym and walk its letters. It makes you sound
              organized, helps the judge follow, and makes your answer memorable when they score you afterward.
            </p>
            <p className="mt-3 rounded-xl bg-slate-50 px-3.5 py-3 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
              “My retention plan follows <strong className="font-semibold">R.A.M.P.</strong>: <strong className="font-semibold">R</strong>eward loyalty,
              <strong className="font-semibold"> A</strong>utomate the outreach, <strong className="font-semibold">M</strong>easure repeat visits,
              <strong className="font-semibold"> P</strong>ilot before rollout.”
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Keep it to 3–5 letters and make each one real. A clear structure beats a clever-but-empty one.
            </p>
          </Card>
          <Card>
            <Eyebrow>Fill the time with substance</Eyebrow>
            <h3 className="mt-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">Add depth, not padding</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Running short? Don't slow down or repeat: add another layer. Each of these buys real time and earns points:
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
              <Tip icon="④">Run every skill through all four beats (Define → Explain → Connect → Above &amp; Beyond).</Tip>
              <Tip icon="⚖️">Name a second option you considered and why you rejected it.</Tip>
              <Tip icon="🔢">Quantify: a rough number, a cost, or a target makes it concrete.</Tip>
              <Tip icon="🗓️">Add an implementation timeline (first 30 days, then 90).</Tip>
              <Tip icon="⚠️">Raise a risk and how you'd handle it: judges love foresight.</Tip>
              <Tip icon="🏆">Drop a real brand example or a quick stat as proof.</Tip>
            </ul>
          </Card>
        </div>
      </section>

      {/* CTA */}
      <Card className="border-indigo-200 bg-indigo-50/70 dark:border-indigo-900/60 dark:bg-indigo-950/30">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Ready to put it into reps?</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Generate a scenario and run the four beats live.</p>
          </div>
          <button className={BTN_PRIMARY} onClick={onStart}>Start practicing →</button>
        </div>
      </Card>
    </div>
  );
}

function SectionHead({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className={`font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl ${eyebrow ? "mt-2" : ""}`}>{title}</h2>
      {children && <p className="mt-3 text-base leading-relaxed text-slate-600 dark:text-slate-300">{children}</p>}
    </div>
  );
}

const METHOD_ACCENT = {
  indigo: { badge: "bg-indigo-600", rule: "border-l-indigo-400 dark:border-l-indigo-500", tag: "text-indigo-500" },
  violet: { badge: "bg-violet-600", rule: "border-l-violet-400 dark:border-l-violet-500", tag: "text-violet-500" },
  fuchsia: { badge: "bg-fuchsia-600", rule: "border-l-fuchsia-400 dark:border-l-fuchsia-500", tag: "text-fuchsia-500" },
  amber: { badge: "bg-amber-500", rule: "border-l-amber-400 dark:border-l-amber-500", tag: "text-amber-600 dark:text-amber-500" },
} as const;

function MethodStep({ n, title, accent, todo, example, highlight }: {
  n: string; title: string; accent: keyof typeof METHOD_ACCENT; todo: ReactNode; example: ReactNode; highlight?: string;
}) {
  const a = METHOD_ACCENT[accent];
  return (
    <li className="relative flex gap-4 sm:gap-5">
      <span className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold text-white shadow-sm ${a.badge}`}>{n}</span>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h3>
          {highlight && (
            <span className="rounded-full bg-fuchsia-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300">{highlight}</span>
          )}
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{todo}</p>
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.15em] ${a.tag}`}>Example</span>
          <p className="mt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{example}</p>
        </div>
      </div>
    </li>
  );
}

function VisualCard({ chart, title, when }: { chart: ReactNode; title: string; when: string }) {
  return (
    <div className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900">
      <div className="grid h-24 place-items-center rounded-xl bg-slate-50 dark:bg-slate-800/40">{chart}</div>
      <p className="mt-3 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{when}</p>
    </div>
  );
}

function TipCard({ n, phase, title, items }: { n: string; phase: string; title: string; items: ReactNode[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-indigo-100 font-mono text-xs font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">{n}</span>
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{phase}</div>
          <h3 className="font-display text-base font-semibold leading-tight text-slate-900 dark:text-slate-100">{title}</h3>
        </div>
      </div>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />{it}</li>
        ))}
      </ul>
    </div>
  );
}

function NotebookStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-100 font-mono text-xs font-bold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">{n}</span>
      <div>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{body}</p>
      </div>
    </div>
  );
}

// A stylized notebook page mockup for the prep-layout tip.
function NotebookMock() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-[#fffdf5] p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {/* margin line */}
      <div className="pointer-events-none absolute inset-y-0 left-9 w-px bg-rose-300/60 dark:bg-rose-500/30" />
      <div className="relative pl-6 font-mono text-[13px] leading-relaxed text-slate-700 dark:text-slate-200">
        <p className="font-bold text-slate-900 dark:text-slate-100">FreshBrew Coffee Co. : Marketing Consultant</p>
        <p className="mt-1 text-slate-500 dark:text-slate-400">Problem: afternoons are dead + first-timers don't return.</p>
        <div className="mt-3 space-y-2.5">
          {[
            { pi: "Promotional strategy", def: "= the mix of ways we reach customers", tie: "→ app push + a 3–5pm power hour" },
            { pi: "Customer relationships", def: "= turning buyers into regulars", tie: "→ tiered loyalty, birthday reward" },
            { pi: "Channel strategy", def: "= how the product reaches them", tie: "→ own the app, drop 3rd-party fees" },
            { pi: "Measuring success", def: "= how we'll know it worked", tie: "→ repeat-visit rate, +15% / 2 qtrs" },
          ].map((r) => (
            <div key={r.pi}>
              <p><span className="font-semibold text-indigo-700 dark:text-indigo-300">▸ {r.pi}</span> <span className="text-slate-500 dark:text-slate-400">{r.def}</span></p>
              <p className="pl-4 text-emerald-700 dark:text-emerald-400">{r.tie}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-slate-500 dark:text-slate-400">Open: “Thanks for having me: here's how we win back the afternoon.”</p>
        <p className="text-slate-500 dark:text-slate-400">Close: “Pilot 3 stores, prove the lift, then scale.”</p>
      </div>
    </div>
  );
}

// Hand-drawn-feel mini charts for the visuals section (inline SVG, theme-aware).
function ChartBars() {
  const bars = [10, 20, 14, 28];
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-28" aria-hidden>
      <line x1="8" y1="56" x2="116" y2="56" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />
      {bars.map((h, i) => (
        <rect key={i} x={16 + i * 26} y={56 - h * 1.6} width="16" height={h * 1.6} rx="2"
          className={i === bars.length - 1 ? "fill-indigo-500" : "fill-indigo-300 dark:fill-indigo-500/50"} />
      ))}
    </svg>
  );
}

function ChartLine() {
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-28" aria-hidden>
      <line x1="8" y1="56" x2="116" y2="56" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />
      <polyline points="12,48 40,38 64,42 88,22 112,12" fill="none" className="stroke-indigo-500" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {[[12,48],[40,38],[64,42],[88,22],[112,12]].map(([x,y],i) => (
        <circle key={i} cx={x} cy={y} r="2.5" className="fill-indigo-500" />
      ))}
    </svg>
  );
}

function ChartMatrix() {
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-28" aria-hidden>
      <line x1="60" y1="6" x2="60" y2="58" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />
      <line x1="14" y1="32" x2="106" y2="32" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />
      <circle cx="84" cy="18" r="6" className="fill-indigo-500" />
      <circle cx="38" cy="22" r="3.5" className="fill-indigo-300 dark:fill-indigo-500/50" />
      <circle cx="44" cy="46" r="3.5" className="fill-indigo-300 dark:fill-indigo-500/50" />
      <circle cx="86" cy="46" r="3.5" className="fill-indigo-300 dark:fill-indigo-500/50" />
    </svg>
  );
}

function ChartTimeline() {
  return (
    <svg viewBox="0 0 120 64" className="h-16 w-28" aria-hidden>
      <line x1="12" y1="32" x2="108" y2="32" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="2" />
      {[12, 44, 76, 108].map((x, i) => (
        <g key={i}>
          <circle cx={x} cy="32" r={i === 1 ? 5 : 4} className={i === 1 ? "fill-indigo-500" : "fill-indigo-300 dark:fill-indigo-500/60"} />
          <line x1={x} y1="32" x2={x} y2={i % 2 ? 16 : 48} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}

// Level → colors. Scale reads worst→best: red → amber → blue → green. Only the
// TOP band (Exemplary) is green, so "all green" never looks like a perfect score
// (Proficient is the second band, ~70-85%, shown blue).
const LEVEL_TONE: Record<RubricLevel, { label: string; badge: string; bg: string; border: string; mark: string }> = {
  novice: { label: "Novice", badge: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", bg: "bg-red-50/50 dark:bg-red-950/30", border: "border-red-200 dark:border-red-900/60", mark: "bg-red-200 text-red-950" },
  developing: { label: "Developing", badge: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", bg: "bg-amber-50/50 dark:bg-amber-950/30", border: "border-amber-200 dark:border-amber-900/60", mark: "bg-amber-200 text-amber-950" },
  proficient: { label: "Proficient", badge: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300", bg: "bg-sky-50/50 dark:bg-sky-950/30", border: "border-sky-200 dark:border-sky-900/60", mark: "bg-sky-200 text-sky-950" },
  exemplary: { label: "Exemplary", badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300", bg: "bg-emerald-50/50 dark:bg-emerald-950/30", border: "border-emerald-200 dark:border-emerald-900/60", mark: "bg-emerald-200 text-emerald-950" },
};

const LEVEL_ORDER: RubricLevel[] = ["novice", "developing", "proficient", "exemplary"];
const LEVEL_FILL: Record<RubricLevel, string> = {
  novice: "bg-red-400",
  developing: "bg-amber-400",
  proficient: "bg-sky-400",
  exemplary: "bg-emerald-400",
};

// Signature: a 4-segment meter for the rubric bands. Segments up to the achieved
// level are filled in their own band color; the rest stay faint.
function LevelMeter({ level }: { level: RubricLevel }) {
  const idx = LEVEL_ORDER.indexOf(level);
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {LEVEL_ORDER.map((lv, i) => (
          <span key={lv} className={`h-1.5 w-6 rounded-full ${i <= idx ? LEVEL_FILL[lv] : "bg-slate-200 dark:bg-slate-700"}`} />
        ))}
      </div>
      <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">{LEVEL_TONE[level].label}</span>
    </div>
  );
}

function richText(s: string): ReactNode {
  if (!s) return s;
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-slate-900 dark:text-slate-100">{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function LevelLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
      {LEVEL_ORDER.map((lv) => (
        <span key={lv} className="inline-flex items-center gap-1.5">
          <span className={`h-3 w-3 rounded-sm ${LEVEL_TONE[lv].mark} ring-1 ring-inset ring-slate-300 dark:ring-slate-600`} />
          {LEVEL_TONE[lv].label}
        </span>
      ))}
      <span className="text-slate-500 dark:text-slate-400">· green = top band, not a perfect score</span>
    </div>
  );
}

// --- timers ----------------------------------------------------------------

function useCountdown(seconds: number, running: boolean, onElapsed?: () => void) {
  const [left, setLeft] = useState(seconds);
  const fired = useRef(false);
  const cb = useRef(onElapsed);
  cb.current = onElapsed;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          if (!fired.current) {
            fired.current = true;
            cb.current?.();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  return left;
}

function fmt(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function wordCount(v: string): number {
  return v.trim() ? v.trim().split(/\s+/).length : 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
