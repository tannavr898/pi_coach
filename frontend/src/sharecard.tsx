// The Gauntlet card — a shareable 4:5 results image whose only job is to DARE the
// viewer into attempting the same role-play.
//
// Deliberately NOT a stat breakdown. It carries the scenario hook, the score to
// beat, one optional taunt, and the brand. The section-by-section numbers live in
// the feedback view; putting them here would turn a dare into a scouting report.
//
// Two things about the styling look wrong and are not:
//
//  1. No Tailwind utility classes on the card itself. Tailwind v4 emits oklch()
//     colors and the app palette is theme-conditional; html-to-image serializes
//     computed styles, so both are export hazards. Every value here is a literal
//     hex/px in an inline style object, and the card is always dark regardless of
//     the app theme — what you see is what lands in the PNG.
//  2. Every font-family carries a concrete system fallback. The webfonts come from
//     Google Fonts over the network; if that fetch is blocked the card degrades to
//     a legible system stack instead of Times New Roman.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getFontEmbedCSS, toBlob } from "html-to-image";
import type { ScenarioResponse, ScoreResponse } from "./api";
import { track } from "./analytics";
import { BrandMark } from "./ui";

// Logical card size. 4:5 portrait — screenshots and shares clean into IG / TikTok /
// Discord. Exported at pixelRatio 2 → 1080x1350, which is IG's native asset size.
const CARD_W = 540;
const CARD_H = 675;
const EXPORT_SCALE = 2;

const SITE_URL = "https://trypicoach.com";

/**
 * The link that closes the loop: it drops the viewer into the SAME scenario
 * rather than a random one, so the score on the card is actually something to
 * beat. Falls back to the bare site when the scenario has no pool id (nothing
 * to deep-link to — e.g. the onboarding and demo fixtures).
 */
function challengeUrl(scenario: ScenarioResponse): string {
  return scenario.scenario_id ? `${SITE_URL}/?s=${encodeURIComponent(scenario.scenario_id)}` : SITE_URL;
}

const SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DISPLAY = '"Space Grotesk", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

// --- copy derivation --------------------------------------------------------

/** The hero line. Falls back through topic to a generic dare — never blank. */
export function cardHook(scenario: ScenarioResponse): string {
  const hook = (scenario.hook || "").trim();
  if (hook) return hook;
  const topic = (scenario.topic || "").trim();
  if (topic) return topic.charAt(0).toUpperCase() + topic.slice(1);
  return "A real business role-play, scored in minutes.";
}

/**
 * One taunt line drawn from the run's weakest indicator, or null.
 *
 * Uses only the criterion's public NAME — never `feedback`, `gaps`, or
 * `final.biggest_weakness`. Those are written at the student about their own run;
 * putting them on a card they hand to other people would broadcast their personal
 * critique. The name alone reads as a dare about the scenario.
 *
 * Returns null when every indicator landed proficient or above — there is no honest
 * taunt to make, and the layout closes the gap rather than reserving an empty row.
 */
export function cardTaunt(score: ScoreResponse): string | null {
  const weak = score.scores.filter((c) => c.level === "novice" || c.level === "developing");
  if (weak.length === 0) return null;
  const worst = [...weak].sort(
    (a, b) => a.points / (a.max_points || 1) - b.points / (b.max_points || 1),
  )[0];
  if (!worst?.name) return null;
  return `Most people fumble ${worst.name.toLowerCase()}.`;
}

/** Coarse score bucket for analytics — never the raw score, never the hook text. */
function scoreBucket(pct: number): string {
  const lo = Math.max(0, Math.min(90, Math.floor(pct / 10) * 10));
  return `${lo}-${lo + 9}`;
}

// --- the card ---------------------------------------------------------------

const cardStyle: CSSProperties = {
  width: CARD_W,
  height: CARD_H,
  display: "flex",
  flexDirection: "column",
  padding: "44px 40px",
  boxSizing: "border-box",
  // Navy base with an indigo→violet wash pulled toward the lower-right, so the
  // score numeral sits in the brightest part of the field.
  backgroundColor: "#0a0f1f",
  backgroundImage:
    "radial-gradient(120% 90% at 12% 0%, rgba(99,102,241,0.34) 0%, rgba(99,102,241,0) 58%), " +
    "radial-gradient(110% 80% at 100% 100%, rgba(124,58,237,0.40) 0%, rgba(124,58,237,0) 62%)",
  color: "#e2e8f0",
  fontFamily: SANS,
  position: "relative",
  overflow: "hidden",
};

