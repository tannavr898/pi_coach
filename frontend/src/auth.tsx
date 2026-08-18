// Auth context + modal, backed by Supabase's managed auth: email/password, or
// Google as a one-tap alternative. We never hand-roll sessions or password
// handling — supabase-js owns that; here we only expose a thin React surface
// (user, sign in/up/out, sign in with a provider) and a login dialog.
//
// Login is entirely optional: anonymous practice never touches this. When
// Supabase isn't configured (`ready === false`), the UI hides account features.

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { identifyUser, PH_MASK, resetIdentity, track } from "./analytics";
import { BTN_PRIMARY } from "./ui";

type AuthResult = { error?: string; needsConfirmation?: boolean };

// The providers enabled in the Supabase dashboard. Adding another (Apple,
// Microsoft) is a dashboard change plus one entry here and in PROVIDER_BUTTONS
// below — nothing else in the flow is provider-specific.
export type OAuthProvider = "google";

type AuthState = {
  ready: boolean; // is Supabase login configured at all?
  loading: boolean; // initial session check in flight
  user: User | null;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  // Hands the browser off to the provider; resolves only on failure, since
  // success navigates away from this page entirely.
  signInWithProvider: (provider: OAuthProvider) => Promise<AuthResult>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let active = true;
    getSupabase().then((sb) => {
      if (!active) return;
      if (!sb) {
        setReady(false);
        setLoading(false);
        return;
      }
      setReady(true);
      sb.auth.getSession().then(({ data }) => {
        if (!active) return;
        const u = data.session?.user ?? null;
        setUser(u);
        if (u) identifyUser(u.id);
        setLoading(false);
      });
      const { data } = sb.auth.onAuthStateChange((_event, session) => {
        const u = session?.user ?? null;
        setUser(u);
        // Covers sign-in, a sign-up that returns a session, token refresh, and a
        // session restored on reload. identify is idempotent, so re-calling with
        // the same id costs nothing. Sign-out is handled in signOut() below —
        // resetting here would also fire on transient null sessions.
        if (u) identifyUser(u.id);
      });
      unsub = () => data.subscription.unsubscribe();
    });
    return () => {
      active = false;
      unsub?.();
    };
  }, []);

  const signUp = async (email: string, password: string): Promise<AuthResult> => {
    const sb = await getSupabase();
    if (!sb) return { error: "Accounts aren't available right now." };
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return { error: error.message };
    track("auth_signed_up", {});
    // With "confirm email" enabled, signUp returns a user but no active session
    // until they click the email link.
    if (!data.session) return { needsConfirmation: true };
    return {};
  };

  const signIn = async (email: string, password: string): Promise<AuthResult> => {
    const sb = await getSupabase();
    if (!sb) return { error: "Accounts aren't available right now." };
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    track("auth_signed_in", {});
    return {};
  };

  // Redirect-based OAuth. Nothing after a successful call runs — the tab is
  // already on the provider's consent screen — so the completion side lives
  // entirely in onAuthStateChange above, which fires once we are bounced back
  // with a session. That is also why there is no signed-up vs logged-in event
  // here: from our side the two are indistinguishable on an OAuth return, so we
  // record the attempt and let the person properties settle the rest.
  const signInWithProvider = async (provider: OAuthProvider): Promise<AuthResult> => {
    const sb = await getSupabase();
    if (!sb) return { error: "Accounts aren't available right now." };
    track("auth_oauth_started", { provider });
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: {
        // Return to the exact page they left, query string included, so a
        // shared-challenge deep link survives the round trip.
        redirectTo: window.location.origin + window.location.pathname + window.location.search,
      },
    });
    if (error) return { error: error.message };
    return {};
  };

  const signOut = async () => {
    const sb = await getSupabase();
    await sb?.auth.signOut();
    track("auth_signed_out", {});
    // After the event, so it's still attributed to the person who signed out.
    resetIdentity();
  };

  return (
    <Ctx.Provider value={{ ready, loading, user, signUp, signIn, signInWithProvider, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within <AuthProvider>");
  return c;
}

// --- Login / sign-up dialog -------------------------------------------------

// Google's mark, inlined rather than fetched: the button must not depend on a
// third-party request that an ad blocker or a school network can drop, which
// would leave a nameless white square. The four fills are Google's brand colors,
// fixed by their branding guidelines — they do not follow our theme.
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden className="shrink-0">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

const PROVIDER_BUTTONS: { id: OAuthProvider; label: string; icon: ReactNode }[] = [
  { id: "google", label: "Google", icon: <GoogleMark /> },
];

export function AuthModal({
  open,
  initialTab = "signup",
  reason,
  onClose,
  onAuthed,
}: {
  open: boolean;
  initialTab?: "signup" | "login";
  reason?: string;
  onClose: () => void;
  onAuthed?: (mode: "signup" | "login") => void;
}) {
  const { signIn, signUp, signInWithProvider } = useAuth();
  const [tab, setTab] = useState<"signup" | "login">(initialTab);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError(null);
      setConfirmSent(false);
      setBusy(false);
    }
  }, [open, initialTab]);

  if (!open) return null;

  // On success the browser leaves for the provider, so `busy` is deliberately
  // never cleared: it keeps the form disabled through the hand-off instead of
  // flickering back to interactive while the page is already navigating.
  async function startProvider(provider: OAuthProvider) {
    setError(null);
    setBusy(true);
    const res = await signInWithProvider(provider);
    if (res.error) {
      setError(res.error);
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fn = tab === "signup" ? signUp : signIn;
    const res = await fn(email.trim(), password);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.needsConfirmation) {
      setConfirmSent(true);
      return;
    }
    // Signed in — a session is active.
    onAuthed?.(tab);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        {confirmSent ? (
          <div className="text-center">
            <div className="text-3xl">📬</div>
            <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Check your email</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              We sent a confirmation link to <strong className={`font-semibold ${PH_MASK}`}>{email}</strong>. Click it, then come back and log in.
            </p>
            <button className={`mt-5 w-full ${BTN_PRIMARY}`} onClick={onClose}>
              Got it
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                {tab === "signup" ? "Create your account" : "Welcome back"}
              </h2>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            {reason && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{reason}</p>}

            <div className="mt-4 space-y-2">
              {PROVIDER_BUTTONS.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  onClick={() => startProvider(id)}
                  className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {icon}
                  {tab === "signup" ? `Sign up with ${label}` : `Log in with ${label}`}
                </button>
              ))}
            </div>

            <div className="my-4 flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">or</span>
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            </div>

            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  placeholder="you@school.edu"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Password</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete={tab === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  placeholder={tab === "signup" ? "At least 6 characters" : "Your password"}
                />
              </label>

              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

              <button type="submit" disabled={busy} className={`w-full ${BTN_PRIMARY}`}>
                {busy ? "…" : tab === "signup" ? "Create account" : "Log in"}
              </button>
            </form>

            <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
              {tab === "signup" ? (
                <>
                  Already have an account?{" "}
                  <button className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => { setTab("login"); setError(null); }}>
                    Log in
                  </button>
                </>
              ) : (
                <>
                  New here?{" "}
                  <button className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => { setTab("signup"); setError(null); }}>
                    Create an account
                  </button>
                </>
              )}
            </p>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              We only store your email and your practice sessions: nothing else. Signing in is optional; you can keep practicing without an account.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
