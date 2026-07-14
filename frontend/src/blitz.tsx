// Mastery Blitz (Phase 5) — a rapid drill over the flashcard terms. One short
// predetermined scenario; then, under a per-term timer, the student applies each
// term in DECA format (typed or spoken). The loop is model-free — the ONLY model
// call is a single batched grade at the END (fast/cheap). Spoken answers are
// transcribed in the background as they're captured, so nothing waits. Streak/score
// is session-local (sessionStorage) — no accounts, no backend, per your scope.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getBlitzScenarios,
  postBlitzScore,
  postTranscribe,
  type BlitzResult,
  type BlitzScenario,
  type Criterion,
} from "./api";
import { BTN_PRIMARY, BTN_SECONDARY } from "./ui";

const CAN_RECORD = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";
const SECONDS_PER_TERM = 45; // the time-pressure window
const TERMS_PER_BLITZ = 5;

type Phase = "intro" | "drill" | "scoring" | "results";
type Stats = { answered: number; correct: number; streak: number; best: number };

const ZERO: Stats = { answered: 0, correct: 0, streak: 0, best: 0 };

function loadStats(): Stats {
  try {
    const raw = sessionStorage.getItem("pic-blitz-stats");
    return raw ? { ...ZERO, ...(JSON.parse(raw) as Stats) } : ZERO;
  } catch {
    return ZERO;
  }
}
function saveStats(s: Stats) {
  try {
    sessionStorage.setItem("pic-blitz-stats", JSON.stringify(s));
  } catch {
    /* private mode — streak just won't persist across reopens */
  }
}

// Pick n distinct random items.
function sample<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

