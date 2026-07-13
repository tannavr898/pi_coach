// The logged-in home page (Task 4) — deliberately LEAN. Exactly four things, in
// this order, and nothing else:
//   1. Start a role-play (the primary action, always on top)
//   2. One headline stat — the delivery trend (the most trustworthy signal)
//   3. The weakest criterion + one action (practice it / study it)
//   4. Recent sessions (click to re-read past feedback)
// No extra charts, badges, leaderboards, streaks, or confetti. Every number maps
// to a next action.

import { useEffect, useState } from "react";
import { getProgress, getSessions, type ProgressResponse, type SessionSummary } from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow } from "./ui";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function HomePage(props: {
  onStart: () => void;
  onPracticeCriterion: (name: string) => void;
  onStudyCriterion: (criterionId: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([getProgress(), getSessions()])
      .then(([p, s]) => {
        if (!active) return;
        setProgress(p);
        setSessions(s);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);

  const weak = progress?.weakest_criterion ?? null;
  const trend = progress?.delivery_trend ?? null;
  const count = progress?.sessions_count ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4 pt-2">
      {/* 1 — Start, always at the top */}
      <Card>
        <Eyebrow>Ready when you are</Eyebrow>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
          Let's run a role-play.
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {count > 0
            ? `You've completed ${count} session${count === 1 ? "" : "s"}. Keep the streak of showing up going.`
            : "Pick your event, present out loud, and get honest per-criterion feedback."}
        </p>
        <button className={`mt-4 ${BTN_PRIMARY}`} onClick={props.onStart}>
          Start a role-play →
        </button>
      </Card>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Couldn't load your progress: {error}
        </div>
      )}

      {/* 2 — Delivery trend (the one headline stat) */}
      {trend && (
        <Card>
          <Eyebrow>Your delivery over time</Eyebrow>
          <p className="mt-2 text-base leading-relaxed text-slate-800 dark:text-slate-100">{trend.note}</p>
          {trend.available && trend.recent_wpm != null && (
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Recent pace ≈ {trend.recent_wpm} WPM. Delivery is measured from your audio — it never judges tone or confidence.
            </p>
          )}
        </Card>
      )}

      {/* 3 — Weakest criterion + one action (the coaching moment) */}
      {weak && (
        <Card>
          <Eyebrow>Your next focus</Eyebrow>
          <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{weak.name}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{weak.note}</p>
          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            <button className={`${BTN_PRIMARY} sm:flex-1`} onClick={() => props.onPracticeCriterion(weak.name)}>
              Practice it →
            </button>
            <button className={`${BTN_SECONDARY} sm:flex-1`} onClick={() => props.onStudyCriterion(weak.criterion_id)}>
              Study this criterion
            </button>
          </div>
        </Card>
      )}

      {/* 4 — Recent sessions */}
      <Card>
        <Eyebrow>Recent sessions</Eyebrow>
        {sessions === null ? (
          <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Your completed role-plays will show up here — finish one to start tracking.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
            {sessions.slice(0, 8).map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => props.onOpenSession(s.id)}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:opacity-80"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {s.topic || s.event || "Role-play"}
                      {s.retry_of_session_id && (
                        <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                          retry
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      {fmtDate(s.created_at)} · {s.level}
                      {s.filler_per_min != null ? ` · ${s.filler_per_min.toFixed(1)} fillers/min` : " · typed"}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm font-semibold text-slate-700 dark:text-slate-200">{s.content_score}%</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
