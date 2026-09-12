// The study plan — the dated half of the Study page. The course says WHAT to study;
// the plan says what to do TODAY, and whether that's enough to be ready for District.
//
// Three rules shape the screen:
//   - Today leads. The runway and the week are context; the checklist is the task.
//   - One indigo action: the next unfinished task. Everything else is secondary.
//   - Honest pace. "Behind" is said plainly, with the minutes that would fix it —
//     never softened, and never painted in the scoring ramp's alarm colors.
//
// Nothing here schedules anything: the backend (plan.py) recomputes the plan from
// progress on every load, which is why a missed day just reflows. Tasks launch the
// existing study overlay, Mastery Blitz, and practice flow rather than new ones.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTerms, type Term } from "./api";
import { track } from "./analytics";
import {
  deletePlan,
  getMyPlan,
  previewPlan,
  savePlan,
  type Course,
  type PlanFeasibility,
  type PlanGoal,
  type PlanInputs,
  type PlanPhase,
  type PlanTask,
  type StudyPlan,
} from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, Card } from "./ui";

const STAGE_NAMES = ["District", "State", "ICDC"] as const;
type StageName = (typeof STAGE_NAMES)[number];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PRESETS = [15, 30, 45, 60];
const PER_DAY_STEPS = [0, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

const KIND_LABEL: Record<PlanTask["kind"], string> = {
  learn: "Learn",
  weak: "Shore up",
  review: "Review",
  roleplay: "Role-play",
  mock: "Mock run",
};

// Indigo tints carry the working phases; taper steps to slate because it is the
// quiet part of the season. No gradients: each phase is a solid run.
const PHASE_STYLE: Partial<Record<PlanPhase, { label: string; hint: string; bar: string }>> = {
  learn: { label: "Learn", hint: "new terms", bar: "bg-indigo-500" },
  sharpen: { label: "Sharpen", hint: "review + reps", bar: "bg-indigo-300 dark:bg-indigo-400/70" },
  taper: { label: "Taper", hint: "mock runs", bar: "bg-slate-400 dark:bg-slate-500" },
};

const MICROLABEL = "font-mono text-[10px] font-semibold uppercase tracking-[0.12em]";
const TEXT_ACTION =
  "rounded-md text-sm font-medium text-slate-600 underline-offset-4 transition hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-40 dark:text-slate-300 dark:hover:text-slate-100";
const INPUT =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

// --- helpers ------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Plan dates are calendar days; parsing "2026-09-14" with new Date() would read it
// as UTC midnight and show the previous day west of Greenwich.
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDay(iso: string): string {
  return parseDay(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} m` : `${h} h`;
}

function daysAway(n: number): string {
  return n === 1 ? "tomorrow" : `in ${n} days`;
}

// --- the section the Study page mounts ------------------------------------------

export function StudyPlanSection({
  course,
  authed,
  refreshKey,
  onStudy,
  onBlitz,
  onPractice,
  onSignup,
  onSaved,
  onHasPlan,
}: {
  course: Course;
  authed: boolean;
  refreshKey?: number;
  onStudy: (cards: Term[], startId?: string, title?: string) => void;
  onBlitz: (cards: Term[], title?: string) => void;
  onPractice: (criterionName?: string) => void;
  onSignup: () => void;
  onSaved?: () => void;
  onHasPlan?: (has: boolean) => void;
}) {
  // undefined = still loading; null = no plan.
  const [plan, setPlan] = useState<StudyPlan | null | undefined>(authed ? undefined : null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refetch whenever a study overlay or Blitz closes (refreshKey), so a finished
  // task ticks over the moment the student is back on this screen.
  useEffect(() => {
    if (!authed) {
      setPlan(null);
      return;
    }
    let active = true;
    getMyPlan()
      .then((p) => active && setPlan(p))
      .catch((e) => {
        if (!active) return;
        setPlan((prev) => prev ?? null);
        setError(errText(e));
      });
    return () => {
      active = false;
    };
  }, [authed, refreshKey]);

  const matches = !!plan && plan.event_id === course.event_id;
  useEffect(() => {
    onHasPlan?.(matches);
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const launch = useCallback(
    async (task: PlanTask, how: "study" | "blitz" | "practice") => {
      track("plan_task_started", { kind: task.kind, how });
      if (how === "practice") {
        onPractice(task.criterion_name || undefined);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const cards = await getTerms(task.term_ids);
        if (how === "study") onStudy(cards, undefined, task.title);
        else onBlitz(cards, task.title);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [onBlitz, onPractice, onStudy],
  );

  const remove = useCallback(async () => {
    if (!window.confirm("Delete your study plan? Everything you've studied and proven stays.")) return;
    setBusy(true);
    try {
      await deletePlan();
      track("plan_deleted");
      setPlan(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const errorBanner = error && (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
    >
      <span>{error}</span>
      <button onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 font-semibold">
        ✕
      </button>
    </div>
  );

  if (plan === undefined) return <PlanSkeleton />;

  if (editing) {
    return (
      <div className="space-y-4">
        {errorBanner}
        <PlanBuilder
          course={course}
          authed={authed}
          initial={matches ? plan : null}
          replacing={plan && !matches ? plan.event : null}
          onCancel={() => setEditing(false)}
          onSignup={onSignup}
          onSaved={(p) => {
            setPlan(p);
            setEditing(false);
            onSaved?.();
          }}
        />
      </div>
    );
  }

  if (plan && matches) {
    return (
      <div className="space-y-4">
        {errorBanner}
        <PlanPanel plan={plan} busy={busy} onLaunch={launch} onEdit={() => setEditing(true)} onDelete={remove} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorBanner}
      <Card>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="max-w-xl">
            <h2 className="font-display text-lg font-semibold text-slate-900 [text-wrap:balance] dark:text-slate-100">
              {plan ? `Your plan is for ${plan.event}` : "Turn this path into a plan"}
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {plan
                ? `Build one for ${course.event} instead and it replaces that plan. Everything you've already proven carries over.`
                : "Add your competition dates and the time you have each day. You'll get a day-by-day plan, and an honest answer on whether you're on pace."}
            </p>
          </div>
          <button
            className={`${course.enrolled || !authed || plan ? BTN_PRIMARY : BTN_SECONDARY} shrink-0`}
            onClick={() => {
              track("plan_builder_opened", { authed, replacing: !!plan });
              setEditing(true);
            }}
          >
            {plan ? `Plan for ${course.event}` : "Build my plan →"}
          </button>
        </div>
      </Card>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <Card>
      <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading your study plan">
        <div className="h-5 w-40 rounded bg-slate-200 dark:bg-slate-800" />
        <div className="h-3 w-full rounded-full bg-slate-100 dark:bg-slate-800" />
        <div className="h-4 w-3/4 rounded bg-slate-100 dark:bg-slate-800" />
      </div>
    </Card>
  );
}

