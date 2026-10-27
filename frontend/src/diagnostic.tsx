// The diagnostic: a starting-point quiz that maps what a student already has and
// what to work on, by domain of their written exam.
//
// Thirty questions, balanced across the exam's domains (backend/app/diagnostic.py),
// each with a "Not sure" answer. Not sure earns no credit and is kept apart from a
// wrong answer to the end: a gap needs the idea taught, a misconception needs the
// wrong idea unlearned, and the fix on the results screen differs for each.
//
// It is built on the offline quiz bank, so it costs nothing and is open signed-out.
// The questions arrive without the answer key (it would turn the test into a
// lesson); the key and every rationale come back with the scored result.
//
// A signed-out result is kept in this browser with its answers, and saved to the
// account the first time the student signs in, so nobody sits the test twice.

import { useEffect, useMemo, useRef, useState } from "react";
import { getEvents, type EventSummary } from "./api";
import { track } from "./analytics";
import { useCached } from "./cache";
import {
  diagnosticHistoryKey,
  getDiagnosticHistory,
  getDiagnosticTest,
  readLocalDiagnostic,
  submitDiagnostic,
  writeLocalDiagnostic,
  type DiagnosticAnswer,
  type DiagnosticBand,
  type DiagnosticDomain,
  type DiagnosticResult,
  type DiagnosticTest,
} from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, Eyebrow, LogoLoader, useScrollLock } from "./ui";

type Level = DiagnosticTest["level"];
const LEVELS: Level[] = ["district", "state", "icdc"];
const LEVEL_LABEL: Record<Level, string> = { district: "District", state: "State", icdc: "ICDC" };
const LEVEL_BLURB: Record<Level, string> = {
  district: "One concept, recognize it.",
  state: "One concept, use it in a new situation.",
  icdc: "Two or three concepts, reason about how they interact.",
};

const UNSURE = "unsure";
const EVENT_KEY = "pic-diagnostic-event";

// The band ramp reuses the scoring colors so "needs work" reads the same here as a
// novice skill does everywhere else. Every band also carries a word, never color alone.
const BAND: Record<DiagnosticBand, { label: string; color: string; text: string }> = {
  needs_work: { label: "Needs work", color: "#ef4444", text: "text-red-700 dark:text-red-400" },
  developing: { label: "Developing", color: "#f59e0b", text: "text-amber-700 dark:text-amber-400" },
  mastered: { label: "Mastered", color: "#10b981", text: "text-emerald-700 dark:text-emerald-400" },
};

const PATTERN_COPY: Record<string, string> = {
  gaps: "Mostly ideas you haven't met yet. Start with the cards.",
  misconceptions: "Some ideas you have backwards. The quiz explanations undo those.",
  mixed: "A mix of gaps and mix-ups. Cards first, then the quiz.",
};

// --- the latest result, wherever it lives ------------------------------------------

/**
 * The student's newest result and the history behind it. Signed in, it comes from
 * the account (and any attempt made signed-out is saved to it once, here). Signed
 * out, it is whatever this browser kept.
 */
export function useDiagnostic(authed: boolean): {
  latest: DiagnosticResult | null;
  attempts: DiagnosticResult[];
  loading: boolean;
  remember: (r: DiagnosticResult, answers: DiagnosticAnswer[]) => void;
} {
  const historyQ = useCached(authed ? diagnosticHistoryKey : null, getDiagnosticHistory);
  const [local, setLocal] = useState<DiagnosticResult | null>(() => readLocalDiagnostic()?.result ?? null);
  const savingRef = useRef(false);

  // Signed in with an attempt made while signed out: save it to the account, once,
  // and only if the account has none yet (an older local attempt must not become
  // the newest of a student who has since tested while signed in).
  useEffect(() => {
    if (!authed || historyQ.loading || historyQ.data === undefined || savingRef.current) return;
    const pending = readLocalDiagnostic();
    if (!pending) return;
    savingRef.current = true;
    if (historyQ.data.length > 0) {
      writeLocalDiagnostic(null);
      setLocal(null);
      return;
    }
    submitDiagnostic(pending.result.event_id, pending.result.level, pending.answers)
      .then(() => {
        writeLocalDiagnostic(null);
        setLocal(null);
      })
      .catch(() => {
        savingRef.current = false; // try again next visit; the local copy is untouched
      });
  }, [authed, historyQ.loading, historyQ.data]);

  const attempts = authed ? historyQ.data ?? [] : local ? [local] : [];
  return {
    latest: attempts[0] ?? (authed ? local : null),
    attempts,
    loading: authed && historyQ.loading,
    remember: (r, answers) => {
      if (!authed) {
        writeLocalDiagnostic({ result: r, answers });
        setLocal(r);
      }
    },
  };
}

