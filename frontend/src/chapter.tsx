// The Chapter tab. A chapter is a school club: its managers (advisor, officers)
// follow their students, post announcements and assignments, and message students;
// a student sees the feed, their own assignments with live progress, and their own
// thread with the managers.
//
// Everything here is presentation. Who may see or do what is enforced by the
// backend (chapters.py), so a hidden button is a courtesy, never the protection.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getDomains, type DomainSummary } from "./api";
import { SIGNUP_STASH_KEY, type SignupMeta } from "./auth";
import {
  approveMember,
  createChapter,
  createPost,
  deletePost,
  getAssignmentStatus,
  getMe,
  getMessages,
  messagesKey,
  getPosts,
  getRoster,
  getThreads,
  joinChapter,
  leaveChapter,
  markFeedRead,
  removeMember,
  rotateCode,
  saveProfile,
  sendMessage,
  type AssignmentKind,
  type AssignmentState,
  type ChapterPost,
  type Me,
  type Membership,
  type Roster,
  type RosterStudent,
  type SessionDetail,
  type ThreadSummary,
} from "./progress";
import { StudentProfileView } from "./profile";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow, InlineLoader, LogoLoader, PageHead, PageLoader, SideGroup, SideItem, Sidebar } from "./ui";
import { invalidate, useCached } from "./cache";
import { track } from "./analytics";

const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
const LABEL = "text-xs font-medium text-slate-500 dark:text-slate-400";
const TEXT_ACTION =
  "text-sm font-medium text-indigo-600 underline-offset-2 hover:underline disabled:opacity-40 dark:text-indigo-400";
const DANGER_ACTION =
  "text-sm font-medium text-red-600 underline-offset-2 hover:underline disabled:opacity-40 dark:text-red-400";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

const fullName = (s: { first_name: string; last_name: string }) => `${s.first_name} ${s.last_name}`.trim() || "Unnamed student";

// --- account bootstrap --------------------------------------------------------

/**
 * Apply the details a Google sign-up left in localStorage (see auth.tsx): the
 * name, and a chapter to register. The email path sends the same details as
 * user_metadata and the backend applies them; this is the provider-path twin.
 * Removed once applied, so it runs at most once per sign-up.
 */
async function applyStashedSignup(): Promise<void> {
  let meta: SignupMeta | null = null;
  try {
    const raw = localStorage.getItem(SIGNUP_STASH_KEY);
    meta = raw ? (JSON.parse(raw) as SignupMeta) : null;
  } catch {
    meta = null;
  }
  if (!meta) return;
  try {
    if (meta.first_name && meta.last_name) await saveProfile({ first_name: meta.first_name, last_name: meta.last_name });
    if (meta.pending_chapter) await createChapter(meta.pending_chapter);
  } finally {
    try { localStorage.removeItem(SIGNUP_STASH_KEY); } catch { /* ignore */ }
  }
}

function hasStash(): boolean {
  try {
    return !!localStorage.getItem(SIGNUP_STASH_KEY);
  } catch {
    return false;
  }
}

/** The signed-in person's name and chapters (null while loading or signed out).
 *  Cached like every other read, so the Chapter tab and its badge are instant on
 *  return visits; a Google sign-up's stashed details are applied before the
 *  first fetch so that fetch already includes them. */
export function useMe(userId: string | null): { me: Me | null; error: string | null; refresh: () => Promise<void> } {
  const [stashDone, setStashDone] = useState<string | null>(null);
  const waiting = !!userId && stashDone !== userId && hasStash();
  useEffect(() => {
    if (!userId || !hasStash()) return;
    applyStashedSignup()
      .catch(() => {})
      .finally(() => setStashDone(userId));
  }, [userId]);
  const q = useCached(userId && !waiting ? "/api/me" : null, getMe);
  return { me: q.data ?? null, error: q.error, refresh: q.refresh };
}

export function unreadTotal(me: Me | null): number {
  return (me?.memberships ?? []).reduce((n, m) => n + m.unread_feed + m.unread_messages, 0);
}

