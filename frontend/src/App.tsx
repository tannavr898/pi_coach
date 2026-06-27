import { useEffect, useRef, useState } from "react";
import {
  type Coverage,
  type EventSummary,
  type Level,
  type PIResult,
  type ScenarioResponse,
  type ScoreResponse,
  getEvents,
  postScenario,
  postScore,
} from "./api";

const PREP_SECONDS = 10 * 60;
const RESPONSE_SECONDS = 10 * 60;

type Stage = "pick" | "loading" | "prep" | "respond" | "scoring" | "feedback";

export default function App() {
  const [stage, setStage] = useState<Stage>("pick");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCode, setEventCode] = useState("");
  const [level, setLevel] = useState<Level>("district");
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);
  const [responseText, setResponseText] = useState("");
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
      setScore(null);
      setStage("prep");
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
        scenario: scenario.scenario,
        pi_ids: scenario.performance_indicators.map((p) => p.id),
        response: responseText,
      });
      setScore(result);
      setStage("feedback");
    } catch (e) {
      setError(errMsg(e));
      setStage("respond");
    }
  }

  function restart() {
    setScenario(null);
    setScore(null);
    setResponseText("");
    setError(null);
    setStage("pick");
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-3xl px-5 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold">DECA Roleplay Trainer</h1>
          <p className="text-sm text-slate-500">
            Practice a Principles roleplay out loud — original scenario, real prep timer, honest feedback.
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

        {stage === "prep" && scenario && (
          <PrepScreen scenario={scenario} onStart={() => setStage("respond")} />
        )}

        {stage === "respond" && scenario && (
          <RespondScreen
            scenario={scenario}
            value={responseText}
            onChange={setResponseText}
            onSubmit={submit}
          />
        )}

        {stage === "scoring" && <Centered>Reading your response against the PIs…</Centered>}

        {stage === "feedback" && score && scenario && (
          <FeedbackScreen scenario={scenario} score={score} onRestart={restart} />
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

function PrepScreen(props: { scenario: ScenarioResponse; onStart: () => void }) {
  const left = useCountdown(PREP_SECONDS, true, props.onStart);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="text-sm font-medium text-amber-800">Prep time</div>
        <div className="font-mono text-lg font-semibold text-amber-900">{fmt(left)}</div>
      </div>
      <PIList pis={props.scenario.performance_indicators} />
      <ScenarioSheet text={props.scenario.scenario} />
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
  onSubmit: () => void;
}) {
  const left = useCountdown(RESPONSE_SECONDS, true);
  const words = props.value.trim() ? props.value.trim().split(/\s+/).length : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="text-sm font-medium text-slate-700">Response time {left === 0 && "— time's up (you can still submit)"}</div>
        <div className={`font-mono text-lg font-semibold ${left === 0 ? "text-red-600" : "text-slate-900"}`}>{fmt(left)}</div>
      </div>
      <details className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Show scenario &amp; PIs</summary>
        <div className="mt-3 space-y-3">
          <PIList pis={props.scenario.performance_indicators} embedded />
          <ScenarioSheet text={props.scenario.scenario} embedded />
        </div>
      </details>
      <Card>
        <label className="text-sm font-medium text-slate-700">Type your response</label>
        <textarea
          className="mt-2 h-64 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm leading-relaxed"
          placeholder="Address the task and every performance indicator. Speak it out loud as you type — that's the rep."
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">{words} words</span>
          <button
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            onClick={props.onSubmit}
            disabled={!props.value.trim()}
          >
            Submit for feedback
          </button>
        </div>
      </Card>
    </div>
  );
}

function FeedbackScreen(props: { scenario: ScenarioResponse; score: ScoreResponse; onRestart: () => void }) {
  const s = props.score.pi_coverage_summary;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">PI coverage feedback</h2>
          <div className="flex gap-2 text-xs font-medium">
            <Pill className="bg-green-100 text-green-800">{s.hit} hit</Pill>
            <Pill className="bg-amber-100 text-amber-800">{s.partial} partial</Pill>
            <Pill className="bg-red-100 text-red-800">{s.missed} missed</Pill>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          This is the model's structured read of your content, not a judge or competition score.
        </p>
      </Card>

      {props.score.pi_results.map((r) => (
        <PIResultCard key={r.id} r={r} />
      ))}

      <Card>
        <h3 className="text-sm font-semibold">Structure &amp; task</h3>
        <p className="mt-1 text-sm text-slate-700">{props.score.structure_feedback}</p>
        <p className="mt-2 text-sm">
          Addressed the task:{" "}
          <span className={props.score.addressed_task ? "text-green-700" : "text-red-700"}>
            {props.score.addressed_task ? "yes" : "not fully"}
          </span>
        </p>
        {props.score.overall_notes && (
          <p className="mt-2 text-sm text-slate-700">{props.score.overall_notes}</p>
        )}
      </Card>

      {props.score.followup_question && (
        <Card className="border-slate-300 bg-white">
          <h3 className="text-sm font-semibold">Judge follow-up to practice</h3>
          <p className="mt-1 text-sm text-slate-700">“{props.score.followup_question}”</p>
        </Card>
      )}

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

// --- shared bits -----------------------------------------------------------

function PIResultCard({ r }: { r: PIResult }) {
  const tone = coverageTone(r.coverage);
  return (
    <Card className={tone.border}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-800">{r.text}</p>
        <Pill className={tone.pill}>{r.coverage}</Pill>
      </div>
      {r.evidence && (
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Evidence:</span> {r.evidence}
        </p>
      )}
      {r.improvement && (
        <p className="mt-1 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Improve:</span> {r.improvement}
        </p>
      )}
      <p className="mt-1 text-xs text-slate-400">{r.id}</p>
    </Card>
  );
}

function PIList({ pis, embedded }: { pis: ScenarioResponse["performance_indicators"]; embedded?: boolean }) {
  const body = (
    <>
      <h3 className="text-sm font-semibold">Performance indicators ({pis.length})</h3>
      <ul className="mt-2 space-y-1.5">
        {pis.map((p) => (
          <li key={p.id} className="text-sm text-slate-700">
            • {p.text} <span className="text-xs text-slate-400">({p.id})</span>
          </li>
        ))}
      </ul>
    </>
  );
  return embedded ? <div>{body}</div> : <Card>{body}</Card>;
}

function ScenarioSheet({ text, embedded }: { text: string; embedded?: boolean }) {
  const body = (
    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{text}</pre>
  );
  return embedded ? body : <Card>{body}</Card>;
}

function HonestyNote() {
  return (
    <p className="mt-4 text-xs text-slate-400">
      Scenarios are original practice materials in DECA's style — not official DECA documents. Feedback is PI
      coverage + structure, never a judge score.
    </p>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border bg-white p-5 shadow-sm ${className || "border-slate-200"}`}>
      {children}
    </div>
  );
}

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded-full px-2 py-0.5 ${className}`}>{children}</span>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <span className="h-3 w-3 animate-pulse rounded-full bg-amber-400" />
        {children}
      </div>
    </Card>
  );
}

function coverageTone(c: Coverage) {
  if (c === "hit") return { pill: "bg-green-100 text-green-800", border: "border-green-200" };
  if (c === "partial") return { pill: "bg-amber-100 text-amber-800", border: "border-amber-200" };
  return { pill: "bg-red-100 text-red-800", border: "border-red-200" };
}

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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
