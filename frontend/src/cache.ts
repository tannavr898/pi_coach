// A tiny stale-while-revalidate cache for the signed-in API reads.
//
// The point is that moving between tabs should feel instant. The first visit to
// a page fetches as usual; every visit after that renders the last answer we had
// immediately and refreshes it in the background, and anything subscribed (the
// `useCached` hook) re-renders when the fresh copy lands. Writes that change what
// a page shows call `invalidate` with the affected path prefixes, which DROPS
// those entries, so the next read is a real fetch rather than a stale answer.
//
// Entries are scoped to one account and mirrored to sessionStorage, so a reload
// is instant too. sessionStorage rather than localStorage on purpose: school
// computers are shared, and this holds a student's scores and messages. It dies
// with the tab, and `setCacheScope` wipes it the moment the account changes.

import { useEffect, useReducer, useRef } from "react";

type Entry = { data: unknown; at: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
// Per key: the mounted components showing it. `render` re-renders one with the
// current entry; `refetch` refreshes the entry with that component's fetcher.
type Listener = { render: () => void; refetch: () => Promise<unknown> };
const listeners = new Map<string, Set<Listener>>();
let scope: string | null = null;

// Background refreshes are skipped when the copy we hold is younger than this:
// clicking between two tabs shouldn't refetch both every time.
const FRESH_MS = 5_000;
const STORAGE_PREFIX = "pic-cache:";
// Large answers (a 200-session progress payload) are still small, but a ceiling
// keeps one bad entry from blowing the per-origin storage quota.
const MAX_PERSIST_CHARS = 400_000;

function storageKey(): string | null {
  return scope ? `${STORAGE_PREFIX}${scope}` : null;
}

function persist(): void {
  const k = storageKey();
  if (!k) return;
  try {
    const obj: Record<string, Entry> = {};
    for (const [key, e] of store) obj[key] = e;
    const raw = JSON.stringify(obj);
    if (raw.length <= MAX_PERSIST_CHARS) sessionStorage.setItem(k, raw);
  } catch {
    /* private mode or quota: the in-memory cache still works */
  }
}

let persistTimer: number | undefined;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    persist();
  }, 300);
}

function notify(key: string): void {
  listeners.get(key)?.forEach((l) => l.render());
}

/** Point the cache at an account (or none). A different account empties it. */
export function setCacheScope(userId: string | null): void {
  if (userId === scope) return;
  store.clear();
  inflight.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX) && k !== `${STORAGE_PREFIX}${userId}`) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  scope = userId;
  const k = storageKey();
  if (!k) return;
  try {
    const raw = sessionStorage.getItem(k);
    if (raw) for (const [key, e] of Object.entries(JSON.parse(raw) as Record<string, Entry>)) store.set(key, e);
  } catch {
    /* corrupt: start empty */
  }
}

// The key whose fetcher is starting right now. A component subscribes with an API
// function (getProgress) that is itself written as `cached(key, rawFetch)`; when
// we call it to REFRESH, that inner lookup must go to the network, not hand back
// the very copy we're replacing. The inner call happens synchronously as the
// fetcher starts, so a plain variable is enough to recognize it.
let starting: string | null = null;

function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const owner = scope;
  let started: Promise<T>;
  starting = key;
  try {
    started = fetcher();
  } finally {
    starting = null;
  }
  const p = started
    .then((data) => {
      // An answer for an account that has since signed out must not land.
      if (owner === scope) {
        store.set(key, { data, at: Date.now() });
        schedulePersist();
        notify(key);
      }
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * The cached answer if there is one (refreshing it in the background when it's
 * more than a few seconds old), otherwise a real fetch. Errors are never cached.
 */
export function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  if (key === starting) {
    starting = null;
    return fetcher();
  }
  const hit = store.get(key);
  if (hit) {
    if (Date.now() - hit.at > FRESH_MS) revalidate(key, fetcher).catch(() => {});
    return Promise.resolve(hit.data as T);
  }
  return revalidate(key, fetcher);
}

/** Read what's cached right now, without fetching. */
export function peek<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined;
}

/** Warm an entry ahead of a visit. Never throws. */
export function prefetch<T>(key: string, fetcher: () => Promise<T>): void {
  if (!store.has(key)) revalidate(key, fetcher).catch(() => {});
}

/**
 * Something changed what these reads would return. Entries a mounted component
 * is showing are refetched in place (the old data stays up until the new copy
 * lands, so nothing flashes); the rest are dropped so their next visit fetches.
 */
export function invalidate(...prefixes: string[]): Promise<void> {
  let changed = false;
  const pending: Promise<unknown>[] = [];
  for (const key of [...store.keys()]) {
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    const showing = listeners.get(key);
    if (showing?.size) {
      inflight.delete(key); // a request already in flight may predate the change
      pending.push([...showing][0].refetch());
    } else {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersist();
  return Promise.all(pending).then(() => undefined);
}

/**
 * Subscribe a component to one cached read. Renders the cached value on the very
 * first paint when there is one; `loading` is only true when there's nothing to
 * show yet. `refresh()` forces a refetch and keeps showing the old data meanwhile.
 * A null key means "not ready to fetch" (no chapter picked yet, say).
 */
export function useCached<T>(key: string | null, fetcher: () => Promise<T>): {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const errRef = useRef<{ key: string | null; msg: string | null }>({ key: null, msg: null });
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (!key) return;
    const load = () =>
      cached(key, () => fetcherRef.current()).catch((e) => {
        errRef.current = { key, msg: e instanceof Error ? e.message : String(e) };
        bump();
      });
    const onChange: Listener = {
      render: bump,
      refetch: () => revalidate(key, () => fetcherRef.current()).catch(() => {}),
    };
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(onChange);
    errRef.current = { key, msg: null };
    void load();
    return () => {
      set?.delete(onChange);
    };
  }, [key]);

  const data = key ? (store.get(key)?.data as T | undefined) : undefined;
  const error = errRef.current.key === key ? errRef.current.msg : null;

  async function refresh() {
    if (!key) return;
    refreshingRef.current = true;
    bump();
    try {
      await revalidate(key, () => fetcherRef.current());
      errRef.current = { key, msg: null };
    } catch (e) {
      errRef.current = { key, msg: e instanceof Error ? e.message : String(e) };
    } finally {
      refreshingRef.current = false;
      bump();
    }
  }

  return { data, error, loading: !!key && data === undefined && !error, refreshing: refreshingRef.current, refresh };
}
