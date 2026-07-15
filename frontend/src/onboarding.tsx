// The onboarding "first rep" pre-session screen (Task 1b + 1c).
//
// Shown to a first-time visitor who opts into the guided rep. It sets
// expectations in a few lines BEFORE the mic turns on, and offers a typed
// fallback for anyone who can't speak out loud right now (public place, shared
// computer, nerves). Voice stays the default and recommended path.
//
// It doesn't own any session state: picking a path calls onStart(mode), and
// App.tsx runs the exact same RespondScreen → FollowupScreen → FeedbackScreen
// flow the full app uses, seeded with ONBOARDING_SCENARIO.

import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow } from "./ui";
import { ONBOARDING_SCENARIO } from "./onboardingData";

export function PreSessionScreen(props: {
  onStart: (mode: "speak" | "type") => void;
  onSkip: () => void;
  canRecord: boolean;
}) {
  const s = ONBOARDING_SCENARIO;
  const prepMin = Math.round(s.timing.prep_seconds / 60);
  return (
    <div className="mx-auto max-w-2xl space-y-4 pt-4">
      <Card>
        <Eyebrow>Your first rep: 2 minutes</Eyebrow>
        <h1 className="mt-2 font-display text-2xl font-semibold leading-tight tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
          Let's do one quick round so you can see how this works.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Here's exactly what's about to happen:
        </p>
        <ol className="mt-3 space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
          <Step n={1}>
            You'll get a short, everyday business situation: a friend's coffee cart.
          </Step>
          <Step n={2}>
            You get <strong className="font-semibold">{prepMin} minutes</strong> to think and jot a few notes.
          </Step>
          <Step n={3}>
            You give a <strong className="font-semibold">60–90 second</strong> recommendation out loud (or typed).
          </Step>
          <Step n={4}>
            You get real feedback: how your ideas scored on three business skills, and, if you speak, your delivery.
          </Step>
        </ol>

        <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          🎙️ If you speak, your audio is transcribed to measure delivery: pace, filler
          words, and pauses, and then <strong className="font-semibold">discarded</strong>. It's never stored or
          judged for tone or confidence.
        </p>

        <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
          <button
            className={`${BTN_PRIMARY} sm:flex-1`}
            onClick={() => props.onStart("speak")}
            disabled={!props.canRecord}
            title={props.canRecord ? undefined : "Your browser can't record audio here: try typing instead."}
          >
            🎙️ Start out loud: recommended
          </button>
          <button className={`${BTN_SECONDARY} sm:flex-1`} onClick={() => props.onStart("type")}>
            ⌨️ Type it instead
          </button>
        </div>
        {!props.canRecord && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Recording isn't available in this browser, so we'll start you in typing mode. You still get full content feedback.
          </p>
        )}

        <button
          onClick={props.onSkip}
          className="mt-4 text-sm font-medium text-indigo-600 underline decoration-indigo-400/60 decoration-1 underline-offset-2 transition hover:text-indigo-700 hover:decoration-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          Skip the intro: set up a full role-play instead →
        </button>
      </Card>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-mono text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
