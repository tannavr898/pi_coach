import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Criterion,
  type CriterionScore,
  type DeliveryMetrics,
  type EventSummary,
  type Level,
  type MathCheck,
  type Mode,
  type RubricLevel,
  type ScenarioResponse,
  type ScoreResponse,
  type Utterance,
  getEvents,
  postDelivery,
  postFeedback,
  postScenario,
  postScore,
} from "./api";
import { track } from "./analytics";
import { DEMO_DELIVERY, DEMO_FOLLOWUP, DEMO_RESPONSE, DEMO_SCENARIO, DEMO_SCORE } from "./demoData";

type ResponseMode = "type" | "speak";
type View = "practice" | "tips" | "faq";
const CAN_RECORD = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

// Presentation timing now comes per-event from scenario.timing (team events get a
// longer prep/present window). The presentation budget is shared by the response
// and the judge's questions: the response clock counts it down, the follow-up
// inherits the rest.

type Stage = "pick" | "loading" | "ready" | "prep" | "walkin" | "respond" | "followup" | "scoring" | "feedback";

// How long the participant can sit on the response/follow-up screen without
// starting before the 5-second auto-start countdown kicks in.
const IDLE_GRACE_MS = 40000;

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
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("practice");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

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

  async function generate() {
    if (!eventId) return;
    setError(null);
    setStage("loading");
    try {
      const s = await postScenario({ event: eventId, request: request.trim(), level, mode: practiceMode });
      track("scenario_generated", { level, mode: practiceMode, event: eventId, focused: !!request.trim() });
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
      setStage("ready");
    } catch (e) {
      setError(errMsg(e));
      setStage("pick");
    }
  }

  async function submit() {
    if (!scenario) return;
    setError(null);
    setStage("scoring");
    try {
      let responseForScoring = responseText;
      let deliveryMetrics: DeliveryMetrics | null = null;

      // Spoken path: transcribe first, then score the transcript.
      if (mode === "speak") {
        if (!audioBlob) {
          setError("No recording found — record your response first.");
          setStage("respond");
          return;
        }
        const d = await postDelivery(audioBlob, scenario.timing.target_seconds, scenario.team);
        responseForScoring = d.transcript;
        deliveryMetrics = d.metrics;
        setUtterances(d.utterances); // team: speaker-labeled turns for the transcript
        setResponseText(d.transcript); // so the Transcript tab can highlight it
      }

      if (!responseForScoring.trim()) {
        setError("Your response came back empty — try again.");
        setStage("respond");
        return;
      }

      // Spoken follow-up: transcribe it too (content only — its delivery isn't graded).
      let followupForScoring = followupAnswer;
      if (followupMode === "speak" && followupAudio) {
        const fd = await postDelivery(followupAudio, scenario.timing.target_seconds);
        followupForScoring = fd.transcript;
        setFollowupAnswer(fd.transcript);
      }

      const result = await postScore({
        scenario: scenario.situation,
        criteria_ids: scenario.criteria.map((c) => c.id),
        response: responseForScoring,
        followup_questions: scenario.followup_questions,
        followup_answer: followupForScoring,
        event: eventId, // lets the backend run math checks for quantitative events
      });
      setDelivery(deliveryMetrics);
      setScore(result);
      track("scored", {
        total_points: result.total_points,
        pct: result.overall_percent,
        mode,
        practice_mode: scenario.mode,
        has_delivery: !!deliveryMetrics,
      });
      setStage("feedback");
    } catch (e) {
      setError(errMsg(e));
      setStage("followup");
    }
  }

  function restart() {
    setScenario(null);
    setScore(null);
    setDelivery(null);
    setUtterances([]);
    setResponseText("");
    setAudioBlob(null);
    setPresentRemaining(0);
    setClockRunning(false);
    setAutoCountdown(null);
    setFollowupAnswer("");
    setFollowupAudio(null);
    setError(null);
    setStage("pick");
  }

  const wide = (view === "practice" && stage === "feedback") || view === "tips";

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader view={view} onView={setView} theme={theme} onToggleTheme={toggleTheme} onFeedback={() => setFeedbackOpen(true)} />
      <main className={`w-full flex-1 mx-auto px-5 pb-20 pt-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {view === "tips" ? (
          <TipsPage onStart={() => setView("practice")} />
        ) : view === "faq" ? (
          <FAQPage onStart={() => setView("practice")} />
        ) : (
          <>
            {stage === "pick" && (
              <PickScreen
                events={events}
                eventId={eventId}
                request={request}
                practiceMode={practiceMode}
                level={level}
                onEvent={setEventId}
                onRequest={setRequest}
                onPracticeMode={setPracticeMode}
                onLevel={setLevel}
                onGenerate={generate}
                onTips={() => setView("tips")}
              />
            )}

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

            {stage === "ready" && scenario && <ReadyScreen scenario={scenario} onStart={() => setStage("prep")} />}

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
              <WalkinScreen scenario={scenario} onEnter={() => setStage("respond")} />
            )}

            {stage === "respond" && scenario && (
              <RespondScreen
                scenario={scenario}
                remaining={presentRemaining}
                running={clockRunning}
                autoCountdown={autoCountdown}
                onStart={startClock}
                mode={mode}
                onMode={setMode}
                value={responseText}
                onChange={setResponseText}
                audioBlob={audioBlob}
                onRecorded={setAudioBlob}
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

            {stage === "feedback" && score && scenario && (
              <FeedbackScreen
                scenario={scenario}
                score={score}
                response={responseText}
                followupAnswer={followupAnswer}
                delivery={delivery}
                utterances={utterances}
                audioBlob={audioBlob}
                onRestart={restart}
              />
            )}
          </>
        )}
      </main>
      <SiteFooter />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
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
    <div className="flex min-h-screen flex-col">
      <SiteHeader view="practice" onView={exit} theme={theme} onToggleTheme={toggleTheme} onFeedback={() => setFeedbackOpen(true)} />
      <DemoRibbon onExit={exit} />
      <main className={`w-full flex-1 mx-auto px-5 pb-20 pt-7 ${step === "feedback" ? "max-w-6xl" : "max-w-3xl"}`}>
        {step === "scenario" ? (
          <DemoScenarioStep onNext={() => setStep("feedback")} />
        ) : (
          <div className="space-y-5">
            <DemoStepHeader
              step={2}
              title="The graded feedback"
              blurb="Scored criterion by criterion against the framework. Open any tab — the Transcript even highlights the exact phrases that earned credit."
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
          <span className="ml-2">A sample session — example scenario and feedback, no account needed.</span>
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
        title="The scenario — and a sample response"
        blurb="PI Coach writes an original scenario built around the skills you want to practice, then the competitor presents. Here's an example prompt with a strong (not perfect) typed response, the way a real session looks before grading."
      />
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{s.topic}</h2>
          <span className="font-mono text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">District · Learn mode</span>
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
        <p className="text-xs leading-relaxed text-slate-400 dark:text-slate-500">
          Now see how PI Coach grades it — as a percentage, skill by skill.
        </p>
        <button className={`${BTN_PRIMARY} w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 sm:w-auto`} onClick={onNext}>
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

function SiteFooter() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/50 dark:border-slate-800/80 dark:bg-slate-950/40">
      <div className="mx-auto max-w-5xl px-5 py-6 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
        <div className="mb-3">
          <span className="font-display text-sm font-semibold text-slate-600 dark:text-slate-300">PI Coach</span>
        </div>
        <p>
          Trains the business skills and delivery that win DECA role-plays, using original practice scenarios and
          our own independent evaluation framework — not official DECA materials, and not affiliated with DECA Inc.
          Feedback is practice coaching, never an official competition score.
        </p>
        <p className="mt-1.5">
          Recordings are transcribed to measure delivery, then discarded on our servers — your audio stays on your
          device unless you keep it. Delivery covers timing only (pace, fillers, pauses), never tone or confidence.
        </p>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Bugs, ideas, what felt off — all welcome. No account needed.</p>

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
            <input
              className="mt-2 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:bg-slate-900 dark:text-slate-100"
              placeholder="Email (optional — only if you want a reply)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            {state === "error" && (
              <p className="mt-2 text-xs text-red-600">Couldn't send — check your connection and try again.</p>
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

// --- brand / shell ---------------------------------------------------------

function BrandMark({ size = 30 }: { size?: number }) {
  // Concentric target = "hit the mark" — practice until you nail it.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="#c7d2fe" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#818cf8" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3.5" fill="#4f46e5" />
    </svg>
  );
}

function SiteHeader({ view, onView, theme, onToggleTheme, onFeedback }: {
  view: View;
  onView: (v: View) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onFeedback: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-md dark:bg-slate-950/60">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
        <button onClick={() => onView("practice")} className="flex items-center gap-2.5 text-left">
          <BrandMark />
          <div className="leading-none">
            <div className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">PI Coach</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">DECA role-play practice</div>
          </div>
        </button>
        <nav className="flex items-center gap-4 sm:gap-5">
          <NavLink active={view === "practice"} onClick={() => onView("practice")}>Practice</NavLink>
          <NavLink active={view === "tips"} onClick={() => onView("tips")}>Tips</NavLink>
          <NavLink active={view === "faq"} onClick={() => onView("faq")}>FAQ</NavLink>
          <button
            onClick={onFeedback}
            aria-label="Send feedback"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-800 sm:px-2.5"
          >
            <span className="text-sm leading-none">💬</span>
            <span className="hidden sm:inline">Feedback</span>
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </nav>
      </div>
      <div className="h-px bg-gradient-to-r from-transparent via-indigo-400/50 to-transparent" />
    </header>
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

function ThemeToggle({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  const dark = theme === "dark";
  return (
    <button
      onClick={onToggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
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

// --- screens ---------------------------------------------------------------

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
    <div className="space-y-8">
      <section className="pt-4">
        <Eyebrow>DECA role-play practice</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl">
          Rehearse the room
          <br />
          <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
            before you're in it.
          </span>
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600 dark:text-slate-300">
          Pick your event, get an original role-play built around it, prep against a real timer,
          present out loud, and get honest, per-criterion feedback — content <em>and</em> delivery.
        </p>
        <button
          onClick={props.onTips}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          New to DECA role-plays? Read the competition tips →
        </button>
      </section>

      <ProcessStrip />

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
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                {props.events.length ? "Grouped by cluster — pick the one you compete in." : "Loading events…"}
              </p>
            )}
          </Field>

          <Field label="Anything specific you want to focus on? (optional)">
            <textarea
              className={`h-20 ${TEXTAREA_CLS}`}
              placeholder={
                selected
                  ? `e.g. "${suggestions[0] ?? "a challenge you want to practice"}" — or leave blank for a surprise scenario`
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
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
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
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
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
              className={`${BTN_PRIMARY} w-full whitespace-nowrap bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 sm:w-auto`}
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
  return parts.join(" — ");
}

function ProcessStrip() {
  const steps = [
    { n: "01", label: "Prep", desc: "10-min timer, notes allowed" },
    { n: "02", label: "Present", desc: "Type or speak it out loud" },
    { n: "03", label: "Feedback", desc: "Per-criterion score + fixes" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {steps.map((s) => (
        <div key={s.n} className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 transition duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md dark:border-slate-800 dark:bg-slate-800/60 dark:hover:border-indigo-900/60">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-medium text-indigo-500">{s.n}</span>
            <span className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">{s.label}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{s.desc}</p>
        </div>
      ))}
    </div>
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
          Your scenario is written. Take a breath — the prep clock only starts when you press the button.
        </p>
        {s.team && (
          <p className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-200">
            <strong className="font-semibold">Team event:</strong> you get more time — {prepMin} minutes to prep and {presentMin} to present.
            If you record, we'll pick up both partners' voices and show how the talking was split.
          </p>
        )}
        {s.quantitative && (
          <p className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
            <strong className="font-semibold">🧮 Numbers matter here:</strong> show your calculations. Any math you do is
            recomputed on our server — exactly — so your figures get checked, not guessed at.
          </p>
        )}

        <h3 className="mt-6 font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Before you start</h3>
        <ul className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-200">
          <Tip icon="✏️">Grab a pen and paper (or open notes) — you'll outline your plan during prep.</Tip>
          <Tip icon="⏱️">
            <strong className="font-semibold">{prepMin} minutes</strong> to read and plan, then{" "}
            <strong className="font-semibold">{presentMin} to present</strong> — that window includes the judge's questions.
          </Tip>
          <Tip icon="🎯">
            Aim to wrap your pitch in about <strong className="font-semibold">{targetMin} minutes</strong>, leaving the rest for the follow-up.
          </Tip>
          <Tip icon="🗣️">Find a quiet spot and present out loud — type or use 🎙️ Speak.</Tip>
          <Tip icon="❓">At the end the judge asks two follow-up questions — you'll answer those too.</Tip>
        </ul>

        <button className={`mt-6 ${BTN_PRIMARY}`} onClick={props.onStart}>
          I'm ready — start prep ({fmt(s.timing.prep_seconds)}) →
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
        I'm done prepping — I'm ready to present →
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
      : "Clock paused — it starts the moment you begin"
    : remaining === 0
      ? "Time's up — you can still finish"
      : wrapUp
        ? "Wrap up soon — leave time for the questions"
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
          <strong className="font-semibold text-slate-800 dark:text-slate-200"> won't start until you begin speaking or typing</strong> — so there's no rush to press this.
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
              placeholder="Open with a greeting, address the situation and every skill you're assessed on, propose your solution, and close. Speak it out loud as you type — that's the rep."
              value={props.value}
              onChange={(e) => handleType(e.target.value)}
            />
            <div className="mt-2 font-mono text-xs text-slate-400 dark:text-slate-500">{words} words</div>
          </>
        ) : (
          <div className="mt-3">
            <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} onStart={props.onStart} />
            <p className="mt-3 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
              Present out loud as if the judge is in front of you. We transcribe the audio and measure delivery —
              pace, fillers, pauses, time — alongside the content score. Delivery covers timing only, not tone or
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
          className={`rounded-md px-2.5 py-1 transition ${mode === m ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300" : "text-slate-500 dark:text-slate-400"}`}
          onClick={() => onMode(m)}
        >
          {m === "type" ? "✍️ Type" : "🎙️ Speak"}
        </button>
      ))}
    </div>
  );
}