// Every account needs a name now (managers have to recognize who they're looking
// at). Email sign-ups give one on the form; Google sign-ups and accounts from
// before chapters existed are asked once, here.
export function NameModal({ onSaved }: { onSaved: () => void }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!first.trim() || !last.trim()) {
      setError("Enter your first and last name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveProfile({ first_name: first.trim(), last_name: last.trim() });
      track("profile_name_saved", {});
      onSaved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-title"
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <h2 id="name-title" className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">What's your name?</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          So your chapter advisor knows who you are if you join a chapter. Only you and your chapter's managers see it.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <label className="block">
            <span className={LABEL}>First name</span>
            <input autoFocus value={first} onChange={(e) => setFirst(e.target.value)} maxLength={40} autoComplete="given-name" className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>Last name</span>
            <input value={last} onChange={(e) => setLast(e.target.value)} maxLength={40} autoComplete="family-name" className={INPUT} />
          </label>
        </div>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={busy} className={`mt-4 w-full ${BTN_PRIMARY}`}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

// --- where you are, in the URL ---------------------------------------------------
// Which chapter, which section, and which student or thread is open all live in
// the query string (/chapter?tab=feed, /chapter?student=<id>), so a refresh keeps
// your place and Back steps out of a profile instead of out of the tab.

const QUERY_EVENT = "pic-query";

function useQuery(): [(name: string) => string | null, (patch: Record<string, string | null>) => void] {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((x) => x + 1);
    window.addEventListener("popstate", on);
    window.addEventListener(QUERY_EVENT, on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener(QUERY_EVENT, on);
    };
  }, []);
  const get = (name: string) => new URLSearchParams(window.location.search).get(name);
  const set = (patch: Record<string, string | null>) => {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    const next = `${u.pathname}${u.search}${u.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.pushState({}, "", next);
      window.dispatchEvent(new Event(QUERY_EVENT));
    }
  };
  return [get, set];
}

// --- the tab ------------------------------------------------------------------

export function ChapterTab({
  me,
  error,
  onRefresh,
  onStartAssignment,
  renderSession,
}: {
  me: Me | null;
  error?: string | null;
  onRefresh: () => void;
  onStartAssignment: (post: ChapterPost) => void;
  renderSession: (detail: SessionDetail, onBack: () => void) => ReactNode;
}) {
  const memberships = me?.memberships ?? [];
  const [q, setQ] = useQuery();
  const selected = q("c");
  const [showJoin, setShowJoin] = useState(false);
  const current =
    memberships.find((m) => m.chapter.id === selected) ??
    memberships.find((m) => m.role === "manager" && m.status === "active") ??
    memberships[0] ??
    null;

  if (!me) {
    return error ? (
      <Card>
        <div className="space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-200">Couldn't load your chapter: {error}</p>
          <button className={BTN_SECONDARY} onClick={onRefresh}>Try again</button>
        </div>
      </Card>
    ) : (
      <PageLoader label="Loading your chapter" />
    );
  }

  if (!current) return <JoinOrRegister onDone={onRefresh} />;

  const hasStudentRole = memberships.some((m) => m.role === "student");

  return (
    <div className="space-y-5">
      {/* The chapters sit in the sidebar where the row of chapter buttons used to
          be; the open chapter's own sections follow them (see Tabs below). */}
      <Sidebar>
        <SideGroup title="Your chapters">
          {memberships.map((m) => {
            const unread = m.unread_feed + m.unread_messages;
            return (
              <SideItem
                key={m.chapter.id}
                active={m.chapter.id === current.chapter.id}
                onClick={() => setQ({ c: m.chapter.id, tab: null, student: null, thread: null })}
                sub={m.role === "manager" ? "You manage" : "My chapter"}
                right={unread > 0 ? <span className="font-mono text-[13px] tabular-nums text-slate-500 dark:text-slate-400">{unread}</span> : undefined}
              >
                {m.chapter.name}
              </SideItem>
            );
          })}
        </SideGroup>
        <div className="px-2.5">
          <RefreshButton chapterId={current.chapter.id} />
        </div>
      </Sidebar>

      {current.chapter.status !== "active" ? (
        <ReviewCard m={current} />
      ) : current.status === "pending" ? (
        <PendingCard m={current} onDone={onRefresh} />
      ) : current.role === "manager" ? (
        <ManagerView key={current.chapter.id} m={current} onRefresh={onRefresh} renderSession={renderSession} />
      ) : (
        <StudentView key={current.chapter.id} m={current} onRefresh={onRefresh} onStartAssignment={onStartAssignment} />
      )}

      <div className="pt-2">
        {showJoin ? (
          <JoinOrRegister onDone={() => { setShowJoin(false); onRefresh(); }} canJoin={!hasStudentRole} onCancel={() => setShowJoin(false)} />
        ) : (
          <button className={TEXT_ACTION} onClick={() => setShowJoin(true)}>
            {hasStudentRole ? "Register or co-manage another chapter" : "Join or register another chapter"}
          </button>
        )}
      </div>
    </div>
  );
}

// Pull everything on this chapter fresh: the roster, feed, messages, and the
// unread counts, without leaving the tab. Data on screen stays up meanwhile.
function RefreshButton({ chapterId }: { chapterId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        track("chapter_refreshed", {});
        try {
          await invalidate(`/api/chapters/${chapterId}`, "/api/me");
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      aria-label="Refresh chapter"
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
    >
      {busy ? (
        <LogoLoader size={16} label="Refreshing" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      )}
      {busy ? "Refreshing" : "Refresh"}
    </button>
  );
}

function ChapterHeader({ m, right }: { m: Membership; right?: ReactNode }) {
  return (
    <PageHead sub={`${m.role === "manager" ? "You manage" : "Your chapter"}, ${m.chapter.school_name}`} title={m.chapter.name}>
      {right}
    </PageHead>
  );
}

function ReviewCard({ m }: { m: Membership }) {
  return (
    <Card>
      <Eyebrow>{m.chapter.status === "rejected" ? "Not approved" : "Under review"}</Eyebrow>
      <h1 className="mt-1 font-display text-xl font-semibold pic-title">{m.chapter.name}</h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        {m.chapter.status === "rejected"
          ? "We couldn't verify this chapter. If you think that's a mistake, send us a note through Feedback with your school's details."
          : `Thanks for registering ${m.chapter.school_name}. We check every new chapter before students can join, usually within a day. Your join code appears here once it's approved.`}
      </p>
    </Card>
  );
}

