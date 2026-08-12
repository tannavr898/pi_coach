// Product analytics via PostHog. The public project key is fetched at runtime
// from /api/config (so it isn't baked into the build), and analytics is fully
// optional — if no key is configured, every call here is a no-op and posthog-js
// is never even downloaded (it's dynamically imported only when enabled).
//
// Privacy posture (this is a minors-facing tool): autocapture is OFF and event
// properties only ever carry coarse metadata (event code, level, a score
// number). We NEVER send response text, transcripts, or scenario content —
// those stay between the user and the grading call.
//
// Session replay is ON, and that rule is what shapes how it's configured: every
// input is masked AND every rendered text node is masked (`maskTextSelector:
// "*"`). A replay therefore carries layout, clicks, scrolling, hesitation and
// timing — everything needed to see WHERE someone drops off — but not one
// character a student wrote or read. Masking rendered text is the half that
// matters most here: the transcript, the evidence quotes and the scenario are
// read-only text, not form inputs, so `maskAllInputs` alone would not touch
// them. If you ever narrow the mask, narrow it to specific marketing surfaces;
// never unmask the practice flow.

type PostHog = typeof import("posthog-js")["default"];

let ph: PostHog | null = null;

export async function initAnalytics(): Promise<void> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = (await res.json()) as { posthog_key?: string; posthog_host?: string };
    if (!cfg.posthog_key) return; // analytics disabled: posthog-js never loads
    const mod = await import("posthog-js");
    mod.default.init(cfg.posthog_key, {
      api_host: cfg.posthog_host || "https://us.i.posthog.com",
      autocapture: false,
      capture_pageview: true,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        // Everything rendered, not just form fields — see the note at the top.
        maskTextSelector: "*",
      },
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

// Tie the browser to the signed-in account. Person profiles are
// "identified_only", so without this a logged-in student's sessions and replays
// stay anonymous and never stitch into a person — which is exactly what
// person-level journey analysis (and any AI synthesis of it) needs in order to
// follow someone across visits instead of seeing a crowd of one-offs.
//
// We identify by the Supabase user id, NOT the email: the id is already the join
// key everywhere server-side, and it keeps a minor's address out of the
// analytics store. `identifyEmail` below is the one deliberate exception, for a
// voluntary waitlist capture.
export function identifyUser(userId: string): void {
  if (!ph || !userId) return;
  try {
    ph.identify(userId);
  } catch {
    /* swallow */
  }
}

// Sign-out has to break the link between the account and this browser. Without
// it, the next person on a shared school laptop inherits the previous student's
// distinct id and both sets of sessions merge into one person — which is both a
// privacy leak and a corrupted funnel.
export function resetIdentity(): void {
  if (!ph) return;
  try {
    ph.reset();
  } catch {
    /* swallow */
  }
}

// Attach an email to the PostHog person so waitlist signups are queryable as a
// list in the Persons view. Person profiles are "identified_only", so this call
// is what creates the profile — we only ever do it for a voluntary email capture
// (waitlist), never for anonymous practice sessions.
export function identifyEmail(email: string): void {
  if (!ph || !email) return;
  try {
    ph.identify(email, { email });
  } catch {
    /* swallow */
  }
}

// Same as `track`, but for events fired from a `pagehide` handler, where a
// normal XHR is usually killed before it leaves the tab. sendBeacon is handed to
// the browser to deliver after the page is gone.
//
// Treat anything sent this way as a LOWER BOUND: posthog-js registers its own
// unload flush, and if ours loses that race the event is dropped. Never compare
// beacon-delivered volume against normally-tracked volume as if the two were
// measured equally.
export function trackBeacon(event: string, props?: Record<string, unknown>): void {
  if (!ph) return;
  try {
    ph.capture(event, props, { transport: "sendBeacon" });
  } catch {
    /* swallow */
  }
}
