// A student's profile as their chapter manager sees it: who they are and what
// they compete in, the same graphs the student sees on their own Home (shared via
// ProfilePanels, so the two can't drift), their study plan read-only, and a way to
// send them a reminder. The server decides who may load this (backend
// chapters.require_manager + require_student_in); this file only renders it.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getDomains, type DomainSummary } from "./api";
import { ProfilePanels } from "./home";
import { PlanReadOnly } from "./plan";
import { useCached } from "./cache";
import {
  getStudentProfile,
  studentProfileKey,
  getStudentSession,
  sendMessage,
  type SessionDetail,
  type StudentProfileData,
} from "./progress";
import { BTN_PRIMARY, BTN_SECONDARY, Card, Eyebrow, PageLoader } from "./ui";
import { track } from "./analytics";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function StudentProfileView({
  chapterId,
  studentId,
  onBack,
  onOpenThread,
  renderSession,
}: {
  chapterId: string;
  studentId: string;
  onBack: () => void;
  onOpenThread: (studentId: string) => void;
  // The feedback screen lives in App.tsx; it's handed in rather than imported to
  // keep this module free of App's dependency graph.
  renderSession: (detail: SessionDetail, onBack: () => void) => ReactNode;
}) {
  const profileQ = useCached<StudentProfileData>(studentProfileKey(chapterId, studentId), () => getStudentProfile(chapterId, studentId));
  const domainsQ = useCached<DomainSummary[]>("static:domains", getDomains);
  const data = profileQ.data ?? null;
  const domains = domainsQ.data ?? [];
  const error = data ? null : profileQ.error;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [sessionErr, setSessionErr] = useState<string | null>(null);

  useEffect(() => {
    track("chapter_student_opened", {});
  }, [studentId]);

  async function openSession(id: string) {
    setSessionErr(null);
    try {
      setSession(await getStudentSession(chapterId, studentId, id));
    } catch (e) {
      setSessionErr(errText(e));
    }
  }

  if (session) return <>{renderSession(session, () => setSession(null))}</>;

  const name = data ? `${data.first_name} ${data.last_name}`.trim() || "This student" : "";
  const first = data?.first_name || "This student";

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
        ← Back to roster
      </button>

      {error ? (
        <Card>
          <p className="text-sm text-red-600 dark:text-red-400">Couldn't load this student: {error}</p>
        </Card>
      ) : !data ? (
        <PageLoader label="Loading profile" />
      ) : (
        <>
          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <Eyebrow>Student profile</Eyebrow>
                <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{name}</h1>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {data.event || "Hasn't picked an event yet"}
                  {" · "}
                  {data.progress.sessions_count} role-play{data.progress.sessions_count === 1 ? "" : "s"}
                </p>
              </div>
              <button className={BTN_SECONDARY} onClick={() => onOpenThread(studentId)}>
                Open messages
              </button>
            </div>
            <ReminderBox chapterId={chapterId} studentId={studentId} firstName={first} />
          </Card>

          {sessionErr && <p className="text-sm text-red-600 dark:text-red-400">Couldn't open that role-play: {sessionErr}</p>}

          <ProfilePanels
            progress={data.progress}
            sessions={data.sessions}
            domains={domains}
            course={data.course}
            subjectName={first}
            onOpenSession={openSession}
          />

          {data.plan ? (
            <PlanReadOnly plan={data.plan} name={first} />
          ) : (
            <Card>
              <Eyebrow>Study plan</Eyebrow>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {first} hasn't made a study plan yet. A reminder to set one up in the Study tab is a good first nudge.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// A one-line reminder straight from the profile, landing in the student's thread.
function ReminderBox({ chapterId, studentId, firstName }: { chapterId: string; studentId: string; firstName: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      await sendMessage(chapterId, body.trim(), [studentId]);
      setBody("");
      setNote(`Sent. ${firstName} will see it in their Chapter tab.`);
      track("chapter_reminder_sent", { from: "profile" });
    } catch (e) {
      setNote(`Couldn't send: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <label className="sr-only" htmlFor="reminder">Send {firstName} a reminder</label>
      <input
        id="reminder"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        placeholder={`Send ${firstName} a reminder…`}
        className="w-full flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
      <button type="submit" className={BTN_PRIMARY} disabled={busy || !body.trim()}>
        {busy ? "Sending…" : "Send"}
      </button>
      {note && <p className="text-sm text-slate-600 dark:text-slate-300 sm:basis-full">{note}</p>}
    </form>
  );
}