function PendingCard({ m, onDone }: { m: Membership; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <Eyebrow>Request sent</Eyebrow>
      <h1 className="mt-1 font-display text-xl font-semibold pic-title">{m.chapter.name}</h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        A manager at {m.chapter.school_name} needs to approve you. Once they do, this tab shows your chapter's updates and assignments.
      </p>
      <button
        className={`mt-4 ${TEXT_ACTION}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await leaveChapter(m.chapter.id); } finally { onDone(); }
        }}
      >
        Withdraw request
      </button>
    </Card>
  );
}

// --- joining and registering ----------------------------------------------------

function JoinOrRegister({ onDone, canJoin = true, onCancel }: { onDone: () => void; canJoin?: boolean; onCancel?: () => void }) {
  return (
    <div className="space-y-5">
      {!onCancel && (
        <div>
          <Eyebrow>Chapter</Eyebrow>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] pic-title">Practice with your chapter</h1>
          <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-300">
            Join your school's chapter to get updates and assignments from your advisor, or register your chapter if you run one.
          </p>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {canJoin && <JoinCard onDone={onDone} />}
        <RegisterCard onDone={onDone} />
      </div>
      {onCancel && (
        <button className={TEXT_ACTION} onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}

function JoinCard({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "consent">("code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(consent: boolean) {
    setBusy(true);
    setError(null);
    try {
      const m = await joinChapter(code, consent);
      track("chapter_join_requested", { role: m.role });
      onDone();
    } catch (e) {
      setError(errText(e));
      setStep("code");
    } finally {
      setBusy(false);
    }
  }

  // A manager code skips consent (it doesn't share anything), but the client
  // can't tell the two kinds apart, so everyone sees the consent step. It's true
  // for students and harmless for co-managers.
  return (
    <Card>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Join a chapter</h2>
      {step === "code" ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 4) setStep("consent"); }}
          className="mt-3 space-y-3"
        >
          <label className="block">
            <span className={LABEL}>Chapter code from your advisor</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={20}
              autoComplete="off"
              placeholder="e.g. 7KQ2MX"
              className={`${INPUT} font-mono tracking-[0.2em]`}
            />
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button type="submit" className={BTN_PRIMARY} disabled={code.trim().length < 4}>Continue</button>
        </form>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">Before you join, here's what your chapter's managers will see:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>Your name and the event you're studying for</li>
            <li>Your skills graph, scores, and trends, including role-plays from before you joined</li>
            <li>Your role-plays and their feedback</li>
            <li>Your study plan and how closely you're following it</li>
            <li>Whether you've finished the assignments they post</li>
          </ul>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            They won't see your email. You can leave any time, and they lose access the moment you do.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className={BTN_PRIMARY} disabled={busy} onClick={() => join(true)}>{busy ? "Joining…" : "I agree, join"}</button>
            <button className={BTN_SECONDARY} disabled={busy} onClick={() => setStep("code")}>Back</button>
          </div>
        </div>
      )}
    </Card>
  );
}

function RegisterCard({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createChapter({ name: name.trim(), school_name: school.trim(), contact_email: email.trim() });
      track("chapter_registered", { from: "tab" });
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">Register a chapter</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">For advisors and officers. We review new chapters before students can join.</p>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <label className="block">
          <span className={LABEL}>Chapter name</span>
          <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Northview DECA" className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>School name</span>
          <input required minLength={2} maxLength={120} value={school} onChange={(e) => setSchool(e.target.value)} placeholder="Northview High School" className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Contact email</span>
          <input required type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="advisor@school.edu" className={INPUT} />
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" className={BTN_SECONDARY} disabled={busy}>{busy ? "Registering…" : "Register chapter"}</button>
      </form>
    </Card>
  );
}

// --- shared bits ----------------------------------------------------------------

// The sections of the open chapter. They render into the sidebar, under the list
// of chapters, which leaves the page itself to the section being read.
function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; badge?: number }[] }) {
  return (
    <Sidebar>
      <SideGroup title="This chapter">
        {items.map((it) => (
          <SideItem
            key={it.key}
            active={value === it.key}
            onClick={() => onChange(it.key)}
            right={it.badge ? <span className="font-mono text-[13px] tabular-nums text-slate-500 dark:text-slate-400">{it.badge}</span> : undefined}
          >
            {it.label}
          </SideItem>
        ))}
      </SideGroup>
    </Sidebar>
  );
}

const KIND_LABEL: Record<AssignmentKind, string> = {
  roleplay: "Role-play",
  quiz: "Quiz",
  blitz: "Blitz",
  flashcards: "Flashcards",
};

function describeTarget(p: ChapterPost): string {
  const t = p.target;
  if (!p.assignment_kind || !t) return "";
  const area = p.domain ? ` in ${p.domain}` : "";
  switch (p.assignment_kind) {
    case "roleplay":
      return `${t.count} role-play${t.count === 1 ? "" : "s"}${t.min_score ? ` scoring ${t.min_score}%+` : ""}`;
    case "quiz":
      return `${t.count} quiz${t.count === 1 ? "" : "zes"}${area}${t.min_pct ? ` at ${t.min_pct}%+` : ""}`;
    case "blitz":
      return `${t.count} Blitz run${t.count === 1 ? "" : "s"}${area}${t.min_pct ? ` at ${t.min_pct}%+` : ""}`;
    case "flashcards":
      return `${t.count} flashcard${t.count === 1 ? "" : "s"} flipped${area}`;
  }
}

const STATUS_STYLE: Record<AssignmentState["status"], { label: string; cls: string }> = {
  done: { label: "Done", cls: "bg-indigo-600 text-white" },
  in_progress: { label: "In progress", cls: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300" },
  not_started: { label: "Not started", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  overdue: { label: "Overdue", cls: "bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900" },
};

function StatusChip({ s }: { s: AssignmentState }) {
  const st = STATUS_STYLE[s.status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${st.cls}`}>
      {st.label}
      {s.count > 1 && s.status !== "done" && <span className="font-mono tabular-nums">{s.done}/{s.count}</span>}
    </span>
  );
}

