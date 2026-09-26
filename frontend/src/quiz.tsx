// Knowledge Check, multiple-choice practice over a set of study terms.
//
// The quiet counterpart to Mastery Blitz. Blitz is production under a clock and
// costs a model call to grade; this is recognition with no timer and no model call
// at all. Questions come pre-generated from the bank (backend/app/quiz.py), answer
// key included, so the pick is graded in the browser the instant it lands and the
// rationale for the option you chose appears with it. That is the whole point of
// the format here: a wrong answer is worth more than a right one if it tells you
// which confusion you just walked into.
//
// Because it spends nothing, it needs no account and no allowance. Results still
// fold into study progress when signed in, where a quiz ranks above a flip and
// below a blitz: recognizing the answer among four is evidence, not proof, so it
// can start a term and demote one but never mark it known (backend/app/study.py).

import { useEffect, useMemo, useRef, useState } from "react";
import { getQuiz, type Level, type QuizQuestion, type Term } from "./api";
import { track } from "./analytics";
import { markStudy } from "./progress";
import { BTN_PRIMARY } from "./ui";

// Enough to find a pattern in what you're missing, short enough to finish.
const QUESTIONS_PER_ROUND = 8;
// Drawn per deck before we split by tier, so the tier pills can show what this
// particular deck actually holds rather than what the whole bank holds.
const DRAW = 40;

const LEVELS: Level[] = ["district", "state", "icdc"];
const LEVEL_LABEL: Record<Level, string> = { district: "District", state: "State", icdc: "ICDC" };
const LEVEL_BLURB: Record<Level, string> = {
  district: "One concept, recognize it.",
  state: "One concept, use it in a new situation.",
  icdc: "Two or three concepts, reason about how they interact.",
};

type Phase = "intro" | "quiz" | "results";

/**
 * How wide the draw is.
 *
 * `deck` is the cards on screen, which is what you want straight after studying a
 * unit. `cluster` is every domain any event in your cluster touches, which is the
 * scope of the exam you actually sit: Business Finance is tested on the Finance
 * cluster, not on the four domains its role-play happens to use. `all` is the
 * whole bank, for anyone revising across clusters.
 */
export type Scope = "deck" | "cluster" | "all";

