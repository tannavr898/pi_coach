// The logged-in home dashboard (Task 4, expanded). Leads with the one action
// (Start a role-play), then visualizes progress so a student sees at a glance
// what's strong and what to drill:
//   - a skill radar of criterion mastery (the "at a glance" view)
//   - the written weakest-criterion nudge + actions (kept — it names the fix)
//   - score trend + delivery trend as line charts
//   - a consistency (sessions/week) bar chart
//   - recent sessions, and a flashcards deck with a recommendation
// Every number still maps to a next action; no badges/leaderboards/streak games.

import { useEffect, useState } from "react";
import { getDomains, type DomainSummary } from "./api";
import { getProgress, getSessions, type ProgressResponse, type SessionSummary } from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow } from "./ui";
import { ChartFrame, SkillRadar, TrendLine, VolumeBars } from "./charts";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// Sessions bucketed into the last `weeks` calendar weeks (oldest → newest).
function weeklyVolume(dates: string[], weeks = 8): { label: string; value: number }[] {
  const now = new Date();
  const day = now.getDay();
  const thisWeekStart = new Date(now);
  thisWeekStart.setHours(0, 0, 0, 0);
  thisWeekStart.setDate(now.getDate() - day); // Sunday
  const buckets: { label: string; value: number; start: number; end: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(thisWeekStart);
    start.setDate(thisWeekStart.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    buckets.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, value: 0, start: start.getTime(), end: end.getTime() });
  }
  for (const d of dates) {
    const t = new Date(d).getTime();
    const b = buckets.find((x) => t >= x.start && t < x.end);
    if (b) b.value += 1;
  }
  return buckets.map(({ label, value }) => ({ label, value }));
}