export function GauntletCard({
  scenario,
  score,
  innerRef,
}: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  const hook = cardHook(scenario);
  const taunt = cardTaunt(score);
  const pct = Math.round(score.overall_percent);
  // Long hooks step down a size so the hero never overruns its band. The backend
  // caps hooks at 200 chars, so this only has to cover the middle of the range.
  const heroSize = hook.length > 108 ? 30 : hook.length > 74 ? 34 : 39;

  return (
    <div ref={innerRef} style={cardStyle}>
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <BrandMark size={26} />
        <span
          style={{
            fontFamily: DISPLAY,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "#ffffff",
          }}
        >
          PI Coach
        </span>
      </div>

      {/* Hero: the dare */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", paddingTop: 30 }}>
        <p
          style={{
            fontFamily: DISPLAY,
            fontSize: heroSize,
            lineHeight: 1.18,
            fontWeight: 600,
            letterSpacing: "-0.021em",
            color: "#ffffff",
            margin: 0,
          }}
        >
          {hook}
        </p>
      </div>

      {/* Score to beat */}
      <div style={{ borderTop: "1px solid rgba(226,232,240,0.16)", paddingTop: 22 }}>
        <p
          style={{
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.19em",
            textTransform: "uppercase",
            color: "#a5b4fc",
            margin: 0,
          }}
        >
          Score to beat
        </p>
        <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 4 }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 78,
              fontWeight: 700,
              lineHeight: 1,
              color: "#ffffff",
              letterSpacing: "-0.035em",
            }}
          >
            {pct}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 500, color: "#818cf8" }}>%</span>
        </div>

        {taunt && (
          <p style={{ fontSize: 16, lineHeight: 1.45, color: "#c7d2fe", margin: "14px 0 0" }}>
            {taunt}
          </p>
        )}
      </div>

      {/* Call to action + footer */}
      <div
        style={{
          marginTop: 24,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <span
          style={{
            fontFamily: DISPLAY,
            fontSize: 21,
            fontWeight: 600,
            color: "#ffffff",
            letterSpacing: "-0.01em",
          }}
        >
          Beat my score →
        </span>
        <div style={{ textAlign: "right" }}>
          <p style={{ fontFamily: MONO, fontSize: 13, color: "#a5b4fc", margin: 0 }}>
            trypicoach.com
          </p>
          {/* Descriptive of this run only. Deliberately no tier word and no claim
              about competition placement. */}
          <p style={{ fontSize: 10.5, color: "#64748b", margin: "3px 0 0" }}>
            Practice score · not an official result
          </p>
        </div>
      </div>
    </div>
  );
}

// --- export + share ---------------------------------------------------------

/**
 * Render the card node to a PNG blob.
 *
 * The two documented failure points, both handled here:
 *  - Fonts: wait for document.fonts.ready, then resolve the @font-face CSS ONCE via
 *    getFontEmbedCSS and hand it to toBlob. Letting toBlob resolve fonts itself
 *    refetches them on every call.
 *  - First-render blanks: html-to-image famously drops styles/images on its first
 *    pass because the cloned resources aren't warm yet. We render twice and keep
 *    the second.
 */
// Resolved once per page load. getFontEmbedCSS walks the document's stylesheets,
// and html-to-image's own injected <style> elements accumulate in that sweep — so
// calling it per export returns a progressively larger blob (measured: 1.5MB on the
// first call, 7.7MB by the fifth in one page). Memoizing keeps every export the
// same size and skips a ~1.5MB refetch each time the card is opened.
let fontEmbedCSSPromise: Promise<string> | null = null;

function resolveFontEmbedCSS(node: HTMLElement): Promise<string> {
  fontEmbedCSSPromise ??= getFontEmbedCSS(node).catch(() => "");
  return fontEmbedCSSPromise;
}

async function renderCardBlob(node: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  // Empty string on failure (offline, CORS): the card's system fallbacks still
  // render legibly, so carry on rather than failing the whole export.
  const fontEmbedCSS = await resolveFontEmbedCSS(node);
  const opts = {
    pixelRatio: EXPORT_SCALE,
    width: CARD_W,
    height: CARD_H,
    cacheBust: true,
    backgroundColor: "#0a0f1f",
    fontEmbedCSS,
  };
  await toBlob(node, opts); // warm-up pass; result intentionally discarded
  const blob = await toBlob(node, opts);
  if (!blob) throw new Error("Card export produced no image.");
  return blob;
}

function filenameFor(scenario: ScenarioResponse): string {
  const slug = (scenario.topic || "challenge")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `pi-coach-${slug || "challenge"}.png`;
}

