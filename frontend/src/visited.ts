// Which parts of the product this account has actually opened, plus whether it
// has seen the guided tour. Drives the "you haven't been here yet" dots in the
// nav and the one-time intro card on each surface.
//
// Same storage posture as flags.ts: per-account localStorage, keyed by user id so
// two accounts on one browser don't share state, and every access wrapped so that
// a disabled/quota-full store degrades to "show the dots again" rather than
// throwing. Like flags.ts, this does NOT sync across devices — that would need a
// user-preferences table, which the backend doesn't have.

import { useCallback, useEffect, useState } from "react";

/** Every surface a first-timer can be pointed at. */
export type Surface = "home" | "course" | "flashcards" | "blitz" | "tips" | "faq";

export const SURFACES: Surface[] = ["home", "course", "flashcards", "blitz", "tips", "faq"];

function visitedKey(userId: string | null): string {
  return `pic-visited-${userId ?? "anon"}`;
}

function tourKey(userId: string | null): string {
  return `pic-tour-${userId ?? "anon"}`;
}

function loadVisited(key: string): Set<Surface> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is Surface => SURFACES.includes(s as Surface)));
  } catch {
    return new Set();
  }
}

function persistVisited(key: string, visited: Set<Surface>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...visited]));
  } catch {
    /* storage disabled — the dots just reappear next load */
  }
}

function loadTourDone(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export type VisitedApi = {
  visited: Set<Surface>;
  isVisited: (s: Surface) => boolean;
  markVisited: (s: Surface) => void;
  /** How many surfaces are still unseen — for a single "N to explore" badge. */
  unvisitedCount: number;
  tourDone: boolean;
  setTourDone: (done: boolean) => void;
};

export function useVisited(userId: string | null): VisitedApi {
  const vKey = visitedKey(userId);
  const tKey = tourKey(userId);
  const [visited, setVisited] = useState<Set<Surface>>(() => loadVisited(vKey));
  const [tourDone, setTourDoneState] = useState<boolean>(() => loadTourDone(tKey));

  // Reload on account switch (login / logout / different user), mirroring useFlags.
  useEffect(() => {
    setVisited(loadVisited(vKey));
    setTourDoneState(loadTourDone(tKey));
  }, [vKey, tKey]);

  const markVisited = useCallback(
    (s: Surface) => {
      setVisited((prev) => {
        if (prev.has(s)) return prev; // no-op keeps the reference stable
        const next = new Set(prev);
        next.add(s);
        persistVisited(vKey, next);
        return next;
      });
    },
    [vKey],
  );

  const setTourDone = useCallback(
    (done: boolean) => {
      setTourDoneState(done);
      try {
        if (done) localStorage.setItem(tKey, "1");
        else localStorage.removeItem(tKey);
      } catch {
        /* storage disabled — the tour may offer itself again */
      }
    },
    [tKey],
  );

  const isVisited = useCallback((s: Surface) => visited.has(s), [visited]);

  return {
    visited,
    isVisited,
    markVisited,
    unvisitedCount: SURFACES.filter((s) => !visited.has(s)).length,
    tourDone,
    setTourDone,
  };
}
