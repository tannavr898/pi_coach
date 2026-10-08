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

import { BTN_PRIMARY, BTN_SECONDARY, PageHead } from "./ui";
import { ONBOARDING_SCENARIO } from "./onboardingData";

export function PreSessionScreen(props: {
  onStart: (mode: "speak" | "type") => void;
  onSkip: () => void;
  canRecord: boolean;
}) {
  const s = ONBOARDING_SCENARIO;
  const prepMin = Math.round(s.timing.prep_seconds / 60);
  return (
    <div>
      <PageHead
        sub="Your first rep, 2 minutes"
        title="One quick round, so you can see how this works"
        blurb="Here's exactly what's about to happen:"
      />
      <ol className="pic-bleed border-t border-slate-200 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200">
        <Step n={1}>
          You'll get a short, everyday business situation: a friend's coffee cart.
        </Step>
        <Step n={2}>
          You get <strong className="font-semibold">{prepMin} minutes</strong> to think and jot a few notes.
        </Step>
        <Step n={3}>
          You give a <strong className="font-semibold">60-90 second</strong> recommendation out loud (or typed).
        </Step>
        <Step n={4}>
          You get real feedback: how your ideas scored on three business skills, and, if you speak, your delivery.
        </Step>
      </ol>

      <p className="mt-5 max-w-[70ch] text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
        If you speak, your audio is transcribed to measure delivery: pace, filler words, and pauses, and then{" "}
        <strong className="font-semibold text-slate-700 dark:text-slate-200">discarded</strong>. It's never stored or
        judged for tone or confidence.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <button
          className={BTN_PRIMARY}
          onClick={() => props.onStart("speak")}
          disabled={!props.canRecord}
          title={props.canRecord ? undefined : "Your browser can't record audio here: try typing instead."}
        >
          Start out loud (recommended)
        </button>
        <button className={BTN_SECONDARY} onClick={() => props.onStart("type")}>
          Type it instead
        </button>
        <button
          onClick={props.onSkip}
          className="ml-1 text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          Skip the intro and set up a full role-play
        </button>
      </div>
      {!props.canRecord && (
        <p className="mt-3 text-[13px] text-slate-500 dark:text-slate-400">
          Recording isn't available in this browser, so we'll start you in typing mode. You still get full content feedback.
        </p>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="pic-inset grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 border-b border-slate-200 py-3 dark:border-slate-800">
      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{n}</span>
      <span className="max-w-[70ch] leading-relaxed">{children}</span>
    </li>
  );
}