function VoiceRecorder({ audioBlob, onRecorded, onStart }: { audioBlob: Blob | null; onRecorded: (b: Blob | null) => void; onStart?: () => void }) {
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
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        onRecorded(blob);
        setState("recorded");
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      recorderRef.current = mr;
      setElapsed(0);
      setState("recording");
      onStart?.(); // starting to speak starts the presentation clock
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch {
      setErr("Microphone access was blocked. Allow mic permission in your browser and try again.");
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
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">✓ Recorded — listen back below.</div>
          {previewUrl && <audio controls src={previewUrl} className="w-full" />}
          <button onClick={reset} className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400 underline">Re-record</button>
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
            <div className="mt-2 font-mono text-xs text-slate-400 dark:text-slate-500">{wordCount(props.value)} words</div>
          </>
        ) : (
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Answer out loud</label>
            <div className="mt-2">
              <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} onStart={props.onStart} />
            </div>
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              We transcribe your answer for grading. Delivery isn't scored on the follow-up — only your content.
            </p>
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

// Mirror of the backend's overall_bands, for the blended (content + delivery) score.
function levelFromPercent(p: number): RubricLevel {
  if (p >= 90) return "exemplary";
  if (p >= 70) return "proficient";
  if (p >= 40) return "developing";
  return "novice";
}

function ScorePill({ label, value, weight }: { label: string; value: number; weight: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-2.5 py-1.5 dark:border-slate-800">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</span>
        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">{weight}</span>
      </div>
      <div className="font-mono text-lg font-bold text-slate-900 dark:text-slate-100">{value}<span className="text-xs font-medium text-slate-400">%</span></div>
    </div>
  );
}

type FeedbackTab = "overview" | "transcript" | "delivery" | "criteria";

function FeedbackScreen(props: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followupAnswer: string;
  delivery: DeliveryMetrics | null;
  utterances: Utterance[];
  audioBlob: Blob | null;
  onRestart: () => void;
}) {
  const { score } = props;
  const marks = buildMarks(score.scores);
  const content = score.overall_percent;
  // When the participant spoke, delivery counts toward the overall (content 80%,
  // delivery 20%). Typed practice shows content only.
  const dscore = props.delivery ? props.delivery.delivery_score : null;
  const pct = dscore !== null ? Math.round(content * 0.8 + dscore * 0.2) : content;
  const level = dscore !== null ? levelFromPercent(pct) : score.overall_level;
  const [tab, setTab] = useState<FeedbackTab>("overview");
  const [activeMark, setActiveMark] = useState<string | null>(null);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "transcript", label: "Transcript" },
    ...(props.delivery ? [{ key: "delivery", label: "Delivery" }] : []),
    { key: "criteria", label: "Criteria", badge: `${score.total_points}/${score.max_points}` },
  ];

  return (
    <div className="lg:grid lg:grid-cols-[300px_1fr] lg:items-start lg:gap-6">
      {/* Score rail — sticks alongside the detail on wide screens. */}
      <div className="lg:sticky lg:top-24">
        <Card>
          <Eyebrow>Framework feedback</Eyebrow>
          <h2 className="mt-2 font-display text-xl font-semibold leading-snug tracking-tight text-slate-900 dark:text-slate-100">
            {props.scenario.topic}
          </h2>
          <div className="mt-5 flex items-end gap-1.5">
            <span className="font-mono text-5xl font-bold leading-none text-slate-900 dark:text-slate-100">{pct}</span>
            <span className="mb-1 font-mono text-lg font-medium text-slate-300 dark:text-slate-600">%</span>
            {dscore === null && (
              <span className="mb-1 ml-auto font-mono text-sm text-slate-500 dark:text-slate-400">{score.total_points}/{score.max_points} pts</span>
            )}
          </div>
          <div className="mt-3"><LevelMeter level={level} /></div>
          {dscore !== null && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <ScorePill label="Content" value={content} weight="80%" />
              <ScorePill label="Delivery" value={dscore} weight="20%" />
            </div>
          )}
          <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {dscore !== null ? (
              <>Blends your {score.scores.length}-skill content score with delivery. Practice coaching, not an official competition score.</>
            ) : (
              <>Graded on {score.scores.length} business skills against our evaluation framework. Practice coaching, not an official competition score.</>
            )}
          </p>
          <div className="mt-4 border-t border-slate-100 dark:border-slate-800 pt-3">
            <LevelLegend />
          </div>
        </Card>
      </div>

      <div className="mt-5 space-y-5 lg:mt-0">
        <TabBar tabs={tabs} active={tab} onChange={(k) => setTab(k as FeedbackTab)} />

        {tab === "overview" && <OverviewTab score={score} />}
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
        {tab === "criteria" && <CriteriaTab scores={score.scores} />}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
          {props.delivery ? (
            <>
              <strong className="font-semibold text-slate-700 dark:text-slate-200">Content</strong> is the rubric score;{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">Delivery</strong> measures pace, fillers, pauses, and
              time only — not tone, confidence, or charisma.
            </>
          ) : (
            <>
              Typed practice measures <strong className="font-semibold text-slate-700 dark:text-slate-200">content</strong> only. Switch to{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">🎙️ Speak</strong> on the response step to also get
              delivery feedback from your voice.
            </>
          )}
        </div>

        <button className={BTN_PRIMARY} onClick={props.onRestart}>
          Practice again →
        </button>
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
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {props.tabs.map((t) => {
        const on = t.key === props.active;
        return (
          <button
            key={t.key}
            onClick={() => props.onChange(t.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition ${
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
  return (
    <div className="space-y-4">
      {score.math_checks.length > 0 && <MathChecksCard checks={score.math_checks} />}
      {score.summary && (
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Summary</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{score.summary}</p>
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
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
          {wrong === 0 ? "all verified" : `${wrong} to fix`}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Every calculation is recomputed by our server — not the AI — so this is exact.
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
                        You said <span className="font-semibold text-red-700 dark:text-red-300">{c.claimed}{unit}</span> — the correct value is{" "}
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">{fmtNum(c.computed)}{unit}</span>.
                      </>
                    ) : good ? (
                      <>Correct — <span className="font-semibold text-emerald-700 dark:text-emerald-300">{fmtNum(c.computed)}{unit}</span>.</>
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
            <span className="font-mono text-xs text-slate-400 dark:text-slate-500">counts 20% of your overall</span>
          </div>
          <div className="mt-2 flex items-end gap-1.5">
            <span className="font-mono text-4xl font-bold leading-none text-slate-900 dark:text-slate-100">{m.delivery_score}</span>
            <span className="mb-0.5 font-mono text-base font-medium text-slate-300 dark:text-slate-600">/100</span>
          </div>
          <div className="mt-4 space-y-2.5">
            {m.delivery_components.map((c) => (
              <div key={c.label}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700 dark:text-slate-200">{c.label}</span>
                  <span className="text-slate-400 dark:text-slate-500">{c.hint}</span>
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
              <span className="font-mono text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">Fillers</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {m.fillers.map((f) => <Chip key={f.word}>{f.word} ×{f.count}</Chip>)}
              </div>
            </div>
          )}
          {m.crutch_phrases.length > 0 && (
            <div className="mt-3">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">Crutch phrases (advisory)</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {m.crutch_phrases.map((f) => <Chip key={f.phrase}>{f.phrase} ×{f.count}</Chip>)}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
        Delivery is deterministic timing measured from your audio — accurate and honest. It does not judge tone,
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
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">team event</span>
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
              <p className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
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
            {r.topic && <span className="ml-1 font-mono text-xs font-normal text-slate-400 dark:text-slate-500">· {r.topic}</span>}
          </p>
          {headline && <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{headline}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
          <span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">{r.points}/{r.max_points}</span>
          {hasDetail && <span className="text-xs text-slate-400 dark:text-slate-500">{open ? "▾" : "▸"}</span>}
        </div>
      </button>
      {open && hasDetail && (
        <div className="border-t border-black/5 px-3.5 pb-3 pt-2.5 dark:border-white/10">
          {r.feedback && <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{richText(r.feedback)}</p>}
          {r.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
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

function MissingCard({ scores }: { scores: CriterionScore[] }) {
  const rows = scores.filter((s) => s.gaps.length > 0 && s.level !== "exemplary");
  if (rows.length === 0) return null;
  return (
    <Card className="border-amber-200 dark:border-amber-900/60">
      <h3 className="font-display text-sm font-semibold text-amber-900 dark:text-amber-300">What was missing</h3>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Gaps that cost points — these weren't in your response, so they can't be highlighted. Add them next time.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((s) => (
          <div key={s.criterion_id}>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
              {s.name}
              {s.topic && <span className="ml-1 font-mono text-slate-400 dark:text-slate-500">· {s.topic}</span>}
            </p>
            <ul className="mt-1 space-y-1">
              {s.gaps.map((g, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-slate-600 dark:text-slate-300"><span className="text-amber-500">+</span><span>{g}</span></li>
              ))}
            </ul>
            {s.suggestion && (
              <p className="mt-1.5 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/70 px-2.5 py-1.5 text-xs leading-relaxed text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">
                <span className="font-semibold">💡 Could've said:</span> <span className="italic">“{s.suggestion}”</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
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
  const activeMark = props.marks.find((m) => m.id === props.active) ?? null;
  const activeSuggestion = activeMark && activeMark.level !== "exemplary"
    ? props.scores.find((s) => s.criterion_id === activeMark.criterionId)?.suggestion ?? ""
    : "";
  const tone = activeMark ? LEVEL_TONE[activeMark.level] : null;
  const hasTurns = props.utterances.length > 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_19rem]">
      <div className="order-2 space-y-4 lg:order-1">
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your presentation</h3>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {hasTurns
              ? "Split by speaker so you can see who said what. Highlights mark where each criterion found credit; 💡 notes show what you could have said. Tap a highlight for detail."
              : "Highlights mark where each criterion found credit (color = the level it reached); 💡 notes woven in show what you could have said. Tap a highlight for the note."}
          </p>
          {hasTurns ? (
            <div className="mt-3 space-y-3">
              {props.utterances.map((u, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold text-white ${SPEAKER_BAR[speakerIndex(props.utterances, u.speaker) % SPEAKER_BAR.length]}`}>
                    {u.speaker}
                  </span>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">
                    {highlight(u.text, props.marks, props.active, props.onSelect)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">
              {highlight(props.response, props.marks, props.active, props.onSelect)}
            </p>
          )}
        </Card>

        {props.followupAnswer.trim() && (
          <Card>
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your follow-up answer</h3>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">
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

      <div className="order-1 space-y-3 lg:order-2">
        <div className="lg:sticky lg:top-20">
          <Card>
            <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Annotation</h3>
            {activeMark && tone ? (
              <div className={`mt-2 rounded-xl border ${tone.border} ${tone.bg} px-3 py-2.5`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{activeMark.label}</span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
                    <span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">{activeMark.points}/{activeMark.maxPoints}</span>
                  </span>
                </div>
                <p className="mt-1.5 text-sm italic text-slate-500 dark:text-slate-400">“{activeMark.quote}”</p>
                {activeMark.feedback && <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{richText(activeMark.feedback)}</p>}
                {activeSuggestion && (
                  <p className="mt-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/70 px-2.5 py-1.5 text-xs leading-relaxed text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">
                    <span className="font-semibold">💡 What you could have said:</span> <span className="italic">“{activeSuggestion}”</span>
                  </p>
                )}
                <button className="mt-2 font-mono text-xs font-medium text-slate-400 dark:text-slate-500 underline" onClick={() => props.onSelect(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                Tap any highlighted phrase in your transcript to see which criterion it counted toward, the level it
                reached, and why.
              </p>
            )}
            <div className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3">
              <LevelLegend />
            </div>
          </Card>
        </div>
        <MissingCard scores={props.scores} />
      </div>
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
        onClick={() => onSelect(on ? null : f.mark.id)}
        title={`${f.mark.label} · ${LEVEL_TONE[f.mark.level].label}`}
        className={`cursor-pointer rounded px-0.5 underline decoration-dotted underline-offset-2 ${LEVEL_TONE[f.mark.level].mark} ${on ? "ring-2 ring-indigo-500/50" : ""}`}
      >
        {text.slice(f.start, f.end)}
      </mark>,
    );
    // "What you could have said" — woven into the transcript right after the phrase.
    if (f.mark.suggestion) {
      nodes.push(
        <span
          key={`s${i}`}
          className="mx-1 inline-flex items-baseline gap-1 rounded-md border border-dashed border-indigo-300 bg-indigo-50/80 px-1.5 py-0.5 align-baseline text-[0.85em] leading-snug text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-200"
        >
          <span aria-hidden>💡</span>
          <span><span className="font-semibold">Could've said:</span> <span className="italic">“{f.mark.suggestion}”</span></span>
        </span>,
      );
    }
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
        {hint && <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">{hint}</span>}
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
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${on ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300" : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"}`}
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
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {learn
            ? "The business skills this role-play assesses — with what a strong answer looks like, so you can aim for it."
            : "The business skills this role-play assesses, by name — just like a real role-play sheet. You supply the substance."}
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
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
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
        against our own evaluation framework — not an official competition score.
      </p>
    </Card>
  );
}

function HonestyNote() {
  return (
    <p className="max-w-xs text-xs leading-relaxed text-slate-400 dark:text-slate-500">
      Original practice scenarios that train the skills DECA role-plays reward — not official DECA materials.
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
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${tones.box} ${sticky ? "sticky top-[68px] z-10" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{label}</div>
        <div className={`font-mono text-2xl font-bold tabular-nums ${tones.num}`}>{fmt(left)}</div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/5">
        <div className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${tones.bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
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
            + 2 background-colored "gap" rings + a glowing dot) share one wave
            keyframe, staggered center→edge so the pulse travels outward. The gap
            rings are the card's own bg, which is what creates the ring illusion.
            Layers are centered with `inset-0 m-auto` (not transforms) so the
            scale animation is free to drive `transform`. */}
        <div className="relative grid place-items-center" style={{ width: 120, height: 120 }}>
          <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: 120, height: 120, background: "#4c5fe4", animationDelay: "0.45s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full bg-white dark:bg-slate-900" style={{ width: 88, height: 88, animationDelay: "0.3s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: 58, height: 58, background: "#7c8cf7", animationDelay: "0.15s" }} />
          <span className="pic-wave absolute inset-0 m-auto rounded-full bg-white dark:bg-slate-900" style={{ width: 31, height: 31, animationDelay: "0.05s" }} />
          <span className="pic-wave-dot absolute inset-0 m-auto rounded-full" style={{ width: 14, height: 14, background: "#a9b6ff" }} />
        </div>

        <div className="text-center">
          <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{title}</p>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-500">PI Coach</p>
        </div>

        {/* Indeterminate progress sweep. */}
        <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className="pic-sweep h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent" />
        </div>

        {/* Staged checklist — done steps check off, the current one spins. */}
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
            response against those exact skills — quoting the phrases that earned credit and naming what was missing.
          </p>
          <p>
            If you speak your answer, your audio is transcribed and we compute delivery metrics (pace, fillers, pauses,
            timing) with plain arithmetic — no AI opinion involved there.
          </p>
        </FAQItem>
        <FAQItem q="Can I trust the score? Is the AI just making things up?">
          <p>
            The score is <strong className="font-semibold text-slate-800 dark:text-slate-200">practice coaching, not an official or predicted competition score</strong> — no tool
            can promise your real judge's number. We keep it honest in a few concrete ways: every skill is graded
            against a written “strong vs. weak” bar so name-dropping a term doesn't earn full marks, and the feedback
            has to cite exact quotes from what you said.
          </p>
          <p>
            For finance and accounting events, we go further: the AI is <em>not trusted to do arithmetic</em>. It hands
            each calculation to our server as a formula, and Python computes it — so a “Math check” either confirms your
            number or shows the correct one. It can't tell you you're wrong when you're right.
          </p>
        </FAQItem>
        <FAQItem q="What about my voice recording and privacy?">
          <p>
            Recordings are sent to a transcription service to measure delivery, then discarded on our servers — we keep
            only the transcript and the numbers. Your audio stays on your device unless you choose to keep it. Delivery
            covers timing only (pace, fillers, pauses) — never tone, confidence, accent, or “charisma.”
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
              said — highlighting the exact words that earned credit, and showing <em>“what you could have said”</em>
              right in your transcript where a stronger line would have raised your score.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Skill by skill, with the gaps.</strong> Every indicator is scored against a written “strong vs. weak”
              bar, so name-dropping a term doesn't fool it — and you get the concrete thing that was missing.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Delivery that counts.</strong> Present out loud and your pace, fillers, pauses, and timing are
              measured and folded into your score — for team events we even show who dominated the talking.
            </li>
            <li>
              <strong className="font-semibold text-slate-800 dark:text-slate-200">Math you can trust.</strong> On finance events, every calculation is recomputed on our server, so a
              wrong number is caught with the right one — never guessed at.
            </li>
          </ul>
          <p>
            It's all built on our own evaluation framework, authored from public business fundamentals (more on why
            below) — so the coaching is ours, end to end.
          </p>
        </FAQItem>
        <FAQItem q="Why build your own framework instead of using DECA's performance indicators?">
          <p>
            DECA / MBA Research's performance-indicator lists are <strong className="font-semibold text-slate-800 dark:text-slate-200">licensed intellectual property</strong>. Rather than
            ship their exact wording, codes, and event-to-PI mapping, we authored our own framework of business skills
            from the underlying public concepts — the same fundamentals taught in any business course. It's the right
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
            Practicing your own skills with original scenarios is ordinary prep — like a mock interview. What isn't okay
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
            <li>Use the prep timer for real — the pressure is the point — and always answer the follow-up questions.</li>
            <li>Read the <strong className="font-semibold text-slate-800 dark:text-slate-200">gaps</strong> in each criterion; they're the exact things that would raise your level next time.</li>
            <li>Climb the levels: <strong className="font-semibold text-slate-800 dark:text-slate-200">District → State → ICDC</strong> as the scenarios get harder.</li>
          </ul>
        </FAQItem>
        <FAQItem q="How do team events work here?">
          <p>
            Pick any “(Team)” event and you get a longer prep and presentation window, matching how team decision-making
            runs. If you record, we pick up both partners' voices and show a <strong className="font-semibold text-slate-800 dark:text-slate-200">talk-time balance</strong> — so you can see if
            one person dominated, and read the transcript split by speaker. Right now you present together on one
            device; there's no separate second-competitor simulation.
          </p>
        </FAQItem>
      </FAQGroup>

      <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 dark:border-indigo-900/60 dark:from-indigo-950/40 dark:to-violet-950/30">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Still have a question?</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Use the 💬 Feedback button up top — we read everything.</p>
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
          The competitors who place run every skill they're assessed on through the same four beats — and back it with a
          visual the judge can't forget. Here's the method, with a worked example you can copy.
        </p>
      </section>

      {/* The DECA method */}
      <section>
        <SectionHead eyebrow="The core skill" title="The method for nailing a skill">
          One running example — <strong className="font-semibold text-slate-700 dark:text-slate-200">channel strategy</strong> for
          BrightBean, a small coffee roaster — carried through all four beats.
        </SectionHead>
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          <MethodCard
            n="1" accent="indigo" title="Define"
            todo="Clearly and confidently define the skill or any key terms right away. Skip the textbook jargon — keep it simple and conversational so the judge knows you grasp the core concept."
            example={<>“Channel strategy is just <em>how our product gets from us into the customer's hands</em> — the path it travels to reach them.”</>}
          />
          <MethodCard
            n="2" accent="violet" title="Explain"
            todo="Elaborate on why this skill matters to a business — its broader impact, what it does, and why a company has to pay attention to it in the real world."
            example={<>“Get the mix right and you control both your <em>margins</em> and how many customers you can reach. Lean on one channel and you're exposed; spread too thin and you lose focus.”</>}
          />
          <MethodCard
            n="3" accent="fuchsia" title="Connect" highlight="Earns the most points"
            todo="Directly apply the skill to your specific role-play scenario. Weave the concept into your actual proposed solution, product, or strategy — that's the systems thinking judges reward."
            example={<>“For BrightBean, I'd add a <em>direct-to-consumer subscription</em> next to the coffee bar — it captures our regulars at full margin and gives us first-party data wholesale never will.”</>}
          />
          <MethodCard
            n="4" accent="amber" title="Above & Beyond"
            todo="Differentiate yourself. Add a creative element beyond the prompt: a quick chart, a real-world statistic, a famous brand case, or a niche business term."
            example={<>“Quick math — 200 regulars at $20/mo is <em>~$48K/yr recurring</em>, about what a second wholesale account brings but at double the margin. (then I'd sketch a bar comparing the two.)”</>}
          />
        </div>
        <p className="mt-5 flex items-start gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3.5 text-sm leading-relaxed text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-200">
          <span className="mt-0.5 shrink-0 font-mono text-xs font-bold uppercase tracking-wider text-indigo-500">Tip</span>
          <span>If your sentence about the skill could apply to <em>any</em> company, you've only <strong className="font-semibold">Defined</strong> it. The points live in <strong className="font-semibold">Connect</strong> — tie it to the scenario in front of you.</span>
        </p>
      </section>

      {/* Visuals */}
      <section>
        <SectionHead eyebrow="Make it stick" title="Use visuals to your advantage">
          You get pen and paper in prep — most competitors only scribble notes. Draw <em>one</em> clean visual, turn it
          toward the judge, and reference it out loud. Here's what to reach for and when.
        </SectionHead>
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <VisualCard chart={<ChartBars />} title="Bar chart" when="Comparing 2–3 options on cost, margin, or risk to justify your pick." />
          <VisualCard chart={<ChartLine />} title="Trend line" when="Anchoring the problem in data — a sales dip, a target, a before/after." />
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
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TipCard eyebrow="Prep time" title="Own your 10 minutes" items={[
            "Read the situation twice; underline the actual ask.",
            "Map each assessed skill to a moment in your plan.",
            "Draft your visual early — not at the last minute.",
            "Outline your open and close so you bookend strong.",
          ]} />
          <TipCard eyebrow="Structure" title="A shape judges reward" items={[
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Open:</strong> greet, confirm your role, preview.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Body:</strong> walk the solution, hit every assessed skill through all four beats.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Close:</strong> restate the recommendation, invite questions.</>,
          ]} />
          <TipCard eyebrow="Follow-up" title="Handle the questions" items={[
            "Take a beat — a short pause beats rambling.",
            "Answer directly, then tie back to your recommendation.",
            "If unsure, reason out loud; judges reward sound thinking.",
          ]} />
          <TipCard eyebrow="Delivery" title="Sound like a pro" items={[
            "Steady pace (~130–160 wpm); trade “um” for a pause.",
            "Make eye contact and use the judge's name.",
            "Use the time, but leave room for the questions.",
          ]} />
        </div>
      </section>

      {/* Notebook */}
      <section>
        <SectionHead eyebrow="Prep like a pro" title="How to lay out your notebook page">
          Your prep paper is a map you'll present from — not an essay. Set it up the same way every time so, under
          pressure, your eyes always know where to look. Here's a layout that works.
        </SectionHead>
        <div className="mt-7 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <NotebookMock />
          <div className="space-y-3">
            <NotebookStep n="1" title="Company & your role" body="Top of the page: the company name and the exact role you're playing. It anchors everything and stops you slipping out of character." />
            <NotebookStep n="2" title="The problem, in one line" body="Force yourself to write the actual ask in a single sentence. If you can't, you haven't found it yet — reread the situation." />
            <NotebookStep n="3" title="Each indicator + your own definition" body="List the skills you're assessed on. Next to each, write a short definition in YOUR words — that's your Define beat, ready to go." />
            <NotebookStep n="4" title="A tie-back bullet per indicator" body="Under each, one bullet on how it applies to THIS scenario. That bullet is your Connect beat — where the points live." />
            <NotebookStep n="5" title="Open & close" body="Jot your first line and last line. Bookending strong is half the impression, and it saves you when nerves hit." />
          </div>
        </div>
      </section>

      {/* Fill the time */}
      <section>
        <SectionHead eyebrow="Command the room" title="Acronyms, and how to fill the time">
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
              “My retention plan follows <strong className="font-semibold">R.A.M.P.</strong> — <strong className="font-semibold">R</strong>eward loyalty,
              <strong className="font-semibold"> A</strong>utomate the outreach, <strong className="font-semibold">M</strong>easure repeat visits,
              <strong className="font-semibold"> P</strong>ilot before rollout.”
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
              Keep it to 3–5 letters and make each one real. A clear structure beats a clever-but-empty one.
            </p>
          </Card>
          <Card>
            <Eyebrow>Fill the time with substance</Eyebrow>
            <h3 className="mt-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">Add depth, not padding</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Running short? Don't slow down or repeat — add another layer. Each of these buys real time and earns points:
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
              <Tip icon="④">Run every skill through all four beats (Define → Explain → Connect → Above &amp; Beyond).</Tip>
              <Tip icon="⚖️">Name a second option you considered and why you rejected it.</Tip>
              <Tip icon="🔢">Quantify — a rough number, a cost, or a target makes it concrete.</Tip>
              <Tip icon="🗓️">Add an implementation timeline (first 30 days, then 90).</Tip>
              <Tip icon="⚠️">Raise a risk and how you'd handle it — judges love foresight.</Tip>
              <Tip icon="🏆">Drop a real brand example or a quick stat as proof.</Tip>
            </ul>
          </Card>
        </div>
      </section>

      {/* CTA */}
      <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 dark:border-indigo-900/60 dark:from-indigo-950/40 dark:to-violet-950/30">
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

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">{title}</h2>
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

function MethodCard({ n, title, accent, todo, example, highlight }: {
  n: string; title: string; accent: keyof typeof METHOD_ACCENT; todo: ReactNode; example: ReactNode; highlight?: string;
}) {
  const a = METHOD_ACCENT[accent];
  return (
    <div className={`group flex h-full flex-col rounded-2xl border bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:bg-slate-900 ${highlight ? "border-fuchsia-300 dark:border-fuchsia-800/70" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-sm font-bold text-white ${a.badge}`}>{n}</span>
        <h3 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h3>
        {highlight && (
          <span className="ml-auto rounded-full bg-fuchsia-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300">{highlight}</span>
        )}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{todo}</p>
      <div className={`mt-4 rounded-r-lg border-l-2 bg-slate-50 px-3.5 py-2.5 dark:bg-slate-800/40 ${a.rule}`}>
        <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.15em] ${a.tag}`}>Example</span>
        <p className="mt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{example}</p>
      </div>
    </div>
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

function TipCard({ eyebrow, title, items }: { eyebrow: string; title: string; items: ReactNode[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="mt-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
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
        <p className="font-bold text-slate-900 dark:text-slate-100">FreshBrew Coffee Co. — Marketing Consultant</p>
        <p className="mt-1 text-slate-500 dark:text-slate-400">Problem: afternoons are dead + first-timers don't return.</p>
        <div className="mt-3 space-y-2.5">
          {[
            { pi: "Promotional strategy", def: "= the mix of ways we reach customers", tie: "→ app push + a 3–5pm power hour" },
            { pi: "Customer relationships", def: "= turning buyers into regulars", tie: "→ tiered loyalty, birthday reward" },
            { pi: "Channel strategy", def: "= how the product reaches them", tie: "→ own the app, drop 3rd-party fees" },
            { pi: "Measuring success", def: "= how we'll know it worked", tie: "→ repeat-visit rate, +15% / 2 qtrs" },
          ].map((r) => (
            <div key={r.pi}>
              <p><span className="font-semibold text-indigo-700 dark:text-indigo-300">▸ {r.pi}</span> <span className="text-slate-400 dark:text-slate-500">{r.def}</span></p>
              <p className="pl-4 text-emerald-700 dark:text-emerald-400">{r.tie}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-slate-500 dark:text-slate-400">Open: “Thanks for having me — here's how we win back the afternoon.”</p>
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
      <span className="text-slate-400 dark:text-slate-500">· green = top band, not a perfect score</span>
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
