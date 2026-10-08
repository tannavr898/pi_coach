// Criterion flashcards, a study overlay (flip-through with flagging) and a full
// library grouped by the 13 domains. Cards keep the same mechanic: FRONT is the
// term/prompt, BACK is a plain definition, a term-specific worked example run
// through the four DECA beats (Define -> Explain -> Connect -> Above & Beyond,
// matching the Tips page), and one term-specific common mistake. Weak sets are
// highlighted; any card can be flagged to study later (persisted via useFlags).

import { useEffect, useMemo, useRef, useState } from "react";
import { getAllTerms, getEvents, getTerms, reportStat, type EventSummary, type FlashcardExample, type Term } from "./api";
import { getCourse, getProgress, markStudy, postActivity, type Course } from "./progress";
import type { FlagsApi } from "./flags";
import { BTN_PRIMARY, BTN_SECONDARY, FilterChip, LEVEL_COLOR, LevelDot, LogoLoader, Meter, PageHead, PageLoader, Sidebar, SideGroup, SideItem, Strip, UNGRADED_COLOR, useScrollLock } from "./ui";

// The four beats, the same method the Tips page teaches, but the CONTENT is
// specific to each term (from the card's worked example), not a fixed blurb.
const BEATS: { key: keyof FlashcardExample; label: string; cls: string; note?: string }[] = [
  { key: "define", label: "Define", cls: "text-indigo-600 dark:text-indigo-400" },
  { key: "explain", label: "Explain", cls: "text-violet-600 dark:text-violet-400" },
  { key: "connect", label: "Connect", cls: "text-fuchsia-600 dark:text-fuchsia-400", note: "most points" },
  { key: "above", label: "Above & Beyond", cls: "text-amber-600 dark:text-amber-400" },
];

// ---------------------------------------------------------------------------
// Study overlay: flip through a given set of cards.
// ---------------------------------------------------------------------------

export function Flashcards({
  ids,
  cards: preloaded,
  startId,
  title,
  flags,
  onClose,
}: {
  ids?: string[];
  cards?: Term[];
  startId?: string;
  title?: string;
  flags: FlagsApi;
  onClose: () => void;
}) {
  const [fetched, setFetched] = useState<Term[] | null>(preloaded ?? null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    if (preloaded) {
      setFetched(preloaded);
      return;
    }
    let active = true;
    getTerms(ids ?? [])
      .then((c) => active && setFetched(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [preloaded, ids]);

  const cards = fetched ?? [];
  // Jump to the requested starting card once loaded.
  useEffect(() => {
    if (startId && cards.length) {
      const idx = cards.findIndex((c) => c.id === startId);
      if (idx >= 0) setI(idx);
    }
  }, [startId, cards.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The focused card handles its own space/Enter; without this check the
      // same keypress flipped the card twice and looked like it did nothing.
      if (e.defaultPrevented) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " ") { e.preventDefault(); setFlipped((f) => !f); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind each render so go() closes over current i

  useScrollLock();

  const total = cards.length;
  const card = total ? cards[Math.min(i, total - 1)] : null;

  // Revealing a card's back records it as STARTED. This is the "flip" evidence the
  // backend has always understood (study.py) and that nothing was ever sending,
  // so before this, working through a deck moved no counter anywhere and the app
  // looked broken to anyone who studied the honest way.
  //
  // A flip can only ever reach "learning", never "known": that stays gated behind a
  // Blitz or a real role-play, because a path you can finish by tapping Next is not
  // the promise the course makes. Marked on reveal rather than on advance, once per
  // card per session (flipping back and forth is not new evidence), and
  // fire-and-forget, markStudy no-ops when signed out and never throws.
  const marked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!flipped || !card || marked.current.has(card.id)) return;
    marked.current.add(card.id);
    void markStudy([{ term_id: card.id, evidence: "flip" }]);
  }, [flipped, card]);

  // Closing the deck is the end of a set: report how many cards were actually
  // turned over, which is what a chapter's flashcard assignment counts. Read
  // through refs because the cleanup runs once, on unmount.
  const totalRef = useRef(0);
  totalRef.current = total;
  useEffect(() => () => {
    const seen = [...marked.current];
    reportStat("flashcards", seen.length);
    if (seen.length) void postActivity({ kind: "flashcards", term_ids: seen, score: seen.length, total: totalRef.current });
  }, []);

  function go(delta: number) {
    setFlipped(false);
    setI((v) => Math.max(0, Math.min(total - 1, v + delta)));
  }

  return (
    // A plain scrim, deliberately not a backdrop blur: blurring the whole library
    // behind a card that is animating on top of it was the main source of jank.
    <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-slate-950/80 p-4" onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/85">{title ?? "Study"}</span>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">✕</button>
        </div>

        {error ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-red-600 dark:bg-slate-900 dark:text-red-400">Couldn't load cards: {error}</div>
        ) : !fetched ? (
          <div className="flex justify-center rounded-2xl bg-white p-10 dark:bg-slate-900">
            <LogoLoader size={64} label="Loading cards" />
          </div>
        ) : !card ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">No cards here yet.</div>
        ) : (
          <>
            <FlipCard key={card.id} card={card} flipped={flipped} onFlip={() => setFlipped((f) => !f)} flagged={flags.isFlagged(card.id)} onFlag={() => flags.toggle(card.id)} />
            <div className="mt-3 flex items-center justify-between">
              <button className={BTN_SECONDARY} onClick={() => go(-1)} disabled={i === 0}>Prev</button>
              <span className="font-mono text-xs tabular-nums text-white/85">{Math.min(i + 1, total)} / {total}</span>
              <button className={BTN_SECONDARY} onClick={() => go(1)} disabled={i >= total - 1}>Next</button>
            </div>
            <p className="mt-2 text-center text-[11px] text-white/60">Tap the card to flip · ← → to move · space to flip · ★ to flag</p>
          </>
        )}
      </div>
    </div>
  );
}

