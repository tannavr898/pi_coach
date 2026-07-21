// Video practice (beta) — opt-in camera capture, client-side frame sampling, and
// the observable-only results panel.
//
// WHAT THIS DOES NOT DO, AND WHY
// No video file is ever created. We do not record video, we do not upload video,
// and there is nothing on disk to leak: the camera stream feeds a hidden <video>
// element purely as a preview surface, and every few seconds we copy one frame
// out of it onto a canvas. When the session ends the stream's tracks are stopped
// and the frames are dropped. Users here are minors — the safest way to not
// retain a recording is to never make one.
//
// The audio pipeline is completely untouched. Video runs alongside the existing
// MediaRecorder audio capture; transcription, delivery metrics, and content
// scoring all behave exactly as they do without it. Audio-only stays a
// first-class path, never a degraded one.
//
// THE SAMPLING MATH (this is the cost control)
// Vision is the expensive part of a session, and image tokens scale with pixel
// area (~w*h/750), so two things bound the bill:
//
//   1. DOWNSCALE. Frames go out at ~512px on the long edge as JPEG q0.6 — about
//      260 image tokens each, versus ~1,600 for a full-resolution frame. Face
//      presence, gaze direction, and a smile are coarse features; paying for
//      more fidelity would buy nothing.
//
//   2. HARD CAP of 60 frames, whatever the session length. At the default 8s
//      interval, 60 frames covers 8 minutes. Past that we DECIMATE rather than
//      stop: drop every other frame already held and double the interval. That
//      halves density each time while keeping coverage spread across the entire
//      session, so a 20-minute rep costs exactly what an 8-minute one does and
//      still reports on how the student finished — which is usually the part
//      that changed.
//
// Decimating (rather than truncating at 60) is the difference between "we
// stopped watching after eight minutes" and "we watched the whole thing, less
// often". Same price, honest denominator.

import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoFrame, VideoMetrics } from "./api";

export const CAN_CAPTURE_VIDEO =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof document !== "undefined";

// Must not exceed the server's MAX_FRAMES (backend/app/video.py), which is the
// real backstop — this is the client doing its share so we don't upload frames
// the server would only discard.
const MAX_FRAMES = 60;
const BASE_INTERVAL_MS = 8000;
const TARGET_LONG_EDGE = 512;
const JPEG_QUALITY = 0.6;

type SamplerState = "idle" | "starting" | "running" | "stopped" | "error";

export type FrameSampler = {
  state: SamplerState;
  error: string | null;
  frameCount: number;
  /**
   * Callback ref for a preview CONTAINER (any element). The sampler owns the
   * <video> itself and moves it into whichever container is currently mounted.
   * See `ensureEl` for why the element can't be a React-rendered one.
   */
  attachPreview: (node: HTMLElement | null) => void;
  start: () => Promise<boolean>;
  /** Stops the camera and returns the frames sampled during the session. */
  stop: () => VideoFrame[];
  /** Stops the camera and discards everything (used when the user cancels). */
  cancel: () => void;
};

