// Product analytics via PostHog. The public project key is fetched at runtime
// from /api/config (so it isn't baked into the build), and analytics is fully
// optional — if no key is configured, every call here is a no-op and posthog-js
// is never even downloaded (it's dynamically imported only when enabled).
//
// Privacy posture (this is a minors-facing tool): autocapture and session
// recording are OFF, and we only ever send coarse metadata (event code, level,
// a score number). We NEVER send response text, transcripts, or scenario
// content — those stay between the user and the grading call.

type PostHog = typeof import("posthog-js")["default"];

let ph: PostHog | null = null;

export async function initAnalytics(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = (await res.json()) as { posthog_key?: string; posthog_host?: string };
    if (!cfg.posthog_key) return; // analytics disabled — posthog-js never loads
    const mod = await import("posthog-js");
    mod.default.init(cfg.posthog_key, {
      api_host: cfg.posthog_host || "https://us.i.posthog.com",
      autocapture: false,
      capture_pageview: true,
      disable_session_recording: true,
      person_profiles: "identified_only",
    });
    ph = mod.default;
  } catch {
    /* analytics is best-effort; never let it break the app */
  }
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!ph) return;
  try {
    ph.capture(event, props);
  } catch {
    /* swallow */
  }
}