export function MasteryBlitz({ cards, onClose }: { cards: Criterion[]; onClose: () => void }) {
  const terms = useMemo(() => sample(cards, TERMS_PER_BLITZ), [cards]);
  const [scenario, setScenario] = useState<BlitzScenario | null>(null);
  const [scenarioErr, setScenarioErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [mode, setMode] = useState<"type" | "speak">("type");
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() => terms.map(() => ""));
  const [secondsLeft, setSecondsLeft] = useState(SECONDS_PER_TERM);
  const [pending, setPending] = useState(0); // in-flight transcriptions
  const [results, setResults] = useState<BlitzResult[] | null>(null);
  const [scoreErr, setScoreErr] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [micErr, setMicErr] = useState<string | null>(null);

  // Fetch the scenario pool once and pick one.
  useEffect(() => {
    let active = true;
    getBlitzScenarios()
      .then((pool) => active && setScenario(pool.length ? pool[Math.floor(Math.random() * pool.length)] : null))
      .catch((e) => active && setScenarioErr(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, []);

  // --- recorder (parent-owned so the timer can auto-stop it) ---------------
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function startRec() {
    setMicErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      const chosen = typeof MediaRecorder.isTypeSupported === "function" ? preferred.find((t) => MediaRecorder.isTypeSupported(t)) : undefined;
      const mr = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
      chunksRef.current = [];
      const idx = i; // this recording belongs to the current term
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || chosen || "audio/mp4" });
        // Transcribe in the BACKGROUND so the drill keeps moving.
        setPending((p) => p + 1);
        postTranscribe(blob)
          .then((text) => setAnswers((a) => { const n = [...a]; n[idx] = text; return n; }))
          .catch(() => setAnswers((a) => { const n = [...a]; if (!n[idx]) n[idx] = ""; return n; }))
          .finally(() => setPending((p) => p - 1));
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setMicErr(name === "NotAllowedError" ? "Mic blocked — allow access or switch to Type." : "Couldn't start the mic — switch to Type mode.");
    }
  }
  function stopRec() {
    if (recorderRef.current && recording) recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  // Advance to the next term (or finish). Kept in a ref so the interval always
  // calls the latest version without re-subscribing every tick.
  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = () => {
    if (recording) stopRec(); // locks the spoken answer (transcribes in background)
    if (i < terms.length - 1) setI(i + 1);
    else { setPhase("scoring"); }
  };

  // Per-term countdown.
  useEffect(() => {
    if (phase !== "drill") return;
    setSecondsLeft(SECONDS_PER_TERM);
    const t = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { window.clearInterval(t); advanceRef.current(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [i, phase]);

  // Once the drill is done AND every background transcription has landed, fire the
  // single batched scoring call.
  const scoredRef = useRef(false);
  useEffect(() => {
    if (phase !== "scoring" || pending > 0 || scoredRef.current || !scenario) return;
    scoredRef.current = true;
    postBlitzScore({
      scenario: scenario.text,
      answers: terms.map((t, k) => ({ criterion_id: t.id, response: answers[k] })),
    })
      .then((r) => {
        setResults(r.results);
        // Update the session streak/score in scenario order.
        const s = loadStats();
        for (const t of terms) {
          const res = r.results.find((x) => x.criterion_id === t.id);
          s.answered += 1;
          if (res?.verdict === "correct") { s.correct += 1; s.streak += 1; s.best = Math.max(s.best, s.streak); }
          else { s.streak = 0; }
        }
        saveStats(s);
        setPhase("results");
      })
      .catch((e) => { setScoreErr(e instanceof Error ? e.message : String(e)); setPhase("results"); });
  }, [phase, pending, scenario, terms, answers]);

  const stats = phase === "results" ? loadStats() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/85">⚡ Mastery Blitz</span>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">✕</button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
          {phase === "intro" && (
            <IntroPanel
              scenario={scenario}
              scenarioErr={scenarioErr}
              count={terms.length}
              mode={mode}
              onMode={setMode}
              onStart={() => setPhase("drill")}
            />
          )}

          {phase === "drill" && scenario && (
            <DrillPanel
              scenario={scenario.text}
              term={terms[i]}
              index={i}
              total={terms.length}
              secondsLeft={secondsLeft}
              mode={mode}
              value={answers[i]}
              onChange={(v) => setAnswers((a) => { const n = [...a]; n[i] = v; return n; })}
              recording={recording}
              micErr={micErr}
              onStartRec={startRec}
              onStopRec={stopRec}
              onNext={() => advanceRef.current()}
              isLast={i === terms.length - 1}
            />
          )}

          {phase === "scoring" && (
            <div className="flex flex-col items-center py-10 text-center">
              <span className="pic-spin h-6 w-6 rounded-full border-2 border-indigo-300 border-t-indigo-600 dark:border-indigo-800 dark:border-t-indigo-300" aria-hidden />
              <p className="mt-4 text-sm font-medium text-slate-700 dark:text-slate-200">Grading your round…</p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{pending > 0 ? "Finishing transcription…" : "One quick pass over all your answers."}</p>
            </div>
          )}

          {phase === "results" && (
            <ResultsPanel
              terms={terms}
              results={results}
              scoreErr={scoreErr}
              stats={stats}
              onAgain={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ModePills({ mode, onMode }: { mode: "type" | "speak"; onMode: (m: "type" | "speak") => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 font-mono text-xs dark:bg-slate-800">
      {(["type", "speak"] as const).map((m) => (
        <button
          key={m}
          disabled={m === "speak" && !CAN_RECORD}
          className={`rounded-md px-2.5 py-1 transition disabled:opacity-40 ${mode === m ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-300" : "text-slate-500 dark:text-slate-400"}`}
          onClick={() => onMode(m)}
        >
          {m === "type" ? "✍️ Type" : "🎙️ Speak"}
        </button>
      ))}
    </div>
  );
}

function IntroPanel({ scenario, scenarioErr, count, mode, onMode, onStart }: {
  scenario: BlitzScenario | null;
  scenarioErr: string | null;
  count: number;
  mode: "type" | "speak";
  onMode: (m: "type" | "speak") => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">Ready to drill {count} terms?</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          You'll get one scenario, then each term with {SECONDS_PER_TERM}s to apply it — Define it, then Connect it to the scenario. Fast rounds; we grade the whole set at the end.
        </p>
      </div>
      {scenarioErr ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">Couldn't load a scenario: {scenarioErr}</p>
      ) : (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/40">
          <div className="font-mono text-[10px] uppercase tracking-wider text-indigo-500">Your scenario</div>
          <p className="mt-1 text-sm leading-relaxed text-slate-800 dark:text-slate-100">{scenario ? scenario.text : "Loading…"}</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <ModePills mode={mode} onMode={onMode} />
        <button className={BTN_PRIMARY} disabled={!scenario} onClick={onStart}>Start the blitz →</button>
      </div>
    </div>
  );
}

function DrillPanel(props: {
  scenario: string;
  term: Criterion;
  index: number;
  total: number;
  secondsLeft: number;
  mode: "type" | "speak";
  value: string;
  onChange: (v: string) => void;
  recording: boolean;
  micErr: string | null;
  onStartRec: () => void;
  onStopRec: () => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const low = props.secondsLeft <= 10;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs tabular-nums text-slate-400 dark:text-slate-500">Term {props.index + 1} / {props.total}</span>
        <span className={`font-mono text-sm font-bold tabular-nums ${low ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-300"}`}>{props.secondsLeft}s</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full transition-all duration-1000 ease-linear ${low ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: `${(props.secondsLeft / SECONDS_PER_TERM) * 100}%` }} />
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">{props.scenario}</div>

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-indigo-500">Use this term, in context</div>
        <h2 className="mt-1 font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">{props.term.name}</h2>
        {props.term.definition && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{props.term.definition}</p>}
      </div>

      {props.mode === "type" ? (
        <textarea
          autoFocus
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder="Define it in a sentence, then connect it to the scenario…"
          className="h-28 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      ) : (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-slate-800 dark:bg-slate-800/60">
          {props.micErr && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{props.micErr}</div>}
          {props.recording ? (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Recording…</span>
              <button className={BTN_SECONDARY} onClick={props.onStopRec}>Stop</button>
            </div>
          ) : props.value ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">✓ Answer captured. Next up →</p>
          ) : (
            <button onClick={props.onStartRec} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700">
              <span className="h-2.5 w-2.5 rounded-full bg-white" /> Record your answer
            </button>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button className={BTN_PRIMARY} onClick={props.onNext}>{props.isLast ? "Finish & grade →" : "Next term →"}</button>
      </div>
    </div>
  );
}

function ResultsPanel({ terms, results, scoreErr, stats, onAgain }: {
  terms: Criterion[];
  results: BlitzResult[] | null;
  scoreErr: string | null;
  stats: Stats | null;
  onAgain: () => void;
}) {
  if (scoreErr || !results) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">Couldn't grade this round: {scoreErr ?? "no results"}.</p>
        <button className={BTN_PRIMARY} onClick={onAgain}>Close</button>
      </div>
    );
  }
  const correct = results.filter((r) => r.verdict === "correct").length;
  const tone: Record<string, string> = {
    correct: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/50 dark:bg-emerald-950/30",
    partial: "border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/30",
    missed: "border-red-200 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/30",
  };
  const badge: Record<string, string> = { correct: "✓ Correct", partial: "~ Partial", missed: "✗ Missed" };
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">Round score</div>
          <div className="font-mono text-4xl font-bold leading-none text-slate-900 dark:text-slate-100">{correct}<span className="text-xl text-slate-300 dark:text-slate-600">/{results.length}</span></div>
        </div>
        {stats && (
          <div className="text-right text-xs text-slate-500 dark:text-slate-400">
            <div>Session streak: <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{stats.streak}</span></div>
            <div>Best: <span className="font-mono">{stats.best}</span> · {stats.correct}/{stats.answered} this session</div>
          </div>
        )}
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto">
        {terms.map((t) => {
          const r = results.find((x) => x.criterion_id === t.id);
          const v = r?.verdict ?? "missed";
          return (
            <div key={t.id} className={`rounded-xl border p-3 ${tone[v]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</span>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-slate-600 dark:text-slate-300">{badge[v]}</span>
              </div>
              {r?.note && <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{r.note}</p>}
            </div>
          );
        })}
      </div>

      <button className={`${BTN_PRIMARY} w-full`} onClick={onAgain}>Done →</button>
    </div>
  );
}