const SCOPE_BLURB: Record<Scope, string> = {
  deck: "Only the cards in front of you.",
  cluster: "The whole cluster exam, the realistic one.",
  all: "Every domain in the corpus.",
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Above this many cards the id list stops fitting comfortably in a URL: the whole
// library is 800+ terms, which is a ~6KB query string and a 431 waiting to happen
// on some proxies. A deck that big is asking for "questions about this area"
// rather than "questions about these exact cards", so it narrows by domain
// instead, and a deck spanning everything simply draws from the whole bank.
const MAX_IDS_IN_URL = 120;
const MAX_DOMAINS_IN_URL = 8;

export function KnowledgeCheck({ cards, title, cluster, defaultScope = "deck", onClose }: {
  cards: Term[];
  title?: string;
  // The student's cluster, when the launcher knows it. Its presence is what makes
  // the cluster scope offerable at all, and its name is what labels the button.
  cluster?: string;
  // Which scope this particular launcher should open on. A course unit means
  // "quiz me on what I just studied"; the course-wide button means "test me",
  // and a test that only covers one event's four domains is not the test they sit.
  defaultScope?: Scope;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>(() => (defaultScope === "cluster" && !cluster ? "deck" : defaultScope));
  const filter = useMemo(() => {
    if (scope === "all") return {};
    if (scope === "cluster") return cluster ? { cluster } : {};
    const ids = cards.map((c) => c.id);
    if (ids.length <= MAX_IDS_IN_URL) return { termIds: ids };
    const domainIds = [...new Set(cards.map((c) => c.domain_id).filter(Boolean))];
    return domainIds.length && domainIds.length <= MAX_DOMAINS_IN_URL ? { domainIds } : {};
  }, [cards, scope, cluster]);
  const [drawn, setDrawn] = useState<QuizQuestion[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("district");
  const [phase, setPhase] = useState<Phase>("intro");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [i, setI] = useState(0);
  // The option id picked per question, in question order. Absent = not answered.
  const [picks, setPicks] = useState<Record<string, string>>({});

  // One request for the whole deck; the tiers are split out of it below. A tier
  // with nothing in it for THIS deck is disabled rather than opening empty.
  useEffect(() => {
    let active = true;
    getQuiz({ ...filter, count: DRAW })
      .then((r) => active && setDrawn(r.questions))
      .catch((e) => active && setLoadErr(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [filter]);

  const byLevel = useMemo(() => {
    const out: Record<Level, QuizQuestion[]> = { district: [], state: [], icdc: [] };
    for (const q of drawn ?? []) out[q.level]?.push(q);
    return out;
  }, [drawn]);

  // Default to a tier this deck can actually fill, so the Start button is live on
  // open instead of making the student hunt for the one that works.
  useEffect(() => {
    if (!drawn || byLevel[level].length) return;
    const fallback = LEVELS.find((l) => byLevel[l].length);
    if (fallback) setLevel(fallback);
  }, [drawn, byLevel, level]);

  function start() {
    const picked = shuffle(byLevel[level]).slice(0, QUESTIONS_PER_ROUND);
    if (!picked.length) return;
    setQuestions(picked);
    setPicks({});
    setI(0);
    setPhase("quiz");
    track("quiz_started", { level, scope, count: picked.length, deck: title ?? "" });
  }

  const current = questions[i];
  const picked = current ? picks[current.id] : undefined;
  const answered = Object.keys(picks).length;

  function choose(optionId: string) {
    if (!current || picks[current.id]) return; // first answer stands
    setPicks((p) => ({ ...p, [current.id]: optionId }));
  }

  function next() {
    if (i < questions.length - 1) {
      setI(i + 1);
      return;
    }
    finish();
  }

  // Marking runs once, on the way into the results screen.
  const markedRef = useRef(false);
  function finish() {
    setPhase("results");
    if (markedRef.current) return;
    markedRef.current = true;
    const right = questions.filter((q) => q.options.find((o) => o.id === picks[q.id])?.correct).length;
    track("quiz_finished", { level, correct: right, total: questions.length });
    // One mark per term the question was built from. Fire-and-forget: markStudy
    // no-ops when signed out and never throws, so progress can't break results.
    const marks = questions
      .filter((q) => picks[q.id])
      .flatMap((q) => {
        const wasRight = !!q.options.find((o) => o.id === picks[q.id])?.correct;
        return q.term_ids.map((term_id) => ({
          term_id,
          evidence: "quiz" as const,
          verdict: (wasRight ? "correct" : "missed") as "correct" | "missed",
        }));
      })
      .slice(0, 60); // the server's per-request ceiling
    void markStudy(marks);
  }

  // Closing mid-round throws the round away, so guard it. Held in a ref so the Esc
  // handler (bound once) always sees the current phase.
  const requestCloseRef = useRef<() => void>(() => {});
  requestCloseRef.current = () => {
    if (phase === "quiz" && answered > 0 && answered < questions.length) {
      if (!window.confirm("Leave the quiz? This round won't be saved.")) return;
    }
    onClose();
  };

  // Modal a11y, matching MasteryBlitz: focus in, Tab trapped, Esc closes, focus
  // restored on the way out.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); requestCloseRef.current(); return; }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm" onClick={() => requestCloseRef.current()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Knowledge Check"
        tabIndex={-1}
        className="w-full max-w-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/85">◎ Knowledge Check</span>
          <button onClick={() => requestCloseRef.current()} aria-label="Close Knowledge Check" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">✕</button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
          {phase === "intro" && (
            <IntroPanel
              title={title}
              loading={!drawn && !loadErr}
              loadErr={loadErr}
              byLevel={byLevel}
              level={level}
              onLevel={setLevel}
              scope={scope}
              onScope={setScope}
              cluster={cluster}
              deckSize={cards.length}
              onStart={start}
            />
          )}

          {phase === "quiz" && current && (
            <QuestionPanel
              question={current}
              index={i}
              total={questions.length}
              picked={picked}
              onChoose={choose}
              onNext={next}
              isLast={i === questions.length - 1}
            />
          )}

          {phase === "results" && (
            <ResultsPanel questions={questions} picks={picks} level={level} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

function IntroPanel({ title, loading, loadErr, byLevel, level, onLevel, scope, onScope, cluster, deckSize, onStart }: {
  title?: string;
  loading: boolean;
  loadErr: string | null;
  byLevel: Record<Level, QuizQuestion[]>;
  level: Level;
  onLevel: (l: Level) => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  // Absent when the launcher has no event in hand, which is what hides the
  // cluster option rather than showing one that cannot be labelled.
  cluster?: string;
  deckSize: number;
  onStart: () => void;
}) {
  const scopes: Scope[] = cluster ? ["deck", "cluster", "all"] : ["deck", "all"];
  const scopeLabel: Record<Scope, string> = {
    deck: `This deck (${deckSize})`,
    cluster: cluster ? `${cluster} exam` : "Cluster exam",
    all: "Everything",
  };
  const available = byLevel[level].length;
  const anywhere = LEVELS.some((l) => byLevel[l].length);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
          Knowledge Check{title ? `: ${title}` : ""}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Multiple choice over the terms you're studying. No clock. Every answer, right or wrong, explains itself the moment you pick it.
        </p>
      </div>

      <div className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-indigo-500">Draw from</div>
        <div className="flex flex-wrap gap-2">
          {scopes.map((s) => {
            const active = s === scope;
            return (
              <button
                key={s}
                aria-pressed={active}
                onClick={() => onScope(s)}
                title={SCOPE_BLURB[s]}
                className={`tap rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? "border-indigo-400 bg-indigo-50 text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-200"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {scopeLabel[s]}
              </button>
            );
          })}
        </div>
        <p className="text-xs leading-snug text-slate-500 dark:text-slate-400">{SCOPE_BLURB[scope]}</p>
      </div>

      <div className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-indigo-500">Difficulty</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {LEVELS.map((l) => {
            const n = byLevel[l].length;
            const active = l === level;
            return (
              <button
                key={l}
                disabled={!n}
                aria-pressed={active}
                onClick={() => onLevel(l)}
                className={`tap rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "border-indigo-400 bg-indigo-50/70 dark:border-indigo-700 dark:bg-indigo-950/40"
                    : "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{LEVEL_LABEL[l]}</span>
                  <span className="font-mono text-[11px] tabular-nums text-slate-400">{n}</span>
                </div>
                <p className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">{LEVEL_BLURB[l]}</p>
              </button>
            );
          })}
        </div>
      </div>

      {loadErr && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">Couldn't load questions: {loadErr}</p>
      )}
      {!loading && !loadErr && !anywhere && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          No questions have been written for these terms yet. Try a bigger deck, or drill them in Mastery Blitz instead.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {loading ? "Loading questions…" : available ? `${Math.min(available, QUESTIONS_PER_ROUND)} questions this round` : "Pick a difficulty with questions"}
        </span>
        <button className={BTN_PRIMARY} disabled={!available} onClick={onStart}>Start →</button>
      </div>
    </div>
  );
}

function QuestionPanel({ question, index, total, picked, onChoose, onNext, isLast }: {
  question: QuizQuestion;
  index: number;
  total: number;
  picked: string | undefined;
  onChoose: (id: string) => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const chosen = question.options.find((o) => o.id === picked);
  const right = question.options.find((o) => o.correct);
  const gotIt = !!chosen?.correct;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">Question {index + 1} / {total}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">{LEVEL_LABEL[question.level]} · {question.topic}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
        <div className="h-full rounded-full bg-indigo-500 transition-all duration-300" style={{ width: `${((index + (picked ? 1 : 0)) / total) * 100}%` }} />
      </div>

      <p className="text-[15px] font-medium leading-relaxed text-slate-900 dark:text-slate-100">{question.question}</p>

      <div className="space-y-2">
        {question.options.map((o) => {
          const isPicked = o.id === picked;
          const reveal = !!picked;
          const tone = !reveal
            ? "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
            : o.correct
              ? "border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/30"
              : isPicked
                ? "border-red-300 bg-red-50/70 dark:border-red-900 dark:bg-red-950/30"
                : "border-slate-200 bg-white opacity-60 dark:border-slate-800 dark:bg-slate-900";
          return (
            <button
              key={o.id}
              disabled={reveal}
              onClick={() => onChoose(o.id)}
              className={`tap w-full rounded-xl border p-3 text-left transition disabled:cursor-default ${tone}`}
            >
              <div className="flex gap-3">
                <span className="mt-0.5 font-mono text-xs font-semibold uppercase text-slate-400">{o.id}</span>
                <span className="flex-1 text-sm leading-relaxed text-slate-800 dark:text-slate-100">{o.text}</span>
                {reveal && (o.correct || isPicked) && (
                  <span className="shrink-0 font-mono text-xs font-semibold">{o.correct ? "✓" : "✗"}</span>
                )}
              </div>
              {/* The teaching line. Shown for what you picked and for the right
                  answer, and withheld for the two you didn't touch: reading four
                  explanations is how a quiz turns into a wall of text. */}
              {reveal && (isPicked || o.correct) && (
                <p className="mt-2 pl-7 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{o.rationale}</p>
              )}
            </button>
          );
        })}
      </div>

      {picked && (
        <div className="flex items-center justify-between gap-3">
          <span role="status" aria-live="polite" className={`text-sm font-semibold ${gotIt ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
            {gotIt ? "Correct" : `Not quite. The answer is ${right?.id.toUpperCase()}`}
          </span>
          <button className={BTN_PRIMARY} autoFocus onClick={onNext}>{isLast ? "See results →" : "Next →"}</button>
        </div>
      )}
    </div>
  );
}

function ResultsPanel({ questions, picks, level, onClose }: {
  questions: QuizQuestion[];
  picks: Record<string, string>;
  level: Level;
  onClose: () => void;
}) {
  const right = questions.filter((q) => q.options.find((o) => o.id === picks[q.id])?.correct);
  const missed = questions.filter((q) => !q.options.find((o) => o.id === picks[q.id])?.correct);
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{LEVEL_LABEL[level]} round</div>
          <div className="font-mono text-4xl font-bold leading-none text-slate-900 dark:text-slate-100">
            {right.length}<span className="text-xl text-slate-300 dark:text-slate-600">/{questions.length}</span>
          </div>
        </div>
        <p className="max-w-[16rem] text-right text-xs text-slate-500 dark:text-slate-400">
          {missed.length
            ? "The terms below are the ones to take into a Blitz next."
            : "Clean round. Blitz these terms to prove you can say it out loud."}
        </p>
      </div>

      {missed.length > 0 && (
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {missed.map((q) => {
            const chosen = q.options.find((o) => o.id === picks[q.id]);
            return (
              <div key={q.id} className="rounded-xl border border-red-200 bg-red-50/70 p-3 dark:border-red-900/50 dark:bg-red-950/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{q.concepts.join(" + ") || q.topic}</span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">{LEVEL_LABEL[q.level]}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  {chosen ? chosen.rationale : "Skipped."}
                </p>
              </div>
            );
          })}
        </div>
      )}

      <button className={`${BTN_PRIMARY} w-full`} onClick={onClose}>Done →</button>
      <p className="text-center text-[11px] text-slate-400 dark:text-slate-500">
        A quiz round counts toward a term's progress, but only a Blitz or a role-play can mark it known.
      </p>
    </div>
  );
}
