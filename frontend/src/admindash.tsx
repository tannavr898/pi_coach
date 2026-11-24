// The owner dashboard (/admin): who is using the app, how much, and when it spiked.
// Two surfaces live here, both owner-only and both free (no LLM tokens):
//
//  1. <Overview>   every counter as a daily time graph, with spikes marked.
//  2. <DemoControls> + buildDemo()   a customizable copy of the canned demo, so the
//     owner can make screenshots and screen recordings with their own business
//     name, score and copy. The screens themselves render in App.tsx (they are not
//     exported), this file owns the data and the controls.
//
// Numbers come from GET /api/admin/overview (backend/app/admin_metrics.py).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminOverview, type AdminOverview, type AdminSeries } from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL } from "./ui";
import { DEMO_DELIVERY, DEMO_FOLLOWUP, DEMO_RESPONSE, DEMO_SCENARIO, DEMO_SCORE } from "./demoData";
import type { DeliveryMetrics, ScenarioResponse, ScoreResponse } from "./api";

// --- small helpers ------------------------------------------------------------

const RANGES = [7, 30, 90, 180, 365] as const;

function day(iso: string, withYear = false): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

function num(n: number | null | undefined): string {
  if (n == null) return "none";
  return Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

// The nicest axis ceiling at or above `max`: 1, 2, 5 times a power of ten.
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * pow >= max) return m * pow;
  return max;
}

