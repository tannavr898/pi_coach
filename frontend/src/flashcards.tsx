// Criterion flashcards (Task 5) — the study step for a user's weak criteria.
// Deliberately tiny: a flip-through built entirely from framework data we already
// have (name, definition, strong/weak looks-like) plus the fixed DECA method.
// NOT a spaced-repetition engine, a general library, or a standalone study mode —
// it's the "next step" for a weak criterion, reached from the home nudge or the
// feedback screen.

import { useEffect, useState } from "react";
import { getCriteria, type Criterion } from "./api";
import { BTN_SECONDARY } from "./ui";

// The DECA method — how a top response treats any criterion. It's fixed coaching
// (it lives in the grading prompt, not per-criterion in the framework), so we show
// it the same on every card.
const DECA_METHOD: { step: string; blurb: string }[] = [
  { step: "Define", blurb: "Say what the skill is in plain terms." },
  { step: "Explain", blurb: "Show why it matters for this business." },
  { step: "Connect", blurb: "Tie it to your actual recommendation." },
  { step: "Above & beyond", blurb: "Add a number, trade-off, or risk most people miss." },
];

export function Flashcards({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [cards, setCards] = useState<Criterion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    let active = true;
    getCriteria(ids)
      .then((c) => { if (active) setCards(c); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [ids]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const card = cards && cards.length > 0 ? cards[Math.min(i, cards.length - 1)] : null;
  const total = cards?.length ?? 0;

  function go(delta: number) {
    setFlipped(false);
    setI((v) => Math.max(0, Math.min(total - 1, v + delta)));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white/80">Study your weak criteria</span>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-white/70 transition hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>

        {error ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-red-600 dark:bg-slate-900 dark:text-red-400">Couldn't load cards: {error}</div>
        ) : !cards ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-slate-400 dark:bg-slate-900">Loading…</div>
        ) : !card ? (
          <div className="rounded-2xl bg-white p-6 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">No cards to study yet.</div>
        ) : (
          <>
            <button
              onClick={() => setFlipped((f) => !f)}
              className="block w-full rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-xl transition dark:border-slate-800 dark:bg-slate-900"
              style={{ minHeight: "20rem" }}
            >
              {!flipped ? (
                <div className="flex h-full min-h-[17rem] flex-col justify-center">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">{card.domain}</div>
                  <h2 className="mt-2 font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">{card.name}</h2>
                  {card.coaches && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{card.coaches}</p>}
                  <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">Tap to see what a strong answer looks like →</p>
                </div>
              ) : (
                <div className="space-y-4 text-sm">
                  {card.definition && (
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">What it's asking</div>
                      <p className="mt-1 text-slate-700 dark:text-slate-200">{card.definition}</p>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Strong looks like</div>
                      <p className="mt-1 text-emerald-900 dark:text-emerald-200">{card.strong_looks_like}</p>
                    </div>
                    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">Weak looks like</div>
                      <p className="mt-1 text-amber-900 dark:text-amber-200">{card.weak_looks_like}</p>
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">Nail it — the DECA method</div>
                    <ol className="mt-1.5 space-y-1">
                      {DECA_METHOD.map((m) => (
                        <li key={m.step} className="text-slate-700 dark:text-slate-200">
                          <strong className="font-semibold text-indigo-600 dark:text-indigo-400">{m.step}:</strong> {m.blurb}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <p className="text-xs text-slate-400 dark:text-slate-500">Tap to flip back →</p>
                </div>
              )}
            </button>

            <div className="mt-3 flex items-center justify-between">
              <button className={BTN_SECONDARY} onClick={() => go(-1)} disabled={i === 0}>
                ← Prev
              </button>
              <span className="font-mono text-xs text-white/80">{Math.min(i + 1, total)} / {total}</span>
              <button className={BTN_SECONDARY} onClick={() => go(1)} disabled={i >= total - 1}>
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