/** Strip the `data:image/jpeg;base64,` prefix — the API wants raw base64. */
function stripDataUri(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export function useFrameSampler(): FrameSampler {
  const [state, setState] = useState<SamplerState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<string[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const intervalRef = useRef<number>(BASE_INTERVAL_MS);

  /**
   * The <video> is created imperatively and owned by the sampler for the whole
   * session, rather than rendered by React. Two bugs made that necessary:
   *
   *   1. MOUNT ORDER. `start()` runs while the CONSENT card is on screen. A
   *      React-rendered preview only mounts once state is "running" — i.e.
   *      after start() has already finished — so the ref was still null at the
   *      moment we needed to assign `srcObject`. The stream attached to
   *      nothing: no preview, and `capture()` bailed on its null guard every
   *      tick, silently, for the entire rep.
   *
   *   2. SCREEN CHANGES. Respond and Follow-up each render their own preview.
   *      With React owning the element, advancing to the follow-up would swap
   *      in a fresh <video> with no srcObject and kill capture mid-session.
   *
   * One long-lived element sidesteps both: it parks in a hidden host and gets
   * moved into whichever preview container is mounted right now.
   */
  const elRef = useRef<HTMLVideoElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const ensureEl = useCallback((): HTMLVideoElement => {
    if (elRef.current) return elRef.current;
    // Off-screen rather than display:none — a hidden video is throttled or
    // paused by some browsers, and a paused element yields blank frames.
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden";
    host.setAttribute("aria-hidden", "true");
    const el = document.createElement("video");
    el.muted = true;         // required for autoplay without a gesture
    el.playsInline = true;   // iOS: don't hijack into the fullscreen player
    el.autoplay = true;
    el.style.cssText = "width:100%;height:auto;display:block;border-radius:0.5rem;background:#0f172a";
    host.appendChild(el);
    document.body.appendChild(host);
    hostRef.current = host;
    elRef.current = el;
    videoRef.current = el;
    return el;
  }, []);

  /** Move the live element into a mounted preview container, or back to the host. */
  const attachPreview = useCallback((node: HTMLElement | null) => {
    const el = elRef.current;
    if (!el) return;
    if (node) {
      node.appendChild(el);
      // Reparenting pauses playback in Safari; a paused element captures a
      // frozen frame, so resume rather than trusting it survived the move.
      void el.play().catch(() => {});
      return;
    }
    // Detach. Don't reclaim the element immediately: moving between screens
    // detaches the old preview and attaches the new one in the same commit, and
    // reclaiming eagerly would yank the stream out of the container that just
    // took it. Settle on a microtask and only rescue the element if it was
    // genuinely orphaned — a detached parent no longer renders, which stops
    // playback and would freeze every subsequent frame.
    queueMicrotask(() => {
      if (elRef.current !== el || el.parentElement?.isConnected) return;
      hostRef.current?.appendChild(el);
      void el.play().catch(() => {});
    });
  }, []);

  const teardown = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (elRef.current) elRef.current.srcObject = null;
  }, []);

  // Releasing the camera on unmount matters for more than tidiness: a stream
  // left open keeps the device's camera light on, which is alarming and would
  // undercut every privacy promise the consent screen just made.
  useEffect(
    () => () => {
      teardown();
      hostRef.current?.remove();
      hostRef.current = null;
      elRef.current = null;
    },
    [teardown],
  );

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    // Downscale on the way in — see the sampling math at the top of this file.
    const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    framesRef.current.push(stripDataUri(canvas.toDataURL("image/jpeg", JPEG_QUALITY)));

    // At the cap, halve density instead of stopping: keep every other frame and
    // double the interval. Coverage still spans the whole session, and the frame
    // count — and therefore the cost — stays flat no matter how long they talk.
    if (framesRef.current.length >= MAX_FRAMES) {
      framesRef.current = framesRef.current.filter((_, i) => i % 2 === 0);
      intervalRef.current *= 2;
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(capture, intervalRef.current);
    }
    setFrameCount(framesRef.current.length);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    setState("starting");
    try {
      // Video only. Audio keeps its own separate MediaRecorder stream so the
      // existing transcription path is entirely unaffected by this feature.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      });
      streamRef.current = stream;
      const el = ensureEl();
      el.srcObject = stream;
      await el.play().catch(() => {});

      // Wait for the first decoded frame before sampling. `videoWidth` is 0
      // until metadata arrives, and `capture()` treats that as "not ready" and
      // returns — so without this the immediate frame below is silently lost on
      // every session. Bounded, because a camera that never produces a frame
      // must not block the rep from starting.
      if (!el.videoWidth) {
        await new Promise<void>((resolve) => {
          const done = () => {
            el.removeEventListener("loadeddata", done);
            window.clearTimeout(timeout);
            resolve();
          };
          const timeout = window.setTimeout(done, 3000);
          el.addEventListener("loadeddata", done);
        });
      }

      framesRef.current = [];
      intervalRef.current = BASE_INTERVAL_MS;
      setFrameCount(0);
      // One frame immediately, so a very short rep still yields a check or two.
      capture();
      timerRef.current = window.setInterval(capture, intervalRef.current);
      setState("running");
      return true;
    } catch (e) {
      // Name the actual failure — on mobile especially, "it didn't work" is not
      // something a student can act on.
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Camera permission was blocked. Allow camera access for this site in your browser settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found. You can still record a voice-only rep.");
      } else {
        setError("We couldn't start your camera. Close other apps using it and try again, or record voice-only.");
      }
      setState("error");
      teardown();
      return false;
    }
  }, [capture, ensureEl, teardown]);

  const stop = useCallback((): VideoFrame[] => {
    teardown();
    setState("stopped");
    return framesRef.current.map((data) => ({ media_type: "image/jpeg", data }));
  }, [teardown]);

  const cancel = useCallback(() => {
    teardown();
    framesRef.current = [];
    setFrameCount(0);
    setState("idle");
  }, [teardown]);

  return { state, error, frameCount, attachPreview, start, stop, cancel };
}

