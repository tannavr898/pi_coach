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
import { Sidebar, SideGroup, SideItem } from "./ui";

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

type QuizOpts = { exam?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" };

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

  return (
    <div>
      {/* The two modes head the sidebar, so My path and All domains read as one
          place; whichever is open adds its own lists underneath. */}
      <Sidebar>
        <SideGroup title="Study">
          <SideItem active={mode === "path"} onClick={() => setMode("path")} sub="Your event, in order">My path</SideItem>
          <SideItem active={mode === "domains"} onClick={() => setMode("domains")} sub="Everything, by topic">All domains</SideItem>
        </SideGroup>
      </Sidebar>

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
            <p className="pt-5 text-sm text-slate-600 dark:text-slate-300">
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
