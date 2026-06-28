import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type DeliveryMetrics,
  type EventSummary,
  type Level,
  type RubricCriterion,
  type RubricLevel,
  type RubricScore,
  type ScenarioResponse,
  type ScoreResponse,
  getEvents,
  postDelivery,
  postScenario,
  postScore,
} from "./api";

type ResponseMode = "type" | "speak";
const CAN_RECORD = typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

const PREP_SECONDS = 10 * 60;
// The presentation window is ONE 10-minute budget shared by the response and the
// judge's questions. The response clock counts it down; whatever's left rolls
// into the follow-up. Aim to wrap the pitch by ~7-8 min, leaving time for Q&A.
const PRESENTATION_SECONDS = 10 * 60;
const RECOMMENDED_SPEAK_SECONDS = 450; // 7:30 — what delivery time is graded against

type Stage = "pick" | "loading" | "ready" | "prep" | "respond" | "followup" | "scoring" | "feedback";

export default function App() {
  const [stage, setStage] = useState<Stage>("pick");
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [eventCode, setEventCode] = useState("");
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
        setFollowupAnswer(fd.transcript); // so the Transcript tab can show it
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
          <Centered>{mode === "speak" ? "Transcribing and grading your delivery…" : "Grading your response against the rubric…"}</Centered>
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
          <li>⏱️ You get <strong>10 minutes</strong> to read and plan, then <strong>10 minutes to present</strong> — and that window includes the judge's questions.</li>
          <li>🎯 Aim to wrap your pitch in about <strong>7–8 minutes</strong>, leaving 1–2 for the follow-up.</li>
          <li>🗣️ Find a quiet spot and present <strong>out loud</strong> — type or use 🎙️ Speak.</li>
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
  // Once under ~2:30 left, nudge them to wrap and save time for the judge's questions.
  const wrapUp = left > 0 && left <= 150;
  const label = left === 0
    ? "Presentation time — time's up (you can still continue)"
    : wrapUp
      ? "Presentation time — wrap up soon, leave time for the questions"
      : "Presentation time (shared with the judge's questions)";
  return (
    <div className="space-y-4">
      <TimerBar label={label} left={left} tone={left === 0 ? "red" : wrapUp ? "amber" : "slate"} />
      <details className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Show scenario &amp; what you're graded on</summary>
        <div className="mt-3 space-y-3">
          <SituationSheet text={props.scenario.situation} embedded />
          <CoverSheet scenario={props.scenario} embedded />
        </div>
      </details>

      <Card>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Your presentation</label>
          {CAN_RECORD && (
            <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
              <button
                className={`rounded-md px-2.5 py-1 ${props.mode === "type" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                onClick={() => props.onMode("type")}
              >
                ✍️ Type
              </button>
              <button
                className={`rounded-md px-2.5 py-1 ${props.mode === "speak" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                onClick={() => props.onMode("speak")}
              >
                🎙️ Speak
              </button>
            </div>
          )}
        </div>

        {props.mode === "type" ? (
          <>
            <textarea
              className="mt-2 h-64 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm leading-relaxed"
              placeholder="Open with a greeting, address the situation and every performance indicator, propose your solution, and close. Speak it out loud as you type — that's the rep."
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
            />
            <div className="mt-2 text-xs text-slate-400">{words} words</div>
          </>
        ) : (
          <div className="mt-3">
            <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} />
            <p className="mt-3 text-xs text-slate-400">
              Present out loud as if the judge is in front of you. We transcribe the audio and measure delivery —
              pace, fillers, pauses, time — alongside the content score. Delivery covers timing only, not tone or
              confidence. Your recording stays on your device unless you keep it.
            </p>
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <button
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            onClick={props.onContinue}
            disabled={!canContinue}
          >
            Continue to the judge's questions →
          </button>
        </div>
      </Card>
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
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-4">
      {err && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
      {state === "idle" && (
        <button onClick={start} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
          <span className="h-2.5 w-2.5 rounded-full bg-white" /> Start recording
        </button>
      )}
      {state === "recording" && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-red-700">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Recording {fmt(elapsed)}
          </div>
          <button onClick={stop} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
            Stop
          </button>
        </div>
      )}
      {state === "recorded" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">✓ Recorded — listen back below.</div>
          {previewUrl && <audio controls src={previewUrl} className="w-full" />}
          <button onClick={reset} className="text-xs font-medium text-slate-500 underline">Re-record</button>
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
        tone={left === 0 ? "red" : left <= 60 ? "amber" : "slate"}
      />
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">The judge asks you:</h2>
          {CAN_RECORD && (
            <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
              <button
                className={`rounded-md px-2.5 py-1 ${props.mode === "type" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                onClick={() => props.onMode("type")}
              >
                ✍️ Type
              </button>
              <button
                className={`rounded-md px-2.5 py-1 ${props.mode === "speak" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                onClick={() => props.onMode("speak")}
              >
                🎙️ Speak
              </button>
            </div>
          )}
        </div>
        <ol className="mt-3 space-y-2">
          {qs.map((q, i) => (
            <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
              <span className="mr-1 font-semibold text-slate-500">{i + 1}.</span> {q}
            </li>
          ))}
          {qs.length === 0 && <li className="text-sm text-slate-500">No follow-up questions for this scenario.</li>}
        </ol>

        {props.mode === "type" ? (
          <>
            <label className="mt-4 block text-sm font-medium text-slate-700">Your answer</label>
            <textarea
              className="mt-2 h-40 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm leading-relaxed"
              placeholder="Answer the judge's questions directly. This is graded as part of your overall impression."
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
            />
            <div className="mt-2 text-xs text-slate-400">{wordCount(props.value)} words</div>
          </>
        ) : (
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700">Answer out loud</label>
            <div className="mt-2">
              <VoiceRecorder audioBlob={props.audioBlob} onRecorded={props.onRecorded} />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              We transcribe your answer for grading. Delivery isn't scored on the follow-up — only your content.
            </p>
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <button
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            onClick={props.onSubmit}
            disabled={!canSubmit}
          >
            Submit for feedback
          </button>
        </div>
      </Card>
    </div>
  );
}

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
  const [tab, setTab] = useState<FeedbackTab>("overview");
  const [activeMark, setActiveMark] = useState<string | null>(null);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "transcript", label: "Transcript" },
    ...(props.delivery ? [{ key: "delivery", label: "Delivery" }] : []),
    ...CATEGORIES.map((c) => ({ key: c.key, label: c.tab, badge: subtotalStr(score.scores, c.key) })),
  ];

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
        <div className="mt-3 border-t border-slate-100 pt-3">
          <LevelLegend />
        </div>
      </Card>

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
      {CATEGORIES.some((c) => c.key === tab) && (
        <CategoryTab category={tab as RubricScore["category"]} scores={score.scores} />
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-500">
        {props.delivery ? (
          <>
            <strong>Content</strong> is the rubric score; <strong>Delivery</strong> measures pace, fillers, pauses,
            and time only — not tone, confidence, or charisma.
          </>
        ) : (
          <>
            Typed practice measures <strong>content</strong> only. Switch to <strong>🎙️ Speak</strong> on the
            response step to also get delivery feedback (pace, fillers, pauses, time) from your voice.
          </>
        )}
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

// --- feedback tabs ---------------------------------------------------------

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
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              on
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
            {t.badge && (
              <span
                className={`rounded px-1.5 py-0.5 text-xs tabular-nums ${
                  on ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                }`}
              >
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
          <h3 className="text-sm font-semibold">Summary</h3>
          <p className="mt-1 text-sm text-slate-700">{score.summary}</p>
        </Card>
      )}
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
    </div>
  );
}

function CategoryTab({ category, scores }: { category: RubricScore["category"]; scores: RubricScore[] }) {
  const meta = CATEGORIES.find((c) => c.key === category)!;
  const rows = scores.filter((s) => s.category === category);
  const [p, m] = subtotal(scores, category);
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
        <h3 className="text-sm font-semibold">{meta.label}</h3>
        <span className="text-sm font-semibold tabular-nums text-slate-500">
          {p}/{m}
        </span>
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
          <h3 className="text-sm font-semibold">Listen back</h3>
          <audio controls src={url} className="mt-2 w-full" />
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pace" value={String(m.pace_wpm)} unit="WPM" ok={m.pace_flag === "good"} />
        <Stat label="Fillers" value={String(m.filler_count)} unit={`${m.filler_per_min}/min`} ok={m.filler_count === 0} />
        <Stat
          label="Long pauses"
          value={String(m.long_pauses.length)}
          unit={m.longest_pause_seconds ? `max ${m.longest_pause_seconds}s` : "none"}
          ok={m.long_pauses.length === 0}
        />
        <Stat label="Time" value={fmt(Math.round(m.time_used_seconds))} unit={TIME_HINT[m.time_flag]} ok={m.time_flag === "good"} />
      </div>

      <Card>
        <h3 className="text-sm font-semibold">Coaching notes</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
          {m.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      </Card>

      {(m.fillers.length > 0 || m.crutch_phrases.length > 0) && (
        <Card>
          <h3 className="text-sm font-semibold">Words to trim</h3>
          {m.fillers.length > 0 && (
            <div className="mt-2">
              <span className="text-xs font-medium text-slate-500">Fillers</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {m.fillers.map((f) => (
                  <Chip key={f.word}>
                    {f.word} ×{f.count}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {m.crutch_phrases.length > 0 && (
            <div className="mt-3">
              <span className="text-xs font-medium text-slate-500">Crutch phrases (advisory)</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {m.crutch_phrases.map((f) => (
                  <Chip key={f.phrase}>
                    {f.phrase} ×{f.count}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        Delivery is deterministic timing measured from your audio — accurate and honest. It does not judge tone,
        confidence, or accent.
      </div>
    </div>
  );
}

const TIME_HINT: Record<DeliveryMetrics["time_flag"], string> = {
  short: "quite short",
  good: "on target",
  long: "near limit",
};

function Stat({ label, value, unit, ok }: { label: string; value: string; unit?: string; ok: boolean }) {
  const tone = ok ? "border-emerald-200 bg-emerald-50/40" : "border-amber-200 bg-amber-50/40";
  return (
    <div className={`rounded-lg border ${tone} px-3 py-2.5`}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">{value}</div>
      {unit && <div className="text-xs text-slate-500">{unit}</div>}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{children}</span>;
}

function CriterionRow({ r }: { r: RubricScore }) {
  const [open, setOpen] = useState(false);
  const tone = LEVEL_TONE[r.level];
  const headline = r.headline || truncate(r.feedback.replace(/\*\*/g, ""), 90);
  const hasDetail = !!r.feedback || r.evidence.length > 0 || r.gaps.length > 0;
  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg}`}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">
            {r.label}
            {r.pi_id && <span className="ml-1 text-xs font-normal text-slate-400">({r.pi_id})</span>}
          </p>
          {headline && <p className="mt-0.5 text-xs text-slate-600">{headline}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
          <span className="text-xs font-semibold tabular-nums text-slate-600">
            {r.points}/{r.max_points}
          </span>
          {hasDetail && <span className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>}
        </div>
      </button>
      {open && hasDetail && (
        <div className="border-t border-white/70 px-3 pb-2.5 pt-2">
          {r.feedback && <p className="text-sm text-slate-700">{richText(r.feedback)}</p>}
          {r.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.evidence.map((q, i) => (
                <span key={i} className="rounded bg-white/70 px-1.5 py-0.5 text-xs italic text-slate-500 ring-1 ring-slate-200">
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

// Per-criterion "what to add" list (shown inside an expanded criterion row).
function GapList({ gaps }: { gaps: string[] }) {
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-2">
      <p className="text-xs font-semibold text-amber-800">To raise the level, add:</p>
      <ul className="mt-1 space-y-1">
        {gaps.map((g, i) => (
          <li key={i} className="flex gap-1.5 text-xs text-amber-900">
            <span className="text-amber-500">+</span>
            <span>{g}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Aggregated "what was missing" — gaps that cost points across every criterion
// that fell short. These are absent from the response, so they can't be
// highlighted in the transcript; we list them beside it instead.
function MissingCard({ scores }: { scores: RubricScore[] }) {
  const rows = scores.filter((s) => s.gaps.length > 0 && s.level !== "exemplary");
  if (rows.length === 0) return null;
  return (
    <Card className="border-amber-200">
      <h3 className="text-sm font-semibold text-amber-900">What was missing</h3>
      <p className="mt-1 text-xs text-slate-500">
        Gaps that cost points — these weren't in your response, so they can't be highlighted. Add them next time.
      </p>
      <div className="mt-3 space-y-3">
        {rows.map((s) => (
          <div key={s.key}>
            <p className="text-xs font-medium text-slate-700">
              {s.label}
              {s.pi_id && <span className="ml-1 text-slate-400">({s.pi_id})</span>}
            </p>
            <ul className="mt-1 space-y-1">
              {s.gaps.map((g, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-slate-600">
                  <span className="text-amber-500">+</span>
                  <span>{g}</span>
                </li>
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
        marks.push({
          id: `${s.key}#${i}`,
          quote: q.trim(),
          level: s.level,
          label: s.label,
          feedback: s.feedback,
          points: s.points,
          maxPoints: s.max_points,
        });
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
      {/* Transcript column */}
      <div className="order-2 space-y-4 lg:order-1">
        <Card>
          <h3 className="text-sm font-semibold">Your presentation</h3>
          <p className="mt-1 text-xs text-slate-400">
            Highlights mark where each criterion found credit; color is the level it reached. Tap one for the note.
          </p>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {highlight(props.response, props.marks, props.active, props.onSelect)}
          </p>
        </Card>

        {props.followupAnswer.trim() && (
          <Card>
            <h3 className="text-sm font-semibold">Your follow-up answer</h3>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
              {highlight(props.followupAnswer, props.marks, props.active, props.onSelect)}
            </p>
            {props.followupFeedback && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                <span className="font-medium text-slate-700">On your follow-up:</span> {props.followupFeedback}
              </p>
            )}
          </Card>
        )}
      </div>

      {/* Annotation + gaps side panel (beside the transcript) */}
      <div className="order-1 space-y-3 lg:order-2">
        <div className="lg:sticky lg:top-4">
          <Card>
            <h3 className="text-sm font-semibold">Annotation</h3>
            {activeMark && tone ? (
              <div className={`mt-2 rounded-lg border ${tone.border} ${tone.bg} px-3 py-2.5`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">{activeMark.label}</span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.label}</span>
                    <span className="text-xs font-semibold tabular-nums text-slate-600">
                      {activeMark.points}/{activeMark.maxPoints}
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 text-sm italic text-slate-500">“{activeMark.quote}”</p>
                {activeMark.feedback && <p className="mt-1.5 text-sm text-slate-700">{richText(activeMark.feedback)}</p>}
                <button
                  className="mt-2 text-xs font-medium text-slate-400 underline"
                  onClick={() => props.onSelect(null)}
                >
                  Clear
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-400">
                Tap any highlighted phrase in your transcript to see which criterion it counted toward, the level it
                reached, and why.
              </p>
            )}
            <div className="mt-3 border-t border-slate-100 pt-3">
              <LevelLegend />
            </div>
          </Card>
        </div>
        <MissingCard scores={props.scores} />
      </div>
    </div>
  );
}

function highlight(
  text: string,
  marks: Mark[],
  active: string | null,
  onSelect: (id: string | null) => void,
): ReactNode {
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
    const on = f.mark.id === active;
    nodes.push(
      <mark
        key={`m${i}`}
        onClick={() => onSelect(on ? null : f.mark.id)}
        title={`${f.mark.label} · ${LEVEL_TONE[f.mark.level].label}`}
        className={`cursor-pointer rounded px-0.5 underline decoration-dotted underline-offset-2 ${
          LEVEL_TONE[f.mark.level].mark
        } ${on ? "ring-2 ring-slate-900/40" : ""}`}
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

// Level → colors (badge, card bg/border, transcript highlight). The scale reads
// worst→best: red → amber → blue → green, so only the TOP level (Exemplary) is
// green. Proficient is the second band (~70-85%), not full marks — coloring it
// blue keeps "all green" from looking like a perfect score when it isn't.
const LEVEL_TONE: Record<RubricLevel, { label: string; badge: string; bg: string; border: string; mark: string }> = {
  novice: { label: "Novice", badge: "bg-red-100 text-red-800", bg: "bg-red-50/40", border: "border-red-200", mark: "bg-red-100" },
  developing: { label: "Developing", badge: "bg-amber-100 text-amber-800", bg: "bg-amber-50/40", border: "border-amber-200", mark: "bg-amber-100" },
  proficient: { label: "Proficient", badge: "bg-sky-100 text-sky-800", bg: "bg-sky-50/40", border: "border-sky-200", mark: "bg-sky-100" },
  exemplary: { label: "Exemplary", badge: "bg-emerald-100 text-emerald-800", bg: "bg-emerald-50/40", border: "border-emerald-200", mark: "bg-emerald-100" },
};

const LEVEL_ORDER: RubricLevel[] = ["novice", "developing", "proficient", "exemplary"];

// Renders **bold** spans from the grader's feedback; everything else is plain.
function richText(s: string): ReactNode {
  if (!s) return s;
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-slate-900">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function LevelLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
      {LEVEL_ORDER.map((lv) => {
        const t = LEVEL_TONE[lv];
        return (
          <span key={lv} className="inline-flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-sm ${t.mark} ring-1 ring-inset ring-slate-300`} />
            {t.label}
          </span>
        );
      })}
      <span className="text-slate-400">· green = top band, not a perfect score</span>
    </div>
  );
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

// Counts down to a wall-clock deadline (ms epoch). Survives stage changes, so the
// presentation budget keeps running as the user moves from response to questions.
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
