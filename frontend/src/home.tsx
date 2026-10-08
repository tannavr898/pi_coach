// The logged-in home dashboard (Task 4, expanded). Leads with the one action
// (Start a role-play), then visualizes progress so a student sees at a glance
// what's strong and what to drill:
//   - a skill radar of criterion mastery (the "at a glance" view)
//   - the written weakest-criterion nudge + actions (kept, it names the fix)
//   - score trend + delivery trend as line charts
//   - a consistency (sessions/week) bar chart
//   - recent sessions, and a flashcards deck with a recommendation
// Every number still maps to a next action; no badges/leaderboards/streak games.

import { useState, type ReactNode } from "react";
import { getDomains, type DomainSummary } from "./api";
import {
  getMyPlan,
  getProgress,
  getSessions,
  myCourseOrNull,
  planKey,
  type Course,
  type ProgressResponse,
  type SessionSummary,
} from "./progress";
import { PlanNudge, PlanTodayCard } from "./plan";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow, InlineLoader, PageHead, PageLoader, Sidebar, SideGroup, SideItem, Strip } from "./ui";
import { useCached } from "./cache";
import { ChartFrame, SkillRadar, TrendLine, VolumeBars } from "./charts";
import { track } from "./analytics";

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
  onOpenStudy: () => void;
}) {
  // Each read comes from the cache (cache.ts): after the first visit the
  // dashboard paints immediately from the last answer and refreshes underneath.
  const progressQ = useCached("/api/progress", getProgress);
  const sessionsQ = useCached("/api/sessions", getSessions);
  const domainsQ = useCached("static:domains", getDomains);
  // The event they're studying for, if they've enrolled in a course. Drives the
  // radar filter; null just means "hasn't picked one", which is not an error.
  const courseQ = useCached("/api/course", myCourseOrNull);
  // Today's slice of their study plan, if they've made one. A failure here just
  // hides the card, the dashboard's other numbers don't depend on it.
  const planQ = useCached(planKey(), getMyPlan);

  const progress = progressQ.data ?? null;
  const sessions = sessionsQ.data ?? null;
  const domains = domainsQ.data ?? [];
  const course = courseQ.data ?? null;
  const plan = planQ.data ?? null;
  const error = progressQ.error ?? sessionsQ.error;

  if (progressQ.loading || sessionsQ.loading) {
    return (
      <div className="pt-6">
        <PageLoader label="Loading your dashboard" card={false} />
      </div>
    );
  }

  const weak = progress?.weakest_criterion ?? null;
  const count = progress?.sessions_count ?? 0;
  const allCriterionIds = (progress?.criterion_mastery ?? []).map((m) => m.criterion_id);

  const latest = sessions?.[0] ?? null;
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="space-y-6">
      {/* History lives in the sidebar: every past role-play, one click from its
          feedback. Below the page on a phone, where the next rep comes first. */}
      <Sidebar below>
        <SideGroup title="Recent role-plays">
          {sessions === null ? (
            <InlineLoader label="Loading role-plays" />
          ) : sessions.length === 0 ? (
            <p className="px-2.5 text-sm text-slate-500 dark:text-slate-400">Your completed role-plays show up here.</p>
          ) : (
            sessions.slice(0, 12).map((x) => (
              <SideItem
                key={x.id}
                onClick={() => props.onOpenSession(x.id)}
                sub={`${fmtDate(x.created_at)}${x.filler_per_min != null ? `, ${x.filler_per_min.toFixed(1)} fillers/min` : ", typed"}${x.retry_of_session_id ? ", retry" : ""}`}
                right={<span className="font-mono text-[13px] tabular-nums text-slate-600 dark:text-slate-300">{x.content_score}%</span>}
              >
                {x.topic || x.event || "Role-play"}
              </SideItem>
            ))
          )}
        </SideGroup>
      </Sidebar>

      {/* 1: Start, always at the top */}
      <div>
        <PageHead
          sub={today}
          title="Ready when you are"
          blurb={
            count > 0
              ? "Keep showing up. That's how the numbers below move."
              : "Pick your event, present out loud, and get honest per-criterion feedback."
          }
        >
          <button className={BTN_SECONDARY} onClick={props.onOpenStudy}>Open Study</button>
          <button className={BTN_PRIMARY} onClick={props.onStart}>Start a role-play</button>
        </PageHead>
        {count > 0 && (
          <Strip
            cells={[
              { label: "Role-plays", value: count },
              { label: "Latest score", value: latest ? `${latest.content_score}%` : "None yet" },
              { label: "Fillers per minute", value: latest?.filler_per_min != null ? latest.filler_per_min.toFixed(1) : "Typed" },
              { label: "Skills graded", value: allCriterionIds.length },
            ]}
          />
        )}
      </div>

      {plan ? (
        <PlanTodayCard plan={plan} onOpen={props.onOpenStudy} />
      ) : course ? (
        <PlanNudge eventName={course.event} onOpen={props.onOpenStudy} />
      ) : null}

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Couldn't load your progress: {error}
        </div>
      )}

      <ProfilePanels
        progress={progress}
        sessions={sessions}
        domains={domains}
        course={course}
        onOpenSession={props.onOpenSession}
        onPracticeCriterion={props.onPracticeCriterion}
        onOpenFlashcards={props.onOpenFlashcards}
        recent={false}
      >
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
                <button className={BTN_PRIMARY} onClick={() => props.onOpenFlashcards([weak.criterion_id])}>Study the recommendation</button>
              )}
              <button className={BTN_SECONDARY} onClick={props.onOpenLibrary}>Open flashcard library</button>
            </div>
          </div>
        </Card>
      </ProfilePanels>
    </div>
  );
}