/**
 * How much to shrink the card for on-screen display so it fits the viewport
 * alongside the share button, capped at 1 so it never scales up past its native
 * size. Reserves vertical room for the button row and the modal's padding.
 */
function displayScale(): number {
  if (typeof window === "undefined") return 1;
  const byWidth = (window.innerWidth - 32) / CARD_W;
  const byHeight = (window.innerHeight - 150) / CARD_H;
  return Math.max(0.3, Math.min(1, byWidth, byHeight));
}

export function GauntletCardModal({
  scenario,
  score,
  onClose,
}: {
  scenario: ScenarioResponse;
  score: ScoreResponse;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [done, setDone] = useState<null | "shared" | "downloaded">(null);
  const [scale, setScale] = useState(() => displayScale());

  // Coarse metadata only. NEVER the hook, the situation, or any criterion text —
  // see the privacy note at the top of analytics.ts. `has_hook` is what tells us
  // whether the hook is doing work, without shipping scenario content to PostHog.
  const baseProps = {
    event: scenario.event || "",
    level: scenario.level,
    mode: scenario.mode,
    score_bucket: scoreBucket(score.overall_percent),
    has_hook: Boolean((scenario.hook || "").trim()),
    has_taunt: cardTaunt(score) !== null,
  };

  // Generate the PNG as soon as the card mounts. This has to happen BEFORE the
  // click: navigator.share() must be called inside the user gesture, and awaiting
  // a render first burns the transient activation on iOS Safari.
  useEffect(() => {
    let cancelled = false;
    const node = cardRef.current;
    if (!node) return;
    (async () => {
      try {
        const b = await renderCardBlob(node);
        if (cancelled) return;
        setBlob(b);
        track("challenge_card_generated", baseProps);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: the card contents can't change while the modal is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => setScale(displayScale());
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const link = challengeUrl(scenario);

  const share = useCallback(async () => {
    if (!blob) return;
    const file = new File([blob], filenameFor(scenario), { type: "image/png" });
    const text = `I scored ${Math.round(score.overall_percent)}% on this role-play. Beat it.`;

    // canShare({ files }) rather than a bare `navigator.share` check: desktop
    // Chrome exposes share() but rejects file payloads.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, url: link });
        track("challenge_card_shared", { ...baseProps, method: "web_share" });
        setDone("shared");
        return;
      } catch (err) {
        // The user dismissing the OS share sheet is not a failure — don't fall
        // through to a surprise download for it.
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
    track("challenge_card_shared", { ...baseProps, method: "download" });
    setDone("downloaded");
  }, [blob, scenario, score, baseProps, link]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Challenge a friend"
      onClick={onClose}
    >
      <div className="my-auto flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
        {/* The capture target. It has to exist at its true 540x675 for the export,
            so it's scaled for display by a measured factor and its wrapper is given
            the resulting size. A transform doesn't affect layout flow, and guessing
            the giveback with negative margins breaks between breakpoints.
            html-to-image serializes the node at its own dimensions, so the display
            scale never reaches the PNG. */}
        <div style={{ width: CARD_W * scale, height: CARD_H * scale }}>
          <div
            style={{
              width: CARD_W,
              height: CARD_H,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
            className="overflow-hidden rounded-2xl shadow-2xl"
          >
            <GauntletCard scenario={scenario} score={score} innerRef={cardRef} />
          </div>
        </div>

        {/* Matched to the card's displayed width. A fixed max-width here overflows
            the viewport on small screens, where the card is scaled well below it. */}
        <div style={{ width: CARD_W * scale }} className="flex flex-col items-center gap-3">
          <button
            onClick={share}
            disabled={busy || error || !blob}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Building your card…" : error ? "Couldn't build the card" : "Share the challenge"}
          </button>
          {done === "shared" && (
            <p className="text-xs text-slate-300" role="status">
              Shared.
            </p>
          )}
          {done === "downloaded" && (
            // A PNG can't carry a link. The Web Share path passes the challenge URL
            // along with the image; on the download path the user has to paste it
            // themselves, so surface it here rather than losing the loop entirely.
            <div className="w-full text-center" role="status">
              <p className="text-xs text-slate-300">
                Saved. Post this link with it so they get the same scenario:
              </p>
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Challenge link"
                className="mt-1.5 w-full rounded-lg border border-white/15 bg-white/10 px-2 py-1.5 text-center font-mono text-[11px] text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
              />
            </div>
          )}
          {error && (
            <p className="text-xs text-slate-300" role="status">
              Something went wrong rendering the image. You can still screenshot the card.
            </p>
          )}
          <button
            onClick={onClose}
            className="text-xs font-medium text-slate-300 underline underline-offset-4 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
