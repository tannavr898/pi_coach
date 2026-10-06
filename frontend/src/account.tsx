// Account settings (/account): the name your chapter sees, the email you sign in
// with, and your password. Also where a password-reset email lands: the link
// signs you in and this page asks for the new password before anything else.
//
// The name is a row of ours (PUT /api/profile). Email and password belong to
// Supabase's managed auth, so those two go through auth.tsx and never touch our
// backend.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "./auth";
import { saveProfile, type Me } from "./progress";
import { BTN_PRIMARY, Card, Eyebrow, PageLoader } from "./ui";
import { PH_MASK, track } from "./analytics";

const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
const LABEL = "text-xs font-medium text-slate-500 dark:text-slate-400";
const MIN_PASSWORD = 6; // matches the sign-up form

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Note = { tone: "ok" | "error"; text: string };

function FormNote({ note }: { note: Note | null }) {
  if (!note) return null;
  return (
    <p
      role={note.tone === "error" ? "alert" : "status"}
      className={`text-sm ${note.tone === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}
    >
      {note.text}
    </p>
  );
}

function Section({ title, blurb, children }: { title: string; blurb: ReactNode; children?: ReactNode }) {
  return (
    <Card>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-300">{blurb}</p>
      {children && <div className="mt-4">{children}</div>}
    </Card>
  );
}

export function AccountSettings({ me, onRefresh }: { me: Me | null; onRefresh: () => Promise<void> | void }) {
  const { user, recovery } = useAuth();
  if (!user) return null;

  return (
    <div className="space-y-5">
      <div>
        <Eyebrow>Account</Eyebrow>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Account settings</h1>
      </div>
      {/* A reset link leads with the one thing they came to do. */}
      {recovery && <PasswordSection />}
      {me ? <NameSection me={me} onRefresh={onRefresh} /> : <PageLoader label="Loading your account" />}
      <EmailSection />
      {!recovery && <PasswordSection />}
    </div>
  );
}

function NameSection({ me, onRefresh }: { me: Me; onRefresh: () => Promise<void> | void }) {
  const saved = me.profile ?? { first_name: "", last_name: "" };
  const [first, setFirst] = useState(saved.first_name);
  const [last, setLast] = useState(saved.last_name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const changed = first.trim() !== saved.first_name || last.trim() !== saved.last_name;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!first.trim() || !last.trim()) {
      setNote({ tone: "error", text: "Enter your first and last name." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await saveProfile({ first_name: first.trim(), last_name: last.trim() });
      await onRefresh();
      track("profile_name_saved", { from: "settings" });
      setNote({ tone: "ok", text: "Name saved." });
    } catch (err) {
      setNote({ tone: "error", text: `Couldn't save your name: ${errText(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Name" blurb="Shown to you and, if you join a chapter, to its managers.">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid max-w-md grid-cols-2 gap-2">
          <label className="block">
            <span className={LABEL}>First name</span>
            <input value={first} onChange={(e) => { setFirst(e.target.value); setNote(null); }} maxLength={40} autoComplete="given-name" className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>Last name</span>
            <input value={last} onChange={(e) => { setLast(e.target.value); setNote(null); }} maxLength={40} autoComplete="family-name" className={INPUT} />
          </label>
        </div>
        <FormNote note={note} />
        <button type="submit" disabled={busy || !changed} className={BTN_PRIMARY}>
          {busy ? "Saving…" : "Save name"}
        </button>
      </form>
    </Section>
  );
}

function EmailSection() {
  const { user, hasPassword, changeEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const current = user?.email ?? "";

  // With two-step email changes on, the first confirmation link comes back here
  // carrying a "now confirm the other one" message in the URL. Show it once and
  // take it out of the address bar.
  useEffect(() => {
    try {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const message = hash.get("message");
      if (!message) return;
      setNote({ tone: "ok", text: message });
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    } catch {
      /* a malformed hash is not worth failing the page over */
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = email.trim();
    if (next.toLowerCase() === current.toLowerCase()) {
      setNote({ tone: "error", text: "That's already your email." });
      return;
    }
    setBusy(true);
    setNote(null);
    const res = await changeEmail(next);
    setBusy(false);
    if (res.error) {
      setNote({ tone: "error", text: res.error });
      return;
    }
    setEmail("");
    setNote({
      tone: "ok",
      text: res.needsConfirmation
        ? `Check ${next} for a confirmation link. Your email changes once you open it, and you may be asked to confirm from your current address too.`
        : "Email updated.",
    });
  }

  return (
    <Section
      title="Email"
      blurb={<>You sign in as <strong className={`font-semibold text-slate-900 dark:text-slate-100 ${PH_MASK}`}>{current}</strong>.</>}
    >
      {hasPassword ? (
        <form onSubmit={submit} className="space-y-3">
          <label className="block max-w-md">
            <span className={LABEL}>New email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); setNote(null); }}
              autoComplete="email"
              placeholder="you@school.edu"
              className={INPUT}
            />
          </label>
          <FormNote note={note} />
          <button type="submit" disabled={busy || !email.trim()} className={BTN_PRIMARY}>
            {busy ? "Sending…" : "Change email"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This account signs in with Google, so its email is managed by your Google account.
        </p>
      )}
    </Section>
  );
}

function PasswordSection() {
  const { hasPassword, recovery, changePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [done, setDone] = useState(false);
  // A reset link already proved who they are, and a Google-only account has no
  // password to ask for.
  const askCurrent = hasPassword && !recovery;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setNote({ tone: "error", text: `Use at least ${MIN_PASSWORD} characters.` });
      return;
    }
    if (next !== again) {
      setNote({ tone: "error", text: "Those two passwords don't match." });
      return;
    }
    setBusy(true);
    setNote(null);
    const res = await changePassword(next, askCurrent ? current : undefined);
    setBusy(false);
    if (res.error) {
      setNote({ tone: "error", text: res.error });
      return;
    }
    setCurrent("");
    setNext("");
    setAgain("");
    setDone(true);
    setNote({ tone: "ok", text: "Password updated. Use it the next time you log in." });
  }

  const title = recovery ? "Choose a new password" : hasPassword ? "Password" : "Add a password";
  const blurb = recovery
    ? "Your reset link worked and you're signed in. Set a new password to finish."
    : hasPassword
      ? "Change the password you log in with."
      : "You sign in with Google. Add a password if you also want to log in with your email.";

  // After a reset there is nothing left to ask for, so the form steps aside.
  if (recovery && done) {
    return <Section title="Password updated" blurb="You're signed in, and your new password is ready for the next time you log in." />;
  }

  return (
    <Section title={title} blurb={blurb}>
      <form onSubmit={submit} className="max-w-md space-y-3">
        {askCurrent && (
          <label className="block">
            <span className={LABEL}>Current password</span>
            <input type="password" required value={current} onChange={(e) => { setCurrent(e.target.value); setNote(null); }} autoComplete="current-password" className={INPUT} />
          </label>
        )}
        <label className="block">
          <span className={LABEL}>New password</span>
          <input type="password" required minLength={MIN_PASSWORD} value={next} onChange={(e) => { setNext(e.target.value); setNote(null); }} autoComplete="new-password" placeholder={`At least ${MIN_PASSWORD} characters`} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Confirm new password</span>
          <input type="password" required value={again} onChange={(e) => { setAgain(e.target.value); setNote(null); }} autoComplete="new-password" className={INPUT} />
        </label>
        <FormNote note={note} />
        <button type="submit" disabled={busy || !next || !again || (askCurrent && !current)} className={BTN_PRIMARY}>
          {busy ? "Saving…" : recovery ? "Set new password" : hasPassword ? "Change password" : "Add password"}
        </button>
      </form>
    </Section>
  );
}
