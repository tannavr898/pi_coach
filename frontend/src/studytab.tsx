// The Study tab: one place to study, with two ways in.
//
// This used to be three nav items doing one job. "Study" was the event course,
// "Library" was the 830-card browser, and "Flashcards" pointed at the public
// server-rendered deck pages, which are an SEO surface rather than a tool. A
// student reading the nav had no way to tell which of the three they wanted, and
// the honest answer was that they wanted whichever one happened to hold the cards
// they were after.
//
// So: one tab, two modes.
//   - MY PATH is the event course, the dated plan, and the units in order. It is
//     the answer to "what should I do today".
//   - ALL DOMAINS is the whole corpus by domain, with search, flags and weak-term
//     decks. It is the answer to "I want to look something up" or "I want to study
//     outside my event".
//
// Progress is shared between them for free, and deliberately so: both write the
// same per-term records keyed by term id (backend/app/study.py), so a term proven
// in a course unit shows as proven when you find it by search, and the other way
// round. Nothing here has to synchronise anything.
//
// The public /flashcards pages still exist at their own URLs, still in the
// sitemap, still linked from the footer. They are simply not nav any more.

import { useEffect, useState } from "react";
import { type Term } from "./api";
import { StudyCourse } from "./course";
import type { FlagsApi } from "./flags";
import { FlashcardLibrary } from "./flashcards";

export type StudyMode = "path" | "domains";

// Remembered so the tab reopens where you left it. A student who studies outside
// their event does it repeatedly, and making them re-pick every visit is the kind
// of small friction that reads as the app not paying attention.
const MODE_KEY = "picoach.study.mode";

function readMode(): StudyMode {
  try {
    return localStorage.getItem(MODE_KEY) === "domains" ? "domains" : "path";
  } catch {
    return "path";
  }
}

type QuizOpts = { cluster?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" };

export function StudyTab({
  authed,
  refreshKey,
  flags,
  initialDeck,
  initialMode,
  onStudy,
  onBlitz,
  onQuiz,
  onPractice,
  onSignup,
}: {
  authed: boolean;
  refreshKey?: number;
  flags: FlagsApi;
  // Arriving from a public deck page: open the browser on that event's deck.
  initialDeck?: string | null;
  initialMode?: StudyMode;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
  onQuiz: (cards: Term[], title?: string, opts?: QuizOpts) => void;
  onPractice: (criterionName?: string) => void;
  onSignup: () => void;
}) {
  const [mode, setMode] = useState<StudyMode>(() => initialMode ?? readMode());

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode: the toggle still works, it just won't be remembered */
    }
  }, [mode]);

  // The two halves are different widths (the course reads as a column, the
  // browser as a grid), so the toggle tracks whichever is below it rather than
  // floating off to one side on a wide screen.
  return (
    <div className={`mx-auto space-y-5 ${mode === "path" ? "max-w-5xl" : "max-w-6xl"}`}>
      <ModeToggle mode={mode} onMode={setMode} />

      {/* Both stay mounted once opened would be nicer still, but the course does
          its own refetching on refreshKey and the library holds the whole corpus,
          so swapping is already instant after the first visit to each. */}
      {mode === "path" ? (
        <StudyCourse
          authed={authed}
          refreshKey={refreshKey}
          onStudy={onStudy}
          onBlitz={onBlitz}
          onQuiz={onQuiz}
          onPractice={onPractice}
          onSignup={onSignup}
          onBrowseAll={() => setMode("domains")}
        />
      ) : (
        <>
          {/* Everything here works signed out: the cards, the search, the flags
              (kept locally) and the quiz. What an account buys is the part that
              has to outlive the tab, so the ask belongs exactly here rather than
              in front of the door. */}
          {!authed && (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              Browse, flip and quiz as much as you like.{" "}
              <button onClick={onSignup} className="font-semibold text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
                Create a free account
              </button>{" "}
              and we'll remember which terms you've proven.
            </p>
          )}
          <FlashcardLibrary
            flags={flags}
            initialDeck={initialDeck}
            onStudy={onStudy}
            onBlitz={onBlitz}
            onQuiz={onQuiz}
          />
        </>
      )}
    </div>
  );
}

function ModeToggle({ mode, onMode }: { mode: StudyMode; onMode: (m: StudyMode) => void }) {
  const options: { id: StudyMode; label: string; hint: string }[] = [
    { id: "path", label: "My path", hint: "Your event, in order" },
    { id: "domains", label: "All domains", hint: "Everything, by topic" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Study mode"
      className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-900"
    >
      {options.map((o) => {
        const active = o.id === mode;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={active}
            onClick={() => onMode(o.id)}
            className={`tap rounded-lg px-4 py-2 text-left transition ${
              active
                ? "bg-white shadow-sm dark:bg-slate-800"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            <span
              className={`block text-sm font-semibold ${
                active ? "text-slate-900 dark:text-slate-100" : ""
              }`}
            >
              {o.label}
            </span>
            <span className="mt-0.5 block text-[11px] leading-none text-slate-500 dark:text-slate-400">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
