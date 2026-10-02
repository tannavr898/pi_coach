// Small shared UI primitives for the account/onboarding modules (onboarding,
// auth, home, flashcards). These mirror the look of the equivalents defined
// locally in App.tsx; they live here so the new modules can share them without
// importing from App.tsx (which would create a circular dependency). App.tsx
// keeps its own copies, this file is only for the new surfaces.

import type { ReactNode } from "react";

export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40";

export const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_1px_2px_rgba(15,23,42,0.04)] transition-shadow duration-200 hover:shadow-[0_6px_24px_rgba(15,23,42,0.08)] dark:bg-slate-900 dark:shadow-none dark:hover:shadow-none ${className || "border-slate-200 dark:border-slate-800"}`}
    >
      {children}
    </div>
  );
}

// The bullseye wordmark. Concentric target = "hit the mark", practice until you
// nail it. Lives here rather than in App.tsx because the share card renders it too,
// and the card must not import from App.tsx (see the note at the top of this file).
//
// Export-safe on purpose: literal hex fills (no `currentColor`, no CSS variables)
// and explicit width/height alongside the viewBox. Those are exactly the properties
// html-to-image needs to serialize an inline SVG into the exported PNG.
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="#c7d2fe" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="#818cf8" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3.5" fill="#4f46e5" />
    </svg>
  );
}

// The PI Coach loading animation: the brand mark as a rippling target. Five
// concentric layers (two real rings, two "gap" rings in the surface color, and a
// glowing indigo dot) share one wave keyframe (index.css `pic-wave`), staggered
// center to edge so the pulse travels outward. The gap rings are the surface's
// own background, which is what makes the rings read as rings, so pass `gap` when
// it sits on something other than a card. Layers are centered with `inset-0 m-auto`
// rather than transforms so the animation is free to drive `transform`.
//
// This is THE loader: every wait in the app uses it, at whatever size fits.
export function LogoLoader({
  size = 140,
  gap = "bg-white dark:bg-slate-900",
  label = "Loading",
}: {
  size?: number;
  gap?: string;
  label?: string;
}) {
  const r = (n: number) => Math.round((n / 140) * size);
  return (
    <div role="status" aria-label={label} className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: size, height: size, background: "#c7d2fe", animationDelay: "0.6s" }} />
      <span className={`pic-wave absolute inset-0 m-auto rounded-full ${gap}`} style={{ width: r(116), height: r(116), animationDelay: "0.4s" }} />
      <span className="pic-wave absolute inset-0 m-auto rounded-full" style={{ width: r(92), height: r(92), background: "#818cf8", animationDelay: "0.2s" }} />
      <span className={`pic-wave absolute inset-0 m-auto rounded-full ${gap}`} style={{ width: r(72), height: r(72), animationDelay: "0.07s" }} />
      <span className="pic-wave-dot absolute inset-0 m-auto rounded-full" style={{ width: r(34), height: r(34), background: "#4f46e5" }} />
    </div>
  );
}

// A whole page (or panel) waiting on its first data: the loader, centered, with a
// short line under it. Only ever shown on a first visit; return visits render
// from the cache (cache.ts).
export function PageLoader({ label = "Loading", card = true }: { label?: string; card?: boolean }) {
  const body = (
    <div className="flex flex-col items-center gap-4 py-14">
      <LogoLoader size={72} label={label} gap={card ? undefined : "bg-[#f6f7fb] dark:bg-[#0a0f1f]"} />
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-indigo-500">{label}</p>
    </div>
  );
  return card ? <Card>{body}</Card> : body;
}

// Inline, for a small region (a list inside a card) that is still loading.
export function InlineLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <LogoLoader size={28} label={label} />
      <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-indigo-500">{children}</p>
  );
}
