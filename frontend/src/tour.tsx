// The guided product tour, and the one-time intro cards that back it up.
//
// This file owns PRESENTATION only — the shell, the caption bar, the keyboard and
// focus handling. The steps themselves are passed in as data, because the screens
// being demonstrated (ReadyScreen, RespondScreen, FeedbackScreen…) live in App.tsx
// and importing them here would make tour.tsx <-> App.tsx circular, which is the
// exact thing ui.tsx exists to avoid.
//
// The tour shows the REAL screens driven by the demo fixtures, not mock-ups, so it
// can't drift out of sync with the product it's explaining.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BTN_PRIMARY, BTN_SECONDARY } from "./ui";
import type { Surface } from "./visited";

export type TourStep = {
  /** Stable id for analytics — safe to reorder steps without breaking funnels. */
  id: string;
  /** Grouping label shown in the caption bar ("The rep", "Your feedback"…). */
  act: string;
  /** The one-line explanation. This is the actual teaching; keep it concrete. */
  caption: ReactNode;
  /** The screen to show above the caption bar. */
  render: () => ReactNode;
  /**
   * Give this step the full-width container. Tailwind breakpoints are viewport
   * based, not container based, so a screen with an `lg:` two-column grid (the
   * feedback view) blows out of a narrow wrapper. Mirrors the `wide` flag the app
   * shell already applies to those same screens.
   */
  wide?: boolean;
  /** Replaces Next on the final step (the hand-off to their first rep). */
  footer?: ReactNode;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function TourShell(props: {
  steps: TourStep[];
  onSkip: () => void;
  onStep?: (index: number, step: TourStep) => void;
  /** Jump straight to a step. Used by the /tour preview route for review. */
  initialStep?: number;
}) {
  const { steps, onSkip, onStep } = props;
  const [i, setI] = useState(() =>
    Math.max(0, Math.min(props.initialStep ?? 0, steps.length - 1)),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Escape must always reach the CURRENT skip handler, not the one captured when
  // the listener was installed.
  const skipRef = useRef(onSkip);
  skipRef.current = onSkip;

  const step = steps[i];
  const last = i === steps.length - 1;

  // Focus trap + Escape + focus restore. Same shape as MasteryBlitz (blitz.tsx),
  // which is the one complete implementation in this codebase.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skipRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (f.length === 0) return;
      const first = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);

  // Each step is a new screen, so start it from the top rather than inheriting the
  // previous step's scroll position.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    if (step) onStep?.(i, step);
    // onStep identity is not stable across renders; the index is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const next = useCallback(() => setI((n) => Math.min(n + 1, steps.length - 1)), [steps.length]);
  const back = useCallback(() => setI((n) => Math.max(n - 1, 0)), []);

  if (!step) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Product tour"
      className="fixed inset-0 z-50 flex flex-col bg-slate-100 dark:bg-slate-950"
    >
      {/* The screen being explained. Scrolls independently so the caption bar can
          stay docked no matter how tall the demo surface is. */}
      {/* `my-auto` on the child rather than `justify-center` on the parent: it
          centres a short screen but still scrolls a tall one from the top instead
          of clipping its head off. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto my-auto w-full px-4 py-6 sm:px-6 ${step.wide ? "max-w-6xl" : "max-w-3xl"}`}
        >
          {step.render()}
        </div>
      </div>

      {/* Caption bar */}
      <div className="shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
        <div
          className="h-1 bg-indigo-600 transition-[width] duration-300 ease-out"
          style={{ width: `${((i + 1) / steps.length) * 100}%` }}
          aria-hidden
        />
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-500">
              {step.act}
            </p>
            <p className="shrink-0 font-mono text-xs text-slate-400 dark:text-slate-500">
              {i + 1} / {steps.length}
            </p>
          </div>

          {/* Announce the new caption to screen readers as steps change. */}
          <p
            role="status"
            className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200 sm:text-base"
          >
            {step.caption}
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={onSkip}
              className="text-xs font-medium text-slate-500 underline underline-offset-4 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
            >
              Skip the tour
            </button>
            <div className="flex items-center gap-2">
              {i > 0 && (
                <button onClick={back} className={`${BTN_SECONDARY} px-4 py-2`}>
                  ← Back
                </button>
              )}
              {last ? (
                step.footer
              ) : (
                <button onClick={next} className={`${BTN_PRIMARY} px-5 py-2`}>
                  Next →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- first-visit intro ------------------------------------------------------

/**
 * The one-time card at the top of a surface the user has never opened. Explains
 * what the page is for in a sentence, then gets out of the way permanently.
 *
 * Deliberately inline rather than a modal: it introduces the thing the user is
 * already looking at, so covering it up would be self-defeating.
 */
export function FeatureIntro(props: {
  title: string;
  body: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-5 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/40 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-500">
            First time here
          </p>
          <h2 className="mt-1.5 font-display text-base font-semibold text-indigo-900 dark:text-indigo-100">
            {props.title}
          </h2>
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-indigo-800/90 dark:text-indigo-200/90">
            {props.body}
          </p>
        </div>
        <button
          onClick={props.onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-indigo-400 transition hover:bg-indigo-100 hover:text-indigo-700 dark:hover:bg-indigo-900/50 dark:hover:text-indigo-200"
        >
          ×
        </button>
      </div>
      <button
        onClick={props.onDismiss}
        className="mt-3 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
      >
        Got it
      </button>
    </div>
  );
}

/** Copy for each surface's first-visit card. */
export const FEATURE_INTROS: Record<Surface, { title: string; body: string }> = {
  home: {
    title: "Your progress, and what to do about it",
    body: "Every number here points at a next action. The radar shows which business skills you've actually demonstrated — spokes at zero mean 'not practiced yet', not 'bad'.",
  },
  course: {
    title: "A finishable path for your event",
    body: "Pick the event you compete in and get an ordered route through every skill it's graded on, split into short units. Add your competition dates and study time, and it becomes a day-by-day plan that reflows when you miss a day.",
  },
  flashcards: {
    title: "The full study library",
    body: "Every term, each with a worked example run through the four beats. Terms you've been scoring low on are marked, so you can go straight to what's costing you points.",
  },
  blitz: {
    title: "Mastery Blitz: five terms, 45 seconds each",
    body: "A speed drill you launch from a course unit or a flashcard set. It's for recall under pressure — the same pressure you're under when a judge asks a follow-up.",
  },
  tips: {
    title: "The four-beat method",
    body: "Define, Explain, Connect, Above & Beyond — the structure that turns a vague answer into a scoring one. One worked example carries the whole page.",
  },
  faq: {
    title: "How this works, and whether it's allowed",
    body: "What the AI does and doesn't do, how we differ from a generic chatbot, and where this sits with competition rules.",
  },
};

/** The small "not opened yet" marker on a nav item. */
export function NavDot() {
  return (
    <span
      className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500 align-middle"
      role="img"
      aria-label="not visited yet"
    />
  );
}
