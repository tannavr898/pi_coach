// The study course — the summer half of the app. Pick the event you're competing
// in, get an ordered path through the terms it actually exercises, and work it.
//
// Two ideas carry the whole screen:
//   - The CORE path is the promise: every skill we actually grade for this event.
//     It gets the headline number. "Everything" is the optional deeper pass.
//   - A UNIT is one topic (~4-7 terms) — small enough to finish in a sitting, which
//     is what makes a 250-term corpus feel like a path instead of a pile.
//
// Units hand off to the existing study overlay and Mastery Blitz rather than
// reimplementing either: both already take an arbitrary set of terms.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getEvents, getTerms, type EventSummary, type Term } from "./api";
import { enrollCourse, getCourse, getMyCourse, type Course, type CourseUnit } from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow } from "./ui";

export function StudyCourse({
  authed,
  onStudy,
  onBlitz,
}: {
  authed: boolean;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
}) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [tier, setTier] = useState<"core" | "all">("core");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: load the picker, and jump straight to the enrolled course if there is
  // one. A 404 here is the normal "hasn't picked yet" answer, not a failure.
  useEffect(() => {
    let active = true;
    getEvents()
      .then((e) => active && setEvents(e))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    if (authed) {
      getMyCourse()
        .then((c) => active && setCourse(c))
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [authed]);

  const pick = useCallback(async (eventId: string) => {
    setBusy(true);
    setError(null);
    try {
      setCourse(await getCourse(eventId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (!course) return;
    setBusy(true);
    try {
      setCourse(await enrollCourse(course.event_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [course]);

  // Units hand ids to the overlay, so fetch the cards only when one is opened —
  // a course is ~250 terms and almost none of them are needed to render this page.
  const launch = useCallback(
    async (ids: string[], title: string, fn: (c: Term[], t?: string) => void) => {
      if (!ids.length) return;
      setBusy(true);
      try {
        fn(await getTerms(ids), title);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const unitIds = useCallback(
    (u: CourseUnit) => (tier === "core" ? u.core_ids : [...u.core_ids, ...u.extended_ids]),
    [tier],
  );

  // Progress must be counted over the tier on screen. Showing "0/8" next to a Core
  // unit that only has 4 core terms makes the path look unfinishable.
  const unitDone = useCallback((u: CourseUnit) => (tier === "core" ? u.core_known : u.known), [tier]);
  const unitTotal = useCallback((u: CourseUnit) => (tier === "core" ? u.core_total : u.total), [tier]);

  const visible = useMemo(
    () => (course?.units ?? []).filter((u) => unitIds(u).length > 0),
    [course, unitIds],
  );

  const allIds = useMemo(() => visible.flatMap(unitIds), [visible, unitIds]);

  if (error && !course) {
    return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!course) return <EventPicker events={events} busy={busy} onPick={pick} />;

  const done = tier === "core" ? course.core_known : course.known_count;
  const total = tier === "core" ? course.core_count : course.total;
  const percent = tier === "core" ? course.core_percent : course.percent;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Study course</Eyebrow>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
            {course.event}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            {course.core_count} core terms across {visible.length} units. Finish the core path and you'll know every
            skill we grade for this event, then practice is about delivery, not vocabulary.
          </p>
        </div>
        <button className={BTN_SECONDARY} onClick={() => setCourse(null)} disabled={busy}>
          Change event
        </button>
      </div>

      {/* Headline progress. Core gets the number; "everything" is the deeper pass. */}
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-wider text-indigo-500">
              {tier === "core" ? "Core path" : "Full mastery"}
            </div>
            <div className="font-mono text-3xl font-bold leading-none text-slate-900 dark:text-slate-100">
              {done}
              <span className="text-lg text-slate-300 dark:text-slate-600">/{total}</span>
              <span className="ml-2 text-base font-semibold text-indigo-600 dark:text-indigo-400">{percent}%</span>
            </div>
          </div>
          <div className="flex gap-2">
            <TierTab active={tier === "core"} onClick={() => setTier("core")} label={`Core path (${course.core_count})`} />
            <TierTab active={tier === "all"} onClick={() => setTier("all")} label={`Everything (${course.total})`} />
          </div>
        </div>
        <Bar percent={percent} className="mt-3" />
        {!authed && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            You're browsing this path signed out: nothing is being saved. Make an account to keep your progress over
            the summer.
          </p>
        )}
        {authed && !course.enrolled && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className={BTN_PRIMARY} onClick={start} disabled={busy}>
              Start this path →
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Sets this as your event. Switching later keeps everything you've already proved.
            </span>
          </div>
        )}
      </Card>

      {/* Blitz the whole course: the drill picks its own 5 from whatever it's given. */}
      <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 p-5 dark:border-indigo-900/60 dark:from-indigo-950/40 dark:to-violet-950/30 sm:flex-row sm:items-center">
        <div>
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">⚡ Blitz this course</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Five random terms from {tier === "core" ? "your core path" : "the whole course"}, 45 seconds each.
          </p>
        </div>
        <button
          className={BTN_PRIMARY}
          disabled={busy || !allIds.length}
          onClick={() => launch(allIds, course.event, onBlitz)}
        >
          Blitz {allIds.length} terms →
        </button>
      </div>

      {visible.map((u) => {
        const ids = unitIds(u);
        const done = unitDone(u);
        const total = unitTotal(u);
        return (
          <Card key={u.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {u.domain}
                </div>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{u.topic}</h2>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {ids.length}
                  </span>
                  {total > 0 && done === total && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      ✓ done
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-xs tabular-nums text-slate-400 dark:text-slate-500">
                  {done}/{total}
                </span>
                <button className={BTN_SECONDARY} disabled={busy} onClick={() => launch(ids, u.topic, onBlitz)}>
                  ⚡ Blitz
                </button>
                <button
                  className={BTN_SECONDARY}
                  disabled={busy}
                  onClick={() => launch(ids, u.topic, (c, t) => onStudy(c, undefined, t))}
                >
                  Study →
                </button>
              </div>
            </div>
            <Bar percent={total ? Math.round((100 * done) / total) : 0} className="mt-3" />
          </Card>
        );
      })}
    </div>
  );
}

function TierTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? "bg-indigo-600 text-white"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {label}
    </button>
  );
}

function Bar({ percent, className = "" }: { percent: number; className?: string }) {
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 ${className}`}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

function EventPicker({
  events,
  busy,
  onPick,
}: {
  events: EventSummary[] | null;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const byCluster = useMemo(() => {
    const order: string[] = [];
    const by: Record<string, EventSummary[]> = {};
    for (const e of events ?? []) {
      if (!by[e.cluster]) {
        by[e.cluster] = [];
        order.push(e.cluster);
      }
      by[e.cluster].push(e);
    }
    return order.map((c) => ({ cluster: c, events: by[c] }));
  }, [events]);

  if (!events) {
    return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-slate-400 dark:text-slate-500">Loading events…</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <Eyebrow>Study course</Eyebrow>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
          What are you competing in?
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
          Pick your event and we'll build the study path for it: the business terms that event actually draws on,
          ordered, in units you can finish one at a time. Start in the summer and the season is about delivery.
        </p>
      </div>

      {byCluster.map(({ cluster, events: list }) => (
        <Card key={cluster}>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{cluster}</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {list.map((e) => (
              <button
                key={e.id}
                disabled={busy}
                onClick={() => onPick(e.id)}
                className="rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-800 dark:hover:bg-slate-800"
              >
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{e.name}</div>
                {e.blurb && <div className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{e.blurb}</div>}
              </button>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