// --- consent ---------------------------------------------------------------

/**
 * Explicit, plain-language consent before the camera turns on.
 *
 * Deliberately not a checkbox buried in settings: it states exactly what is
 * captured, that it is sampled rather than recorded, that it is deleted, and
 * what we will and will not report. Users are minors, so the bar is "a student
 * (or their parent) could read this and know precisely what happens" — not
 * "we technically disclosed it".
 */
export function VideoConsent(props: { onAccept: () => void; onDecline: () => void; error?: string | null }) {
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/60 dark:bg-indigo-950/40">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
          Add video to this rep?
        </h3>
        <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          Beta
        </span>
      </div>

      <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
        <li>
          <strong>What we capture:</strong> a still frame from your camera every ~8 seconds while you
          present. We never record or upload video — only those sampled stills.
        </li>
        <li>
          <strong>What we measure:</strong> whether your face is in frame, whether you're looking at the
          camera, and whether you're smiling. Counts of what the camera saw.
        </li>
        <li>
          <strong>What we don't measure:</strong> confidence, charisma, or how you felt. Those can't be
          read from still frames, so we don't guess at them.
        </li>
        <li>
          <strong>What happens after:</strong> the frames are analyzed and immediately discarded. Nothing
          is stored on our servers.
        </li>
      </ul>

      {props.error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {props.error}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={props.onAccept}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          Turn on my camera
        </button>
        <button
          onClick={props.onDecline}
          className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          No thanks — voice only
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Video is optional. A voice-only rep is graded exactly the same on content and delivery.
      </p>
    </div>
  );
}

// --- live indicator --------------------------------------------------------

/** Unmissable "the camera is on" state, with the live preview and frame count. */
export function VideoIndicator(props: { sampler: FrameSampler; onDisable: () => void }) {
  const { sampler } = props;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/60">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-400">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" aria-hidden />
          Camera on — {sampler.frameCount} {sampler.frameCount === 1 ? "frame" : "frames"} sampled
        </div>
        <button
          onClick={props.onDisable}
          className="rounded-lg px-2 py-1 font-mono text-[11px] text-slate-500 transition hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700"
        >
          Turn off
        </button>
      </div>
      {/* The sampler moves its own long-lived <video> in here — see `ensureEl`.
          Rendering the element from React would tie the live stream to this
          component's mount cycle, which is exactly what broke capture before. */}
      <div
        ref={sampler.attachPreview}
        role="img"
        aria-label="Your camera preview"
        className="mt-2 w-full max-w-[220px] overflow-hidden rounded-lg bg-slate-900"
      />
    </div>
  );
}

// --- gaze anchor -----------------------------------------------------------

/**
 * The judge's face, pinned to the top edge of the screen while the camera runs.
 *
 * WHY IT EXISTS: eye contact is scored against the CAMERA, and the camera sits
 * above the screen. A student watching their own preview, the timer, or their
 * notes is looking down — correctly presenting, and correctly scored as not
 * making eye contact. Telling them that only after the rep is a gotcha. Giving
 * them a fixed point near the lens to present to turns the metric into something
 * they can act on DURING the rep, which is the whole difference between a score
 * and coaching.
 *
 * WHY A FACE: presenting to a dot is unnatural; presenting to a person is the
 * skill being rehearsed. The portrait is deliberately restrained — tonal slate,
 * business attire, adult proportions — because PRODUCT.md rules out mascots and
 * cartoon characters, and a competitor practicing for a real event should be
 * looking at something that reads as a judge, not a game character. It is drawn
 * in flat tones rather than any skin color so it stands for "the judge" without
 * casting a specific person.
 *
 * The eyes are the one indigo element on the screen while it's up. Indigo is
 * this product's signal color — reserved for the single thing to act on — and
 * here the thing to act on is exactly "look here".
 */