// --- builder ----------------------------------------------------------------------

type Draft = { dates: Record<StageName, string>; minutes: number[]; goal: PlanGoal };

function draftKey(eventId: string) {
  return `pic-plan-draft-${eventId}`;
}

function initialDraft(eventId: string, plan: StudyPlan | null): Draft {
  if (plan) {
    const dates = { District: "", State: "", ICDC: "" } as Record<StageName, string>;
    for (const s of plan.stages) if ((STAGE_NAMES as readonly string[]).includes(s.name)) dates[s.name as StageName] = s.date;
    return { dates, minutes: [...plan.day_minutes], goal: plan.goal };
  }
  // A signed-out student who builds a plan and then makes an account shouldn't
  // have to type it all again. Session-scoped: it's a draft, not a record.
  try {
    const raw = sessionStorage.getItem(draftKey(eventId));
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d?.dates && Array.isArray(d.minutes) && d.minutes.length === 7) return d;
    }
  } catch {
    /* storage unavailable — start fresh */
  }
  return { dates: { District: "", State: "", ICDC: "" }, minutes: [0, 30, 30, 30, 30, 30, 0], goal: "core" };
}

function PlanBuilder({
  course,
  authed,
  initial,
  replacing,
  onCancel,
  onSignup,
  onSaved,
}: {
  course: Course;
  authed: boolean;
  initial: StudyPlan | null;
  replacing: string | null;
  onCancel: () => void;
  onSignup: () => void;
  onSaved: (p: StudyPlan) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(course.event_id, initial));
  const [perDay, setPerDay] = useState(false);
  const [lastPreset, setLastPreset] = useState(() => draft.minutes.find((m) => m > 0) ?? 30);
  const [preview, setPreview] = useState<StudyPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef(0);

  const today = isoLocal(new Date());
  const inputs: PlanInputs = useMemo(
    () => ({
      event_id: course.event_id,
      stages: STAGE_NAMES.filter((n) => draft.dates[n]).map((n) => ({ name: n, date: draft.dates[n] })),
      day_minutes: draft.minutes,
      goal: draft.goal,
    }),
    [course.event_id, draft],
  );
  const hasFuture = inputs.stages.some((s) => s.date > today);
  const hasTime = draft.minutes.some((m) => m > 0);
  const valid = hasFuture && hasTime;
  const weekly = draft.minutes.reduce((a, b) => a + b, 0);
  const activeDays = draft.minutes.filter((m) => m > 0).length;
  const uniform = activeDays > 0 && draft.minutes.every((m) => m === 0 || m === draft.minutes.find((x) => x > 0));
  const inputsKey = JSON.stringify(inputs);

  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey(course.event_id), JSON.stringify(draft));
    } catch {
      /* storage unavailable */
    }
  }, [course.event_id, draft]);

  // Live preview, debounced so typing a date doesn't fire a request per keystroke.
  // The sequence number drops any response that lands after a newer edit.
  useEffect(() => {
    if (!valid) {
      seq.current++;
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = window.setTimeout(() => {
      previewPlan(inputs)
        .then((p) => {
          if (mine !== seq.current) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setPreview(null);
          setPreviewError(errText(e));
        })
        .finally(() => mine === seq.current && setPreviewing(false));
    }, 400);
    return () => window.clearTimeout(t);
  }, [inputsKey, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDate = (name: StageName, value: string) =>
    setDraft((d) => ({ ...d, dates: { ...d.dates, [name]: value } }));

  const applyPreset = (m: number) => {
    setLastPreset(m);
    setDraft((d) => {
      const on = d.minutes.some((x) => x > 0) ? d.minutes.map((x) => x > 0) : [false, true, true, true, true, true, false];
      return { ...d, minutes: on.map((isOn) => (isOn ? m : 0)) };
    });
  };

  const toggleDay = (i: number) =>
    setDraft((d) => ({ ...d, minutes: d.minutes.map((m, j) => (j === i ? (m > 0 ? 0 : lastPreset) : m)) }));

  const setDayMinutes = (i: number, m: number) =>
    setDraft((d) => ({ ...d, minutes: d.minutes.map((x, j) => (j === i ? m : x)) }));

  const save = async () => {
    if (!valid) return;
    if (!authed) {
      track("plan_save_gated");
      onSignup();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const p = await savePlan(inputs);
      track("plan_saved", { goal: inputs.goal, stages: inputs.stages.length, weekly, status: p.feasibility.status });
      try {
        sessionStorage.removeItem(draftKey(course.event_id));
      } catch {
        /* storage unavailable */
      }
      onSaved(p);
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const next = preview?.stages.find((s) => !s.past);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
            {initial ? "Edit your plan" : `Plan your season for ${course.event}`}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {replacing
              ? `This replaces your ${replacing} plan. Nothing you've proven is lost.`
              : "Three things and you're set. You can change any of them later, and the plan reflows around missed days on its own."}
          </p>
        </div>
      </div>

      {/* 1. Dates */}
      <fieldset className="mt-6">
        <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">When do you compete?</legend>
        <p id="plan-dates-hint" className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Add the ones you know. The plan aims to have your path proven before the first one.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {STAGE_NAMES.map((name) => {
            const id = `plan-date-${name}`;
            const value = draft.dates[name];
            const past = !!value && value <= today;
            return (
              <div key={name}>
                <label htmlFor={id} className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  {name}
                </label>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    id={id}
                    type="date"
                    value={value}
                    aria-describedby="plan-dates-hint"
                    onChange={(e) => setDate(name, e.target.value)}
                    className={INPUT}
                  />
                  {value && (
                    <button
                      type="button"
                      onClick={() => setDate(name, "")}
                      aria-label={`Clear ${name} date`}
                      className="tap inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {past && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Already happened, shown as done.</p>}
              </div>
            );
          })}
        </div>
      </fieldset>

      {/* 2. Time */}
      <fieldset className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">How much time do you have?</legend>
          <span className="text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
            <span className="font-mono text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {fmtMinutes(weekly)}
            </span>{" "}
            a week
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-slate-500 dark:text-slate-400">Per study day</span>
          {PRESETS.map((m) => {
            const on = uniform && draft.minutes.find((x) => x > 0) === m;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => applyPreset(m)}
                className={`tap rounded-lg px-3 py-1.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                  on
                    ? "bg-indigo-600 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                <span className="font-mono tabular-nums">{m}</span> min
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Study days">
          {WEEKDAY_SHORT.map((label, i) => {
            const m = draft.minutes[i];
            const on = m > 0;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                aria-label={`${WEEKDAY_LONG[i]}: ${on ? `${m} minutes` : "off"}`}
                onClick={() => toggleDay(i)}
                className={`tap flex w-12 flex-col items-center rounded-lg border py-1.5 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                  on
                    ? "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                <span className="text-xs font-semibold">{label}</span>
                <span className="font-mono text-[11px] tabular-nums">{on ? m : "off"}</span>
              </button>
            );
          })}
        </div>

        <button type="button" onClick={() => setPerDay((v) => !v)} aria-expanded={perDay} className={`${TEXT_ACTION} mt-3 text-xs`}>
          {perDay ? "Hide per-day times" : "Set a different time for each day"}
        </button>
        {perDay && (
          <div className="mt-2 flex flex-wrap gap-2">
            {WEEKDAY_SHORT.map((label, i) => (
              <label key={label} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <span className="w-8">{label}</span>
                <select
                  value={draft.minutes[i]}
                  onChange={(e) => setDayMinutes(i, Number(e.target.value))}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-mono text-xs tabular-nums text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {[...new Set([...PER_DAY_STEPS, draft.minutes[i]])]
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m}>
                        {m === 0 ? "off" : `${m} min`}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {/* 3. Goal */}
      <fieldset className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
        <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">What are you aiming for?</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["core", `Core path`, course.core_count, "every skill we grade"],
              ["all", `Everything`, course.total, "core, then the deeper terms"],
            ] as const
          ).map(([goal, label, count, hint]) => {
            const on = draft.goal === goal;
            return (
              <button
                key={goal}
                type="button"
                aria-pressed={on}
                onClick={() => setDraft((d) => ({ ...d, goal }))}
                className={`tap rounded-xl border px-4 py-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                  on
                    ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500 dark:border-indigo-500 dark:bg-indigo-950/50"
                    : "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                }`}
              >
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {label} <span className="font-mono text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">{count}</span>
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Live answer */}
      <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800" aria-live="polite">
        {!valid ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {!hasFuture ? "Add a competition date after today" : "Pick at least one study day"} and your plan appears here.
          </p>
        ) : previewError ? (
          <p className="text-sm text-red-700 dark:text-red-300">{previewError}</p>
        ) : preview ? (
          <div className={`space-y-2 transition-opacity duration-200 ${previewing ? "opacity-60" : ""}`}>
            <FeasibilityLine f={preview.feasibility} />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono tabular-nums">{preview.weeks.length}</span> weeks planned
              {next && (
                <>
                  {" · "}
                  {next.name} {daysAway(next.days_left)}
                </>
              )}
              {" · "}
              <span className="font-mono tabular-nums">{preview.feasibility.core_remaining}</span> core terms left to prove
              {preview.today.tasks.length > 0 && (
                <>
                  {" · "}today: {preview.today.tasks.map((t) => KIND_LABEL[t.kind].toLowerCase()).join(", ")}
                </>
              )}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">Working out your plan…</p>
        )}
      </div>

      {saveError && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {saveError}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className={BTN_PRIMARY} disabled={!valid || saving} onClick={save}>
          {saving ? "Saving…" : authed ? (initial ? "Save changes" : "Save my plan →") : "Create an account to save this plan"}
        </button>
        <button className={BTN_SECONDARY} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {!authed && (
          <span className="text-xs text-slate-500 dark:text-slate-400">Free. Your plan and progress follow you to any device.</span>
        )}
      </div>
    </Card>
  );
}

// --- the saved plan ---------------------------------------------------------------

function PlanPanel({
  plan,
  busy,
  onLaunch,
  onEdit,
  onDelete,
}: {
  plan: StudyPlan;
  busy: boolean;
  onLaunch: (t: PlanTask, how: "study" | "blitz" | "practice") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const weekly = plan.day_minutes.reduce((a, b) => a + b, 0);
  const activeDays = plan.day_minutes.filter((m) => m > 0).length;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Your plan</h2>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
              <span className="font-mono tabular-nums">{fmtMinutes(weekly)}</span> a week over {activeDays} day
              {activeDays === 1 ? "" : "s"} · {plan.goal === "core" ? "Core path" : "Everything"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <button className={TEXT_ACTION} onClick={onEdit} disabled={busy}>
              Edit plan
            </button>
            <button
              className={TEXT_ACTION}
              onClick={() => {
                track("plan_calendar_exported", { days: plan.calendar.length });
                downloadIcs(plan);
              }}
              disabled={!plan.calendar.length}
            >
              Add to calendar
            </button>
            <button className={TEXT_ACTION} onClick={onDelete} disabled={busy}>
              Delete
            </button>
          </div>
        </div>
        <Runway plan={plan} />
        <div className="mt-4">
          <FeasibilityLine f={plan.feasibility} />
        </div>
      </Card>

      <TodayCard plan={plan} busy={busy} onLaunch={onLaunch} onEdit={onEdit} />
      <AheadCard plan={plan} />
    </>
  );
}

const STATUS_LABEL: Record<PlanFeasibility["status"], string> = {
  on_track: "On track",
  tight: "Tight",
  behind: "Behind pace",
  done: "Core proven",
};

function FeasibilityLine({ f }: { f: PlanFeasibility }) {
  const good = f.status === "on_track" || f.status === "done";
  return (
    <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
      <span
        className={`mr-2 inline-block rounded px-1.5 py-0.5 align-[1px] ${MICROLABEL} ${
          good
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
            : "bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600"
        }`}
      >
        {STATUS_LABEL[f.status]}
      </span>
      {f.message}
    </p>
  );
}

// The season at a glance: a single track from today to the last competition, with
// each phase a solid run and each competition a tick. On a phone the positioned
// labels would collide, so the stages drop into a plain list under the bar.
function Runway({ plan }: { plan: StudyPlan }) {
  const upcoming = plan.stages.filter((s) => !s.past);
  const past = plan.stages.filter((s) => s.past);
  if (!upcoming.length) {
    return (
      <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
        No competitions left on this plan. Edit it to add your next one.
      </p>
    );
  }
  const span = Math.max(1, upcoming[upcoming.length - 1].days_left);
  const pct = (day: number) => Math.min(100, Math.max(0, (100 * day) / span));
  const runs = plan.phases.filter((r) => PHASE_STYLE[r.phase] && r.start_day < span);

  let lastPct = -100;
  let row = 0;
  const markers = upcoming.map((s) => {
    const p = pct(s.days_left);
    row = p - lastPct < 26 ? (row + 1) % 2 : 0;
    lastPct = p;
    return { ...s, p, row };
  });
  const twoRows = markers.some((m) => m.row === 1);
  const legend = [...new Set(runs.map((r) => r.phase))];

  const summary = [
    ...runs.map((r) => `${PHASE_STYLE[r.phase]!.label} until day ${Math.min(r.end_day, span)}`),
    ...upcoming.map((s) => `${s.name} ${daysAway(s.days_left)}`),
  ].join(", ");

  return (
    <div className="mt-5">
      <div role="img" aria-label={`Season runway: ${summary}.`}>
        <div className={`${MICROLABEL} mb-1.5 text-indigo-600 dark:text-indigo-400`}>Today</div>
        <div className="relative h-3 rounded-full bg-slate-100 dark:bg-slate-800">
          {runs.map((r, i) => {
            const left = pct(r.start_day);
            const right = pct(Math.min(r.end_day, span));
            return (
              <div
                key={`${r.phase}-${r.start_day}`}
                className={`absolute inset-y-0 ${PHASE_STYLE[r.phase]!.bar} ${i === 0 ? "rounded-l-full" : ""} ${
                  i === runs.length - 1 ? "rounded-r-full" : ""
                }`}
                style={{ left: `${left}%`, width: `calc(${right - left}% - ${i === runs.length - 1 ? 0 : 2}px)` }}
              />
            );
          })}
          {markers.map((m) => (
            <span
              key={m.name + m.date}
              className="absolute -bottom-1.5 -top-1.5 w-[3px] rounded-full bg-slate-900 ring-2 ring-white dark:bg-white dark:ring-slate-900"
              style={{ left: `calc(${m.p}% - 1.5px)` }}
            />
          ))}
        </div>

        <div className={`relative mt-3 hidden sm:block ${twoRows ? "h-[4.5rem]" : "h-9"}`}>
          {markers.map((m) => {
            const align = m.p >= 80 ? "right" : m.p <= 20 ? "left" : "center";
            return (
              <div
                key={m.name + m.date}
                className={`absolute whitespace-nowrap leading-tight ${align === "right" ? "text-right" : align === "center" ? "text-center" : ""}`}
                style={{
                  top: m.row ? "2.25rem" : 0,
                  ...(align === "right"
                    ? { right: `${100 - m.p}%` }
                    : { left: `${m.p}%`, transform: align === "center" ? "translateX(-50%)" : undefined }),
                }}
              >
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">{m.name}</div>
                <div className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  {m.days_left}d · {fmtDay(m.date)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ul className="mt-3 space-y-1 sm:hidden">
        {upcoming.map((s) => (
          <li key={s.name + s.date} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-900 dark:text-slate-100">{s.name}</span>
            <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
              {fmtDay(s.date)} · {s.days_left}d
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {legend.map((phase) => (
          <span key={phase} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-3 rounded-sm ${PHASE_STYLE[phase]!.bar}`} aria-hidden />
            <span className="font-medium text-slate-700 dark:text-slate-300">{PHASE_STYLE[phase]!.label}</span>
            {PHASE_STYLE[phase]!.hint}
          </span>
        ))}
        {past.length > 0 && <span>Behind you: {past.map((s) => `${s.name} (${fmtDay(s.date)})`).join(", ")}</span>}
      </div>
    </div>
  );
}

function TodayCard({
  plan,
  busy,
  onLaunch,
  onEdit,
}: {
  plan: StudyPlan;
  busy: boolean;
  onLaunch: (t: PlanTask, how: "study" | "blitz" | "practice") => void;
  onEdit: () => void;
}) {
  const day = plan.today;
  const tasks = day.tasks;
  const nextIdx = tasks.findIndex((t) => !t.done);
  const doneMin = tasks.filter((t) => t.done).reduce((a, t) => a + t.minutes, 0);
  const nextStudy = plan.days.slice(1).find((d) => d.tasks.length > 0);
  const allDone = tasks.length > 0 && nextIdx === -1;
  const pct = day.planned ? Math.round((100 * doneMin) / day.planned) : 0;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
          Today{" "}
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            {WEEKDAY_LONG[day.weekday]}, {fmtDay(day.date)}
          </span>
        </h2>
        {tasks.length > 0 && (
          <span className="font-mono text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {doneMin}
            <span className="text-slate-400 dark:text-slate-500">/{day.planned} min</span>
          </span>
        )}
      </div>

      {tasks.length > 0 && (
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Today's plan: ${pct}% done`}
        >
          <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}

      {day.phase === "competition" ? (
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
          It's {day.stage} day. The work is in. Warm up with one out-loud answer, then go walk in ready.
        </p>
      ) : day.phase === "done" ? (
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
          Every competition on this plan is behind you.{" "}
          <button className={TEXT_ACTION} onClick={onEdit}>
            Add your next one
          </button>
        </p>
      ) : tasks.length === 0 ? (
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
          Rest day. Nothing's scheduled
          {nextStudy ? `, and your next session is ${WEEKDAY_LONG[nextStudy.weekday]} (${fmtMinutes(nextStudy.planned)}).` : "."}
        </p>
      ) : allDone ? (
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
          That's today done. Tomorrow's plan builds on it{nextStudy ? `, ${fmtMinutes(nextStudy.planned)} on ${WEEKDAY_LONG[nextStudy.weekday]}` : ""}.
        </p>
      ) : null}

      {tasks.length > 0 && (
        <ol className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
          {tasks.map((t, i) => (
            <TaskRow key={t.id} task={t} isNext={i === nextIdx} busy={busy} onLaunch={onLaunch} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function StatusMark({ task, size = "md" }: { task: PlanTask; size?: "sm" | "md" }) {
  const started = task.progress_done > 0 || task.seen > 0;
  const dim = size === "sm" ? "h-4 w-4" : "h-6 w-6";
  if (task.done) {
    return (
      <span className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white`}>
        <svg viewBox="0 0 16 16" className={size === "sm" ? "h-2.5 w-2.5" : "h-3.5 w-3.5"} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">Done</span>
      </span>
    );
  }
  return (
    <span
      className={`inline-block ${dim} shrink-0 rounded-full border-2 ${
        started ? "border-indigo-500 border-r-slate-200 dark:border-r-slate-700" : "border-slate-300 dark:border-slate-600"
      }`}
    >
      <span className="sr-only">{started ? "In progress" : "Not started"}</span>
    </span>
  );
}

function TaskRow({
  task,
  isNext,
  busy,
  onLaunch,
}: {
  task: PlanTask;
  isNext: boolean;
  busy: boolean;
  onLaunch: (t: PlanTask, how: "study" | "blitz" | "practice") => void;
}) {
  const termTask = task.kind === "learn" || task.kind === "weak";
  // Once every card has been flipped, the useful next move is proving them.
  const flipped = task.seen + task.progress_done >= task.progress_total;
  const primary = (on: boolean) => (on && isNext ? BTN_PRIMARY : BTN_SECONDARY);

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 gap-3">
        <div className="pt-0.5">
          <StatusMark task={task} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className={`${MICROLABEL} ${isNext ? "text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400"}`}>
              {isNext ? `Next · ${KIND_LABEL[task.kind]}` : KIND_LABEL[task.kind]}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">{task.minutes} min</span>
          </div>
          <h3
            className={`mt-0.5 font-display text-base font-semibold [text-wrap:balance] ${
              task.done ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-slate-100"
            }`}
          >
            {task.title}
          </h3>
          <p className="mt-0.5 max-w-prose text-sm text-slate-600 dark:text-slate-300">{task.detail}</p>
          {task.progress_total > 1 && !task.done && (task.progress_done > 0 || task.seen > 0) && (
            <p className="mt-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
              {task.progress_done}/{task.progress_total} {task.kind === "review" ? "reviewed" : "proven"}
              {task.seen > 0 && ` · ${task.seen} seen`}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 pl-9 sm:pl-0">
        {termTask && (
          <>
            <button className={primary(!flipped)} disabled={busy} onClick={() => onLaunch(task, "study")}>
              Study cards
            </button>
            <button className={primary(flipped)} disabled={busy} onClick={() => onLaunch(task, "blitz")}>
              ⚡ Blitz
            </button>
          </>
        )}
        {task.kind === "review" && (
          <button className={primary(true)} disabled={busy} onClick={() => onLaunch(task, "blitz")}>
            ⚡ Blitz {task.term_ids.length}
          </button>
        )}
        {(task.kind === "roleplay" || task.kind === "mock") && (
          <button className={primary(true)} disabled={busy} onClick={() => onLaunch(task, "practice")}>
            {task.kind === "mock" ? "Start mock run →" : "Start role-play →"}
          </button>
        )}
      </div>
    </li>
  );
}

// The next seven days as a strip (not a card grid: one column per day, divided by
// hairlines), then the whole road to competition as a quiet table.
function AheadCard({ plan }: { plan: StudyPlan }) {
  const week = plan.days.slice(0, 7);
  const peak = Math.max(30, ...week.map((d) => d.planned));
  const recent = plan.history.slice(-7);
  const recentDone = recent.reduce((a, h) => a + h.done, 0);
  const recentPlanned = recent.reduce((a, h) => a + h.planned, 0);
  const upcoming = plan.stages.filter((s) => !s.past);
  const last = upcoming[upcoming.length - 1];

  if (!week.length) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Next 7 days</h2>
        {recentPlanned > 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Last {recent.length} plan day{recent.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
              {recentDone} of {recentPlanned}
            </span>{" "}
            tasks done
          </span>
        )}
      </div>

      <div className="-mx-1 mt-4 overflow-x-auto px-1 pb-1">
        <ol className="grid min-w-[30rem] grid-cols-7 divide-x divide-slate-100 dark:divide-slate-800">
          {week.map((d, i) => {
            const isToday = i === 0;
            const h = d.planned ? Math.max(8, Math.round((100 * d.planned) / peak)) : 0;
            const label =
              d.phase === "competition"
                ? `${WEEKDAY_LONG[d.weekday]} ${fmtDay(d.date)}: ${d.stage}`
                : `${WEEKDAY_LONG[d.weekday]} ${fmtDay(d.date)}: ${d.planned ? `${d.planned} minutes, ${d.tasks.length} tasks` : "rest"}`;
            return (
              <li key={d.date} aria-label={label} className="flex flex-col items-center px-1 text-center">
                <span
                  className={`${MICROLABEL} ${isToday ? "text-indigo-600 dark:text-indigo-400" : "text-slate-500 dark:text-slate-400"}`}
                >
                  {isToday ? "Today" : WEEKDAY_SHORT[d.weekday]}
                </span>
                <span
                  className={`mt-0.5 font-display text-lg font-semibold tabular-nums ${
                    isToday ? "text-indigo-700 dark:text-indigo-300" : "text-slate-900 dark:text-slate-100"
                  }`}
                >
                  {parseDay(d.date).getDate()}
                </span>
                <div className="mt-2 flex h-14 w-full items-end justify-center" aria-hidden>
                  {d.phase === "competition" ? (
                    <span className="rounded-md bg-slate-900 px-1.5 py-1 text-[11px] font-semibold text-white dark:bg-white dark:text-slate-900">
                      {d.stage}
                    </span>
                  ) : h ? (
                    <div
                      className={`w-3 rounded-t ${
                        isToday
                          ? "bg-indigo-500"
                          : d.phase === "taper"
                            ? "bg-slate-300 dark:bg-slate-600"
                            : "bg-indigo-200 dark:bg-indigo-900"
                      }`}
                      style={{ height: `${h}%` }}
                    />
                  ) : (
                    <span className="pb-1 text-[11px] text-slate-500 dark:text-slate-400">rest</span>
                  )}
                </div>
                <span className="mt-1.5 font-mono text-[11px] tabular-nums text-slate-600 dark:text-slate-300">
                  {d.planned ? `${d.planned}m` : "\u00a0"}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {plan.weeks.length > 1 && (
        <details className="group mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-semibold text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-slate-100 [&::-webkit-details-marker]:hidden">
            <span>
              Week by week{last ? ` to ${last.name}` : ""}{" "}
              <span className="font-mono text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
                {plan.weeks.length} weeks
              </span>
            </span>
            <svg viewBox="0 0 16 16" className="h-4 w-4 text-slate-500 transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className={`${MICROLABEL} text-slate-500 dark:text-slate-400`}>
                  <th className="py-2 pr-3 font-semibold">Week of</th>
                  <th className="py-2 pr-3 font-semibold">Phase</th>
                  <th className="py-2 pr-3 text-right font-semibold">New terms</th>
                  <th className="py-2 pr-3 text-right font-semibold">Role-plays</th>
                  <th className="py-2 text-right font-semibold">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {plan.weeks.map((w) => {
                  const style = PHASE_STYLE[w.phase];
                  return (
                    <tr key={w.start}>
                      <td className="py-2 pr-3 text-slate-700 dark:text-slate-200">
                        {fmtDay(w.start)}
                        {w.stages.length > 0 && (
                          <span className="ml-2 font-semibold text-slate-900 dark:text-slate-100">{w.stages.join(", ")}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1.5">
                          {style && <span className={`h-2 w-2 rounded-sm ${style.bar}`} aria-hidden />}
                          {style?.label ?? "Competition"}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {w.new_terms || "–"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {w.roleplays || "–"}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {w.minutes ? fmtMinutes(w.minutes) : "–"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}

// --- Home ---------------------------------------------------------------------------

export function PlanTodayCard({ plan, onOpen }: { plan: StudyPlan; onOpen: () => void }) {
  const day = plan.today;
  const next = plan.stages.find((s) => !s.past);
  const shown = day.tasks.slice(0, 3);
  const more = day.tasks.length - shown.length;
  const done = day.tasks.filter((t) => t.done).length;
  const f = plan.feasibility;

  return (
    <Card>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Today's study plan</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            {day.phase === "competition"
              ? `${day.stage} is today. Go walk in ready.`
              : day.tasks.length
                ? (
                    <>
                      <span className="font-mono tabular-nums">{day.planned} min</span> · {done} of {day.tasks.length} done
                    </>
                  )
                : "Rest day"}
            {next && day.phase !== "competition" && <> · {next.name} {daysAway(next.days_left)}</>}
          </p>
        </div>
        <button className={`${BTN_SECONDARY} shrink-0`} onClick={onOpen}>
          Open my plan →
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="mt-3 space-y-2">
          {shown.map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 text-sm">
              <StatusMark task={t} size="sm" />
              <span className={`min-w-0 flex-1 truncate ${t.done ? "text-slate-500 dark:text-slate-400" : "text-slate-800 dark:text-slate-100"}`}>
                <span className="text-slate-500 dark:text-slate-400">{KIND_LABEL[t.kind]}:</span> {t.title}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">{t.minutes}m</span>
            </li>
          ))}
          {more > 0 && <li className="pl-6 text-xs text-slate-500 dark:text-slate-400">+{more} more</li>}
        </ul>
      )}
      {(f.status === "behind" || f.status === "tight") && (
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <FeasibilityLine f={f} />
        </div>
      )}
    </Card>
  );
}

export function PlanNudge({ eventName, onOpen }: { eventName: string; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Studying for <span className="font-semibold text-slate-900 dark:text-slate-100">{eventName}</span>? Add your
        competition dates and get a day-by-day plan.
      </p>
      <button className={`${TEXT_ACTION} text-indigo-700 dark:text-indigo-300`} onClick={onOpen}>
        Build my plan →
      </button>
    </div>
  );
}

// --- calendar export ----------------------------------------------------------------

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

// RFC 5545 caps content lines at 75 octets; continuation lines start with a space.
function icsFold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(plan: StudyPlan, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const compact = (iso: string) => iso.replace(/-/g, "");
  const nextDay = (iso: string) => {
    const d = parseDay(iso);
    d.setDate(d.getDate() + 1);
    return compact(isoLocal(d));
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PI Coach//Study plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`PI Coach: ${plan.event}`)}`,
  ];
  for (const c of plan.calendar) {
    const summary = c.kind === "competition" ? `${c.summary} (${plan.event})` : `PI Coach: ${fmtMinutes(c.minutes)} of study`;
    const description =
      c.kind === "competition"
        ? "Walk in ready."
        : `${c.summary}.\n\nYour plan adapts as you study, so open PI Coach for today's exact tasks.`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${compact(c.date)}-${c.kind}-${plan.event_id}@pi-coach`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(c.date)}`,
      `DTEND;VALUE=DATE:${nextDay(c.date)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function downloadIcs(plan: StudyPlan) {
  const blob = new Blob([buildIcs(plan)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pi-coach-plan-${plan.event_id}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
