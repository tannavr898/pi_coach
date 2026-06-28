import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type EventSummary,
  type Level,
  type RubricCriterion,
  type RubricLevel,
  type RubricScore,
  type ScenarioResponse,
  type ScoreResponse,
  getEvents,
  postScenario,
  postScore,
} from "./api";

const PREP_SECONDS = 10 * 60;
const RESPONSE_SECONDS = 10 * 60;
const FOLLOWUP_SECONDS = 3 * 60;

type Stage = "pick" | "loading" | "ready" | "prep" | "respond" | "followup" | "scoring" | "feedback";

export default function App() {
  const [stage, setStage] = useState<Stage>("pick");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCode, setEventCode] = useState("");
  const [level, setLevel] = useState<Level>("district");
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);
  const [responseText, setResponseText] = useState("");
  const [followupAnswer, setFollowupAnswer] = useState("");
  const [score, setScore] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEvents()
      .then((evs) => {
        setEvents(evs);
        if (evs[0]) setEventCode(evs[0].code);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  async function generate() {
    setError(null);
    setStage("loading");
    try {
      const s = await postScenario({ event_code: eventCode, level });
      setScenario(s);
      setResponseText("");
      setFollowupAnswer("");
      setScore(null);
      setStage("ready");
    } catch (e) {
      setError(errMsg(e));
      setStage("pick");
    }
  }

  async function submit() {
    if (!scenario || !responseText.trim()) return;
    setError(null);
    setStage("scoring");
    try {
      const result = await postScore({
        event_code: scenario.event.code,
        scenario: scenario.situation,
        pi_ids: scenario.performance_indicators.map((p) => p.id),
        response: responseText,
        followup_questions: scenario.followup_questions,
        followup_answer: followupAnswer,
      });
      setScore(result);
      setStage("feedback");
    } catch (e) {
      setError(errMsg(e));
      setStage("followup");
    }
  }

  function restart() {
    setScenario(null);
    setScore(null);
    setResponseText("");
    setFollowupAnswer("");
    setError(null);
    setStage("pick");
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-3xl px-5 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold">DECA Roleplay Trainer</h1>
          <p className="text-sm text-slate-500">
            Practice a Principles roleplay out loud — original scenario, real prep timer, rubric feedback.
          </p>
        </header>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {stage === "pick" && (
          <PickScreen
            events={events}
            eventCode={eventCode}
            level={level}
            onEvent={setEventCode}
            onLevel={setLevel}
            onGenerate={generate}
          />
        )}

        {stage === "loading" && <Centered>Writing an original scenario…</Centered>}

        {stage === "ready" && scenario && (
          <ReadyScreen scenario={scenario} onStart={() => setStage("prep")} />
        )}

        {stage === "prep" && scenario && (
          <PrepScreen scenario={scenario} onStart={() => setStage("respond")} />
        )}

        {stage === "respond" && scenario && (
          <RespondScreen
            scenario={scenario}
            value={responseText}
            onChange={setResponseText}
            onContinue={() => setStage("followup")}
          />
        )}

        {stage === "followup" && scenario && (
          <FollowupScreen
            scenario={scenario}
            value={followupAnswer}
            onChange={setFollowupAnswer}
            onSubmit={submit}
          />
        )}

        {stage === "scoring" && <Centered>Grading your response against the rubric…</Centered>}

        {stage === "feedback" && score && scenario && (
          <FeedbackScreen
            scenario={scenario}
            score={score}
            response={responseText}
            followupAnswer={followupAnswer}
            onRestart={restart}
          />
        )}
      </div>
    </main>
  );
}

// --- screens ---------------------------------------------------------------

function PickScreen(props: {
  events: EventSummary[];
  eventCode: string;
  level: Level;
  onEvent: (c: string) => void;
  onLevel: (l: Level) => void;
  onGenerate: () => void;
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold">Start a practice roleplay</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">Event</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            value={props.eventCode}
            onChange={(e) => props.onEvent(e.target.value)}
          >
            {props.events.map((e) => (
              <option key={e.code} value={e.code}>
                {e.name} ({e.code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">Level</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            value={props.level}
            onChange={(e) => props.onLevel(e.target.value as Level)}
          >
            <option value="district">District</option>
            <option value="state">State / Association</option>
            <option value="icdc">ICDC</option>
          </select>
        </label>
      </div>
      <button
        className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        onClick={props.onGenerate}
        disabled={!props.eventCode}
      >
        Generate scenario
      </button>
      <HonestyNote />
    </Card>
  );
}

function ReadyScreen(props: { scenario: ScenarioResponse; onStart: () => void }) {
  const s = props.scenario;
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Ready when you are</p>
        <h2 className="mt-1 text-lg font-semibold">
          {s.event.name} · {s.instructional_area}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Your scenario is written. Take a breath — the prep clock only starts when you press the button.
        </p>

        <h3 className="mt-5 text-sm font-semibold text-slate-700">Before you start</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
          <li>✏️ Grab a pen and paper (or open notes) — you'll outline your plan during prep.</li>
          <li>⏱️ You get <strong>10 minutes</strong> to read the situation and plan, then up to 10 to present.</li>
          <li>🗣️ Find a quiet spot and present <strong>out loud</strong> — typing here is the stand-in for speaking.</li>
          <li>🎯 Plan an intro, address all 4 performance indicators, propose a clear solution, and close.</li>
          <li>❓ At the end the judge asks <strong>two follow-up questions</strong> — you'll answer those too.</li>
        </ul>

        <button
          className="mt-6 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
          onClick={props.onStart}
        >
          I'm ready — start prep (10:00) →
        </button>
      </Card>
      <RubricNote scenario={s} />
    </div>
  );
}

function PrepScreen(props: { scenario: ScenarioResponse; onStart: () => void }) {
  const left = useCountdown(PREP_SECONDS, true, props.onStart);
  return (
    <div className="space-y-4">
      <TimerBar label="Prep time" left={left} tone="amber" />
      <CoverSheet scenario={props.scenario} />
      <SituationSheet text={props.scenario.situation} />
      <button
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        onClick={props.onStart}
      >
        Start my response →
      </button>
    </div>
  );
}

function RespondScreen(props: {
  scenario: ScenarioResponse;
  value: string;
  onChange: (v: string) => void;
  onContinue: () => void;
}) {
  const left = useCountdown(RESPONSE_SECONDS, true);
  const words = wordCount(props.value);
  return (
    <div className="space-y-4">
      <TimerBar
        label={`Response time${left === 0 ? " — time's up (you can still continue)" : ""}`}
        left={left}
        tone={left === 0 ? "red" : "slate"}
      />
      <details className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Show scenario &amp; what you're graded on</summary>
        <div className="mt-3 space-y-3">
          <SituationSheet text={props.scenario.situation} embedded />
          <CoverSheet scenario={props.scenario} embedded />
        </div>
      </details>
      <Card>
        <label className="text-sm font-medium text-slate-700">Your presentation</label>
        <textarea
          className="mt-2 h-64 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm leading-relaxed"
          placeholder="Open with a greeting, address the situation and every performance indicator, propose your solution, and close. Speak it out loud as you type — that's the rep."
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">{words} words</span>
          <button
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            onClick={props.onContinue}
            disabled={!props.value.trim()}
          >
            Continue to the judge's questions →
          </button>
        </div>
      </Card>
    </div>
  );
}

function FollowupScreen(props: {
  scenario: ScenarioResponse;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const left = useCountdown(FOLLOWUP_SECONDS, true);
  const qs = props.scenario.followup_questions;
  return (
    <div className="space-y-4">
      <TimerBar label="The judge follows up" left={left} tone={left === 0 ? "red" : "slate"} />
      <Card>
        <h2 className="text-base font-semibold">The judge asks you:</h2>
        <ol className="mt-3 space-y-2">
          {qs.map((q, i) => (
            <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <span className="mr-1 font-semibold text-slate-500">{i + 1}.</span> {q}
            </li>
          ))}
          {qs.length === 0 && <li className="text-sm text-slate-500">No follow-up questions for this scenario.</li>}
        </ol>
        <label className="mt-4 block text-sm font-medium text-slate-700">Your answer</label>
        <textarea
          className="mt-2 h-40 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm leading-relaxed"
          placeholder="Answer the judge's questions directly. This is graded as part of your overall impression."
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">{wordCount(props.value)} words</span>
          <button
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            onClick={props.onSubmit}
          >
            Submit for feedback
          </button>
        </div>
      </Card>
    </div>
  );
}

function FeedbackScreen(props: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  response: string;
  followupAnswer: string;
  onRestart: () => void;
}) {
  const { score } = props;
  const marks = buildMarks(score.scores);
  const pct = Math.round((score.total_points / score.max_points) * 100);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Rubric feedback</h2>
            <p className="mt-1 text-xs text-slate-500">
              Graded on the DECA 2026 District rubric. Practice coaching, not an official competition score.
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums text-slate-900">
              {score.total_points}
              <span className="text-lg font-medium text-slate-400">/{score.max_points}</span>
            </div>
            <div className="text-xs text-slate-500">{pct}%</div>
          </div>
        </div>
        {score.summary && <p className="mt-3 text-sm text-slate-700">{score.summary}</p>}
      </Card>

      {(score.strengths.length > 0 || score.improvements.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {score.strengths.length > 0 && (
            <Card className="border-emerald-200">
              <h3 className="text-sm font-semibold text-emerald-800">Strengths</h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {score.strengths.map((s, i) => (
                  <li key={i}>✓ {s}</li>
                ))}
              </ul>
            </Card>
          )}
          {score.improvements.length > 0 && (
            <Card className="border-amber-200">
              <h3 className="text-sm font-semibold text-amber-800">Focus next time</h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {score.improvements.map((s, i) => (
                  <li key={i}>→ {s}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <Transcript title="Your presentation" text={props.response} marks={marks} />
      {props.followupAnswer.trim() && (
        <Transcript title="Your follow-up answer" text={props.followupAnswer} marks={marks} />
      )}
      {score.followup_feedback && (
        <Card className="border-slate-300">
          <h3 className="text-sm font-semibold">On your follow-up</h3>
          <p className="mt-1 text-sm text-slate-700">{score.followup_feedback}</p>
        </Card>
      )}

      <RubricBreakdown scores={score.scores} />

      <div className="rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-500">
        Typed practice measures <strong>content</strong> only. Delivery — pace, filler words, pauses — is
        measured from your voice in the spoken loop (coming next), not here.
      </div>

      <button
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        onClick={props.onRestart}
      >
        Practice again
      </button>
    </div>
  );
}

// --- rubric feedback bits --------------------------------------------------

const CATEGORY_ORDER: { key: RubricScore["category"]; label: string }[] = [
  { key: "performance_indicator", label: "Performance Indicators" },
  { key: "solution", label: "Solution" },
  { key: "career_competency", label: "Career Competencies" },
  { key: "overall_impression", label: "Overall Impression" },
];

function RubricBreakdown({ scores }: { scores: RubricScore[] }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold">Score breakdown</h3>
      <div className="mt-3 space-y-5">
        {CATEGORY_ORDER.map((cat) => {
          const rows = scores.filter((s) => s.category === cat.key);
          if (rows.length === 0) return null;
          const pts = rows.reduce((a, r) => a + r.points, 0);
          const max = rows.reduce((a, r) => a + r.max_points, 0);
          return (
            <div key={cat.key}>
              <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{cat.label}</h4>
                <span className="text-xs font-medium tabular-nums text-slate-500">
                  {pts}/{max}
                </span>
              </div>
              <div className="mt-2 space-y-2.5">
                {rows.map((r) => (
                  <CriterionRow key={r.key} r={r} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CriterionRow({ r }: { r: RubricScore }) {
  const tone = LEVEL_TONE[r.level];
  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg} px-3 py-2.5`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-800">
          {r.label}
          {r.pi_id && <span className="ml-1 text-xs font-normal text-slate-400">({r.pi_id})</span>}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
          <span className="text-xs font-semibold tabular-nums text-slate-600">
            {r.points}/{r.max_points}
          </span>
        </div>
      </div>
      {r.feedback && <p className="mt-1.5 text-sm text-slate-600">{r.feedback}</p>}
      {r.evidence.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {r.evidence.map((q, i) => (
            <span key={i} className="rounded bg-white/70 px-1.5 py-0.5 text-xs italic text-slate-500 ring-1 ring-slate-200">
              “{truncate(q, 80)}”
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- transcript highlighting ----------------------------------------------

type Mark = { quote: string; level: RubricLevel; label: string };

function buildMarks(scores: RubricScore[]): Mark[] {
  const marks: Mark[] = [];
  for (const s of scores) {
    for (const q of s.evidence) {
      if (q && q.trim().length > 3) marks.push({ quote: q.trim(), level: s.level, label: `${s.label} · ${LEVEL_TONE[s.level].label}` });
    }
  }
  return marks;
}

function Transcript({ title, text, marks }: { title: string; text: string; marks: Mark[] }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-slate-400">Highlights show where each criterion saw evidence — color reflects the level reached.</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{highlight(text, marks)}</p>
    </Card>
  );
}

function highlight(text: string, marks: Mark[]): ReactNode {
  if (!text) return text;
  const lower = text.toLowerCase();
  const found: { start: number; end: number; mark: Mark }[] = [];
  // Longer quotes first so a specific phrase wins over a contained shorter one.
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
    nodes.push(
      <mark key={`m${i}`} title={f.mark.label} className={`rounded px-0.5 ${LEVEL_TONE[f.mark.level].mark}`}>
        {text.slice(f.start, f.end)}
      </mark>,
    );
    cursor = f.end;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return nodes;
}

// --- shared bits -----------------------------------------------------------

function CoverSheet({ scenario, embedded }: { scenario: ScenarioResponse; embedded?: boolean }) {
  const s = scenario;
  const body = (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Performance indicators ({s.performance_indicators.length})</h3>
        <ul className="mt-2 space-y-1.5">
          {s.performance_indicators.map((p) => (
            <li key={p.id} className="text-sm text-slate-700">
              • {p.text} <span className="text-xs text-slate-400">({p.id})</span>
            </li>
          ))}
        </ul>
      </div>
      <CriteriaList title="Solution" items={s.solution_criteria} />
      <CriteriaList title="Career competencies" items={s.career_competencies} />
      <div>
        <h3 className="text-sm font-semibold">Procedures</h3>
        <ul className="mt-2 space-y-1 text-sm text-slate-600">
          {s.procedures.map((p, i) => (
            <li key={i}>• {p}</li>
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
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">
        {items.map((c) => (
          <li key={c.key}>
            <span className="font-medium">{c.label}</span> — <span className="text-slate-600">{c.desc}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SituationSheet({ text, embedded }: { text: string; embedded?: boolean }) {
  const body = (
    <>
      <h3 className="text-sm font-semibold">Event situation</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{text}</p>
    </>
  );
  return embedded ? <div>{body}</div> : <Card>{body}</Card>;
}

function RubricNote({ scenario }: { scenario: ScenarioResponse }) {
  return (
    <Card className="border-slate-200 bg-slate-50">
      <p className="text-xs text-slate-500">
        You'll be graded out of 100 on the DECA 2026 District rubric: 4 performance indicators (12 pts each),
        a solution ({scenario.solution_criteria.map((c) => c.label.toLowerCase()).join(", ")}), three career
        competencies, and overall impression. Original practice material — not an official DECA document.
      </p>
    </Card>
  );
}

function HonestyNote() {
  return (
    <p className="mt-4 text-xs text-slate-400">
      Scenarios are original practice materials in DECA's style — not official DECA documents. Feedback grades
      content against the rubric; delivery is coached later from your voice.
    </p>
  );
}

function TimerBar({ label, left, tone }: { label: string; left: number; tone: "amber" | "slate" | "red" }) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    slate: "border-slate-200 bg-white text-slate-700",
    red: "border-red-200 bg-red-50 text-red-700",
  };
  const num = { amber: "text-amber-900", slate: "text-slate-900", red: "text-red-600" };
  return (
    <div className={`flex items-center justify-between rounded-lg border px-4 py-3 ${tones[tone]}`}>
      <div className="text-sm font-medium">{label}</div>
      <div className={`font-mono text-lg font-semibold ${num[tone]}`}>{fmt(left)}</div>
    </div>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border bg-white p-5 shadow-sm ${className || "border-slate-200"}`}>{children}</div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <span className="h-3 w-3 animate-pulse rounded-full bg-amber-400" />
        {children}
      </div>
    </Card>
  );
}

// Level → colors (badge, card bg/border, transcript highlight).
const LEVEL_TONE: Record<RubricLevel, { label: string; badge: string; bg: string; border: string; mark: string }> = {
  novice: { label: "Novice", badge: "bg-red-100 text-red-800", bg: "bg-red-50/40", border: "border-red-200", mark: "bg-red-100" },
  developing: { label: "Developing", badge: "bg-amber-100 text-amber-800", bg: "bg-amber-50/40", border: "border-amber-200", mark: "bg-amber-100" },
  proficient: { label: "Proficient", badge: "bg-emerald-100 text-emerald-800", bg: "bg-emerald-50/40", border: "border-emerald-200", mark: "bg-emerald-100" },
  exemplary: { label: "Exemplary", badge: "bg-sky-100 text-sky-800", bg: "bg-sky-50/40", border: "border-sky-200", mark: "bg-sky-100" },
};

// --- timer -----------------------------------------------------------------

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
