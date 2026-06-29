import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type AreaSummary,
  type DeliveryMetrics,
  type EventSummary,
  type Level,
  type RubricCriterion,
  type RubricLevel,
  type RubricScore,
  type ScenarioResponse,
  type ScoreResponse,
  getEventAreas,
  getEvents,
  postDelivery,
  postFeedback,
  postScenario,
  postScore,
} from "./api";
import { track } from "./analytics";

type ResponseMode = "type" | "speak";
const CAN_RECORD = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

const PREP_SECONDS = 10 * 60;
// One 10-minute presentation budget shared by the response and the judge's
// questions. The response clock counts it down; the follow-up inherits the rest.
const PRESENTATION_SECONDS = 10 * 60;
const RECOMMENDED_SPEAK_SECONDS = 450; // 7:30 — what delivery time is graded against

type Stage = "pick" | "loading" | "ready" | "prep" | "respond" | "followup" | "scoring" | "feedback";

export default function App() {
  const [stage, setStage] = useState<Stage>("pick");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCode, setEventCode] = useState("");
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [area, setArea] = useState(""); // "" = let it choose
  const [level, setLevel] = useState<Level>("district");
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);
  const [mode, setMode] = useState<ResponseMode>("type");
  const [responseText, setResponseText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [presentationEndsAt, setPresentationEndsAt] = useState<number | null>(null);
  const [followupMode, setFollowupMode] = useState<ResponseMode>("type");
  const [followupAnswer, setFollowupAnswer] = useState("");
  const [followupAudio, setFollowupAudio] = useState<Blob | null>(null);
  const [score, setScore] = useState<ScoreResponse | null>(null);
  const [delivery, setDelivery] = useState<DeliveryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"practice" | "tips">("practice");
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    getEvents()
      .then((evs) => {
        setEvents(evs);
        if (evs[0]) setEventCode(evs[0].code);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  // Load the selected event's instructional areas for the focus picker.
  useEffect(() => {
    if (!eventCode) return;
    setArea("");
    let live = true;
    getEventAreas(eventCode)
      .then((a) => live && setAreas(a))
      .catch(() => live && setAreas([]));
    return () => {
      live = false;
    };
  }, [eventCode]);

  async function generate() {
    setError(null);
    setStage("loading");
    try {
      const s = await postScenario({ event_code: eventCode, level, area: area || undefined });
      track("scenario_generated", { event_code: eventCode, level, focus_area: area || "auto" });
      setScenario(s);
      setResponseText("");
      setAudioBlob(null);
      setPresentationEndsAt(null);
      setFollowupAnswer("");
      setFollowupAudio(null);
      setScore(null);
      setDelivery(null);
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
        const d = await postDelivery(audioBlob, RECOMMENDED_SPEAK_SECONDS);
        responseForScoring = d.transcript;
        deliveryMetrics = d.metrics;
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
        const fd = await postDelivery(followupAudio, RECOMMENDED_SPEAK_SECONDS);
        followupForScoring = fd.transcript;
        setFollowupAnswer(fd.transcript);
      }

      const result = await postScore({
        event_code: scenario.event.code,
        scenario: scenario.situation,
        pi_ids: scenario.performance_indicators.map((p) => p.id),
        response: responseForScoring,
        followup_questions: scenario.followup_questions,
        followup_answer: followupForScoring,
      });
      setDelivery(deliveryMetrics);
      setScore(result);
      track("scored", {
        event_code: scenario.event.code,
        total_points: result.total_points,
        pct: Math.round((result.total_points / result.max_points) * 100),
        mode,
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
    setResponseText("");
    setAudioBlob(null);
    setPresentationEndsAt(null);
    setFollowupAnswer("");
    setFollowupAudio(null);
    setError(null);
    setStage("pick");
  }

  const wide = stage === "feedback" || view === "tips";

  return (
    <div className="min-h-screen">
      <SiteHeader view={view} onView={setView} theme={theme} onToggleTheme={toggleTheme} />
      <main className={`mx-auto px-5 pb-20 pt-8 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {view === "tips" ? (
          <TipsPage onStart={() => setView("practice")} />
        ) : (
          <>
            {stage === "pick" && (
              <PickScreen
                events={events}
                eventCode={eventCode}
                areas={areas}
                area={area}
                level={level}
                onEvent={setEventCode}
                onArea={setArea}
                onLevel={setLevel}
                onGenerate={generate}
                onTips={() => setView("tips")}
              />
            )}

            {stage === "loading" && <LoadingScreen label="Writing an original scenario…" />}

            {stage === "ready" && scenario && <ReadyScreen scenario={scenario} onStart={() => setStage("prep")} />}

            {stage === "prep" && scenario && (
              <PrepScreen
                scenario={scenario}
                onStart={() => {
                  setPresentationEndsAt(Date.now() + PRESENTATION_SECONDS * 1000);
                  setStage("respond");
                }}
              />
            )}

            {stage === "respond" && scenario && (
              <RespondScreen
                scenario={scenario}
                endsAt={presentationEndsAt}
                mode={mode}
                onMode={setMode}
                value={responseText}
                onChange={setResponseText}
                audioBlob={audioBlob}
                onRecorded={setAudioBlob}
                onContinue={() => setStage("followup")}
              />
            )}

            {stage === "followup" && scenario && (
              <FollowupScreen
                scenario={scenario}
                endsAt={presentationEndsAt}
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
              <LoadingScreen label={mode === "speak" ? "Transcribing and grading your delivery…" : "Grading your response against the rubric…"} />
            )}

            {stage === "feedback" && score && scenario && (
              <FeedbackScreen
                scenario={scenario}
                score={score}
                response={responseText}
                followupAnswer={followupAnswer}
                delivery={delivery}
                audioBlob={audioBlob}
                onRestart={restart}
              />
            )}
          </>
        )}
      </main>
      <SiteFooter />
      <FloatingFeedback />
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
          Generates original practice scenarios in DECA's style — not official DECA materials, and not affiliated
          with DECA Inc. Feedback is practice coaching, never an official competition score.
        </p>
        <p className="mt-1.5">
          Recordings are transcribed to measure delivery, then discarded on our servers — your audio stays on your
          device unless you keep it. Delivery covers timing only (pace, fillers, pauses), never tone or confidence.
        </p>
      </div>
    </footer>
  );
}

function FloatingFeedback() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-700 hover:shadow-indigo-600/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
      >
        <span className="text-base leading-none">💬</span>
        <span className="hidden sm:inline">Feedback</span>
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
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
  // Concentric target = "performance indicator / hit the mark".
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="#c7d2fe" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#818cf8" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3.5" fill="#4f46e5" />
    </svg>
  );
}

function SiteHeader({ view, onView, theme, onToggleTheme }: {
  view: "practice" | "tips";
  onView: (v: "practice" | "tips") => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
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
        <nav className="flex items-center gap-5 sm:gap-6">
          <NavLink active={view === "practice"} onClick={() => onView("practice")}>Practice</NavLink>
          <NavLink active={view === "tips"} onClick={() => onView("tips")}>Tips</NavLink>
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
  eventCode: string;
  areas: AreaSummary[];
  area: string;
  level: Level;
  onEvent: (c: string) => void;
  onArea: (a: string) => void;
  onLevel: (l: Level) => void;
  onGenerate: () => void;
  onTips: () => void;
}) {
  // Group events by cluster_label, preserving first-seen order.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup: Record<string, EventSummary[]> = {};
    for (const e of props.events) {
      const g = e.cluster_label || "Other";
      if (!byGroup[g]) {
        byGroup[g] = [];
        order.push(g);
      }
      byGroup[g].push(e);
    }
    return order.map((g) => ({ label: g, events: byGroup[g] }));
  }, [props.events]);

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
          Generate an original scenario in DECA's format, prep against a real timer, present out loud, and get
          honest, per-indicator feedback — content <em>and</em> delivery.
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
          <Field label="Event" hint={`${props.events.length} events`}>
            <select
              className={SELECT_CLS}
              value={props.eventCode}
              onChange={(e) => props.onEvent(e.target.value)}
            >
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.events.map((e) => (
                    <option key={e.code} value={e.code}>
                      {e.name} ({e.code})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Focus area" hint="optional">
            <select className={SELECT_CLS} value={props.area} onChange={(e) => props.onArea(e.target.value)}>
              <option value="">Any — let it choose</option>
              {props.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id}) · {a.pi_count} PIs
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
              Pin the scenario to one instructional area, or let PI Coach pick a coherent set.
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
              disabled={!props.eventCode}
            >
              Generate scenario →
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProcessStrip() {
  const steps = [
    { n: "01", label: "Prep", desc: "10-min timer, notes allowed" },
    { n: "02", label: "Present", desc: "Type or speak it out loud" },
    { n: "03", label: "Feedback", desc: "Per-indicator score + fixes" },
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
  return (
    <div className="space-y-4">
      <Card>
        <Eyebrow>Ready when you are</Eyebrow>
        <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {s.event.name}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{s.instructional_area}</p>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Your scenario is written. Take a breath — the prep clock only starts when you press the button.
        </p>

        <h3 className="mt-6 font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Before you start</h3>
        <ul className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-200">
          <Tip icon="✏️">Grab a pen and paper (or open notes) — you'll outline your plan during prep.</Tip>
          <Tip icon="⏱️">
            <strong className="font-semibold">10 minutes</strong> to read and plan, then{" "}
            <strong className="font-semibold">10 to present</strong> — that window includes the judge's questions.
          </Tip>
          <Tip icon="🎯">
            Aim to wrap your pitch in about <strong className="font-semibold">7–8 minutes</strong>, leaving 1–2 for the follow-up.
          </Tip>
          <Tip icon="🗣️">Find a quiet spot and present out loud — type or use 🎙️ Speak.</Tip>
          <Tip icon="❓">At the end the judge asks two follow-up questions — you'll answer those too.</Tip>
        </ul>

        <button className={`mt-6 ${BTN_PRIMARY}`} onClick={props.onStart}>
          I'm ready — start prep (10:00) →
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
  const left = useCountdown(PREP_SECONDS, true, props.onStart);
  return (
    <div className="space-y-4">
      <TimerBar label="Prep time" left={left} total={PREP_SECONDS} tone="indigo" />
      <CoverSheet scenario={props.scenario} />
      <SituationSheet text={props.scenario.situation} />
      <button className={BTN_PRIMARY} onClick={props.onStart}>
        Start my response →
      </button>
    </div>
  );
}

function RespondScreen(props: {
  scenario: ScenarioResponse;
  endsAt: number | null;
  mode: ResponseMode;
  onMode: (m: ResponseMode) => void;
  value: string;
  onChange: (v: string) => void;
  audioBlob: Blob | null;
  onRecorded: (b: Blob | null) => void;
  onContinue: () => void;
}) {
  const left = useDeadline(props.endsAt);
  const words = wordCount(props.value);
  const canContinue = props.mode === "type" ? !!props.value.trim() : !!props.audioBlob;
  const wrapUp = left > 0 && left <= 150;
  const label = left === 0
    ? "Presentation time — time's up (you can still continue)"
    : wrapUp
      ? "Wrap up soon — leave time for the questions"
      : "Presentation time (shared with the judge's questions)";
  return (
    <div className="space-y-4">
      <TimerBar label={label} left={left} total={PRESENTATION_SECONDS} tone={left === 0 ? "red" : wrapUp ? "amber" : "slate"} />

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
              placeholder="Open with a greeting, address the situation and every performance indicator, propose your solution, and close. Speak it out loud as you type — that's the rep."
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
            />
            <div className="mt-2 font-mono text-xs text-slate-400 dark:text-slate-500">{words} words</div>
          </>
        ) : (
          <div className="mt-3">
            <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} />
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

function VoiceRecorder({ audioBlob, onRecorded }: { audioBlob: Blob | null; onRecorded: (b: Blob | null) => void }) {
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
  endsAt: number | null;
  mode: ResponseMode;
  onMode: (m: ResponseMode) => void;
  value: string;
  onChange: (v: string) => void;
  audioBlob: Blob | null;
  onRecorded: (b: Blob | null) => void;
  onSubmit: () => void;
}) {
  const left = useDeadline(props.endsAt);
  const qs = props.scenario.followup_questions;
  const canSubmit = props.mode === "type" ? !!props.value.trim() : !!props.audioBlob;
  return (
    <div className="space-y-4">
      <TimerBar
        label={left === 0 ? "Time's up — you can still answer" : "The judge follows up (same 10-min window)"}
        left={left}
        total={PRESENTATION_SECONDS}
        tone={left === 0 ? "red" : left <= 60 ? "amber" : "slate"}
      />
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
              placeholder="Answer the judge's questions directly. This is graded as part of your overall impression."
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
            />
            <div className="mt-2 font-mono text-xs text-slate-400 dark:text-slate-500">{wordCount(props.value)} words</div>
          </>
        ) : (
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Answer out loud</label>
            <div className="mt-2">
              <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} />
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

type FeedbackTab = "overview" | "transcript" | "delivery" | RubricScore["category"];

const CATEGORIES: { key: RubricScore["category"]; label: string; tab: string }[] = [
  { key: "performance_indicator", label: "Performance Indicators", tab: "Indicators" },
  { key: "solution", label: "Solution", tab: "Solution" },
  { key: "career_competency", label: "Career Competencies", tab: "Competencies" },
  { key: "overall_impression", label: "Overall Impression", tab: "Overall" },
];

function FeedbackScreen(props: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followupAnswer: string;
  delivery: DeliveryMetrics | null;
  audioBlob: Blob | null;
  onRestart: () => void;
}) {
  const { score } = props;
  const marks = buildMarks(score.scores);
  const pct = Math.round((score.total_points / score.max_points) * 100);
  const overall = score.scores.find((s) => s.category === "overall_impression");
  const [tab, setTab] = useState<FeedbackTab>("overview");
  const [activeMark, setActiveMark] = useState<string | null>(null);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "transcript", label: "Transcript" },
    ...(props.delivery ? [{ key: "delivery", label: "Delivery" }] : []),
    ...CATEGORIES.map((c) => ({ key: c.key, label: c.tab, badge: subtotalStr(score.scores, c.key) })),
  ];

  return (
    <div className="lg:grid lg:grid-cols-[300px_1fr] lg:items-start lg:gap-6">
      {/* Score rail — sticks alongside the detail on wide screens. */}
      <div className="lg:sticky lg:top-24">
        <Card>
          <Eyebrow>Rubric feedback</Eyebrow>
          <h2 className="mt-2 font-display text-xl font-semibold leading-snug tracking-tight text-slate-900 dark:text-slate-100">
            {props.scenario.event.name}
          </h2>
          <div className="mt-5 flex items-end gap-1.5">
            <span className="font-mono text-5xl font-bold leading-none text-slate-900 dark:text-slate-100">{score.total_points}</span>
            <span className="mb-1 font-mono text-lg font-medium text-slate-300 dark:text-slate-600">/ {score.max_points}</span>
            <span className="mb-1 ml-auto font-mono text-sm text-slate-500 dark:text-slate-400">{pct}%</span>
          </div>
          {overall && <div className="mt-3"><LevelMeter level={overall.level} /></div>}
          <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Graded on the DECA 2026 District rubric. Practice coaching, not an official competition score.
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
          />
        )}
        {tab === "delivery" && props.delivery && <DeliveryTab metrics={props.delivery} audioBlob={props.audioBlob} />}
        {CATEGORIES.some((c) => c.key === tab) && <CategoryTab category={tab as RubricScore["category"]} scores={score.scores} />}

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

function subtotal(scores: RubricScore[], cat: RubricScore["category"]): [number, number] {
  const rows = scores.filter((s) => s.category === cat);
  return [rows.reduce((a, r) => a + r.points, 0), rows.reduce((a, r) => a + r.max_points, 0)];
}

function subtotalStr(scores: RubricScore[], cat: RubricScore["category"]): string {
  const [p, m] = subtotal(scores, cat);
  return `${p}/${m}`;
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

function CategoryTab({ category, scores }: { category: RubricScore["category"]; scores: RubricScore[] }) {
  const meta = CATEGORIES.find((c) => c.key === category)!;
  const rows = scores.filter((s) => s.category === category);
  const [p, m] = subtotal(scores, category);
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
        <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">{meta.label}</h3>
        <span className="font-mono text-sm font-semibold text-slate-500 dark:text-slate-400">{p}/{m}</span>
      </div>
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <CriterionRow key={r.key} r={r} />
        ))}
      </div>
    </Card>
  );
}

function DeliveryTab({ metrics: m, audioBlob }: { metrics: DeliveryMetrics; audioBlob: Blob | null }) {
  const url = useMemo(() => (audioBlob ? URL.createObjectURL(audioBlob) : null), [audioBlob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <div className="space-y-4">
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

function CriterionRow({ r }: { r: RubricScore }) {
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
            {r.label}
            {r.pi_id && <span className="ml-1 font-mono text-xs font-normal text-slate-400 dark:text-slate-500">({r.pi_id})</span>}
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

function MissingCard({ scores }: { scores: RubricScore[] }) {
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
          <div key={s.key}>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
              {s.label}
              {s.pi_id && <span className="ml-1 font-mono text-slate-400 dark:text-slate-500">({s.pi_id})</span>}
            </p>
            <ul className="mt-1 space-y-1">
              {s.gaps.map((g, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-slate-600 dark:text-slate-300"><span className="text-amber-500">+</span><span>{g}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- transcript highlighting ----------------------------------------------

type Mark = {
  id: string;
  quote: string;
  level: RubricLevel;
  label: string;
  feedback: string;
  points: number;
  maxPoints: number;
};

function buildMarks(scores: RubricScore[]): Mark[] {
  const marks: Mark[] = [];
  for (const s of scores) {
    s.evidence.forEach((q, i) => {
      if (q && q.trim().length > 3) {
        marks.push({ id: `${s.key}#${i}`, quote: q.trim(), level: s.level, label: s.label, feedback: s.feedback, points: s.points, maxPoints: s.max_points });
      }
    });
  }
  return marks;
}

function TranscriptTab(props: {
  response: string;
  followupAnswer: string;
  marks: Mark[];
  scores: RubricScore[];
  active: string | null;
  onSelect: (id: string | null) => void;
  followupFeedback: string;
}) {
  const activeMark = props.marks.find((m) => m.id === props.active) ?? null;
  const tone = activeMark ? LEVEL_TONE[activeMark.level] : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_19rem]">
      <div className="order-2 space-y-4 lg:order-1">
        <Card>
          <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">Your presentation</h3>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            Highlights mark where each criterion found credit; color is the level it reached. Tap one for the note.
          </p>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-100">
            {highlight(props.response, props.marks, props.active, props.onSelect)}
          </p>
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

const SELECT_CLS =
  "w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-100 shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";
const TEXTAREA_CLS =
  "w-full resize-y rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 p-3.5 text-sm leading-relaxed shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

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
  const body = (
    <div className="space-y-4">
      <div>
        <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">
          Performance indicators ({s.performance_indicators.length})
        </h3>
        <ul className="mt-2 space-y-1.5">
          {s.performance_indicators.map((p) => (
            <li key={p.id} className="text-sm text-slate-700 dark:text-slate-200">
              <span className="mr-1.5 font-mono text-xs text-indigo-400">{p.id}</span>
              {p.text}
            </li>
          ))}
        </ul>
      </div>
      <CriteriaList title="Solution" items={s.solution_criteria} />
      <CriteriaList title="Career competencies" items={s.career_competencies} />
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

function CriteriaList({ title, items }: { title: string; items: RubricCriterion[] }) {
  return (
    <div>
      <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-200">
        {items.map((c) => (
          <li key={c.key}>
            <span className="font-medium">{c.label}</span> — <span className="text-slate-600 dark:text-slate-300">{c.desc}</span>
          </li>
        ))}
      </ul>
    </div>
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
        You'll be graded out of 100 on the DECA 2026 District rubric: 4 performance indicators (12 pts each), a
        solution ({scenario.solution_criteria.map((c) => c.label.toLowerCase()).join(", ")}), three career
        competencies, and overall impression. Original practice material — not an official DECA document.
      </p>
    </Card>
  );
}

function HonestyNote() {
  return (
    <p className="max-w-xs text-xs leading-relaxed text-slate-400 dark:text-slate-500">
      Original practice scenarios in DECA's style — not official DECA documents.
    </p>
  );
}

function TimerBar({ label, left, total, tone }: { label: string; left: number; total: number; tone: "indigo" | "amber" | "slate" | "red" }) {
  const tones = {
    indigo: { box: "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-200", num: "text-indigo-700 dark:text-indigo-300", bar: "bg-indigo-500" },
    amber: { box: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200", num: "text-amber-700 dark:text-amber-300", bar: "bg-amber-500" },
    slate: { box: "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200", num: "text-slate-900 dark:text-slate-100", bar: "bg-slate-400" },
    red: { box: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200", num: "text-red-600 dark:text-red-300", bar: "bg-red-500" },
  }[tone];
  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${tones.box}`}>
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
function LoadingScreen({ label }: { label: string }) {
  return (
    <Card>
      <div className="flex flex-col items-center justify-center gap-6 py-14 text-center">
        <div className="relative grid h-24 w-24 place-items-center">
          {[0, 0.6, 1.2].map((delay) => (
            <span
              key={delay}
              className="pic-radar-ring absolute inset-0 rounded-full border-2 border-indigo-400/60 dark:border-indigo-500/50"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
          <div className="pic-bob">
            <BrandMark size={48} />
          </div>
        </div>
        <div>
          <p className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{label}</p>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-500">PI Coach</p>
        </div>
      </div>
    </Card>
  );
}

// --- competition tips ------------------------------------------------------

function TipsPage({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-14">
      {/* Hero */}
      <section className="pt-2">
        <Eyebrow>Competition tips</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl">
          Don't just mention the PI.<br />
          <span className="text-indigo-600 dark:text-indigo-400">Own it.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600 dark:text-slate-300">
          The competitors who place run every performance indicator through the same four beats — and back it with a
          visual the judge can't forget. Here's the method, with a worked example you can copy.
        </p>
      </section>

      {/* The DECA method */}
      <section>
        <SectionHead eyebrow="The core skill" title="The DECA method for nailing a PI">
          One running example — <strong className="font-semibold text-slate-700 dark:text-slate-200">channel management</strong> for
          BrightBean, a small coffee roaster — carried through all four beats.
        </SectionHead>
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          <MethodCard
            n="1" accent="indigo" title="Define"
            todo="Clearly and confidently define the PI or any key terms right away. Skip the textbook jargon — keep it simple and conversational so the judge knows you grasp the core concept."
            example={<>“Channel management is just <em>how our product gets from us into the customer's hands</em> — the path it travels to reach them.”</>}
          />
          <MethodCard
            n="2" accent="violet" title="Explain"
            todo="Elaborate on why this PI matters to a business — its broader impact, what it does, and why a company has to pay attention to it in the real world."
            example={<>“Get the mix right and you control both your <em>margins</em> and how many customers you can reach. Lean on one channel and you're exposed; spread too thin and you lose focus.”</>}
          />
          <MethodCard
            n="3" accent="fuchsia" title="Connect" highlight="Earns the most points"
            todo="Directly apply the PI to your specific role-play scenario. Weave the concept into your actual proposed solution, product, or strategy — that's the systems thinking judges reward."
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
          <span>If your sentence about the PI could apply to <em>any</em> company, you've only <strong className="font-semibold">Defined</strong> it. The points live in <strong className="font-semibold">Connect</strong> — tie it to the scenario in front of you.</span>
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
            "Map each of the 5 PIs to a moment in your plan.",
            "Draft your visual early — not at the last minute.",
            "Outline your open and close so you bookend strong.",
          ]} />
          <TipCard eyebrow="Structure" title="A shape judges reward" items={[
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Open:</strong> greet, confirm your role, preview.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Body:</strong> walk the solution, hit every PI through all four beats.</>,
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

// Counts down to a wall-clock deadline (ms epoch). Survives stage changes so the
// presentation budget keeps running from response into the judge's questions.
function useDeadline(endsAt: number | null): number {
  const calc = () => (endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : 0);
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    if (!endsAt) return;
    setLeft(calc);
    const id = setInterval(() => setLeft(Math.max(0, Math.round((endsAt - Date.now()) / 1000))), 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt]);
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