function delta(s: AdminSeries): { text: string; tone: "up" | "down" | "flat" | "new" } {
  const { total, prev_total: prev } = s;
  if (total == null || prev == null) return { text: "no earlier data", tone: "flat" };
  if (s.kind === "avg") {
    const d = Math.round((total - prev) * 10) / 10;
    return { text: `${d > 0 ? "+" : ""}${d} pts`, tone: d > 0 ? "up" : d < 0 ? "down" : "flat" };
  }
  if (prev === 0) return total === 0 ? { text: "no change", tone: "flat" } : { text: "new this period", tone: "new" };
  const pct = Math.round(((total - prev) / prev) * 100);
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, tone: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

const TONE: Record<string, string> = {
  up: "text-emerald-700 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  flat: "text-slate-500 dark:text-slate-400",
  new: "text-indigo-600 dark:text-indigo-300",
};
const ARROW: Record<string, string> = { up: "▲", down: "▼", flat: "", new: "●" };

// --- the time graph -----------------------------------------------------------
// Bars for counts (a spike reads as a tall bar), a line for averages and running
// totals. The drawing is one stretched SVG; markers and the readout are HTML on
// top of it, so nothing distorts when the card changes width.

const W = 600;
const H = 150;

export function TimeChart({ axis, values, kind = "bars", spikes = [], height = 150, label, zoom = false }: {
  axis: string[];
  values: (number | null)[];
  kind?: "bars" | "line";
  spikes?: number[];
  height?: number;
  label: string;
  // Start the axis at the lowest value instead of zero, for a running total that only climbs.
  zoom?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const nums = values.filter((v): v is number => v != null);
  const lo = zoom && nums.length ? Math.min(...nums) : 0;
  const hi = Math.max(0, ...nums);
  const top = zoom ? Math.max(hi, lo + 1) : niceMax(hi);
  const n = values.length;
  const x = (i: number) => (kind === "bars" ? ((i + 0.5) / n) * W : n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - ((v - lo) / (top - lo || 1)) * (H - 4) - 2;
  const spikeSet = useMemo(() => new Set(spikes), [spikes]);

  const line = useMemo(() => {
    if (kind !== "line") return { path: "", area: "" };
    let path = "";
    let area = "";
    let open = false;
    let startX = 0;
    let lastX = 0;
    values.forEach((v, i) => {
      if (v == null) {
        if (open) { area += ` L${lastX},${H} L${startX},${H} Z`; open = false; }
        return;
      }
      path += `${open ? "L" : "M"}${x(i)},${y(v)} `;
      if (!open) { area += `M${x(i)},${H} L${x(i)},${y(v)} `; startX = x(i); open = true; } else area += `L${x(i)},${y(v)} `;
      lastX = x(i);
    });
    if (open) area += ` L${lastX},${H} L${startX},${H} Z`;
    return { path, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, kind, top]);

  function onMove(e: React.PointerEvent) {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const f = Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.floor(f * n));
  }

  const barW = (W / n) * 0.72;
  const hv = hover != null ? values[hover] : null;
  const leftPct = hover != null ? (x(hover) / W) * 100 : 0;

  return (
    <div>
      <div
        ref={box}
        className="relative touch-pan-y select-none"
        style={{ height }}
        role="img"
        aria-label={label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <span className="pointer-events-none absolute left-0 top-0 z-10 font-mono text-[10px] text-slate-400 dark:text-slate-500">{num(top)}</span>
        {zoom && <span className="pointer-events-none absolute bottom-0 left-0 z-10 font-mono text-[10px] text-slate-400 dark:text-slate-500">{num(lo)}</span>}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={y(lo + (top - lo) * f)} y2={y(lo + (top - lo) * f)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {kind === "bars"
            ? values.map((v, i) =>
                v ? (
                  <rect
                    key={i}
                    x={x(i) - barW / 2}
                    y={y(v)}
                    width={barW}
                    height={H - y(v)}
                    rx={1}
                    className={spikeSet.has(i) ? "fill-amber-500" : hover === i ? "fill-indigo-400 dark:fill-indigo-300" : "fill-indigo-500 dark:fill-indigo-400"}
                  />
                ) : null,
              )
            : (
              <>
                <path d={line.area} className="fill-indigo-500/10" />
                <path d={line.path} fill="none" className="stroke-indigo-500 dark:stroke-indigo-400" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </>
            )}
        </svg>
        {kind === "line" && hover != null && hv != null && (
          <span className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-600 dark:border-slate-900" style={{ left: `${leftPct}%`, top: `${(y(hv) / H) * 100}%` }} />
        )}
        {hover != null && (
          <div
            className="pointer-events-none absolute top-0 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900"
            style={{ left: `clamp(48px, ${leftPct}%, calc(100% - 48px))` }}
          >
            <span className="font-semibold text-slate-900 dark:text-slate-100">{hv == null ? "no data" : num(hv)}</span>
            <span className="ml-1.5 text-slate-500 dark:text-slate-400">{day(axis[hover])}</span>
            {spikeSet.has(hover) && <span className="ml-1.5 font-semibold text-amber-600 dark:text-amber-400">spike</span>}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-400 dark:text-slate-500">
        <span>{day(axis[0])}</span>
        <span>{day(axis[Math.floor(axis.length / 2)])}</span>
        <span>{day(axis[axis.length - 1])}</span>
      </div>
    </div>
  );
}

function ChartCard({ s, axis, hint }: { s: AdminSeries; axis: string[]; hint?: string }) {
  const d = delta(s);
  const quiet = s.values.every((v) => !v);
  const summary = `${s.label}: ${s.kind === "avg" ? "average" : "total"} ${num(s.total)} over ${axis.length} days${s.peak ? `, busiest ${day(s.peak.day)} with ${num(s.peak.n)}` : ""}.`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">{s.label}</h3>
        <span className={`font-mono text-[11px] ${TONE[d.tone]}`}>{ARROW[d.tone]} {d.text}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-2xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-100">{num(s.total)}</span>
        {s.kind === "avg" && <span className="text-xs text-slate-500 dark:text-slate-400">average</span>}
        {s.peak && (
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
            peak {num(s.peak.n)} on {day(s.peak.day)}
          </span>
        )}
      </div>
      <div className="mt-3">
        {quiet ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500" style={{ height: 110 }}>
            Nothing in this range
          </div>
        ) : (
          <TimeChart axis={axis} values={s.values} kind={s.kind === "avg" ? "line" : "bars"} spikes={s.spikes} height={110} label={summary} />
        )}
      </div>
      {hint && <p className="mt-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500">{hint}</p>}
    </section>
  );
}

function Stat({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 font-display text-3xl font-semibold tracking-[-0.03em] text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
    </>
  );
  const cls = "rounded-xl border border-slate-200 bg-white p-4 text-left dark:border-slate-800 dark:bg-slate-900";
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition hover:border-indigo-300 dark:hover:border-indigo-700`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// --- the overview tab ---------------------------------------------------------

const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Practice", keys: ["roleplays", "scenarios", "blitzes", "quizzes", "questions", "cards"] },
  { title: "People", keys: ["signups", "active_users", "diagnostics"] },
  { title: "Chapters and quality", keys: ["chapters", "chapter_joins", "avg_score"] },
];

const HINTS: Record<string, string> = {
  active_users: "Signed-in people with a saved role-play or study activity that day. Signed-out practice is not attributed to anyone.",
  roleplays: "Every graded rep, signed out included.",
  questions: "Reported by the browser, so a softer number than the server-counted ones.",
  cards: "Reported by the browser, so a softer number than the server-counted ones.",
  avg_score: "Mean content score of saved role-plays that day.",
};

export function Overview({ pass, onGoChapters }: { pass: string; onGoChapters: () => void }) {
  const [days, setDays] = useState<number>(() => {
    try { const v = Number(localStorage.getItem("pic-admin-days")); return RANGES.includes(v as never) ? v : 30; } catch { return 30; }
  });
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (fresh: boolean) => {
      setLoading(true);
      setError(null);
      adminOverview(pass, days, fresh)
        .then(setData)
        .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the dashboard."))
        .finally(() => setLoading(false));
    },
    [pass, days],
  );

  useEffect(() => { load(false); }, [load]);

  function pick(n: number) {
    setDays(n);
    try { localStorage.setItem("pic-admin-days", String(n)); } catch { /* ignore */ }
  }

  const t = data?.totals;
  const spikeDays = useMemo(() => {
    if (!data) return [] as { key: string; label: string; day: string; n: number }[];
    const out: { key: string; label: string; day: string; n: number }[] = [];
    for (const [key, s] of Object.entries(data.series)) {
      for (const i of s.spikes) out.push({ key, label: s.label, day: data.axis[i], n: s.values[i] ?? 0 });
    }
    return out.sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 8);
  }, [data]);
  const maxEvent = Math.max(1, ...(data?.top_events.map((e) => e.n) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => pick(r)}
              aria-pressed={days === r}
              className={`rounded-md px-3 py-1 text-sm font-medium transition ${days === r ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}
            >
              {r === 365 ? "1y" : `${r}d`}
            </button>
          ))}
        </div>
        <button className={BTN_SMALL} onClick={() => load(true)} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        {data && <span className="text-xs text-slate-400 dark:text-slate-500">Updated {new Date(data.generated_at).toLocaleTimeString()}. Days are UTC.</span>}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">{error}</p>}
      {data?.notes.map((n) => <p key={n} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{n}</p>)}
      {!data && !error && <p className="text-sm text-slate-500 dark:text-slate-400">Loading the numbers…</p>}

      {data && t && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Accounts" value={num(t.users)} sub={`${num(data.series.signups.total)} new in ${days}d`} />
            <Stat label="Active, 7 days" value={num(t.wau)} sub={t.users ? `${Math.round((t.wau / t.users) * 100)}% of accounts` : undefined} />
            <Stat label="Active, 30 days" value={num(t.mau)} sub={`${num(t.ever_active)} have ever practiced`} />
            <Stat label={`Role-plays, ${days}d`} value={num(data.series.roleplays.total)} sub={`${num(data.series.scenarios.total)} scenarios written`} />
            <Stat
              label="Chapters to review"
              value={num(t.pending_chapters)}
              sub={t.pending_chapters ? "Open the Chapters tab" : "All caught up"}
              onClick={t.pending_chapters ? onGoChapters : undefined}
            />
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">Total accounts over time</h3>
              <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{num(data.cumulative_users[data.cumulative_users.length - 1])} now</span>
            </div>
            <div className="mt-3">
              <TimeChart axis={data.axis} values={data.cumulative_users} kind="line" zoom height={150} label={`Total accounts, ${num(data.cumulative_users[0])} at the start of the range to ${num(data.cumulative_users[data.cumulative_users.length - 1])} now.`} />
            </div>
          </section>

          {spikeDays.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
              <h3 className="text-sm font-medium text-amber-900 dark:text-amber-200">Spikes in this range</h3>
              <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">Days at least two standard deviations above that stat's own normal. Marked amber on the graphs below.</p>
              <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm text-amber-900 sm:grid-cols-2 dark:text-amber-100">
                {spikeDays.map((s) => (
                  <li key={`${s.key}-${s.day}`} className="flex justify-between gap-3">
                    <span>{s.label}</span>
                    <span className="font-mono text-xs">{num(s.n)} on {day(s.day)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {GROUPS.map((g) => (
            <div key={g.title}>
              <h2 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-500">{g.title}</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {g.keys.map((k) => data.series[k] && <ChartCard key={k} s={data.series[k]} axis={data.axis} hint={HINTS[k]} />)}
              </div>
            </div>
          ))}

          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">What people practice</h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Saved role-plays by event, last {days} days.</p>
              {data.top_events.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">No saved role-plays in this range.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {data.top_events.map((e) => (
                    <li key={e.event}>
                      <div className="flex justify-between text-sm"><span className="text-slate-700 dark:text-slate-200">{e.event}</span><span className="font-mono text-xs text-slate-500 dark:text-slate-400">{e.n}</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${(e.n / maxEvent) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">Health</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500 dark:text-slate-400">Scenario cache hit rate</dt>
                  <dd className="font-mono text-slate-800 dark:text-slate-100">
                    {data.cache && data.cache.enabled && Number(data.cache.lookups) > 0 ? `${data.cache.hit_rate_percent}% of ${data.cache.lookups}` : "no lookups since restart"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500 dark:text-slate-400">Daily history starts</dt>
                  <dd className="font-mono text-slate-800 dark:text-slate-100">{t.counter_since ? day(t.counter_since, true) : "not recording yet"}</dd>
                </div>
              </dl>
              {!t.counter_since && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  The daily counter table isn't there yet. Run the updated schema.sql in Supabase to start it. Until then, role-plays, scenarios, Blitz and quizzes are rebuilt from saved rows (signed-in only), and questions and flashcards stay at zero.
                </p>
              )}
              {t.counter_since && (
                <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">Days before this are rebuilt from saved rows, so anonymous practice, questions and flashcards read low or zero then.</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// --- demo studio --------------------------------------------------------------

export type DemoScreen = "feedback" | "beforeafter" | "scenario" | "onboarding" | "flashcards";
export type DemoFrame = "full" | "tablet" | "phone";

export type DemoConfig = {
  screen: DemoScreen;
  frame: DemoFrame;
  business: string;
  owner: string;
  event: string;
  topic: string;
  // The four graded sections, as percents. The overall score is derived from them.
  indicators: number;
  solution: number;
  competencies: number;
  presentation: number;
  response: string;
  followup: string;
  strength: string;
  weakness: string;
  fix: string;
  wpm: number;
  fillers: number;
};

const ORIGINAL = { business: "FreshBlend", owner: "Dana Okafor" };

export const DEFAULT_DEMO: DemoConfig = {
  screen: "feedback",
  frame: "full",
  business: ORIGINAL.business,
  owner: ORIGINAL.owner,
  event: DEMO_SCENARIO.event,
  topic: DEMO_SCENARIO.topic,
  indicators: Math.round(DEMO_SCORE.pi_section_percent),
  solution: Math.round(DEMO_SCORE.analytical?.section_percent ?? 99),
  competencies: Math.round(DEMO_SCORE.career_competencies?.section_percent ?? 81),
  presentation: Math.round(DEMO_SCORE.presentation?.section_percent ?? 84),
  response: DEMO_RESPONSE,
  followup: DEMO_FOLLOWUP,
  strength: DEMO_SCORE.final?.top_strength ?? "",
  weakness: DEMO_SCORE.final?.biggest_weakness ?? "",
  fix: DEMO_SCORE.final?.one_key_fix ?? "",
  wpm: DEMO_DELIVERY.pace_wpm,
  fillers: DEMO_DELIVERY.filler_count,
};

// Rename the demo business and owner wherever they appear, in strings at any depth.
function rename<T>(value: T, pairs: [RegExp, string][]): T {
  if (typeof value === "string") return pairs.reduce((acc: string, [re, to]) => acc.replace(re, to), value) as T;
  if (Array.isArray(value)) return value.map((v) => rename(v, pairs)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v, pairs)])) as T;
  }
  return value;
}

function levelFor(percent: number): ScoreResponse["overall_level"] {
  return percent >= 90 ? "exemplary" : percent >= 70 ? "proficient" : percent >= 40 ? "developing" : "novice";
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

// The final grade, weighted the way the real rubric does: 50 / 25 / 10 / 15.
export function overallPercent(cfg: Pick<DemoConfig, "indicators" | "solution" | "competencies" | "presentation">): number {
  return Math.round((0.5 * clamp(cfg.indicators) + 0.25 * clamp(cfg.solution) + 0.1 * clamp(cfg.competencies) + 0.15 * clamp(cfg.presentation)) * 10) / 10;
}

// Spread `total` points over the criteria, each capped at its max, so the
// per-indicator rows add up to the Indicators percent shown in the header.
function spreadPoints(total: number, count: number, max: number): number[] {
  const out = Array<number>(count).fill(Math.floor(total / count));
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0 && i < count; i++, rest--) out[i] += 1;
  return out.map((v) => Math.min(max, v));
}

export function buildDemo(cfg: DemoConfig): {
  scenario: ScenarioResponse; score: ScoreResponse; response: string; followup: string; delivery: DeliveryMetrics;
} {
  const business = cfg.business.trim() || ORIGINAL.business;
  const owner = cfg.owner.trim() || ORIGINAL.owner;
  const pairs: [RegExp, string][] = [
    [/FreshBlend/g, business],
    [/Dana Okafor/g, owner],
    [/\bDana\b/g, owner.split(/\s+/)[0]],
  ];
  const ind = clamp(cfg.indicators);
  const sol = clamp(cfg.solution);
  const comp = clamp(cfg.competencies);
  const pres = clamp(cfg.presentation);
  const overall = overallPercent(cfg);
  const fpm = Math.round((cfg.fillers / Math.max(1, DEMO_DELIVERY.duration_seconds / 60)) * 10) / 10;

  const scenario = rename({ ...DEMO_SCENARIO, event: cfg.event.trim() || DEMO_SCENARIO.event, topic: cfg.topic.trim() || DEMO_SCENARIO.topic }, pairs);

  // Indicators: points per criterion follow the percent, and each level follows its points.
  const rows = DEMO_SCORE.scores;
  const maxEach = rows[0]?.max_points ?? 10;
  const totalMax = rows.reduce((a, r) => a + r.max_points, 0);
  const totalPts = Math.round((ind / 100) * totalMax);
  const pts = spreadPoints(totalPts, rows.length, maxEach);
  const scores = rows.map((r, i) => ({ ...r, points: pts[i], level: levelFor((pts[i] / r.max_points) * 100) }));

  const base = DEMO_SCORE;
  const score = rename(
    {
      ...base,
      overall_percent: overall,
      overall_level: levelFor(overall),
      total_points: pts.reduce((a, b) => a + b, 0),
      max_points: totalMax,
      pi_section_percent: ind,
      pi_section_score: Math.round(ind * 0.04 * 100) / 100,
      scores,
      analytical: base.analytical ? { ...base.analytical, section_percent: sol, section_score: Math.round(sol * 0.04 * 100) / 100 } : base.analytical,
      career_competencies: base.career_competencies
        ? { ...base.career_competencies, section_percent: comp, section_score: Math.round(comp * 0.04 * 100) / 100 }
        : base.career_competencies,
      presentation: base.presentation
        ? { ...base.presentation, section_percent: pres, section_score: Math.round(pres * 0.04 * 100) / 100 }
        : base.presentation,
      final: {
        ...(base.final as NonNullable<ScoreResponse["final"]>),
        percent: overall,
        top_strength: cfg.strength,
        biggest_weakness: cfg.weakness,
        one_key_fix: cfg.fix,
      },
    },
    pairs,
  );
  const delivery: DeliveryMetrics = { ...DEMO_DELIVERY, pace_wpm: cfg.wpm, filler_count: cfg.fillers, filler_per_min: fpm, delivery_score: pres };
  return { scenario, score, response: rename(cfg.response, pairs), followup: rename(cfg.followup, pairs), delivery };
}

const PRESET_KEY = "pic-admin-demo-presets";
const CURRENT_KEY = "pic-admin-demo-current";

export function loadDemoConfig(): DemoConfig {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (raw) return { ...DEFAULT_DEMO, ...(JSON.parse(raw) as Partial<DemoConfig>) };
  } catch { /* ignore */ }
  return DEFAULT_DEMO;
}

export function saveDemoConfig(cfg: DemoConfig): void {
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

function loadPresets(): Record<string, DemoConfig> {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}") as Record<string, DemoConfig>; } catch { return {}; }
}

export const FRAME_WIDTH: Record<DemoFrame, string | undefined> = { full: undefined, tablet: "768px", phone: "390px" };

const SCREENS: { key: DemoScreen; label: string; note: string }[] = [
  { key: "feedback", label: "Feedback", note: "The graded result: score, criteria, transcript, delivery." },
  { key: "beforeafter", label: "Before and after", note: "The retry view that shows improvement against the first attempt." },
  { key: "scenario", label: "Scenario", note: "The brief a student reads before presenting." },
  { key: "onboarding", label: "Onboarding", note: "The first-rep setup screen." },
  { key: "flashcards", label: "Flashcards", note: "Opens the flashcard deck over this page." },
];

const FIELD = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
const LABEL = "block text-xs font-medium text-slate-600 dark:text-slate-300";

function Field({ label, value, onChange, area = false, hint }: { label: string; value: string; onChange: (v: string) => void; area?: boolean; hint?: string }) {
  return (
    <label className={LABEL}>
      {label}
      {area ? (
        <textarea className={`${FIELD} min-h-[88px] resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={FIELD} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && <span className="mt-1 block text-[11px] font-normal text-slate-400 dark:text-slate-500">{hint}</span>}
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-md px-3 py-1 text-sm font-medium transition ${value === o.key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DemoControls({ cfg, onChange, onPresent }: { cfg: DemoConfig; onChange: (c: DemoConfig) => void; onPresent: () => void }) {
  const [presets, setPresets] = useState<Record<string, DemoConfig>>(loadPresets);
  const [name, setName] = useState("");
  const set = <K extends keyof DemoConfig>(k: K, v: DemoConfig[K]) => onChange({ ...cfg, [k]: v });
  const edited = JSON.stringify({ ...cfg, screen: 0, frame: 0 }) !== JSON.stringify({ ...DEFAULT_DEMO, screen: 0, frame: 0 });

  function savePreset() {
    const n = name.trim();
    if (!n) return;
    const next = { ...presets, [n]: cfg };
    setPresets(next);
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setName("");
  }
  function dropPreset(n: string) {
    const { [n]: _gone, ...rest } = presets;
    void _gone;
    setPresets(rest);
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(rest)); } catch { /* ignore */ }
  }

  return (
    <aside className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
      <div>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Demo studio</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Real screens, canned data, your wording. Nothing here calls the API or saves to any account. Changes stay in this browser.</p>
      </div>

      <div>
        <div className={LABEL}>Screen</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {SCREENS.map((s) => (
            <button
              key={s.key}
              onClick={() => set("screen", s.key)}
              aria-pressed={cfg.screen === s.key}
              className={`rounded-lg border px-2.5 py-1 text-[13px] font-medium transition ${cfg.screen === s.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">{SCREENS.find((s) => s.key === cfg.screen)?.note}</p>
      </div>

      <div>
        <div className={LABEL}>Frame</div>
        <div className="mt-1">
          <Seg label="Frame" value={cfg.frame} onChange={(v) => set("frame", v)} options={[{ key: "full", label: "Desktop" }, { key: "tablet", label: "Tablet" }, { key: "phone", label: "Phone" }]} />
        </div>
      </div>

      <div className="space-y-3">
        <Field label="Business name" value={cfg.business} onChange={(v) => set("business", v)} hint="Replaces the demo business everywhere, including the transcript." />
        <Field label="Judge or owner" value={cfg.owner} onChange={(v) => set("owner", v)} />
        <Field label="Event" value={cfg.event} onChange={(v) => set("event", v)} />
        <Field label="Scenario title" value={cfg.topic} onChange={(v) => set("topic", v)} />
      </div>

      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
          <div className="text-xs text-slate-500 dark:text-slate-400">Overall score, from the four below</div>
          <div className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">{Math.round(overallPercent(cfg))}%</div>
        </div>
        {([
          ["indicators", "Indicators (50%)"],
          ["solution", "Solution (25%)"],
          ["competencies", "Competencies (10%)"],
          ["presentation", "Presentation (15%)"],
        ] as const).map(([k, label]) => (
          <label key={k} className={LABEL}>
            {label}: <span className="font-mono text-slate-900 dark:text-slate-100">{cfg[k]}%</span>
            <input type="range" min={0} max={100} value={cfg[k]} onChange={(e) => set(k, Number(e.target.value))} className="mt-1 w-full accent-indigo-600" />
          </label>
        ))}
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Pace (WPM)<input type="number" min={60} max={220} className={FIELD} value={cfg.wpm} onChange={(e) => set("wpm", Number(e.target.value) || 0)} /></label>
          <label className={LABEL}>Filler words<input type="number" min={0} max={80} className={FIELD} value={cfg.fillers} onChange={(e) => set("fillers", Math.max(0, Number(e.target.value) || 0))} /></label>
        </div>
      </div>

      <div className="space-y-3">
        <Field label="Top strength" value={cfg.strength} onChange={(v) => set("strength", v)} area />
        <Field label="Biggest weakness" value={cfg.weakness} onChange={(v) => set("weakness", v)} area />
        <Field label="One key fix" value={cfg.fix} onChange={(v) => set("fix", v)} area />
        <Field label="Presentation" value={cfg.response} onChange={(v) => set("response", v)} area hint="Quoted evidence in the criteria is matched against this text. If you rewrite it, highlights for lines you removed simply won't show." />
        <Field label="Follow-up answer" value={cfg.followup} onChange={(v) => set("followup", v)} area />
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex gap-2">
          <button className={`${BTN_PRIMARY} flex-1`} onClick={onPresent}>Demo mode (hide everything)</button>
          <button className={BTN_SECONDARY} onClick={() => onChange({ ...DEFAULT_DEMO, screen: cfg.screen, frame: cfg.frame })} disabled={!edited}>Reset</button>
        </div>
        <div className="flex gap-2">
          <input className={`${FIELD} mt-0`} placeholder="Name this version" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") savePreset(); }} aria-label="Preset name" />
          <button className={BTN_SECONDARY} onClick={savePreset} disabled={!name.trim()}>Save</button>
        </div>
        {Object.keys(presets).length > 0 && (
          <ul className="space-y-1">
            {Object.keys(presets).map((n) => (
              <li key={n} className="flex items-center justify-between gap-2 text-sm">
                <button className="truncate text-left font-medium text-indigo-600 hover:underline dark:text-indigo-300" onClick={() => onChange({ ...DEFAULT_DEMO, ...presets[n] })}>{n}</button>
                <button className="text-xs text-slate-400 hover:text-red-600 dark:text-slate-500" onClick={() => dropPreset(n)} aria-label={`Delete ${n}`}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