// --- the card ----------------------------------------------------------------------

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function bandCounts(domains: DiagnosticDomain[]): Record<DiagnosticBand, DiagnosticDomain[]> {
  return {
    needs_work: domains.filter((d) => d.band === "needs_work"),
    developing: domains.filter((d) => d.band === "developing"),
    mastered: domains.filter((d) => d.band === "mastered"),
  };
}

/** The entry point: take it, or see where the last one left you. */
export function DiagnosticCard({ latest, onTake, onSeeResults }: {
  latest: DiagnosticResult | null;
  onTake: () => void;
  onSeeResults: () => void;
}) {
  if (!latest) {
    return (
      <div className="flex flex-col items-start justify-between gap-4 border-t border-slate-200 pt-5 sm:flex-row sm:items-center dark:border-slate-800">
        <div className="min-w-0">
          <Eyebrow>Diagnostic</Eyebrow>
          <h3 className="mt-1 font-display text-base font-semibold text-slate-900 dark:text-slate-100">Find your starting point</h3>
          <p className="mt-1 max-w-[62ch] text-sm text-slate-600 dark:text-slate-300">
            Thirty questions, about ten minutes. See which areas of your exam you already have and which to work on, so your practice starts in the right place.
          </p>
        </div>
        <button className={`${BTN_PRIMARY} shrink-0`} onClick={onTake}>Take the diagnostic</button>
      </div>
    );
  }
  const groups = bandCounts(latest.domains);
  const first = groups.needs_work.slice(0, 3).map((d) => d.name);
  return (
    <div className="flex flex-col items-start justify-between gap-4 border-t border-slate-200 pt-5 sm:flex-row sm:items-center dark:border-slate-800">
      <div className="min-w-0">
        <Eyebrow>Diagnostic, {fmtDate(latest.created_at)}</Eyebrow>
        <h3 className="mt-1 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
          {groups.needs_work.length} need work, {groups.developing.length} developing, {groups.mastered.length} mastered
        </h3>
        <p className="mt-1 max-w-[62ch] text-sm text-slate-600 dark:text-slate-300">
          {first.length ? <>Start with {first.join(", ")}.</> : "Nothing is flagged as needing work. Retake it later to check it holds."}
        </p>
      </div>
      <div className="flex shrink-0 gap-2.5">
        <button className={BTN_SECONDARY} onClick={onSeeResults}>See results</button>
        <button className={BTN_SECONDARY} onClick={onTake}>Retake</button>
      </div>
    </div>
  );
}

// --- the modal ---------------------------------------------------------------------

type Phase = "intro" | "test" | "submitting" | "results";

