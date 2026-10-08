// Small shared UI primitives for the account/onboarding modules (onboarding,
// auth, home, flashcards). These mirror the look of the equivalents defined
// locally in App.tsx; they live here so the new modules can share them without
// importing from App.tsx (which would create a circular dependency). App.tsx
// keeps its own copies, this file is only for the new surfaces.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0";

export const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

// The small button that sits in a table row or a page header.
export const BTN_SMALL =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[13px] font-medium text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

// Freeze the page behind a full-screen overlay. Unlocked, a wheel or swipe that
// runs past the end of the overlay's own content chains into the page underneath
// and drags all of it along behind the scrim. The padding stands in for the
// scrollbar so nothing shifts sideways when it disappears.
export function useScrollLock() {
  useEffect(() => {
    const { style } = document.body;
    const prev = { overflow: style.overflow, paddingRight: style.paddingRight };
    const gap = window.innerWidth - document.documentElement.clientWidth;
    style.overflow = "hidden";
    if (gap > 0) style.paddingRight = `${gap}px`;
    return () => {
      style.overflow = prev.overflow;
      style.paddingRight = prev.paddingRight;
    };
  }, []);
}

// A section of a page. It used to be a rounded, shadowed box, and a page was a
// stack of them; now it is a stretch of the content sheet under a hairline, so
// the page reads as one surface. A caller that passes its own border or fill
// colour is asking for a callout (a warning, a bonus), and that keeps a frame.
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  const callout = /(^|\s)(dark:)?(border|bg)-[a-z]/.test(className);
  return (
    <div className={callout ? `rounded-xl border p-5 ${className}` : `border-t border-slate-200 pt-6 dark:border-slate-800 ${className}`}>
      {children}
    </div>
  );
}

// --- the app shell -----------------------------------------------------------
// One frame for every page: the canvas with its glow, the dock, then either a
// sidebar beside the content sheet or the sheet alone. index.css holds the parts
// of this that are not Tailwind utilities (`.pic-app`, `.pic-main` and friends).

// The canvas. Also owns the cursor light, which follows a real mouse (never a
// touch) and is moved with one transform per frame.
export function AppFrame({ children }: { children: ReactNode }) {
  const ptr = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ptr.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let x = 0, y = 0, queued = false;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      x = e.clientX; y = e.clientY;
      el.style.opacity = "1";
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; el.style.transform = `translate3d(${x}px, ${y}px, 0)`; });
    };
    const leave = () => { el.style.opacity = "0"; };
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <div className="pic-app">
      <div ref={ptr} className="pic-ptr" aria-hidden />
      {children}
    </div>
  );
}

// The page body: the content sheet, and to its left (from `lg` up; stacked above
// it below that) whatever the page puts in a <Sidebar>. The app owns the one
// Shell and each page decides whether it has a sidebar, which is why the sidebar
// arrives through a portal instead of a prop: the lists in it are driven by
// state that lives deep inside the page. With no sidebar the sheet is a centred
// column, `width` wide.
const SHELL_WIDTH = { narrow: "max-w-3xl", wide: "max-w-6xl", full: "max-w-[88rem]" };
const SideSlot = createContext<{ el: HTMLElement | null; claim: (on: boolean, below: boolean) => void } | null>(null);