// The graphs that make up a student's profile: skill radar with their next focus,
// recent role-plays, score and delivery trends, and weekly consistency. Shared by
// the student's own Home and by a chapter manager opening that student, so the two
// can never disagree about what the numbers say. With no action handlers (the
// manager's view) it renders read-only: a manager can't start practice for them.
export function ProfilePanels(props: {
  progress: ProgressResponse | null;
  sessions: SessionSummary[] | null;
  domains: DomainSummary[];
  course: Course | null;
  // Set when someone other than the student is looking; it changes "Your" to
  // their name and hides the practice buttons.
  subjectName?: string;
  onOpenSession: (id: string) => void;
  onPracticeCriterion?: (name: string) => void;
  onOpenFlashcards?: (ids: string[]) => void;
  // The recent role-plays list. Home turns it off because its sidebar is that list.
  recent?: boolean;
  children?: ReactNode;
}) {
  const { progress, sessions, domains, course, recent = true } = props;
  const [radarScope, setRadarScope] = useState<"event" | "all">("event");
  const own = !props.subjectName;
  const whose = own ? "Your" : `${props.subjectName}'s`;

  const weak = progress?.weakest_criterion ?? null;
  const trend = progress?.delivery_trend ?? null;
  const scoreTrend = progress?.score_trend ?? null;
  const count = progress?.sessions_count ?? 0;
  const mastery = progress?.criterion_mastery ?? [];

  // The domains this student's event is actually graded on. A course's units are
  // grouped by domain, so the distinct domain_ids across them ARE the event's set,
  // already in priority order. Empty when they haven't enrolled in a course.
  const eventDomainIds = course ? [...new Set(course.units.map((u) => u.domain_id))] : [];
  const canFilter = eventDomainIds.length >= 3; // fewer spokes than that isn't a radar
  const filtered = canFilter && radarScope === "event";
  const shownDomains = filtered ? domains.filter((d) => eventDomainIds.includes(d.id)) : domains;

  // Skill radar. Each domain's value is the average mastery rank (0 Novice to
  // 3 Exemplary) of the criteria they've been graded on in it; untouched domains
  // sit at 0, the "fill in your skills" view. Note the join is on domain NAME:
  // CriterionMastery carries the display name, not the id.
  const radarData = shownDomains.map((d) => {
    const crits = mastery.filter((m) => m.domain === d.name);
    const value = crits.length ? crits.reduce((sum, m) => sum + m.avg_rank, 0) / crits.length : 0;
    return { label: d.name, value };
  });
  const practicedDomains = radarData.filter((d) => d.value > 0).length;

  const scorePoints = (scoreTrend?.points ?? []).map((p) => ({ label: fmtDate(p.created_at), value: p.score }));
  const deliveryPoints = (sessions ?? [])
    .filter((x) => x.filler_per_min != null)
    .slice()
    .reverse() // sessions arrive newest-first; charts want oldest-first
    .map((x) => ({ label: fmtDate(x.created_at), value: Number(x.filler_per_min) }));
  const volume = weeklyVolume((sessions ?? []).map((x) => x.created_at));

  return (
    <div className={`grid gap-x-8 gap-y-7 lg:grid-cols-3 ${recent ? "" : "[&>*:first-child]:border-t-0 [&>*:first-child]:pt-0"}`}>
      {/* Skill radar (13 domains) + weakest-criterion coaching (the headline) */}
      <Card className={recent ? "lg:col-span-2" : "lg:col-span-3"}>
        {canFilter && (
          <div className="mb-3 flex flex-wrap items-center justify-end gap-1.5">
            <span className="mr-auto text-xs font-medium text-slate-500 dark:text-slate-400">Showing</span>
            {(["event", "all"] as const).map((sc) => (
              <button
                key={sc}
                onClick={() => { setRadarScope(sc); track("radar_filter_changed", { scope: sc, own }); }}
                aria-pressed={radarScope === sc}
                className={`rounded-full border px-3 py-1 text-[13px] transition ${
                  radarScope === sc
                    ? "border-indigo-200 bg-indigo-50 font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {sc === "event" ? course?.event ?? "Event" : "All domains"}
              </button>
            ))}
          </div>
        )}
        <ChartFrame
          title={filtered ? `${whose} skills for ${course?.event}` : `${whose} skills across the ${domains.length || 13} domains`}
          hint={
            filtered
              ? `Only the ${radarData.length} domains this event is graded on. Higher is stronger: 0 Novice → 3 Exemplary.`
              : "Higher is stronger: 0 Novice → 3 Exemplary, averaged over the criteria graded in each domain."
          }
        >
          {radarData.length >= 3 && count > 0 ? (
            <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
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
              {own
                ? `Finish a session and your skill map fills in here: one spoke per domain, ${domains.length || 13} in all.`
                : "No graded role-plays yet, so there's no skill map to show."}
            </p>
          )}
        </ChartFrame>
        {practicedDomains > 0 && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {own ? "You've" : `${props.subjectName} has`} touched {practicedDomains} of {radarData.length || domains.length || 13}{" "}
            {filtered ? "domains this event grades" : "domains"}. Spokes at 0 haven't been practiced yet.
          </p>
        )}

        {weak && (
          <div className="mt-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
            <div className="min-w-0">
              <Eyebrow>{own ? "Work on next" : "Biggest gap"}</Eyebrow>
              <h2 className="mt-0.5 font-display text-base font-semibold text-slate-900 dark:text-slate-100">{weak.name}</h2>
              <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-slate-600 dark:text-slate-300">{weak.note}</p>
            </div>
            {props.onPracticeCriterion && props.onOpenFlashcards && (
              <div className="flex flex-wrap gap-2">
                <button className={BTN_SECONDARY} onClick={() => props.onOpenFlashcards?.([weak.criterion_id])}>Study it</button>
                <button className={BTN_PRIMARY} onClick={() => props.onPracticeCriterion?.(weak.name)}>Practice it</button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Recent sessions */}
      {recent && <Card className="lg:col-span-1">
        <Eyebrow>Recent role-plays</Eyebrow>
        {sessions === null ? (
          <InlineLoader label="Loading role-plays" />
        ) : sessions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{own ? "Your completed role-plays show up here." : "No role-plays yet."}</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
            {sessions.slice(0, 7).map((x) => (
              <li key={x.id}>
                <button onClick={() => props.onOpenSession(x.id)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:opacity-80">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {x.topic || x.event || "Role-play"}
                      {x.retry_of_session_id && (
                        <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">retry</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {fmtDate(x.created_at)}
                      {x.filler_per_min != null ? ` · ${x.filler_per_min.toFixed(1)} fillers/min` : " · typed"}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-sm font-semibold text-slate-700 dark:text-slate-200">{x.content_score}%</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>}

      {/* Score trend */}
      <Card className="lg:col-span-1">
        <ChartFrame title="Score trend" hint={scoreTrend?.note}>
          {scorePoints.length >= 2 ? (
            <TrendLine points={scorePoints} color="indigo" yMin={0} yMax={100} valueSuffix="%" />
          ) : (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">A few more sessions and the score trend plots here.</p>
          )}
        </ChartFrame>
      </Card>

      {/* Delivery trend (fillers/min) */}
      <Card className="lg:col-span-1">
        <ChartFrame title="Delivery: fillers per minute" hint={trend?.note}>
          {deliveryPoints.length >= 2 ? (
            <TrendLine points={deliveryPoints} color="emerald" yMin={0} valueSuffix="/min" />
          ) : (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">A couple of spoken reps and the filler rate plots here.</p>
          )}
        </ChartFrame>
      </Card>

      {/* Consistency / volume */}
      <Card className="lg:col-span-1">
        <ChartFrame title="Consistency" hint={count > 0 ? `${count} session${count === 1 ? "" : "s"} total: sessions per week.` : "Sessions per week."}>
          {sessions && sessions.length > 0 ? (
            <VolumeBars bars={volume} />
          ) : (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Weekly activity shows up here.</p>
          )}
        </ChartFrame>
      </Card>

      {props.children}
    </div>
  );
}
