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
  /** Live preview element ref — attach to a <video> so the user can see themselves. */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
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

  const teardown = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Releasing the camera on unmount matters for more than tidiness: a stream
  // left open keeps the device's camera light on, which is alarming and would
  // undercut every privacy promise the consent screen just made.
  useEffect(() => () => teardown(), [teardown]);

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
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
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
  }, [capture, teardown]);

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

  return { state, error, frameCount, videoRef, start, stop, cancel };
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
      <video
        ref={sampler.videoRef}
        muted
        playsInline
        aria-label="Your camera preview"
        className="mt-2 w-full max-w-[220px] rounded-lg bg-slate-900"
      />
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
