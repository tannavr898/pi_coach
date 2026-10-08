// The study course, the summer half of the app. Pick the event you're competing
// in, get an ordered path through the terms it actually exercises, and work it.
//
// Two ideas carry the whole screen:
//   - The CORE path is the promise: every skill we actually grade for this event.
//     It gets the headline number. "Everything" is the optional deeper pass.
//   - A UNIT is one topic (~4-7 terms), small enough to finish in a sitting, which
//     is what makes a 250-term corpus feel like a path instead of a pile.
//
// Units hand off to the existing study overlay and Mastery Blitz rather than
// reimplementing either: both already take an arbitrary set of terms.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getEvents, getTerms, type EventSummary, type Term } from "./api";
import { StudyPlanSection } from "./plan";
import { enrollCourse, getCourse, getMyCourse, type Course, type CourseUnit } from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, FilterChip, PageHead, PageLoader, Strip } from "./ui";

export function StudyCourse({
  authed,
  refreshKey,
  onStudy,
  onBlitz,
  onQuiz,
  onPractice,
  onSignup,
  onBrowseAll,
}: {
  authed: boolean;
  // Changes each time a study overlay or a Blitz closes. See the refetch below.
  refreshKey?: number;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
  onQuiz: (cards: Term[], title?: string, opts?: { exam?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" }) => void;
  // A plan's role-play task. With a name, practice is focused on that skill.
  onPractice: (criterionName?: string) => void;
  onSignup: () => void;
  // Switch the Study tab over to the all-domains browser. Offered from the event
  // picker especially: someone who has not chosen an event yet still wants to be
  // able to read a card without committing to a path first.
  onBrowseAll?: () => void;
}) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [tier, setTier] = useState<"core" | "all">("core");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // With a plan on screen, its next task is the one indigo action; the course's
  // own "Blitz this course" panel steps down to secondary.
  const [hasPlan, setHasPlan] = useState(false);

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

  // Progress is written server-side while a study overlay or Blitz is open, so by
  // the time one closes this screen's copy of the course is stale. Refetch the
  // course being VIEWED (not getMyCourse -- you can browse a path you aren't
  // enrolled in, and clobbering that would bounce you to a different event).
  //
  // Without this, flipping cards and finishing Blitzes both left every counter
  // frozen until a full page reload, which is indistinguishable from studying not
  // counting at all.
  useEffect(() => {
    if (!refreshKey) return;
    const eventId = course?.event_id;
    if (!eventId) return;
    let active = true;
    getCourse(eventId)
      .then((c) => active && setCourse(c))
      .catch(() => {}); // a failed refresh just leaves the old numbers up
    return () => {
      active = false;
    };
    // Deliberately keyed on refreshKey alone: including `course` would refetch in
    // a loop, since the refetch replaces it.
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Units hand ids to the overlay, so fetch the cards only when one is opened,
  // a course is ~250 terms and almost none of them are needed to render this page.
  const launch = useCallback(
    async (
      ids: string[],
      title: string,
      fn: (c: Term[], t?: string, o?: { exam?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" }) => void,
      opts?: { exam?: string; scope?: "deck" | "cluster" | "all"; level?: "district" | "state" | "icdc" },
    ) => {
      if (!ids.length) return;
      setBusy(true);
      try {
        fn(await getTerms(ids), title, opts);
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
  // Seen but not yet proven. Shown next to the proven count because otherwise
  // working honestly through a deck moves nothing on screen and the app reads as
  // broken -- a flip can only ever reach "learning" (backend study.py), so without
  // surfacing it there is no feedback at all until the first Blitz lands.
  const unitSeen = useCallback((u: CourseUnit) => (tier === "core" ? u.core_learning : u.learning), [tier]);

  const visible = useMemo(
    () => (course?.units ?? []).filter((u) => unitIds(u).length > 0),
    [course, unitIds],
  );

  const allIds = useMemo(() => visible.flatMap(unitIds), [visible, unitIds]);

  if (error && !course) {
    return <p className="mx-auto max-w-3xl py-10 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!course) return <EventPicker events={events} busy={busy} onPick={pick} onBrowseAll={onBrowseAll} />;

  const done = tier === "core" ? course.core_known : course.known_count;
  const total = tier === "core" ? course.core_count : course.total;
  const percent = tier === "core" ? course.core_percent : course.percent;
  const seen = tier === "core" ? course.core_learning : course.learning_count;

  return (
    <div>
      <PageHead
        sub={course.enrolled ? "My path, your event" : "My path"}
        title={course.event}
        blurb={`${course.core_count} core terms across ${visible.length} units. Finish the core path and you'll know every skill we grade for this event, then practice is about delivery, not vocabulary.`}
      >
        <button className={BTN_SECONDARY} onClick={() => setCourse(null)} disabled={busy}>
          Change event
        </button>
        {/* The no-cost drill, open whether or not you're signed in. This is the
            whole-course button, so it opens on the CLUSTER rather than on this
            event's terms: the paper a Business Finance competitor sits covers the
            Finance cluster, and a test that quietly narrows to one event's four
            domains is the wrong rehearsal. The deck scope is still one tap away
            inside. */}
        <button
          className={BTN_SECONDARY}
          disabled={busy || !allIds.length}
          onClick={() => launch(allIds, course.event, onQuiz, { exam: course.exam, scope: "cluster" })}
        >
          Quiz
        </button>
        {/* Blitz the whole course: the drill picks its own 5 from whatever it's
            given. With a plan on screen its next task is the one indigo action,
            so this steps down to secondary. */}
        <button
          className={hasPlan ? BTN_SECONDARY : BTN_PRIMARY}
          disabled={busy || !allIds.length}
          onClick={() => launch(allIds, course.event, onBlitz)}
        >
          Blitz {allIds.length} terms
        </button>
      </PageHead>

      {/* Headline progress. Core gets the number; "everything" is the deeper pass. */}
      <Strip
        cells={[
          { label: tier === "core" ? "Core terms proven" : "Terms proven", value: `${done} of ${total}` },
          { label: "Complete", value: `${percent}%` },
          { label: "Seen, not yet proven", value: seen },
          { label: "Units", value: visible.length },
        ]}
      />
      <div className="pic-bleed pic-inset flex flex-wrap items-center gap-1.5 border-b border-slate-200 py-3 dark:border-slate-800">
        <span className="mr-1 text-xs font-medium text-slate-500 dark:text-slate-400">Show</span>
        <FilterChip on={tier === "core"} onClick={() => setTier("core")}>Core path ({course.core_count})</FilterChip>
        <FilterChip on={tier === "all"} onClick={() => setTier("all")}>Everything ({course.total})</FilterChip>
        <span className="min-w-2 flex-1" />
        {authed && !course.enrolled && (
          <>
            <span className="text-[13px] text-slate-500 dark:text-slate-400">
              Sets this as your event. Switching later keeps everything you've already proved.
            </span>
            <button className={BTN_PRIMARY} onClick={start} disabled={busy}>
              Start this path
            </button>
          </>
        )}
      </div>

      <div className="space-y-6 pt-6">
        {/* Any error raised once a course is on screen -- enrolling is the main
            one. The guard above only catches errors that prevented a course
            loading at all, so without this an enroll failure was literally
            invisible: the button appeared to do nothing and no message was ever
            shown. */}
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 font-semibold">
              ✕
            </button>
          </div>
        )}
        {!authed && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            You're browsing this path signed out: nothing is being saved. Make an account to keep your progress over
            the summer.
          </p>
        )}

        <StudyPlanSection
          course={course}
          authed={authed}
          refreshKey={refreshKey}
          onStudy={onStudy}
          onBlitz={onBlitz}
          onQuiz={onQuiz}
          onPractice={onPractice}
          onSignup={onSignup}
          onHasPlan={setHasPlan}
          // Saving a plan enrolls its event, so the "Your path" badge should follow.
          onSaved={() => {
            getCourse(course.event_id)
              .then(setCourse)
              .catch(() => {});
          }}
        />

        <div>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Units</h2>
          {done < total && (
            <p className="mt-1 max-w-[70ch] text-[13px] text-slate-500 dark:text-slate-400">
              Flipping a card marks it seen. A term counts as proven once you use it correctly in a Blitz, or apply
              it in a graded role-play.
            </p>
          )}
          <div className="pic-bleed mt-3 overflow-x-auto border-t border-slate-200 dark:border-slate-800">
            <div className="min-w-[620px]">
              {visible.map((u) => {
                const ids = unitIds(u);
                const done = unitDone(u);
                const total = unitTotal(u);
                const seen = unitSeen(u);
                return (
                  <div
                    key={u.id}
                    className="pic-inset grid grid-cols-[minmax(0,1fr)_minmax(120px,200px)_auto] items-center gap-5 border-b border-slate-200 py-2.5 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{u.topic}</div>
                      <div className="truncate text-[13px] text-slate-500 dark:text-slate-400">
                        {u.domain}, {ids.length} term{ids.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        <span>{total > 0 && done === total ? "Done" : seen > 0 ? `${seen} seen` : ""}</span>
                        <span>{done}/{total}</span>
                      </div>
                      <Bar
                        percent={total ? Math.round((100 * done) / total) : 0}
                        behind={total ? Math.round((100 * (done + seen)) / total) : 0}
                        className="mt-1"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button className={BTN_SMALL} disabled={busy} onClick={() => launch(ids, u.topic, onBlitz)}>
                        Blitz
                      </button>
                      <button className={BTN_SMALL} disabled={busy} onClick={() => launch(ids, u.topic, onQuiz, { exam: course.exam, scope: "deck" })}>
                        Quiz
                      </button>
                      <button className={BTN_SMALL} disabled={busy} onClick={() => launch(ids, u.topic, (c, t) => onStudy(c, undefined, t))}>
                        Study
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Two-layer progress. `percent` is what's been PROVEN (solid indigo); the optional
// `behind` is proven-plus-seen (a pale wash under it), so flipping through a deck
// visibly moves something without ever claiming the term is mastered. The solid
// layer is the only one that means "done", that distinction is the whole point.
//
// aria-valuenow stays on the proven figure: a screen reader must hear the honest
// number, and the wash is a hint, not a second value.
function Bar({
  percent,
  behind,
  label,
  className = "",
}: {
  percent: number;
  behind?: number;
  label?: string;
  className?: string;
}) {
  const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)));
  const pct = clamp(percent);
  const seenPct = behind == null ? 0 : Math.max(pct, clamp(behind));
  return (
    <div
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ? `${label}: ${pct}% complete` : `${pct}% complete`}
    >
      {seenPct > pct && (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-indigo-200 transition-[width] duration-500 dark:bg-indigo-900"
          style={{ width: `${seenPct}%` }}
        />
      )}
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-indigo-500 transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function EventPicker({
  events,
  busy,
  onPick,
  onBrowseAll,
}: {
  events: EventSummary[] | null;
  busy: boolean;
  onPick: (id: string) => void;
  onBrowseAll?: () => void;
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
    return (
      <div className="pt-6">
        <PageLoader label="Loading events" card={false} />
      </div>
    );
  }

  return (
    <div>
      <PageHead
        sub="My path"
        title="What are you competing in?"
        blurb="Pick your event and we'll build the study path for it: the business terms that event actually draws on, ordered, in units you can finish one at a time. Start in the summer and the season is about delivery."
      >
        {/* Not everyone arrives ready to commit to an event, and making the whole
            corpus unreachable until they do is a wall in front of the thing they
            came to read. */}
        {onBrowseAll && (
          <button className={BTN_SECONDARY} onClick={onBrowseAll}>
            Browse all domains instead
          </button>
        )}
      </PageHead>

      <div className="pic-bleed border-t border-slate-200 dark:border-slate-800">
        {byCluster.map(({ cluster, events: list }) => (
          <section key={cluster}>
            <h2 className="pic-inset border-b border-slate-200 bg-slate-50 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
              {cluster}
            </h2>
            {list.map((e) => (
              <button
                key={e.id}
                disabled={busy}
                onClick={() => onPick(e.id)}
                className="pic-inset tap grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-0.5 border-b border-slate-200 py-2.5 text-left transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-800 dark:hover:bg-slate-800/40 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto]"
              >
                <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{e.name}</span>
                <span className="order-last col-span-2 truncate text-[13px] text-slate-500 dark:text-slate-400 sm:order-none sm:col-span-1">{e.blurb}</span>
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="text-slate-400">
                  <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