function PostMeta({ p }: { p: ChapterPost }) {
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      {p.author_name || "A manager"} · {fmtDate(p.created_at)}
      {p.due_at && ` · due ${fmtDate(p.due_at)}`}
    </p>
  );
}

// --- student view ---------------------------------------------------------------

function StudentView({
  m,
  onRefresh,
  onStartAssignment,
}: {
  m: Membership;
  onRefresh: () => void;
  onStartAssignment: (post: ChapterPost) => void;
}) {
  const [q, setQ] = useQuery();
  const tab: "feed" | "messages" =
    q("tab") === "messages" || (!q("tab") && m.unread_messages > 0 && m.unread_feed === 0) ? "messages" : "feed";
  const setTab = (t: "feed" | "messages") => setQ({ tab: t });
  const [confirmLeave, setConfirmLeave] = useState(false);
  const id = m.chapter.id;

  return (
    <div className="space-y-5">
      <ChapterHeader
        m={m}
        right={
          confirmLeave ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-slate-600 dark:text-slate-300">Leave and stop sharing your progress?</span>
              <button className={DANGER_ACTION} onClick={async () => { await leaveChapter(id).catch(() => {}); onRefresh(); }}>Leave</button>
              <button className={TEXT_ACTION} onClick={() => setConfirmLeave(false)}>Stay</button>
            </div>
          ) : (
            <button className={TEXT_ACTION} onClick={() => setConfirmLeave(true)}>Leave chapter</button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "feed", label: "Updates & assignments", badge: m.unread_feed },
          { key: "messages", label: "Messages", badge: m.unread_messages },
        ]}
      />
      {tab === "feed" ? (
        <StudentFeed chapterId={id} onStart={onStartAssignment} unread={m.unread_feed} />
      ) : (
        <Thread chapterId={id} studentId={null} title="Your chapter's managers" />
      )}
    </div>
  );
}