export function GazeAnchor({ frameCount }: { frameCount: number }) {
  return (
    // z-30: above the sticky header (z-20), below modals (z-50). It occupies the
    // header's empty center; the label drops on small screens where the logo and
    // menu button close that gap.
    <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center">
      <div className="flex items-center gap-2.5 rounded-b-2xl border border-t-0 border-slate-200 bg-white py-1.5 pl-1.5 pr-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <svg viewBox="0 0 40 40" aria-hidden className="h-9 w-9 shrink-0">
          <defs>
            <clipPath id="pic-gaze-clip">
              <circle cx="20" cy="20" r="20" />
            </clipPath>
          </defs>
          <g clipPath="url(#pic-gaze-clip)">
            <rect width="40" height="40" className="fill-slate-100 dark:fill-slate-800" />
            {/* shoulders — a blazer, because the room this rehearses is a formal one */}
            <path d="M4 40c0-7.4 5.6-12.8 16-12.8S36 32.6 36 40Z" className="fill-slate-500 dark:fill-slate-400" />
            {/* collar, in the circle's own background tone so it reads as a shirt */}
            <path
              d="M16.2 27.8 20 32.4l3.8-4.6"
              fill="none"
              strokeWidth="1.6"
              strokeLinecap="round"
              className="stroke-slate-100 dark:stroke-slate-800"
            />
            <path d="M16.6 22.6h6.8v6.4h-6.8z" className="fill-slate-300 dark:fill-slate-600" />
            <ellipse cx="20" cy="17" rx="8.2" ry="9.4" className="fill-slate-300 dark:fill-slate-600" />
            <path
              d="M11.8 15.4c0-5 3.7-8 8.2-8s8.2 3 8.2 8c-1.6-1.2-2.2-3.2-2.6-4.6-2 2-8.4 2.6-11.4 1.2-.8 1-1.8 2.4-2.4 3.4Z"
              className="fill-slate-600 dark:fill-slate-300"
            />
            <path
              d="M15.4 14.6c.9-.6 2.1-.6 3 0M21.6 14.6c.9-.6 2.1-.6 3 0"
              fill="none"
              strokeWidth="1.1"
              strokeLinecap="round"
              className="stroke-slate-500 dark:stroke-slate-400"
            />
            <g className="pic-blink">
              <ellipse cx="16.9" cy="17.6" rx="1.25" ry="1.45" className="fill-indigo-600 dark:fill-indigo-400" />
              <ellipse cx="23.1" cy="17.6" rx="1.25" ry="1.45" className="fill-indigo-600 dark:fill-indigo-400" />
            </g>
            <path
              d="M17.4 21.8c1.5 1.4 3.7 1.4 5.2 0"
              fill="none"
              strokeWidth="1.2"
              strokeLinecap="round"
              className="stroke-slate-500 dark:stroke-slate-400"
            />
          </g>
        </svg>

        <div className="hidden leading-tight sm:block">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Look here</div>
          {/* The live count sits AT the point they're being asked to look at, so
              glancing up to check it is the behavior we want anyway. */}
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-slate-500 dark:text-slate-400">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-600" aria-hidden />
            {frameCount} {frameCount === 1 ? "frame" : "frames"}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- results panel ---------------------------------------------------------

function Stat(props: { label: string; count: number; total: number; percent?: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{props.label}</div>
      <div className="mt-1 font-display text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {props.count} <span className="text-sm font-normal text-slate-500">of {props.total}</span>
        {props.percent !== undefined && (
          <span className="ml-2 font-mono text-sm font-medium text-indigo-600 dark:text-indigo-400">
            {props.percent}%
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The Video tab, alongside Delivery.
 *
 * Every number here is a count of observable checks with its denominator shown,
 * because "38 of 45" is a fact a student can verify and "84% confident" is a
 * claim we have no basis for. The notes come from the backend already computed
 * from those counts — no model prose reaches this component, which is what makes
 * the no-inferred-states rule structural rather than a matter of prompt care.
 */
export function VideoPanel({ metrics }: { metrics: VideoMetrics }) {
  if (metrics.checks === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
        We couldn't read any frames from this rep, so there's nothing to report here. Your content and
        delivery feedback are unaffected.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Looked at the camera"
          count={metrics.eye_contact_count}
          total={metrics.checks}
          percent={metrics.eye_contact_percent}
        />
        <Stat
          label="Smiled / positive expression"
          count={metrics.positive_expression_count}
          total={metrics.checks}
        />
        <Stat label="Off-frame" count={metrics.off_frame_count} total={metrics.checks} />
      </div>

      {/* What video did to the delivery score, stated before the coaching notes.
          A score that moved without an explanation is the kind of unexplained
          number this product exists to not produce — and when the sample was too
          small to move anything, saying THAT is the honest result, not a gap. */}
      {metrics.adjustment_reason && (
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <span
            className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${
              metrics.delivery_adjustment > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : metrics.delivery_adjustment < 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-slate-400 dark:text-slate-500"
            }`}
          >
            {metrics.delivery_adjustment > 0 ? "+" : ""}
            {metrics.delivery_adjustment.toFixed(1)}
          </span>
          <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {metrics.adjustment_reason}
          </p>
        </div>
      )}

      {metrics.notes.length > 0 && (
        <ul className="space-y-2">
          {metrics.notes.map((note, i) => (
            <li
              key={i}
              className="flex gap-2 rounded-xl bg-indigo-50/60 px-3 py-2.5 text-sm leading-relaxed text-slate-800 dark:bg-indigo-950/40 dark:text-slate-100"
            >
              <span aria-hidden className="text-indigo-500">→</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The disclaimer is part of the result, not fine print tucked elsewhere —
          the credibility of every number above depends on it being read. */}
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
        {metrics.disclaimer}
      </p>
    </div>
  );
}

// --- opt-in surface (shown on the response screen, speak mode) --------------

export type VideoGate =
  | { kind: "ready" }
  | { kind: "needs-account" }
  | { kind: "capped"; resetsOn: string }
  | { kind: "unsupported" };

/**
 * The whole video opt-in, in one place: gate -> consent -> live indicator.
 *
 * Every branch that can't proceed still leaves the student a way forward, because
 * the point of the session is the rep, not the upsell. A capped or signed-out
 * student is told plainly that voice and typing still work and are graded the
 * same — which is true, and is why we can say it.
 */
export function VideoOptIn(props: {
  gate: VideoGate;
  sampler: FrameSampler;
  enabled: boolean;
  remaining: number | null;
  onEnable: () => void;
  onDisable: () => void;
  onSignIn: () => void;
}) {
  const { gate, sampler } = props;
  const [consenting, setConsenting] = useState(false);

  if (gate.kind === "unsupported") return null;

  if (props.enabled && sampler.state === "running") {
    return <VideoIndicator sampler={sampler} onDisable={props.onDisable} />;
  }

  if (consenting) {
    return (
      <VideoConsent
        error={sampler.error}
        onAccept={props.onEnable}
        onDecline={() => setConsenting(false)}
      />
    );
  }

  if (gate.kind === "needs-account") {
    return (
      <Notice>
        <strong className="font-semibold">Want video feedback too?</strong> Eye-contact and expression
        checks are free with an account while video is in beta.{" "}
        <button onClick={props.onSignIn} className="font-semibold text-indigo-700 underline dark:text-indigo-300">
          Create a free account
        </button>{" "}
        — or just keep going with voice, which is graded exactly the same.
      </Notice>
    );
  }

  if (gate.kind === "capped") {
    return (
      <Notice>
        You've used your video sessions this month — they reset on {gate.resetsOn}. This rep will be
        recorded with voice only, which is graded exactly the same on content and delivery.
      </Notice>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-4 py-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-600 dark:text-slate-300">
          <strong className="font-semibold text-slate-800 dark:text-slate-100">Add video?</strong> We'll
          check eye contact and expression from sampled frames.
          {props.remaining !== null && (
            <span className="ml-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {props.remaining} left this month
            </span>
          )}
        </div>
        <button
          onClick={() => setConsenting(true)}
          className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Set up camera
        </button>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
      {children}
    </div>
  );
}