export function HomePage(props: {
  onStart: () => void;
  onPracticeCriterion: (name: string) => void;
  onOpenFlashcards: (ids: string[]) => void;
  onOpenLibrary: () => void;
  onOpenSession: (id: string) => void;
}) {
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([getProgress(), getSessions(), getDomains()])
      .then(([p, s, d]) => {
        if (!active) return;
        setProgress(p);
        setSessions(s);
        setDomains(d);
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
  const scoreTrend = progress?.score_trend ?? null;
  const count = progress?.sessions_count ?? 0;
  const mastery = progress?.criterion_mastery ?? [];

  // Skill radar = the 13 domains. Each domain's value is the average mastery rank
  // (0 Novice → 3 Exemplary) of the criteria you've been graded on in it; domains
  // you haven't touched sit at 0 — the "fill in your skills" view.
  const radarData = domains.map((d) => {
    const crits = mastery.filter((m) => m.domain === d.name);
    const value = crits.length ? crits.reduce((s, m) => s + m.avg_rank, 0) / crits.length : 0;
    return { label: d.name, value };
  });
  const practicedDomains = radarData.filter((d) => d.value > 0).length;

  const scorePoints = (scoreTrend?.points ?? []).map((p) => ({ label: fmtDate(p.created_at), value: p.score }));
  const deliveryPoints = (sessions ?? [])
    .filter((s) => s.filler_per_min != null)
    .slice()
    .reverse() // getSessions is newest-first; charts want oldest-first
    .map((s) => ({ label: fmtDate(s.created_at), value: Number(s.filler_per_min) }));
  const volume = weeklyVolume((sessions ?? []).map((s) => s.created_at));
  const allCriterionIds = mastery.map((m) => m.criterion_id);

  return (
    <div className="mx-auto max-w-[84rem] space-y-5">
      {/* 1: Start, always at the top */}
      <Card>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <Eyebrow>Ready when you are</Eyebrow>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
              Let's run a role-play.
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {count > 0
                ? `${count} session${count === 1 ? "" : "s"} in. Keep showing up. That's how the numbers below move.`
                : "Pick your event, present out loud, and get honest per-criterion feedback."}
            </p>
          </div>
          <button className={`${BTN_PRIMARY} shrink-0 px-6 py-3 text-base`} onClick={props.onStart}>
            Start a role-play →
          </button>
        </div>
      </Card>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Couldn't load your progress: {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* 2: Skill radar (13 domains) + weakest-criterion coaching (the headline) */}
        <Card className="lg:col-span-2">
          <ChartFrame title="Your skills across the 13 domains" hint="Higher is stronger: 0 Novice → 3 Exemplary, averaged over the criteria you've been graded on in each domain.">
            {radarData.length >= 3 && count > 0 ? (
              <div className="grid items-center gap-6 sm:grid-cols-[1.4fr_1fr]">
                <SkillRadar data={radarData} max={3} />
                <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  {[...radarData]
                    .sort((a, b) => b.value - a.value)
                    .map((d) => (
                      <li key={d.label} className="flex items-center justify-between gap-2">
                        <span className="truncate text-slate-600 dark:text-slate-300">{d.label}</span>
                        <span className={`font-mono tabular-nums ${d.value === 0 ? "text-slate-300 dark:text-slate-600" : "text-slate-500 dark:text-slate-400"}`}>{d.value.toFixed(1)}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                Finish a session and your skill map fills in here: one spoke per domain, {domains.length || 13} in all.
              </p>
            )}
          </ChartFrame>
          {practicedDomains > 0 && (
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">You've touched {practicedDomains} of {domains.length || 13} domains. Spokes at 0 are ones you haven't practiced yet.</p>
          )}

          {weak && (
            <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/40">
              <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">Your next focus</div>
              <h2 className="mt-1 font-display text-base font-semibold text-slate-900 dark:text-slate-100">{weak.name}</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{weak.note}</p>
              <div className="mt-3 flex flex-col gap-2.5 sm:flex-row">
                <button className={`${BTN_PRIMARY} sm:flex-1`} onClick={() => props.onPracticeCriterion(weak.name)}>Practice it →</button>
                <button className={`${BTN_SECONDARY} sm:flex-1`} onClick={() => props.onOpenFlashcards([weak.criterion_id])}>Study this criterion</button>
              </div>
            </div>
          )}
        </Card>

        {/* Recent sessions */}
        <Card className="lg:col-span-1">
          <Eyebrow>Recent sessions</Eyebrow>
          {sessions === null ? (
            <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Your completed role-plays show up here.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {sessions.slice(0, 7).map((s) => (
                <li key={s.id}>
                  <button onClick={() => props.onOpenSession(s.id)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:opacity-80">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {s.topic || s.event || "Role-play"}
                        {s.retry_of_session_id && (
                          <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">retry</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                        {fmtDate(s.created_at)}
                        {s.filler_per_min != null ? ` · ${s.filler_per_min.toFixed(1)} fillers/min` : " · typed"}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono tabular-nums text-sm font-semibold text-slate-700 dark:text-slate-200">{s.content_score}%</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Score trend */}
        <Card className="lg:col-span-1">
          <ChartFrame title="Score trend" hint={scoreTrend?.note}>
            {scorePoints.length >= 2 ? (
              <TrendLine points={scorePoints} color="indigo" yMin={0} yMax={100} valueSuffix="%" />
            ) : (
              <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">A few more sessions and your score trend plots here.</p>
            )}
          </ChartFrame>
        </Card>

        {/* Delivery trend (fillers/min) */}
        <Card className="lg:col-span-1">
          <ChartFrame title="Delivery: fillers per minute" hint={trend?.note}>
            {deliveryPoints.length >= 2 ? (
              <TrendLine points={deliveryPoints} color="emerald" yMin={0} valueSuffix="/min" />
            ) : (
              <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Do a couple of spoken reps to track your filler rate.</p>
            )}
          </ChartFrame>
        </Card>

        {/* Consistency / volume */}
        <Card className="lg:col-span-1">
          <ChartFrame title="Your consistency" hint={count > 0 ? `${count} session${count === 1 ? "" : "s"} total: sessions per week.` : "Sessions per week."}>
            {sessions && sessions.length > 0 ? (
              <VolumeBars bars={volume} />
            ) : (
              <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Your weekly activity shows up here.</p>
            )}
          </ChartFrame>
        </Card>

        {/* Flashcards deck */}
        <Card className="lg:col-span-3">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <Eyebrow>Flashcards</Eyebrow>
              <h3 className="mt-1 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                {weak ? <>Recommended: study <span className="text-indigo-600 dark:text-indigo-400">{weak.name}</span></> : "Build your flashcard deck"}
              </h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {allCriterionIds.length > 0
                  ? `Flip through the ${allCriterionIds.length} criteria you've been graded on: definition, what strong vs. weak looks like, and the DECA method.`
                  : "Finish a session and the criteria you were graded on become a study deck here."}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2.5 sm:flex-row">
              {weak && (
                <button className={BTN_PRIMARY} onClick={() => props.onOpenFlashcards([weak.criterion_id])}>Study the recommendation →</button>
              )}
              <button className={BTN_SECONDARY} onClick={props.onOpenLibrary}>Open flashcard library →</button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