export function DiagnosticModal({ authed, defaultEventId, latest, openResults, onResult, onClose, onPractice, onSignup }: {
  authed: boolean;
  // The event the student is already studying for, preselected.
  defaultEventId?: string;
  // Their newest result: shown directly when `openResults`, and the questions in it
  // are skipped on a retake so the second test is not the first one again.
  latest: DiagnosticResult | null;
  openResults?: boolean;
  onResult: (r: DiagnosticResult, answers: DiagnosticAnswer[]) => void;
  onClose: () => void;
  // Study the cards behind a domain's misses, or quiz on them.
  onPractice: (mode: "study" | "quiz", termIds: string[], title: string) => void;
  onSignup: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(openResults && latest ? "results" : "intro");
  const [result, setResult] = useState<DiagnosticResult | null>(openResults ? latest : null);

  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [eventsErr, setEventsErr] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string>(() => {
    if (defaultEventId) return defaultEventId;
    try {
      return localStorage.getItem(EVENT_KEY) ?? latest?.event_id ?? "";
    } catch {
      return latest?.event_id ?? "";
    }
  });
  const [level, setLevel] = useState<Level>(latest?.level ?? "district");

  const [test, setTest] = useState<DiagnosticTest | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getEvents()
      .then((e) => active && setEvents(e))
      .catch((e) => active && setEventsErr(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, []);

  const grouped = useMemo(() => {
    const m = new Map<string, EventSummary[]>();
    for (const e of events ?? []) m.set(e.cluster, [...(m.get(e.cluster) ?? []), e]);
    return [...m.entries()];
  }, [events]);

  async function start() {
    if (!eventId || starting) return;
    setStarting(true);
    setLoadErr(null);
    try {
      const skip = latest && latest.event_id === eventId ? latest.question_ids : [];
      const t = await getDiagnosticTest(eventId, level, skip);
      try {
        localStorage.setItem(EVENT_KEY, eventId);
      } catch {
        /* private mode: the choice still holds for this test */
      }
      setTest(t);
      setAnswers({});
      setI(0);
      setPhase("test");
      track("diagnostic_started", { event: eventId, level, retake: !!latest });
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function finish() {
    if (!test) return;
    setPhase("submitting");
    setSubmitErr(null);
    const body: DiagnosticAnswer[] = test.questions.map((q) => ({ question_id: q.id, choice: answers[q.id] ?? UNSURE }));
    try {
      const r = await submitDiagnostic(test.event_id, test.level, body);
      setResult(r);
      onResult(r, body);
      setPhase("results");
      track("diagnostic_finished", {
        event: test.event_id, level: test.level, correct: r.correct, unsure: r.unsure, total: r.total,
        needs_work: r.domains.filter((d) => d.band === "needs_work").length,
      });
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
      setPhase("test");
    }
  }

  const q = test?.questions[i];
  const answered = Object.keys(answers).length;
  const choose = (id: string) => q && setAnswers((a) => ({ ...a, [q.id]: id }));

  // Closing mid-test throws it away, so guard it. A ref so the Esc handler (bound
  // once) always sees the current phase.
  const requestCloseRef = useRef<() => void>(() => {});
  requestCloseRef.current = () => {
    if (phase === "test" && answered > 0) {
      if (!window.confirm("Leave the diagnostic? Your answers won't be saved.")) return;
    }
    if (phase === "submitting") return;
    onClose();
  };

  // Keys during the test: a to d pick an option, n picks Not sure, Enter goes on.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e) => {
    if (phase !== "test" || !q || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const target = e.target as HTMLElement | null;
    if (target && /^(input|select|textarea)$/i.test(target.tagName)) return;
    const hit = q.options.find((o) => o.id === k);
    if (hit) { e.preventDefault(); choose(hit.id); }
    else if (k === "n") { e.preventDefault(); choose(UNSURE); }
    else if (k === "enter" && answers[q.id] && target?.tagName !== "BUTTON") {
      e.preventDefault();
      if (i < test!.questions.length - 1) setI(i + 1); else void finish();
    }
  };

  useScrollLock();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); requestCloseRef.current(); return; }
      keysRef.current(e);
      if (e.key !== "Tab") return;
      const f = node.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
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
    <div className="fixed inset-0 z-50 flex overflow-y-auto overscroll-contain bg-slate-950/80 p-4" onClick={() => requestCloseRef.current()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Diagnostic"
        tabIndex={-1}
        className="pic-card-in m-auto w-full max-w-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/85">Diagnostic</span>
          <button onClick={() => requestCloseRef.current()} aria-label="Close Diagnostic" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">✕</button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
          {phase === "intro" && (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-100">Find your starting point</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                  Thirty multiple-choice questions, spread evenly across the areas of your written exam. Answer what you know and tap <strong className="font-semibold text-slate-800 dark:text-slate-100">Not sure</strong> when you don't. A guess that lands tells us nothing, an honest "not sure" tells us exactly where to start. No answers are shown until the end.
                </p>
              </div>

              <div>
                <label htmlFor="diag-event" className="block text-sm font-medium text-slate-800 dark:text-slate-100">Which event are you competing in?</label>
                {eventsErr ? (
                  <p className="mt-2 text-sm text-red-700 dark:text-red-400">Couldn't load events: {eventsErr}</p>
                ) : (
                  <select
                    id="diag-event"
                    value={eventId}
                    disabled={!events}
                    onChange={(e) => setEventId(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="" disabled>{events ? "Choose your event" : "Loading events"}</option>
                    {grouped.map(([cluster, list]) => (
                      <optgroup key={cluster} label={cluster}>
                        {list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                )}
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">The test covers every area of the written exam your event sits.</p>
              </div>

              <div>
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">How hard?</span>
                <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Difficulty">
                  {LEVELS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      aria-checked={level === l}
                      onClick={() => setLevel(l)}
                      className={`tap rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        level === l
                          ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      }`}
                    >
                      {LEVEL_LABEL[l]}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{LEVEL_BLURB[level]} Not sure? District is the place to start.</p>
              </div>

              {loadErr && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loadErr}</p>}
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <button className={`${BTN_PRIMARY} w-full sm:flex-1`} disabled={!eventId || starting} onClick={() => void start()}>
                  {starting ? "Loading" : "Start the diagnostic"}
                </button>
                <button className={`${BTN_SECONDARY} w-full sm:flex-1`} onClick={onClose}>Not now</button>
              </div>
            </div>
          )}

          {phase === "test" && test && q && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">Question {i + 1} / {test.questions.length}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{q.domain}</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                <div className="h-full origin-left rounded-full bg-indigo-500 transition-transform duration-300" style={{ transform: `scaleX(${(i + (answers[q.id] ? 1 : 0)) / test.questions.length})` }} />
              </div>

              <p id="diag-q" className="text-[15px] font-medium leading-relaxed text-slate-900 dark:text-slate-100">{q.question}</p>

              <div className="space-y-2" role="radiogroup" aria-labelledby="diag-q">
                {q.options.map((o) => {
                  const on = answers[q.id] === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => choose(o.id)}
                      className={`tap w-full rounded-xl border p-3 text-left transition ${
                        on
                          ? "border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/40"
                          : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
                      }`}
                    >
                      <div className="flex gap-3">
                        <span className="mt-0.5 font-mono text-xs font-semibold uppercase text-slate-400">{o.id}</span>
                        <span className="flex-1 text-sm leading-relaxed text-slate-800 dark:text-slate-100">{o.text}</span>
                      </div>
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="radio"
                  aria-checked={answers[q.id] === UNSURE}
                  onClick={() => choose(UNSURE)}
                  className={`tap w-full rounded-xl border border-dashed p-3 text-left text-sm transition ${
                    answers[q.id] === UNSURE
                      ? "border-slate-500 bg-slate-100 font-medium text-slate-900 dark:border-slate-400 dark:bg-slate-800 dark:text-slate-100"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  Not sure
                </button>
              </div>

              {submitErr && <p role="alert" className="text-sm text-red-700 dark:text-red-400">Couldn't score that: {submitErr}. Your answers are still here, try again.</p>}
              <div className="flex items-center justify-between gap-3">
                <button className={BTN_SECONDARY} disabled={i === 0} onClick={() => setI(i - 1)}>Back</button>
                <span className="hidden text-[11px] text-slate-400 sm:inline dark:text-slate-500">Keys: A to D, N for not sure</span>
                {i < test.questions.length - 1 ? (
                  <button className={BTN_PRIMARY} disabled={!answers[q.id]} onClick={() => setI(i + 1)}>Next</button>
                ) : (
                  <button className={BTN_PRIMARY} disabled={!answers[q.id] || answered < test.questions.length} onClick={() => void finish()}>See results</button>
                )}
              </div>
              {i === test.questions.length - 1 && answered < test.questions.length && (
                <p className="text-xs text-slate-500 dark:text-slate-400">{test.questions.length - answered} unanswered. Use Back to finish them, or mark them Not sure.</p>
              )}
            </div>
          )}

          {phase === "submitting" && (
            <div className="flex flex-col items-center gap-4 py-10">
              <LogoLoader size={72} label="Scoring your diagnostic" />
              <p className="text-sm text-slate-500 dark:text-slate-400">Scoring your diagnostic</p>
            </div>
          )}

          {phase === "results" && result && (
            <ResultsPanel result={result} authed={authed} onPractice={onPractice} onSignup={onSignup} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

// --- results ------------------------------------------------------------------------

function pointChange(c: number | null | undefined): string | null {
  if (c == null) return null;
  const pts = Math.round(c * 100);
  if (pts === 0) return "Same as last time";
  return `${pts > 0 ? "Up" : "Down"} ${Math.abs(pts)} points since last time`;
}

function DomainRow({ d, onPractice }: {
  d: DiagnosticDomain;
  onPractice: (mode: "study" | "quiz", termIds: string[], title: string) => void;
}) {
  const band = BAND[d.band];
  const change = pointChange(d.change);
  return (
    <li className="border-b border-slate-200 py-3.5 dark:border-slate-800">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{d.name}</span>
        <span className={`shrink-0 text-[13px] font-semibold ${band.text}`}>{band.label}</span>
      </div>
      <div className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden="true">
        {d.correct > 0 && <i className="block h-full" style={{ width: `${(d.correct / d.asked) * 100}%`, background: "#10b981" }} />}
        {d.wrong > 0 && <i className="block h-full" style={{ width: `${(d.wrong / d.asked) * 100}%`, background: "#ef4444" }} />}
        {d.unsure > 0 && <i className="block h-full" style={{ width: `${(d.unsure / d.asked) * 100}%`, background: "#94a3b8" }} />}
      </div>
      <p className="mt-1.5 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
        {d.correct} right, {d.wrong} wrong, {d.unsure} not sure{change ? `. ${change}` : ""}
      </p>
      {d.band !== "mastered" && d.pattern && (
        <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{PATTERN_COPY[d.pattern]}</p>
      )}
      {d.band !== "mastered" && d.term_ids.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button className={BTN_SMALL} onClick={() => onPractice("study", d.term_ids, d.name)}>Study {d.term_ids.length} {d.term_ids.length === 1 ? "card" : "cards"}</button>
          <button className={BTN_SMALL} onClick={() => onPractice("quiz", d.term_ids, d.name)}>Quiz these</button>
        </div>
      )}
    </li>
  );
}

function ResultsPanel({ result, authed, onPractice, onSignup, onClose }: {
  result: DiagnosticResult;
  authed: boolean;
  onPractice: (mode: "study" | "quiz", termIds: string[], title: string) => void;
  onSignup: () => void;
  onClose: () => void;
}) {
  const groups = bandCounts(result.domains);
  const missed = (result.review ?? []).filter((r) => r.outcome !== "correct");
  const per = result.domains.length ? Math.round(result.total / result.domains.length) : 0;
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{LEVEL_LABEL[result.level]} diagnostic</div>
          <div className="font-mono text-4xl font-bold leading-none text-slate-900 dark:text-slate-100">
            {result.correct}<span className="text-xl text-slate-300 dark:text-slate-600">/{result.total}</span>
          </div>
        </div>
        <p className="max-w-[16rem] text-right text-xs text-slate-500 dark:text-slate-400">
          {result.unsure} marked not sure. {groups.needs_work.length} {groups.needs_work.length === 1 ? "area needs" : "areas need"} work, {groups.mastered.length} mastered.
        </p>
      </div>

      <ul className="border-t border-slate-200 dark:border-slate-800">
        {result.domains.map((d) => <DomainRow key={d.domain_id} d={d} onPractice={onPractice} />)}
      </ul>
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        About {per} questions per area, so read this as a starting point and not a verdict. Mastered means a clean sheet in that area. It earns the area a lighter touch in your plan, not a pass to skip it.
      </p>

      {missed.length > 0 && (
        <details className="group border-t border-slate-200 pt-4 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-100">
            Review the {missed.length} you missed or skipped
          </summary>
          <div className="mt-3 max-h-80 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
            {missed.map((r) => {
              const right = r.options.find((o) => o.correct);
              const mine = r.options.find((o) => o.id === r.choice);
              return (
                <div key={r.question_id} className="py-3">
                  <p className="text-sm font-medium leading-relaxed text-slate-900 dark:text-slate-100">{r.question}</p>
                  <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">
                    {r.outcome === "unsure" ? "You marked this not sure." : <>You chose {r.choice.toUpperCase()}: {mine?.text}</>}
                  </p>
                  {mine && r.outcome === "wrong" && <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">{mine.rationale}</p>}
                  {right && (
                    <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-400">
                      Answer {right.id.toUpperCase()}: {right.text}. {right.rationale}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {!authed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
          <p className="max-w-[40ch] text-sm text-slate-600 dark:text-slate-300">
            This is saved in this browser only. Create a free account to keep it and have your study plan start with these areas.
          </p>
          <button className={BTN_SECONDARY} onClick={onSignup}>Create a free account</button>
        </div>
      ) : (
        <p className="border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Saved. Your study plan now puts the areas that need work first and the mastered ones last. Retake it in a few weeks to see what moved.
        </p>
      )}

      <button className={`${BTN_PRIMARY} w-full`} onClick={onClose}>Done</button>
    </div>
  );
}
