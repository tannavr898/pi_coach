// Criterion flashcards — a study overlay (flip-through with flagging) and a full
// library grouped by the 13 domains. Cards keep the same mechanic: FRONT is the
// term/prompt, BACK is a plain definition, a term-specific worked example run
// through the four DECA beats (Define -> Explain -> Connect -> Above & Beyond,
// matching the Tips page), and one term-specific common mistake. Weak sets are
// highlighted; any card can be flagged to study later (persisted via useFlags).

import { useEffect, useMemo, useRef, useState } from "react";
import { getAllTerms, getEvents, getTerms, type EventSummary, type FlashcardExample, type Term } from "./api";
import { getCourse, getProgress, markStudy, type Course } from "./progress";
import type { FlagsApi } from "./flags";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow } from "./ui";

// The four beats — the same method the Tips page teaches, but the CONTENT is
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
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " ") { e.preventDefault(); setFlipped((f) => !f); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind each render so go() closes over current i

  const total = cards.length;
  const card = total ? cards[Math.min(i, total - 1)] : null;

  // Revealing a card's back records it as STARTED. This is the "flip" evidence the
  // backend has always understood (study.py) and that nothing was ever sending —
  // so before this, working through a deck moved no counter anywhere and the app
  // looked broken to anyone who studied the honest way.
  //
  // A flip can only ever reach "learning", never "known": that stays gated behind a
  // Blitz or a real role-play, because a path you can finish by tapping Next is not
  // the promise the course makes. Marked on reveal rather than on advance, once per
  // card per session (flipping back and forth is not new evidence), and
  // fire-and-forget — markStudy no-ops when signed out and never throws.
  const marked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!flipped || !card || marked.current.has(card.id)) return;
    marked.current.add(card.id);
    void markStudy([{ term_id: card.id, evidence: "flip" }]);
  }, [flipped, card]);

  function go(delta: number) {
    setFlipped(false);
    setI((v) => Math.max(0, Math.min(total - 1, v + delta)));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/85">{title ?? "Study"}</span>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">✕</button>
        </div>

        {error ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-red-600 dark:bg-slate-900 dark:text-red-400">Couldn't load cards: {error}</div>
        ) : !fetched ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-slate-400 dark:bg-slate-900">Loading…</div>
        ) : !card ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">No cards here yet.</div>
        ) : (
          <>
            <FlipCard card={card} flipped={flipped} onFlip={() => setFlipped((f) => !f)} flagged={flags.isFlagged(card.id)} onFlag={() => flags.toggle(card.id)} />
            <div className="mt-3 flex items-center justify-between">
              <button className={BTN_SECONDARY} onClick={() => go(-1)} disabled={i === 0}>← Prev</button>
              <span className="font-mono text-xs tabular-nums text-white/85">{Math.min(i + 1, total)} / {total}</span>
              <button className={BTN_SECONDARY} onClick={() => go(1)} disabled={i >= total - 1}>Next →</button>
            </div>
            <p className="mt-2 text-center text-[11px] text-white/60">Tap the card to flip · ← → to move · space to flip · ★ to flag</p>
          </>
        )}
      </div>
    </div>
  );
}

