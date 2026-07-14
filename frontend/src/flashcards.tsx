// Criterion flashcards — a study overlay (flip-through with flagging) and a full
// library grouped by the 13 domains. Cards keep the same mechanic: FRONT is the
// term/prompt, BACK is a plain definition, a term-specific worked example run
// through the four DECA beats (Define -> Explain -> Connect -> Above & Beyond,
// matching the Tips page), and one term-specific common mistake. Weak sets are
// highlighted; any card can be flagged to study later (persisted via useFlags).

import { useEffect, useMemo, useState } from "react";
import { getAllCriteria, getCriteria, type Criterion, type FlashcardExample } from "./api";
import { getProgress } from "./progress";
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
  cards?: Criterion[];
  startId?: string;
  title?: string;
  flags: FlagsApi;
  onClose: () => void;
}) {
  const [fetched, setFetched] = useState<Criterion[] | null>(preloaded ?? null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    if (preloaded) {
      setFetched(preloaded);
      return;
    }
    let active = true;
    getCriteria(ids ?? [])
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
function FlipCard({ card, flipped, onFlip, flagged, onFlag }: { card: Criterion; flipped: boolean; onFlip: () => void; flagged: boolean; onFlag: () => void }) {
  return (
    <div style={{ perspective: 1400 }}>
      <div
        className="relative cursor-pointer"
        style={{ height: "24rem", transformStyle: "preserve-3d", transition: "transform 0.5s", transform: flipped ? "rotateY(180deg)" : "none" }}
        onClick={onFlip}
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
          <p className="text-center text-xs text-slate-400 dark:text-slate-500">Tap for a worked example →</p>
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
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Definition</div>
                <p className="mt-1 text-slate-700 dark:text-slate-200">{card.definition}</p>
              </div>
            )}
            {card.example && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">In a response — run it through the four beats</div>
                <ol className="mt-2 space-y-2">
                  {BEATS.map((b) => (
                    <li key={b.key} className="leading-relaxed">
                      <span className={`font-semibold ${b.cls}`}>{b.label}</span>
                      {b.note && (
                        <span className="ml-1.5 rounded bg-fuchsia-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-fuchsia-600 dark:bg-fuchsia-950/40 dark:text-fuchsia-300">{b.note}</span>
                      )}
                      <span className="text-slate-700 dark:text-slate-200"> — {card.example?.[b.key]}</span>
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
      title={flagged ? "Flagged — click to remove" : "Flag to study later"}
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

export function FlashcardLibrary({
  flags,
  onStudy,
  onBlitz,
}: {
  flags: FlagsApi;
  onStudy: (cards: Criterion[], startId?: string, title?: string) => void;
  onBlitz: (cards: Criterion[], title?: string) => void;
}) {
  const [all, setAll] = useState<Criterion[] | null>(null);
  const [weakIds, setWeakIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    getAllCriteria()
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
    return () => {
      active = false;
    };
  }, []);

  const flaggedCards = useMemo(() => (all ?? []).filter((c) => flags.flags.has(c.id)), [all, flags.flags]);
  const recommended = useMemo(() => (all ?? []).filter((c) => weakIds.has(c.id)), [all, weakIds]);

  // Group by domain, honoring the search filter.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (all ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q) || c.topic.toLowerCase().includes(q));
    const order: string[] = [];
    const by: Record<string, Criterion[]> = {};
    for (const c of filtered) {
      if (!by[c.domain]) {
        by[c.domain] = [];
        order.push(c.domain);
      }
      by[c.domain].push(c);
    }
    return order.sort((a, b) => a.localeCompare(b)).map((d) => ({ domain: d, cards: by[d] }));
  }, [all, query]);

  if (error) return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-red-600 dark:text-red-400">Couldn't load the library: {error}</p>;
  if (!all) return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-slate-400 dark:text-slate-500">Loading the library…</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Flashcard library</Eyebrow>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">All {all.length} terms, by domain</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Front: the term. Back: a plain definition, a worked example run through the four beats, and the one mistake to avoid. Flag any card ★ to study later.</p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terms…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:w-64"
        />
      </div>

      {/* Mastery Blitz launcher — rapid, timed drill over a set of terms. */}
      <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 p-5 dark:border-indigo-900/60 dark:from-indigo-950/40 dark:to-violet-950/30 sm:flex-row sm:items-center">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">⚡ Mastery Blitz</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Rapid drill: one scenario, {5} terms, {45}s each — apply each term in DECA format, graded instantly at the end.
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

      {/* Domains */}
      {groups.map(({ domain, cards }) => {
        const weakHere = cards.filter((c) => weakIds.has(c.id)).length;
        return (
          <Card key={domain}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{domain}</h2>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">{cards.length}</span>
                {weakHere > 0 && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">{weakHere} to drill</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button className={BTN_SECONDARY} onClick={() => onBlitz(cards, domain)}>⚡ Blitz</button>
                <button className={BTN_SECONDARY} onClick={() => onStudy(cards, undefined, domain)}>Study domain →</button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {cards.map((c) => {
                const weak = weakIds.has(c.id);
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
          </Card>
        );
      })}
      {groups.length === 0 && <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">No terms match "{query}".</p>}
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
          Study {count > 0 ? `${count} card${count === 1 ? "" : "s"}` : "—"} →
        </button>
        <button className={`${BTN_SECONDARY} disabled:opacity-40`} disabled={count === 0} onClick={onBlitz}>⚡ Blitz</button>
      </div>
    </div>
  );
}