// A single flip card. Fixed height; the back scrolls if long.
//
// Only one face is in the DOM at a time, and at rest the card carries no transform
// at all. The flip is two short keyframe halves (index.css): turn edge-on, swap
// the face, turn back. The earlier version kept both faces alive inside a
// preserve-3d box rotated 180deg, which meant the back was scrolled through a 3D
// transform: the browser could not scroll it on the compositor, so it repainted
// the whole card every frame and the text rendered soft.
function FlipCard({ card, flipped, onFlip, flagged, onFlag }: { card: Term; flipped: boolean; onFlip: () => void; flagged: boolean; onFlag: () => void }) {
  // The face actually on screen. It trails `flipped` by the first half of the turn.
  const [shown, setShown] = useState(flipped);
  const [turned, setTurned] = useState(false);
  const leaving = shown !== flipped;
  const anim = leaving ? "pic-flip-out" : turned ? "pic-flip-in" : "pic-card-in";
  return (
      <div
        className={`${anim} relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:border-slate-800 dark:bg-slate-900 dark:focus-visible:ring-offset-slate-950`}
        style={{ height: "24rem", ["--flip-dir" as string]: flipped ? 1 : -1 }}
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={flipped ? `${card.name}: showing the worked example. Activate to flip back.` : `${card.name}: flashcard front. Activate to reveal a worked example.`}
        onClick={onFlip}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFlip();
          }
        }}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget || !leaving) return;
          setShown(flipped);
          setTurned(true);
        }}
      >
        {!shown ? (
        <div className="flex h-full flex-col p-6">
          <div className="flex items-start justify-between">
            <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{card.domain}</div>
            <FlagButton flagged={flagged} onFlag={onFlag} />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <h2 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">{card.name}</h2>
            {card.coaches && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{card.coaches}</p>}
          </div>
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">Tap for a worked example</p>
        </div>
        ) : (
        <div className="h-full overflow-y-auto overscroll-contain p-6">
          <div className="flex items-start justify-between">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{card.name}</h3>
            <FlagButton flagged={flagged} onFlag={onFlag} />
          </div>
          <div className="mt-3 space-y-3.5 text-sm">
            {card.definition && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">Definition</div>
                <p className="mt-1 text-slate-700 dark:text-slate-200">{card.definition}</p>
              </div>
            )}
            {card.example && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">In a response: run it through the four beats</div>
                <ol className="mt-2 space-y-2">
                  {BEATS.map((b) => (
                    <li key={b.key} className="leading-relaxed">
                      <span className={`font-semibold ${b.cls}`}>{b.label}</span>
                      {b.note && (
                        <span className="ml-1.5 rounded bg-fuchsia-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-fuchsia-600 dark:bg-fuchsia-950/40 dark:text-fuchsia-300">{b.note}</span>
                      )}
                      <span className="text-slate-700 dark:text-slate-200">: {card.example?.[b.key]}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {card.mistake && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
                <div className="font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">Common mistake</div>
                <p className="mt-1 text-amber-900 dark:text-amber-200">{card.mistake}</p>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
  );
}

function FlagButton({ flagged, onFlag }: { flagged: boolean; onFlag: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onFlag(); }}
      aria-label={flagged ? "Unflag" : "Flag to study later"}
      title={flagged ? "Flagged: click to remove" : "Flag to study later"}
      className={`rounded-lg px-2 py-1 text-lg leading-none transition ${flagged ? "text-amber-500" : "text-slate-300 hover:text-amber-400 dark:text-slate-600"}`}
    >
      {flagged ? "★" : "☆"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Library: all terms, grouped by domain, weak sets highlighted.
// ---------------------------------------------------------------------------

const LEVELS = ["novice", "developing", "proficient", "exemplary"] as const;
type Lv = (typeof LEVELS)[number];
const LEVEL_LABEL: Record<Lv, string> = { novice: "Novice", developing: "Developing", proficient: "Proficient", exemplary: "Exemplary" };
const LEVEL_RANK: Record<string, number> = { novice: 0, developing: 1, proficient: 2, exemplary: 3 };

// Where the chosen deck is remembered. Local to the browser like `pic-theme` and
// the card flags: it's a view preference, not progress, so it needs no account.
const DECK_KEY = "pic-deck";

export function FlashcardLibrary({
  flags,
  initialDeck,
  onStudy,
  onBlitz,
  onQuiz,
}: {
  flags: FlagsApi;
  // An event handed over from its public deck page (/flashcards/<event>). Wins over
  // the remembered choice: following that link is a deliberate "show me THIS deck",
  // and honouring a stale localStorage value instead would silently ignore it.
  initialDeck?: string | null;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
  onQuiz: (cards: Term[], title?: string, opts?: { exam?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" }) => void;
}) {
  const [all, setAll] = useState<Term[] | null>(null);
  // The level each graded criterion sits at, from the student's sessions. Empty
  // signed out, and then every term simply reads "Not yet graded".
  const [levels, setLevels] = useState<Map<string, Lv>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // What the table is showing: every term, one of the two sets, or one domain.
  // null until they choose, which resolves to the first domain.
  const [picked, setPicked] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<Lv | "ungraded" | "all">("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  // The deck filter: which event's terms the library is scoped to. "" is the whole
  // 830-term corpus. A competitor studies for ONE event, and 830 cards grouped by
  // all 13 domains buries the ~250 that are actually theirs. Remembered locally so
  // it survives a reload and does not need an account; the event catalog is public
  // either way.
  const [deckId, setDeckId] = useState<string>(() => {
    if (initialDeck) return initialDeck;
    try {
      return localStorage.getItem(DECK_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [deck, setDeck] = useState<Course | null>(null);

  useEffect(() => {
    let active = true;
    getAllTerms()
      .then((c) => active && setAll(c))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    // Levels come from progress; failure is non-fatal (nothing is graded).
    getProgress()
      .then((p) => {
        if (!active) return;
        setLevels(new Map(p.criterion_mastery.map((m) => [m.criterion_id, m.consistent_level as Lv])));
      })
      .catch(() => {});
    // The event picker. Non-fatal: without it the deck filter just isn't offered.
    getEvents()
      .then((e) => active && setEvents(e))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // The chosen event's course gives us its term ids. Anonymous-friendly (getCourse
  // uses maybeAuthFetch), so the filter works signed out; only the progress numbers
  // inside it need an account.
  useEffect(() => {
    let active = true;
    try {
      localStorage.setItem(DECK_KEY, deckId);
    } catch {
      /* private mode, the filter still works, it just won't be remembered */
    }
    if (!deckId) {
      setDeck(null);
      return;
    }
    getCourse(deckId)
      .then((c) => active && setDeck(c))
      .catch(() => active && setDeck(null));
    return () => {
      active = false;
    };
  }, [deckId]);

  const deckIds = useMemo(() => {
    if (!deck) return null;
    return new Set(deck.units.flatMap((u) => [...u.core_ids, ...u.extended_ids]));
  }, [deck]);

  // Everything below counts over the SCOPED set, not the corpus: with a deck
  // chosen, "12 flagged" has to mean 12 in this deck or the number is a lie.
  const scoped = useMemo(
    () => (deckIds ? (all ?? []).filter((c) => deckIds.has(c.id)) : all ?? []),
    [all, deckIds],
  );

  // A level comes from graded sessions, so only terms with a criterion can have
  // one; study-only terms have nothing to be graded against.
  const levelOf = (t: Term): Lv | null => (t.criterion_id ? levels.get(t.criterion_id) ?? null : null);
  const isWeak = (t: Term) => {
    const l = levelOf(t);
    return l !== null && LEVEL_RANK[l] <= 1;
  };

  const flaggedCards = useMemo(() => scoped.filter((c) => flags.flags.has(c.id)), [scoped, flags.flags]);
  const recommended = useMemo(() => scoped.filter(isWeak), [scoped, levels]); // eslint-disable-line react-hooks/exhaustive-deps

  const domains = useMemo(() => {
    const by = new Map<string, Term[]>();
    for (const c of scoped) by.set(c.domain, [...(by.get(c.domain) ?? []), c]);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([domain, cards]) => ({ domain, cards }));
  }, [scoped]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  // A domain that is not in the current deck falls back to the first one that is.
  const current =
    picked === "all" || picked === "weak" || picked === "flagged" || domains.some((d) => d.domain === picked)
      ? (picked as string)
      : domains[0]?.domain ?? "all";

  const title = searching
    ? `Results for "${query.trim()}"`
    : current === "all"
      ? "All terms"
      : current === "weak"
        ? "Weakest for you"
        : current === "flagged"
          ? "Flagged to study later"
          : current;
  // A search looks through the whole deck, whatever set is selected.
  const inSet = searching
    ? scoped.filter((c) => c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q) || c.topic.toLowerCase().includes(q))
    : current === "all"
      ? scoped
      : current === "weak"
        ? recommended
        : current === "flagged"
          ? flaggedCards
          : domains.find((d) => d.domain === current)?.cards ?? [];

  // Weakest first, ungraded last, then by name.
  const order = (t: Term) => {
    const l = levelOf(t);
    return l === null ? 4 : LEVEL_RANK[l];
  };
  const visible = inSet
    .filter((c) => {
      if (flaggedOnly && !flags.flags.has(c.id)) return false;
      if (levelFilter === "all") return true;
      const l = levelOf(c);
      return levelFilter === "ungraded" ? l === null : l === levelFilter;
    })
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const filtered = flaggedOnly || levelFilter !== "all";
  const countAt = (cards: Term[], l: Lv | null) => cards.filter((c) => levelOf(c) === l).length;
  // Quizzing the whole deck draws from the event's exam; anything narrower is
  // just "questions on these terms".
  const quizOpts = current === "all" && !searching && !filtered ? (deck ? { exam: deck.exam, scope: "cluster" as const } : { scope: "all" as const }) : { exam: deck?.exam };

  if (error) return <p className="py-10 text-center text-sm text-red-600 dark:text-red-400">Couldn't load the library: {error}</p>;
  if (!all) {
    return (
      <div className="pt-6">
        <PageLoader label="Loading the library" card={false} />
      </div>
    );
  }

  const pick = (key: string) => {
    setPicked(key);
    setQuery("");
  };
  // Grouped into DECA's clusters, matching how the events are presented everywhere
  // else; a flat list of 28 is a wall.
  const clusters = [...new Set(events.map((e) => e.cluster))];

  return (
    <div>
      <Sidebar>
        {/* Scope the library to one event's deck. The event to terms join is the
            same one the course path uses (backend courses.py), fetched through
            getCourse, so the deck here and My path can never disagree. */}
        {events.length > 0 && (
          <SideGroup title="Event">
            <div className="relative mx-0.5">
              <select
                value={deckId}
                onChange={(e) => setDeckId(e.target.value)}
                aria-label="Filter the library to an event"
                className="tap w-full appearance-none truncate rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-8 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">Every event</option>
                {clusters.map((cluster) => (
                  <optgroup key={cluster} label={cluster}>
                    {events.filter((e) => e.cluster === cluster).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-slate-400">▾</span>
            </div>
          </SideGroup>
        )}
        <SideGroup title="Sets">
          <SideItem active={!searching && current === "all"} onClick={() => pick("all")} right={<Count n={scoped.length} />}>All terms</SideItem>
          <SideItem active={!searching && current === "weak"} onClick={() => pick("weak")} right={<Count n={recommended.length} />}>Weakest for you</SideItem>
          <SideItem active={!searching && current === "flagged"} onClick={() => pick("flagged")} right={<Count n={flaggedCards.length} />}>Flagged</SideItem>
        </SideGroup>
        <SideGroup title="Domains">
          {domains.map(({ domain, cards }) => (
            <SideItem
              key={domain}
              active={!searching && current === domain}
              onClick={() => pick(domain)}
              right={<Meter total={cards.length} parts={LEVELS.map((l) => ({ color: LEVEL_COLOR[l], n: countAt(cards, l) }))} />}
            >
              {domain}
            </SideItem>
          ))}
        </SideGroup>
      </Sidebar>

      <PageHead sub={deck ? deck.event : "Every event"} title={title}>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-400 dark:border-slate-700 dark:bg-slate-900">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.2 9.2 13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search terms"
            aria-label="Search terms"
            className="w-32 min-w-0 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
        </label>
        <button className={BTN_SECONDARY} disabled={!visible.length} onClick={() => onQuiz(visible, title, quizOpts)}>Quiz</button>
        <button className={BTN_SECONDARY} disabled={!visible.length} onClick={() => onBlitz(visible, title)}>Blitz</button>
        <button className={BTN_PRIMARY} disabled={!visible.length} onClick={() => onStudy(visible, undefined, title)}>
          Study {visible.length} card{visible.length === 1 ? "" : "s"}
        </button>
      </PageHead>

      <Strip
        cells={[
          ...LEVELS.map((l) => ({ label: LEVEL_LABEL[l], value: countAt(inSet, l), tone: LEVEL_COLOR[l] })),
          { label: "Not yet graded", value: countAt(inSet, null), tone: UNGRADED_COLOR },
        ]}
      />

      <div className="pic-bleed pic-inset flex flex-wrap items-center gap-1.5 border-b border-slate-200 py-3 dark:border-slate-800">
        <span className="mr-1 text-xs font-medium text-slate-500 dark:text-slate-400">Level</span>
        <FilterChip on={levelFilter === "all"} onClick={() => setLevelFilter("all")}>All</FilterChip>
        {LEVELS.map((l) => (
          <FilterChip key={l} on={levelFilter === l} onClick={() => setLevelFilter(l)}>
            <LevelDot color={LEVEL_COLOR[l]} />
            {LEVEL_LABEL[l]}
          </FilterChip>
        ))}
        <FilterChip on={levelFilter === "ungraded"} onClick={() => setLevelFilter("ungraded")}>
          <LevelDot color={UNGRADED_COLOR} />
          Not yet graded
        </FilterChip>
        <span className="min-w-2 flex-1" />
        <FilterChip on={flaggedOnly} onClick={() => setFlaggedOnly((v) => !v)}>★ Flagged only</FilterChip>
      </div>

      {visible.length > 0 ? (
        <div className="pic-bleed overflow-x-auto">
          <div className="min-w-[540px]">
            <div className="pic-inset grid grid-cols-[minmax(0,1fr)_130px_minmax(0,0.7fr)_28px] items-center gap-3.5 border-b border-slate-200 bg-slate-50 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
              <span>Term</span>
              <span>Level</span>
              <span>{searching || current === "all" || current === "weak" || current === "flagged" ? "Domain" : "Topic"}</span>
              <span />
            </div>
            {visible.map((c) => {
              const l = levelOf(c);
              const flagged = flags.flags.has(c.id);
              return (
                <div
                  key={c.id}
                  className="pic-inset grid grid-cols-[minmax(0,1fr)_130px_minmax(0,0.7fr)_28px] items-center gap-3.5 border-b border-slate-200 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                >
                  <button
                    onClick={() => onStudy(visible, c.id, title)}
                    className="truncate py-2.5 text-left text-sm font-medium text-slate-900 hover:text-indigo-700 dark:text-slate-100 dark:hover:text-indigo-300"
                  >
                    {c.name}
                  </button>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-slate-600 dark:text-slate-300">
                    <LevelDot color={l ? LEVEL_COLOR[l] : UNGRADED_COLOR} />
                    {l ? LEVEL_LABEL[l] : "Not yet graded"}
                  </span>
                  <span className="truncate text-[13px] text-slate-500 dark:text-slate-400">
                    {searching || current === "all" || current === "weak" || current === "flagged" ? c.domain : c.topic}
                  </span>
                  <button
                    onClick={() => flags.toggle(c.id)}
                    aria-label={flagged ? `Remove the flag from ${c.name}` : `Flag ${c.name} to study later`}
                    aria-pressed={flagged}
                    className={`tap text-right text-base leading-none ${flagged ? "text-amber-500" : "text-slate-300 hover:text-amber-400 dark:text-slate-600"}`}
                  >
                    {flagged ? "★" : "☆"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="py-8 text-sm text-slate-500 dark:text-slate-400">
          {searching
            ? `No terms match "${query.trim()}".`
            : filtered
              ? "No terms match these filters. Clear one to see more."
              : current === "weak"
                ? "Finish some role-plays and the terms you have been weakest on show up here."
                : current === "flagged"
                  ? "Star any term to add it here."
                  : "No terms here yet."}
        </p>
      )}

      {/* What the three buttons at the top do, said once and quietly. */}
      <div className="mt-6 grid gap-x-8 gap-y-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400 sm:grid-cols-3">
        <p><span className="font-medium text-slate-700 dark:text-slate-200">Study</span> flips through the cards: a plain definition, a worked example run through the four beats, and the one mistake to avoid.</p>
        <p><span className="font-medium text-slate-700 dark:text-slate-200">Blitz</span> is a rapid drill: one scenario, 5 terms, 45 seconds each, graded at the end.</p>
        <p><span className="font-medium text-slate-700 dark:text-slate-200">Quiz</span> is multiple choice at district, state or ICDC difficulty. No clock, and every answer explains itself.</p>
      </div>
      {deck && (
        <p className="mt-3 text-[13px] text-slate-500 dark:text-slate-400">
          {/* A real link, not a view switch: this deck also exists as a public page
              that needs no account, which is what you send a team partner. */}
          <a
            className="font-medium text-indigo-600 transition hover:text-indigo-700 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
            href={`/flashcards/${deck.event_id}`}
          >
            Open the shareable {deck.event} deck page
          </a>
          . Readable without signing in, so you can send it to your partner.
        </p>
      )}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-[13px] tabular-nums text-slate-500 dark:text-slate-400">{n}</span>;
}
