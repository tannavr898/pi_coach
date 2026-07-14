// "Flag to study later" for flashcards. Stored per-account in localStorage so
// toggling is instant (no round-trip) and survives reloads. Keyed by user id so
// two accounts on the same browser don't share flags. (Cross-device sync would
// need a DB table — a later upgrade.)

import { useCallback, useEffect, useState } from "react";

function keyFor(userId: string | null): string {
  return `pic-flags-${userId ?? "anon"}`;
}

function load(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persist(key: string, flags: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...flags]));
  } catch {
    /* storage disabled — flags just won't persist this session */
  }
}

export type FlagsApi = {
  flags: Set<string>;
  isFlagged: (id: string) => boolean;
  toggle: (id: string) => void;
};

export function useFlags(userId: string | null): FlagsApi {
  const key = keyFor(userId);
  const [flags, setFlags] = useState<Set<string>>(() => load(key));

  // Reload when the account changes (login/logout/switch).
  useEffect(() => {
    setFlags(load(key));
  }, [key]);

  const toggle = useCallback(
    (id: string) => {
      setFlags((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(key, next);
        return next;
      });
    },
    [key],
  );

  const isFlagged = useCallback((id: string) => flags.has(id), [flags]);

  return { flags, isFlagged, toggle };
}