// A single 3D-flip card. Fixed height; the back scrolls if long.
function FlipCard({ card, flipped, onFlip, flagged, onFlag }: { card: Term; flipped: boolean; onFlip: () => void; flagged: boolean; onFlag: () => void }) {
  return (
    <div style={{ perspective: 1400 }}>
      <div
        className="relative cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
        style={{ height: "24rem", transformStyle: "preserve-3d", transition: "transform 0.5s", transform: flipped ? "rotateY(180deg)" : "none" }}
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
      >
        {/* Front */}
        <div className="absolute inset-0 flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900" style={{ backfaceVisibility: "hidden" }}>
          <div className="flex items-start justify-between">
            <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{card.domain}</div>
            <FlagButton flagged={flagged} onFlag={onFlag} />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <h2 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">{card.name}</h2>
            {card.coaches && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{card.coaches}</p>}
          </div>
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">Tap for a worked example →</p>
        </div>

        {/* Back */}
        <div className="absolute inset-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}>
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
      </div>
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

const LEVEL_RANK: Record<string, number> = { novice: 0, developing: 1, proficient: 2, exemplary: 3 };

// Where the chosen deck is remembered. Local to the browser like `pic-theme` and
// the card flags: it's a view preference, not progress, so it needs no account.
const DECK_KEY = "pic-deck";

export function FlashcardLibrary({
  flags,
  onStudy,
  onBlitz,
}: {
  flags: FlagsApi;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
}) {
  const [all, setAll] = useState<Term[] | null>(null);
  const [weakIds, setWeakIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Domains collapse by default so the whole library fits on a screen or two;
  // open the one you want. A live search auto-expands every match.
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const toggleDomain = (d: string) =>
    setOpenDomains((s) => {
      const n = new Set(s);
      n.has(d) ? n.delete(d) : n.add(d);
      return n;
    });

  // The deck filter: which event's terms the library is scoped to. "" is the whole
  // 830-term corpus. This is the one thing the library was missing — a competitor
  // studies for ONE event, and 830 cards grouped by all 13 domains buries the ~250
  // that are actually theirs. Remembered locally so it survives a reload and does
  // not need an account; the event catalog is public either way.
  const [deckId, setDeckId] = useState<string>(() => {
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
    // Weak criteria come from progress; failure is non-fatal (no highlights).
    getProgress()
      .then((p) => {
        if (!active) return;
        const weak = new Set(
          p.criterion_mastery.filter((m) => LEVEL_RANK[m.consistent_level] <= 1).map((m) => m.criterion_id),
        );
        setWeakIds(weak);
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
      /* private mode — the filter still works, it just won't be remembered */
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

  // Weakness comes from graded sessions, so only terms with a criterion can be weak
  // — study-only terms have nothing to be weak against.
  const isWeak = (t: Term) => !!t.criterion_id && weakIds.has(t.criterion_id);

  const flaggedCards = useMemo(() => scoped.filter((c) => flags.flags.has(c.id)), [scoped, flags.flags]);
  const recommended = useMemo(() => scoped.filter(isWeak), [scoped, weakIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group by domain, honoring the search filter.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = scoped.filter((c) => !q || c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q) || c.topic.toLowerCase().includes(q));
    const order: string[] = [];
    const by: Record<string, Term[]> = {};
    for (const c of filtered) {
      if (!by[c.domain]) {
        by[c.domain] = [];
        order.push(c.domain);
      }
      by[c.domain].push(c);
    }
    return order.sort((a, b) => a.localeCompare(b)).map((d) => ({ domain: d, cards: by[d] }));
  }, [scoped, query]);

  const searching = query.trim().length > 0;
  const allOpen = groups.length > 0 && groups.every((g) => openDomains.has(g.domain));

  if (error) return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-red-600 dark:text-red-400">Couldn't load the library: {error}</p>;
  if (!all) return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading the library…</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Flashcard library</Eyebrow>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
            {deck ? `${deck.event}: ${scoped.length} terms` : `All ${all.length} terms, by domain`}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Front: the term. Back: a plain definition, a worked example run through the four beats, and the one mistake to avoid. Flag any card ★ to study later.</p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terms…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:w-64"
        />
      </div>

      <DeckBar
        events={events}
        deckId={deckId}
        deck={deck}
        count={scoped.length}
        onPick={setDeckId}
        onStudy={() => scoped.length && onStudy(scoped, undefined, deck ? deck.event : "All terms")}
        onBlitz={() => scoped.length && onBlitz(scoped, deck ? deck.event : "All terms")}
      />

      {/* Mastery Blitz launcher: rapid, timed drill over a set of terms. */}
      <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5 dark:border-indigo-900/60 dark:bg-indigo-950/30 sm:flex-row sm:items-center">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">⚡ Mastery Blitz</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Rapid drill: one scenario, {5} terms, {45}s each: apply each term in DECA format, graded instantly at the end.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {recommended.length > 0 && (
            <button className={BTN_PRIMARY} onClick={() => onBlitz(recommended, "Your weak terms")}>Blitz weak terms →</button>
          )}
          <button className={BTN_SECONDARY} disabled={!all.length} onClick={() => all.length && onBlitz(all, "All terms")}>Blitz random terms →</button>
        </div>
      </div>

      {/* Highlighted sets */}
      <div className="grid gap-4 sm:grid-cols-2">
        <SetCard
          tone="indigo"
          title="Recommended for you"
          subtitle={recommended.length ? `The ${recommended.length} criteria you've been weakest on.` : "Finish some sessions and your weak spots show up here."}
          count={recommended.length}
          onStudy={() => recommended.length && onStudy(recommended, undefined, "Recommended for you")}
          onBlitz={() => recommended.length && onBlitz(recommended, "Recommended for you")}
        />
        <SetCard
          tone="amber"
          title="Flagged to study later"
          subtitle={flaggedCards.length ? `${flaggedCards.length} card${flaggedCards.length === 1 ? "" : "s"} you starred.` : "Star ★ any card to add it here."}
          count={flaggedCards.length}
          onStudy={() => flaggedCards.length && onStudy(flaggedCards, undefined, "Flagged to study later")}
          onBlitz={() => flaggedCards.length && onBlitz(flaggedCards, "Flagged to study later")}
        />
      </div>

      {/* Domains — collapsed by default so the full library fits on a screen;
          open the one you want. A live search auto-expands every match. */}
      <div className="flex items-center justify-between px-1 pt-1">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
          {groups.length} domain{groups.length === 1 ? "" : "s"}
        </div>
        {!searching && groups.length > 0 && (
          <button
            onClick={() => setOpenDomains(allOpen ? new Set() : new Set(groups.map((g) => g.domain)))}
            className="text-sm font-medium text-indigo-600 transition hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {groups.map(({ domain, cards }) => {
        const weakHere = cards.filter(isWeak).length;
        const open = searching || openDomains.has(domain);
        const panelId = `domain-${domain.replace(/\s+/g, "-")}`;
        return (
          <Card key={domain}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="min-w-0 flex-1">
                <button
                  onClick={() => !searching && toggleDomain(domain)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  disabled={searching}
                  className="flex w-full items-center gap-2 text-left"
                >
                  <svg
                    viewBox="0 0 12 12"
                    width="12"
                    height="12"
                    aria-hidden="true"
                    className={`shrink-0 text-slate-400 transition-transform duration-200 dark:text-slate-500 ${open ? "rotate-90" : ""} ${searching ? "opacity-0" : ""}`}
                  >
                    <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{domain}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">{cards.length}</span>
                  {weakHere > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">{weakHere} to drill</span>
                  )}
                </button>
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                <button className={BTN_SECONDARY} onClick={() => onBlitz(cards, domain)}>⚡ Blitz</button>
                <button className={BTN_SECONDARY} onClick={() => onStudy(cards, undefined, domain)}>Study domain →</button>
              </div>
            </div>
            {open && (
              <div id={panelId} className="mt-3 flex flex-wrap gap-2">
                {cards.map((c) => {
                  const weak = isWeak(c);
                  const flagged = flags.flags.has(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => onStudy(cards, c.id, domain)}
                      className={`group inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition ${
                        weak
                          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                          : "border-slate-200 bg-white text-slate-700 hover:border-indigo-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-800"
                      }`}
                    >
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => { e.stopPropagation(); flags.toggle(c.id); }}
                        className={flagged ? "text-amber-500" : "text-slate-300 group-hover:text-amber-400 dark:text-slate-600"}
                      >
                        {flagged ? "★" : "☆"}
                      </span>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
      {groups.length === 0 && <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">No terms match "{query}".</p>}
    </div>
  );
}

// Scope the library to one event's deck.
//
// The library holds all 830 terms across 13 domains, but a competitor is studying
// for exactly ONE event, and roughly 250 of those cards are theirs. Without this,
// finding them meant knowing which domains your event draws from — which is the
// app's internal model, not something a student should have to learn.
//
// The event->terms join is the same one the course path uses (backend courses.py),
// fetched through getCourse, so the deck here and the Study tab can never disagree.
function DeckBar({
  events,
  deckId,
  deck,
  count,
  onPick,
  onStudy,
  onBlitz,
}: {
  events: EventSummary[];
  deckId: string;
  deck: Course | null;
  count: number;
  onPick: (id: string) => void;
  onStudy: () => void;
  onBlitz: () => void;
}) {
  // Grouped into DECA's clusters, matching how the events are presented everywhere
  // else — a flat list of 28 is a wall.
  const clusters = useMemo(() => {
    const order: string[] = [];
    const by: Record<string, EventSummary[]> = {};
    for (const e of events) {
      if (!by[e.cluster]) {
        by[e.cluster] = [];
        order.push(e.cluster);
      }
      by[e.cluster].push(e);
    }
    return order.map((c) => ({ cluster: c, events: by[c] }));
  }, [events]);

  if (!events.length) return null;

  return (
    <div
      className={`rounded-2xl border p-5 transition-colors ${
        deck
          ? "border-indigo-200 bg-indigo-50/60 dark:border-indigo-900/60 dark:bg-indigo-950/30"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            {deck ? `Studying for ${deck.event}` : "Studying for one event?"}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {deck
              ? `${count} cards, the ones this event actually exercises. ${deck.core_count} of them are skills we grade you on.`
              : "Narrow the library to just the terms your event draws on."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="deck-pick">
            Filter the library to an event
          </label>
          <select
            id="deck-pick"
            value={deckId}
            onChange={(e) => onPick(e.target.value)}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">Every term</option>
            {clusters.map(({ cluster, events: inCluster }) => (
              <optgroup key={cluster} label={cluster}>
                {inCluster.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className={BTN_SECONDARY} disabled={!count} onClick={onStudy}>
            Study →
          </button>
          <button className={BTN_SECONDARY} disabled={!count} onClick={onBlitz}>
            ⚡ Blitz
          </button>
        </div>
      </div>
      {deck && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {/* A real link, not a view switch: this deck also exists as a public page
              that needs no account, which is what you send a team partner. */}
          <a
            className="font-medium text-indigo-600 transition hover:text-indigo-700 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
            href={`/flashcards/${deck.event_id}`}
          >
            Open the shareable {deck.event} deck page →
          </a>{" "}
          Readable without signing in, so you can send it to your partner.
        </p>
      )}
    </div>
  );
}

function SetCard({ tone, title, subtitle, count, onStudy, onBlitz }: { tone: "indigo" | "amber"; title: string; subtitle: string; count: number; onStudy: () => void; onBlitz: () => void }) {
  const toneCls =
    tone === "indigo"
      ? "border-indigo-200 bg-indigo-50/60 dark:border-indigo-900/60 dark:bg-indigo-950/40"
      : "border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30";
  return (
    <div className={`rounded-2xl border p-5 ${toneCls}`}>
      <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{subtitle}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={`${BTN_PRIMARY} disabled:opacity-40`} disabled={count === 0} onClick={onStudy}>
          Study {count > 0 ? `${count} card${count === 1 ? "" : "s"}` : ": "} →
        </button>
        <button className={`${BTN_SECONDARY} disabled:opacity-40`} disabled={count === 0} onClick={onBlitz}>⚡ Blitz</button>
      </div>
    </div>
  );
}
