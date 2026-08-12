// Auth context + modal, backed by Supabase's managed email/password auth. We
// never hand-roll sessions or password handling — supabase-js owns that; here we
// only expose a thin React surface (user, sign in/up/out) and a login dialog.
//
// Login is entirely optional: anonymous practice never touches this. When
// Supabase isn't configured (`ready === false`), the UI hides account features.

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { identifyUser, resetIdentity, track } from "./analytics";
import { BTN_PRIMARY } from "./ui";

type AuthResult = { error?: string; needsConfirmation?: boolean };

type AuthState = {
  ready: boolean; // is Supabase login configured at all?
  loading: boolean; // initial session check in flight
  user: User | null;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
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

  const signOut = async () => {
    const sb = await getSupabase();
    await sb?.auth.signOut();
    track("auth_signed_out", {});
    // After the event, so it's still attributed to the person who signed out.
    resetIdentity();
  };

  return <Ctx.Provider value={{ ready, loading, user, signUp, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used within <AuthProvider>");
  return c;
}

// --- Login / sign-up dialog -------------------------------------------------

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
  const { signIn, signUp } = useAuth();
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
              We sent a confirmation link to <strong className="font-semibold">{email}</strong>. Click it, then come back and log in.
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

            <form onSubmit={submit} className="mt-4 space-y-3">
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
