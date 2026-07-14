// Small, dependency-free SVG charts for the home dashboard. Each is SINGLE-SERIES
// (one entity), so color is simple: one hue, ink-token text, recessive hairline
// grid, no legend (the card title names it). Theme-aware via Tailwind fill/stroke
// utilities with dark: variants, so they follow the app's light/dark toggle.
//
// Palette (from the dataviz skill, mapped to the app's brand):
//   series "indigo"  → progress/score/volume/skills
//   series "emerald" → delivery (fewer fillers = good, reads positive)
//   ink   slate-500/400 · grid slate-200/800 · surface ring white/slate-900

import type { ReactNode } from "react";

type Series = "indigo" | "emerald";

const MARK: Record<Series, string> = {
  indigo: "fill-indigo-500 dark:fill-indigo-400",
  emerald: "fill-emerald-500 dark:fill-emerald-400",
};
const STROKE: Record<Series, string> = {
  indigo: "stroke-indigo-500 dark:stroke-indigo-400",
  emerald: "stroke-emerald-500 dark:stroke-emerald-400",
};

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

// --- Skill radar (criterion mastery "at a glance") --------------------------

export function SkillRadar({ data, max = 3 }: { data: { label: string; value: number }[]; max?: number }) {
  const n = data.length;
  const cx = 190;
  const cy = 150;
  const r = 92;
  const labelR = r + 12;
  const angleAt = (i: number) => (360 / n) * i;

  const ringLevels = Array.from({ length: max }, (_, i) => i + 1);
  const dataPts = data.map((d, i) => polar(cx, cy, (Math.max(0, Math.min(max, d.value)) / max) * r, angleAt(i)));
  const dataPoly = dataPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <svg viewBox="0 0 380 300" className="h-auto w-full" role="img" aria-label="Skill mastery radar">
      {/* rings */}
      {ringLevels.map((lvl) => {
        const pts = data.map((_, i) => polar(cx, cy, (lvl / max) * r, angleAt(i)));
        return (
          <polygon
            key={lvl}
            points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
            className="fill-none stroke-slate-200 dark:stroke-slate-700"
            strokeWidth={1}
          />
        );
      })}
      {/* spokes + labels */}
      {data.map((d, i) => {
        const end = polar(cx, cy, r, angleAt(i));
        const lab = polar(cx, cy, labelR, angleAt(i));
        const anchor = lab.x > cx + 6 ? "start" : lab.x < cx - 6 ? "end" : "middle";
        const name = d.label.length > 14 ? d.label.slice(0, 13) + "…" : d.label;
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={end.x} y2={end.y} className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
            <text
              x={lab.x}
              y={lab.y}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="fill-slate-500 dark:fill-slate-400"
              style={{ fontSize: 8 }}
            >
              {name}
            </text>
          </g>
        );
      })}
      {/* data polygon */}
      <polygon points={dataPoly} className={`${MARK.indigo} ${STROKE.indigo}`} fillOpacity={0.18} strokeWidth={2} strokeLinejoin="round" />
      {dataPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} className={`${MARK.indigo} stroke-white dark:stroke-slate-900`} strokeWidth={1.5}>
          <title>{`${data[i].label}: ${data[i].value.toFixed(1)} / ${max}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// --- Trend line (score / delivery over sessions) ----------------------------

export function TrendLine({
  points,
  color = "indigo",
  yMin,
  yMax,
  valueSuffix = "",
}: {
  points: { label: string; value: number }[];
  color?: Series;
  yMin?: number;
  yMax?: number;
  valueSuffix?: string;
}) {
  const W = 320;
  const H = 150;
  const padL = 30;
  const padR = 16;
  const padT = 12;
  const padB = 22;
  const vals = points.map((p) => p.value);
  const lo = yMin ?? Math.min(...vals);
  const hi = yMax ?? Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => padL + (points.length === 1 ? (W - padL - padR) / 2 : ((W - padL - padR) * i) / (points.length - 1));
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / span);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ticks = [lo, lo + span / 2, hi];
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Trend over sessions">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
          <text x={padL - 5} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(t)}
          </text>
        </g>
      ))}
      <polyline points={line} fill="none" className={STROKE[color]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r={i === points.length - 1 ? 4 : 2.5} className={`${MARK[color]} stroke-white dark:stroke-slate-900`} strokeWidth={1.5}>
          <title>{`${p.label}: ${p.value}${valueSuffix}`}</title>
        </circle>
      ))}
      {/* end value label */}
      <text x={x(points.length - 1)} y={y(last.value) - 8} textAnchor="end" className="fill-slate-600 dark:fill-slate-300" style={{ fontSize: 10, fontWeight: 600 }}>
        {last.value}
        {valueSuffix}
      </text>
      {/* first + last x labels */}
      <text x={padL} y={H - 6} textAnchor="start" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9 }}>{points[0].label}</text>
      {points.length > 1 && (
        <text x={W - padR} y={H - 6} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9 }}>{last.label}</text>
      )}
    </svg>
  );
}

// --- Volume bars (sessions per week) ----------------------------------------

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export function VolumeBars({ bars }: { bars: { label: string; value: number }[] }) {
  const W = 320;
  const H = 150;
  const padL = 22;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const maxV = Math.max(1, ...bars.map((b) => b.value));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / bars.length;
  const bw = Math.min(24, slot - 6);
  const baseline = padT + plotH;
  const yTicks = maxV <= 4 ? Array.from({ length: maxV + 1 }, (_, i) => i) : [0, Math.round(maxV / 2), maxV];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Sessions per week">
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={baseline - (t / maxV) * plotH} x2={W - padR} y2={baseline - (t / maxV) * plotH} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
          <text x={padL - 5} y={baseline - (t / maxV) * plotH} textAnchor="end" dominantBaseline="middle" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9, fontVariantNumeric: "tabular-nums" }}>{t}</text>
        </g>
      ))}
      {bars.map((b, i) => {
        const h = (b.value / maxV) * plotH;
        const bx = padL + i * slot + (slot - bw) / 2;
        const by = baseline - h;
        return (
          <g key={i}>
            {b.value > 0 && <path d={roundedTopRect(bx, by, bw, h, 4)} className={MARK.indigo}><title>{`${b.label}: ${b.value} session${b.value === 1 ? "" : "s"}`}</title></path>}
            {bars.length <= 10 && (
              <text x={bx + bw / 2} y={H - 6} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 8 }}>{b.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// A small titled wrapper so every chart card reads consistently.
export function ChartFrame({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}