function StudentFeed({ chapterId, onStart, unread }: { chapterId: string; onStart: (p: ChapterPost) => void; unread: number }) {
  const { data: posts, error } = useCached(`/api/chapters/${chapterId}/posts`, () => getPosts(chapterId));

  // Opening the feed is reading it; clears the badge (markFeedRead refreshes /api/me).
  useEffect(() => {
    if (posts && unread > 0) markFeedRead(chapterId).catch(() => {});
  }, [chapterId, posts, unread]);

  if (error && !posts) return <p className="text-sm text-red-600 dark:text-red-400">Couldn't load updates: {error}</p>;
  if (!posts) return <PageLoader label="Loading updates" />;

  const open = posts.filter((p) => p.kind === "assignment" && p.mine && p.mine.status !== "done");
  const rest = posts.filter((p) => !open.includes(p));

  if (!posts.length) {
    return (
      <Card>
        <p className="text-sm text-slate-600 dark:text-slate-300">Nothing posted yet. Updates and assignments from your managers show up here.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {open.length > 0 && (
        <section>
          <h2 className="mb-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">To do</h2>
          <div className="space-y-3">
            {open.map((p) => <StudentPost key={p.id} p={p} onStart={onStart} />)}
          </div>
        </section>
      )}
      {rest.length > 0 && (
        <section>
          <h2 className="mb-2 font-display text-base font-semibold text-slate-900 dark:text-slate-100">{open.length ? "Earlier" : "Updates"}</h2>
          <div className="space-y-3">
            {rest.map((p) => <StudentPost key={p.id} p={p} onStart={onStart} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function StudentPost({ p, onStart }: { p: ChapterPost; onStart: (p: ChapterPost) => void }) {
  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {p.kind === "assignment" && p.assignment_kind && (
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-indigo-500">Assignment · {KIND_LABEL[p.assignment_kind]}</span>
              {p.mine && <StatusChip s={p.mine} />}
            </div>
          )}
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{p.title}</h3>
          {p.kind === "assignment" && <p className="mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-200">{describeTarget(p)}</p>}
          {p.body && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">{p.body}</p>}
          <div className="mt-2"><PostMeta p={p} /></div>
        </div>
        {p.kind === "assignment" && p.mine?.status !== "done" && (
          <button className={`${BTN_PRIMARY} shrink-0`} onClick={() => { track("chapter_assignment_started", { kind: p.assignment_kind }); onStart(p); }}>
            Start
          </button>
        )}
      </div>
    </Card>
  );
}

// --- messages -------------------------------------------------------------------

// One thread. `studentId` null means "my own thread" (a student); a manager
// passes the student's id. Opening it marks it read server-side.
function Thread({ chapterId, studentId, title }: { chapterId: string; studentId: string | null; title: string }) {
  const { data: msgs, error: loadErr } = useCached(messagesKey(chapterId, studentId), () => getMessages(chapterId, studentId));
  const [sendErr, setSendErr] = useState<string | null>(null);
  const error = sendErr ?? (msgs ? null : loadErr);
  // Loading a thread marks it read on the server; refresh the badge to match.
  const loaded = !!msgs;
  useEffect(() => {
    if (loaded) void invalidate("/api/me");
  }, [loaded, chapterId, studentId]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await sendMessage(chapterId, body.trim(), studentId ? [studentId] : []);
      setBody("");
      setSendErr(null);
      track("chapter_message_sent", { from: studentId ? "manager" : "student" });
    } catch (err) {
      setSendErr(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!msgs ? (
        <InlineLoader label="Loading messages" />
      ) : msgs.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {studentId ? "No messages yet. Send a reminder or a word of encouragement." : "No messages yet. Reminders from your managers land here, and you can reply."}
        </p>
      ) : (
        <ol className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {msgs.map((x) => (
            <li key={x.id} className={`flex ${x.mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                  x.mine ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                }`}
              >
                <p className="whitespace-pre-line">{x.body}</p>
                <p className={`mt-1 text-[11px] ${x.mine ? "text-indigo-100" : "text-slate-500 dark:text-slate-400"}`}>
                  {x.mine ? "You" : x.sender_name || (x.from_manager ? "Manager" : "Student")} · {fmtDate(x.created_at)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label className="sr-only" htmlFor={`msg-${studentId ?? "me"}`}>Message</label>
        <input
          id={`msg-${studentId ?? "me"}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          placeholder={studentId ? "Write a message…" : "Reply to your managers…"}
          className="w-full flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !body.trim()}>Send</button>
      </form>
    </Card>
  );
}

// --- manager view ---------------------------------------------------------------

type ManagerTab = "students" | "feed" | "messages" | "settings";

function ManagerView({
  m,
  onRefresh,
  renderSession,
}: {
  m: Membership;
  onRefresh: () => void;
  renderSession: (detail: SessionDetail, onBack: () => void) => ReactNode;
}) {
  const id = m.chapter.id;
  const [q, setQ] = useQuery();
  const tabParam = q("tab");
  const tab: ManagerTab = tabParam === "feed" || tabParam === "messages" || tabParam === "settings" ? tabParam : "students";
  const rosterQ = useCached(`/api/chapters/${id}/roster`, () => getRoster(id));
  const roster: Roster | null = rosterQ.data ?? null;
  const rosterErr = roster ? null : rosterQ.error;
  const openStudent = q("student");
  const openThread = q("thread");
  const setOpenStudent = (sid: string | null) => setQ({ student: sid });
  const setOpenThread = (sid: string | null) => setQ({ thread: sid });


  const active = useMemo(() => (roster?.students ?? []).filter((s) => s.status === "active"), [roster]);
  const pending = useMemo(() => (roster?.students ?? []).filter((s) => s.status === "pending"), [roster]);

  if (openStudent) {
    return (
      <StudentProfileView
        chapterId={id}
        studentId={openStudent}
        onBack={() => setOpenStudent(null)}
        onOpenThread={(sid) => setQ({ student: null, thread: sid, tab: "messages" })}
        renderSession={renderSession}
      />
    );
  }

  const codes = roster?.chapter ?? m.chapter;

  return (
    <div className="space-y-5">
      <ChapterHeader
        m={m}
        right={
          <div className="text-right">
            <div className="text-xs text-slate-500 dark:text-slate-400">Student join code</div>
            <div className="font-mono text-xl font-semibold tracking-[0.2em] text-slate-900 dark:text-slate-100">{codes.join_code}</div>
          </div>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setQ({ tab: t === "students" ? null : t, thread: t === "messages" ? openThread : null })}
        items={[
          { key: "students", label: `Students${active.length ? ` (${active.length})` : ""}`, badge: pending.length },
          { key: "feed", label: "Feed & assignments" },
          { key: "messages", label: "Messages", badge: m.unread_messages },
          { key: "settings", label: "Settings" },
        ]}
      />
      {rosterErr && <p className="text-sm text-red-600 dark:text-red-400">Couldn't load the roster: {rosterErr}</p>}

      {tab === "students" && (
        <>
          {pending.length > 0 && <PendingRequests chapterId={id} students={pending} />}
          <RosterTable students={active} loading={!roster} joinCode={codes.join_code} onOpen={setOpenStudent} />
        </>
      )}
      {tab === "feed" && <ManagerFeed chapterId={id} students={active} />}
      {tab === "messages" && (
        <ManagerMessages
          chapterId={id}
          students={active}
          open={openThread}
          onOpen={setOpenThread}
        />
      )}
      {tab === "settings" && roster && (
        <ManagerSettings roster={roster} onLeft={onRefresh} />
      )}
    </div>
  );
}

function PendingRequests({ chapterId, students }: { chapterId: string; students: RosterStudent[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function act(uid: string, approve: boolean) {
    setBusy(uid);
    try {
      if (approve) await approveMember(chapterId, uid);
      else await removeMember(chapterId, uid);
      track(approve ? "chapter_member_approved" : "chapter_member_declined", {});
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Waiting for approval</h2>
      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">Only approve students you recognize. Approving shares their progress with every manager here.</p>
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {students.map((s) => (
          <li key={s.user_id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{fullName(s)}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Requested {fmtDate(s.requested_at)}</div>
            </div>
            <div className="flex gap-2">
              <button className={BTN_PRIMARY} disabled={busy === s.user_id} onClick={() => act(s.user_id, true)}>Approve</button>
              <button className={BTN_SECONDARY} disabled={busy === s.user_id} onClick={() => act(s.user_id, false)}>Decline</button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type SortKey = "name" | "event" | "last_active" | "roleplays_7d" | "avg_score_recent" | "plan_follow_through";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Student" },
  { key: "event", label: "Event" },
  { key: "last_active", label: "Last active" },
  { key: "roleplays_7d", label: "Role-plays (7d)", numeric: true },
  { key: "avg_score_recent", label: "Recent avg", numeric: true },
  { key: "plan_follow_through", label: "Plan (7d)", numeric: true },
];

function sortValue(s: RosterStudent, k: SortKey): string | number {
  switch (k) {
    case "name": return fullName(s).toLowerCase();
    case "event": return s.event.toLowerCase() || "~";
    case "last_active": return s.last_active ? new Date(s.last_active).getTime() : 0;
    case "roleplays_7d": return s.roleplays_7d;
    case "avg_score_recent": return s.avg_score_recent ?? -1;
    case "plan_follow_through": return s.plan_follow_through ?? -1;
  }
}

function RosterTable({ students, loading, joinCode, onOpen }: { students: RosterStudent[]; loading: boolean; joinCode: string | null; onOpen: (uid: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const sorted = useMemo(() => {
    const out = [...students];
    out.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    return out;
  }, [students, sort]);

  if (loading) return <PageLoader label="Loading students" />;
  if (!students.length) {
    return (
      <Card>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">No students yet</h2>
        <p className="mt-1 max-w-prose text-sm text-slate-600 dark:text-slate-300">
          Share your join code <span className="font-mono font-semibold tracking-[0.15em]">{joinCode}</span> with your members. They enter it in their Chapter tab, then you approve them here.
        </p>
      </Card>
    );
  }

  return (
    <div className="pic-bleed border-y border-slate-200 dark:border-slate-800">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm [&_td:first-child]:pl-[var(--pic-pad)] [&_th:first-child]:pl-[var(--pic-pad)]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/40">
              {COLUMNS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th key={c.key} scope="col" aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={`px-4 py-2.5 font-medium ${c.numeric ? "text-right" : ""}`}>
                    <button
                      onClick={() => setSort({ key: c.key, dir: on ? (sort.dir === 1 ? -1 : 1) : c.numeric || c.key === "last_active" ? -1 : 1 })}
                      className={`text-xs uppercase tracking-wider transition ${on ? "text-indigo-600 dark:text-indigo-400" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"}`}
                    >
                      {c.label}{on ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Biggest gap</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((s) => (
              <tr key={s.user_id} className="transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2.5">
                  <button onClick={() => onOpen(s.user_id)} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">
                    {fullName(s)}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{s.event || <span className="text-slate-400">Not set</span>}</td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{fmtAgo(s.last_active)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{s.roleplays_7d}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{s.avg_score_recent != null ? `${s.avg_score_recent}%` : "-"}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                  {s.plan_follow_through != null ? `${s.plan_follow_through}%` : s.has_plan ? "-" : <span className="font-sans text-slate-400">No plan</span>}
                </td>
                <td className="max-w-[14rem] truncate px-4 py-2.5 text-slate-600 dark:text-slate-300">{s.weakest || <span className="text-slate-400">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Feed: compose announcements and assignments, then track who has finished.
function ManagerFeed({ chapterId, students }: { chapterId: string; students: RosterStudent[] }) {
  const { data: posts, error: loadErr } = useCached(`/api/chapters/${chapterId}/posts`, () => getPosts(chapterId));
  const error = posts ? null : loadErr;
  const [expanded, setExpanded] = useState<string | null>(null);
  // Co-managers' posts count as unread until the feed is opened.
  useEffect(() => {
    markFeedRead(chapterId).catch(() => {});
  }, [chapterId]);

  return (
    <div className="space-y-5">
      <Composer chapterId={chapterId} students={students} />
      {!posts && !error && <PageLoader label="Loading the feed" />}
      {error && <p className="text-sm text-red-600 dark:text-red-400">Couldn't load the feed: {error}</p>}
      {posts && posts.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">Nothing posted yet. Your first announcement or assignment shows up here.</p>
      )}
      {posts?.map((p) => (
        <Card key={p.id}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {p.kind === "assignment" && p.assignment_kind && (
                <div className="mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-indigo-500">Assignment · {KIND_LABEL[p.assignment_kind]}</div>
              )}
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">{p.title}</h3>
              {p.kind === "assignment" && <p className="mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-200">{describeTarget(p)}</p>}
              {p.body && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">{p.body}</p>}
              <div className="mt-2">
                <PostMeta p={p} />
                {p.audience_size != null && <p className="text-xs text-slate-500 dark:text-slate-400">Sent to {p.audience_size} student{p.audience_size === 1 ? "" : "s"}</p>}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              {p.kind === "assignment" && p.assigned_count != null && (
                <button className={TEXT_ACTION} onClick={() => setExpanded(expanded === p.id ? null : p.id)} aria-expanded={expanded === p.id}>
                  <span className="font-mono tabular-nums">{p.done_count}/{p.assigned_count}</span> done {expanded === p.id ? "▴" : "▾"}
                </button>
              )}
              <DeletePost onDelete={async () => { await deletePost(chapterId, p.id); }} />
            </div>
          </div>
          {expanded === p.id && <AssignmentBreakdown chapterId={chapterId} postId={p.id} />}
        </Card>
      ))}
    </div>
  );
}

function DeletePost({ onDelete }: { onDelete: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button className="text-xs text-slate-400 hover:text-red-600 dark:hover:text-red-400" onClick={() => setConfirm(true)}>Delete</button>;
  return (
    <span className="flex gap-3 text-xs">
      <button className="font-medium text-red-600 dark:text-red-400" onClick={() => onDelete().catch(() => setConfirm(false))}>Delete for everyone</button>
      <button className="text-slate-500" onClick={() => setConfirm(false)}>Cancel</button>
    </span>
  );
}

function AssignmentBreakdown({ chapterId, postId }: { chapterId: string; postId: string }) {
  const { data: rows, error } = useCached(`/api/chapters/${chapterId}/posts/${postId}/status`, () => getAssignmentStatus(chapterId, postId));
  if (error && !rows) return <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!rows) return <InlineLoader label="Loading who's done" />;
  return (
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
      {rows.map((r) => (
        <li key={r.user_id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span className="text-slate-700 dark:text-slate-200">{r.name}</span>
          <StatusChip s={r.status} />
        </li>
      ))}
    </ul>
  );
}

function Composer({ chapterId, students }: { chapterId: string; students: RosterStudent[] }) {
  const [kind, setKind] = useState<"announcement" | "assignment">("announcement");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aKind, setAKind] = useState<AssignmentKind>("quiz");
  const [count, setCount] = useState(1);
  const [threshold, setThreshold] = useState<number | "">("");
  const [domain, setDomain] = useState("");
  const [due, setDue] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDomains().then(setDomains).catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createPost(chapterId, {
        kind,
        title: title.trim(),
        body: body.trim(),
        ...(kind === "assignment"
          ? {
              assignment_kind: aKind,
              target: {
                count,
                min_score: aKind === "roleplay" && threshold !== "" ? threshold : null,
                min_pct: (aKind === "quiz" || aKind === "blitz") && threshold !== "" ? threshold : null,
                domain_id: aKind !== "roleplay" && domain ? domain : null,
              },
              // End of the chosen day, in the manager's time zone.
              due_at: due ? new Date(`${due}T23:59:00`).toISOString() : null,
            }
          : {}),
        audience: everyone ? [] : picked,
      });
      track("chapter_post_created", { kind, assignment_kind: kind === "assignment" ? aKind : undefined, everyone });
      setTitle("");
      setBody("");
      setThreshold("");
      setDue("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const countLabel = aKind === "flashcards" ? "Cards to flip" : aKind === "roleplay" ? "Role-plays" : "Runs";

  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">New post</h2>
          <div role="radiogroup" aria-label="Post type" className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {(["announcement", "assignment"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg px-3 py-1 text-sm font-medium transition ${kind === k ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
              >
                {k === "announcement" ? "Announcement" : "Assignment"}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className={LABEL}>Title</span>
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "assignment" ? "Marketing quiz before Thursday's meeting" : "District registration closes Friday"} className={INPUT} />
        </label>

        {kind === "assignment" && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className={LABEL}>Type</span>
              <select value={aKind} onChange={(e) => { setAKind(e.target.value as AssignmentKind); setCount(e.target.value === "flashcards" ? 20 : 1); setThreshold(""); }} className={INPUT}>
                <option value="quiz">Quiz</option>
                <option value="blitz">Blitz</option>
                <option value="flashcards">Flashcards</option>
                <option value="roleplay">Role-play</option>
              </select>
            </label>
            <label className="block">
              <span className={LABEL}>{countLabel}</span>
              <input type="number" min={1} max={aKind === "flashcards" ? 500 : 20} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} className={INPUT} />
            </label>
            {aKind !== "flashcards" && (
              <label className="block">
                <span className={LABEL}>{aKind === "roleplay" ? "Minimum score %" : "Minimum correct %"}</span>
                <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(e.target.value === "" ? "" : Math.min(100, Math.max(0, Number(e.target.value))))} placeholder="Any" className={INPUT} />
              </label>
            )}
            {aKind !== "roleplay" && (
              <label className="block">
                <span className={LABEL}>Skill area</span>
                <select value={domain} onChange={(e) => setDomain(e.target.value)} className={INPUT}>
                  <option value="">Any</option>
                  {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className={LABEL}>Due (optional)</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={INPUT} />
            </label>
          </div>
        )}

        <label className="block">
          <span className={LABEL}>{kind === "assignment" ? "Instructions (optional)" : "Message"}</span>
          <textarea maxLength={4000} rows={3} value={body} onChange={(e) => setBody(e.target.value)} className={INPUT} />
        </label>

        <fieldset className="space-y-2">
          <legend className={LABEL}>Who sees it</legend>
          <div className="flex flex-wrap gap-4 text-sm text-slate-700 dark:text-slate-200">
            <label className="inline-flex items-center gap-2"><input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> Whole chapter</label>
            <label className="inline-flex items-center gap-2"><input type="radio" checked={!everyone} onChange={() => setEveryone(false)} disabled={!students.length} /> Specific students</label>
          </div>
          {!everyone && (
            <StudentPicker students={students} picked={picked} onChange={setPicked} />
          )}
        </fieldset>

        {kind === "assignment" && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Completion is tracked automatically from what students actually do after you post it. Nobody ticks a box.
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !title.trim() || (!everyone && !picked.length)}>
          {busy ? "Posting…" : kind === "assignment" ? "Post assignment" : "Post announcement"}
        </button>
      </form>
    </Card>
  );
}

function StudentPicker({ students, picked, onChange }: { students: RosterStudent[]; picked: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
      <div className="mb-1 flex gap-3 text-xs">
        <button type="button" className={TEXT_ACTION} onClick={() => onChange(students.map((s) => s.user_id))}>All</button>
        <button type="button" className={TEXT_ACTION} onClick={() => onChange([])}>None</button>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {students.map((s) => (
          <label key={s.user_id} className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={picked.includes(s.user_id)}
              onChange={(e) => onChange(e.target.checked ? [...picked, s.user_id] : picked.filter((x) => x !== s.user_id))}
            />
            <span className="truncate">{fullName(s)}{s.event ? ` · ${s.event}` : ""}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ManagerMessages({
  chapterId,
  students,
  open,
  onOpen,
}: {
  chapterId: string;
  students: RosterStudent[];
  open: string | null;
  onOpen: (sid: string | null) => void;
}) {
  const { data: threads } = useCached<ThreadSummary[]>(`/api/chapters/${chapterId}/threads`, () => getThreads(chapterId));
  const [composing, setComposing] = useState(false);

  const nameOf = (sid: string) => {
    const s = students.find((x) => x.user_id === sid);
    return s ? fullName(s) : threads?.find((t) => t.student_id === sid)?.name ?? "Student";
  };

  if (open) {
    return (
      <div className="space-y-3">
        <button className={TEXT_ACTION} onClick={() => { onOpen(null); void invalidate(`/api/chapters/${chapterId}/threads`, "/api/me"); }}>← All messages</button>
        <Thread chapterId={chapterId} studentId={open} title={nameOf(open)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {composing ? (
        <Broadcast chapterId={chapterId} students={students} onDone={() => setComposing(false)} />
      ) : (
        <button className={BTN_PRIMARY} onClick={() => setComposing(true)} disabled={!students.length}>New reminder</button>
      )}
      <Card>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Conversations</h2>
        {!threads ? (
          <InlineLoader label="Loading conversations" />
        ) : threads.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No messages yet. Each student has one private thread with the chapter's managers.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
            {threads.map((t) => (
              <li key={t.student_id}>
                <button onClick={() => onOpen(t.student_id)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:opacity-80">
                  <div className="min-w-0">
                    <div className={`text-sm ${t.unread ? "font-semibold text-slate-900 dark:text-slate-100" : "font-medium text-slate-700 dark:text-slate-200"}`}>{t.name}</div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">{t.last_body}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.unread > 0 && <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white">{t.unread}</span>}
                    <span className="text-xs text-slate-500 dark:text-slate-400">{fmtDate(t.last_at)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// One message to many students, delivered into each one's own thread.
function Broadcast({ chapterId, students, onDone }: { chapterId: string; students: RosterStudent[]; onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>(students.map((s) => s.user_id));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendMessage(chapterId, body.trim(), picked);
      track("chapter_reminder_sent", { from: "broadcast", count: picked.length });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">New reminder</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">Each student gets it in their own private thread, so replies come back to you one by one.</p>
        <StudentPicker students={students} picked={picked} onChange={setPicked} />
        <label className="block">
          <span className={LABEL}>Message</span>
          <textarea required maxLength={2000} rows={3} value={body} onChange={(e) => setBody(e.target.value)} className={INPUT} />
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className={BTN_PRIMARY} disabled={busy || !body.trim() || !picked.length}>
            {busy ? "Sending…" : `Send to ${picked.length}`}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={onDone}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

function ManagerSettings({ roster, onLeft }: { roster: Roster; onLeft: () => void }) {
  const ch = roster.chapter;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function rotate(which: "join" | "manager") {
    setBusy(which);
    setError(null);
    try {
      await rotateCode(ch.id, which);
      setConfirm(null);
      track("chapter_code_rotated", { which });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Codes</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {([
            ["join", "Student join code", ch.join_code, "Give this to members. Each request still needs your approval."],
            ["manager", "Manager code", ch.manager_code, "Only for co-advisors and officers. Anyone with it can see every student's progress."],
          ] as const).map(([which, label, code, help]) => (
            <div key={which} className="border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className={LABEL}>{label}</div>
              <div className="mt-1 font-mono text-xl font-semibold tracking-[0.2em] text-slate-900 dark:text-slate-100">{code}</div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{help}</p>
              {confirm === which ? (
                <div className="mt-2 flex gap-3">
                  <button className={DANGER_ACTION} disabled={busy === which} onClick={() => rotate(which)}>Replace it</button>
                  <button className={TEXT_ACTION} onClick={() => setConfirm(null)}>Keep</button>
                </div>
              ) : (
                <button className={`mt-2 ${TEXT_ACTION}`} onClick={() => setConfirm(which)}>New code</button>
              )}
            </div>
          ))}
        </div>
        {confirm && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">The old code stops working right away. People already in the chapter stay in.</p>}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </Card>

      <Card>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Managers</h2>
        <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
          {roster.managers.map((mg) => (
            <li key={mg.user_id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="text-slate-700 dark:text-slate-200">{fullName(mg)}{mg.is_you && " (you)"}</span>
              {mg.is_you ? (
                <LeaveButton chapterId={ch.id} onLeft={onLeft} />
              ) : (
                <button className={DANGER_ACTION} onClick={async () => { await removeMember(ch.id, mg.user_id).catch(() => {}); }}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">Students</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Remove a student who has left the club. They keep their account and practice history; your chapter just stops seeing it.</p>
        <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
          {roster.students.filter((s) => s.status === "active").map((s) => (
            <li key={s.user_id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-slate-700 dark:text-slate-200">{fullName(s)}</span>
              <button className={DANGER_ACTION} onClick={async () => { await removeMember(ch.id, s.user_id).catch(() => {}); }}>Remove</button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LeaveButton({ chapterId, onLeft }: { chapterId: string; onLeft: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirm) return <button className={TEXT_ACTION} onClick={() => setConfirm(true)}>Leave</button>;
  return (
    <span className="flex flex-wrap items-center gap-3">
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      <button
        className={DANGER_ACTION}
        onClick={async () => {
          try { await leaveChapter(chapterId); onLeft(); } catch (e) { setError(errText(e)); }
        }}
      >
        Leave chapter
      </button>
      <button className={TEXT_ACTION} onClick={() => { setConfirm(false); setError(null); }}>Cancel</button>
    </span>
  );
}