export function Shell({ width = "wide", children }: { width?: keyof typeof SHELL_WIDTH; children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState({ n: 0, below: false });
  const slot = useMemo(
    () => ({ el, claim: (on: boolean, below: boolean) => setClaims((c) => ({ n: c.n + (on ? 1 : -1), below: on ? below : c.below })) }),
    [el],
  );
  const side = claims.n > 0;
  // The sheet's fading hairlines only make sense where its edge is not also the
  // edge of the screen: both sides of a centred column, the sidebar side of a
  // full-width one.
  const edges = side ? "lg:border-l" : width === "full" ? "" : "sm:border-x";
  return (
    <SideSlot.Provider value={slot}>
      <div className={`relative mx-auto mt-6 grid w-full flex-1 ${side ? `${SHELL_WIDTH.full} lg:grid-cols-[244px_minmax(0,1fr)]` : SHELL_WIDTH[width]}`}>
        <aside
          ref={setEl}
          className={side ? `flex min-w-0 flex-col gap-5 px-3 pb-5 pt-1 lg:sticky lg:top-[76px] lg:order-none lg:max-h-[calc(100dvh-76px)] lg:self-start lg:overflow-y-auto lg:pb-8 lg:pt-4 ${claims.below ? "order-last pt-6" : ""}` : "hidden"}
        />
        <main className={`pic-main min-w-0 pb-20 ${edges}`}>{children}</main>
      </div>
    </SideSlot.Provider>
  );
}

// Whether there is a Shell above to hold a sidebar. A screen that is also shown
// outside the app frame (the feedback screen, inside the product tour) uses this
// to fall back to an inline layout.
export function useInShell(): boolean {
  return useContext(SideSlot) !== null;
}

// Render this anywhere inside a page to give that page a sidebar. On a phone the
// sidebar stacks above the content, which suits navigation; `below` puts it
// after the content instead, which suits history.
export function Sidebar({ below = false, children }: { below?: boolean; children: ReactNode }) {
  const slot = useContext(SideSlot);
  useLayoutEffect(() => {
    slot?.claim(true, below);
    return () => slot?.claim(false, below);
  }, [slot, below]);
  return slot?.el ? createPortal(children, slot.el) : null;
}

export function SideGroup({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {title && <h2 className="mb-1.5 px-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400">{title}</h2>}
      {children}
    </div>
  );
}

// One row of a sidebar list: a label, an optional second line, and something
// small on the right (a count, a level dot, a mastery meter).
export function SideItem({ active = false, onClick, sub, right, children }: {
  active?: boolean;
  onClick?: () => void;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`tap grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
        active
          ? "pic-on font-medium text-indigo-700 dark:text-indigo-300"
          : "text-slate-600 hover:bg-slate-200/50 dark:text-slate-300 dark:hover:bg-slate-800/60"
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate">{children}</span>
        {sub && <span className="block truncate text-xs font-normal text-slate-500 dark:text-slate-400">{sub}</span>}
      </span>
      {right}
    </button>
  );
}

// The top of a page: a quiet line of context, the title, and the page's actions.
export function PageHead({ sub, title, children, blurb }: { sub?: ReactNode; title: ReactNode; children?: ReactNode; blurb?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pb-6 pt-6">
      <div className="min-w-0">
        {sub && <p className="text-sm text-slate-500 dark:text-slate-400">{sub}</p>}
        <h1 className="pic-title font-display text-2xl font-semibold leading-tight tracking-[-0.03em]">{title}</h1>
        {blurb && <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-slate-600 dark:text-slate-300">{blurb}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

// A whole number that counts up when it arrives. Anything else (a level name, a
// ratio) is shown as it is.
export function CountUp({ value }: { value: number | string }) {
  const end = typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null;
  const [shown, setShown] = useState<number | null>(end === null ? null : 0);
  useEffect(() => {
    if (end === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(end); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      setShown(Math.round(end * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [end]);
  return <>{end === null ? value : shown}</>;
}

// The row of figures under a page title. A cell with a `tone` (one of the
// scoring colours) gets that colour's dot and a faint wash of it.
export type StripCell = { label: ReactNode; value: number | string; tone?: string };
export function Strip({ cells }: { cells: StripCell[] }) {
  return (
    <div
      className="pic-bleed grid grid-cols-2 border-y border-slate-200 sm:grid-cols-[repeat(var(--n),minmax(0,1fr))] dark:border-slate-800"
      style={{ "--n": cells.length } as CSSProperties}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          className={`flex min-w-0 flex-col gap-0.5 border-slate-200 px-4 py-3.5 dark:border-slate-800 ${i % 2 ? "border-l" : "sm:border-l"} ${i > 1 ? "border-t sm:border-t-0" : ""} ${i === 0 ? "sm:border-l-0 sm:pl-7" : ""} ${c.tone ? "pic-tone" : ""}`}
          style={c.tone ? ({ "--c": c.tone } as CSSProperties) : undefined}
        >
          <span className="flex items-center gap-1.5 text-[13px] text-slate-500 dark:text-slate-400">
            {c.tone && <LevelDot color={c.tone} />}
            {c.label}
          </span>
          <span className="truncate text-xl font-semibold tracking-[-0.03em] tabular-nums text-slate-900 dark:text-slate-100">
            <CountUp value={c.value} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function LevelDot({ color }: { color: string }) {
  return <i aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} />;
}

// A thin stacked bar: how a set of terms splits across the scoring levels.
export function Meter({ parts, total }: { parts: { color: string; n: number }[]; total: number }) {
  return (
    <span aria-hidden className="flex h-1 w-10 shrink-0 gap-px overflow-hidden rounded-full bg-slate-300/70 dark:bg-slate-700">
      {total > 0 && parts.map((p, i) => (p.n > 0 ? <i key={i} className="pic-grow block h-full" style={{ width: `${(p.n / total) * 100}%`, background: p.color }} /> : null))}
    </span>
  );
}

// A filter chip: a small toggle in a row above a table.
export function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] transition ${
        on
          ? "border-indigo-200 bg-indigo-50 font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

// The scoring ramp, as literal colours for dots, washes and meters.
export const LEVEL_COLOR = { novice: "#ef4444", developing: "#f59e0b", proficient: "#0ea5e9", exemplary: "#10b981" } as const;
// A term nobody has graded yet: a neutral that reads on both themes.
export const UNGRADED_COLOR = "#94a3b8";

// The pill behind the active dock item. Give it the dock element and a key that
// changes when the active item does; it measures `[aria-current="page"]` inside
// the dock and slides there.
export function DockPill({ dock, activeKey }: { dock: RefObject<HTMLElement | null>; activeKey: string }) {
  const pill = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = pill.current;
      const on = dock.current?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!el) return;
      if (!on || !on.offsetWidth) { el.style.opacity = "0"; return; }
      el.style.opacity = "1";
      el.style.width = `${on.offsetWidth}px`;
      el.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    place();
    const live = requestAnimationFrame(() => pill.current?.classList.add("live"));
    // The dock is sized to its contents, so anything that changes an item (a
    // badge arriving, the web font swapping in) moves the active one.
    const watch = new ResizeObserver(place);
    if (dock.current) watch.observe(dock.current);
    return () => { cancelAnimationFrame(live); watch.disconnect(); };
  }, [dock, activeKey]);
  return <span ref={pill} aria-hidden className="pic-pill pointer-events-none absolute left-0 top-[5px] h-[calc(100%-10px)] w-0 rounded-[9px] opacity-0" />;
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
      <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
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
    <p className="text-[13px] font-medium text-slate-500 dark:text-slate-400">{children}</p>
  );
}
