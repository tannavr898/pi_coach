// The privacy policy (/privacy) and terms of service (/terms).
//
// These exist for two reasons. The first is that Google's OAuth consent screen
// will not show our app name in place of the raw `<project-ref>.supabase.co`
// host until the brand is verified, and verification requires both URLs to
// resolve on the authorized domain (see DEPLOY.md §6b). The second is that a
// tool used by minors should say plainly what it does with their data.
//
// KEEP THIS HONEST. Every claim below is a claim about code that exists — raw
// audio never persisted, no video file ever created, analytics carrying no
// response text. If any of those change, this page changes in the same commit.
// A privacy policy that has drifted from the implementation is worse than none,
// because people rely on it.
//
// Deliberately standalone: no imports from App.tsx (which would drag the whole
// practice flow into a static prose page), and no analytics beyond the pageview
// that main.tsx already fires.

import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "./ui";

// --- the bits that are yours to set ----------------------------------------

// Must be an address that is actually monitored — Google checks that the
// contact route on a privacy policy is real during brand verification, and it
// is the address a parent or guardian would write to asking for a deletion.
const CONTACT_EMAIL = "support@trypicoach.com";

// The state whose law governs the terms. Set this to where you actually are.
const GOVERNING_LAW = "the State of Texas, USA";

// Shown on both pages. Bump it whenever the substance changes, not for typo
// fixes — a date that moves for nothing trains people to ignore it.
const LAST_UPDATED = "August 18, 2026";

// --- shell ------------------------------------------------------------------

// The legal pages render outside <App>, so they carry their own theme wiring
// rather than inheriting the app's. Read-only on purpose: this page shows the
// theme you already chose but offers no toggle, since it isn't a place anyone
// comes to change settings.
function useStoredTheme() {
  const [dark] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = localStorage.getItem("pic-theme");
    if (saved === "light" || saved === "dark") return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
}

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  useStoredTheme();
  useEffect(() => {
    document.title = `${title} — PI Coach`;
  }, [title]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200/80 bg-white/60 backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/50">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <a href="/" className="flex items-center gap-2.5">
            <BrandMark size={26} />
            <span className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">PI Coach</span>
          </a>
          <a
            href="/"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            ← Back to practice
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="mt-2 font-mono text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Last updated {LAST_UPDATED}
        </p>
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      <footer className="border-t border-slate-200/80 bg-white/50 dark:border-slate-800/80 dark:bg-slate-950/40">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-6 text-xs text-slate-500 dark:text-slate-400">
          <a className="font-medium hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/privacy">
            Privacy
          </a>
          <a className="font-medium hover:text-slate-900 hover:underline dark:hover:text-slate-100" href="/terms">
            Terms
          </a>
          <a className="font-medium hover:text-slate-900 hover:underline dark:hover:text-slate-100" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          <span className="ml-auto">Not affiliated with DECA Inc.</span>
        </div>
      </footer>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">{heading}</h2>
      <div className="mt-2.5 space-y-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-indigo-400" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

// A claim strong enough that burying it in a paragraph would be a kind of lie.
// Text is tinted toward the indigo ground rather than the slate used for body
// copy: on a colored panel a neutral gray reads as washed out, where a deep
// shade of the panel's own hue reads as deliberate emphasis.
function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3 text-sm leading-relaxed text-indigo-950 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-50">
      {children}
    </div>
  );
}

// --- /privacy ---------------------------------------------------------------

export function PrivacyApp() {
  return (
    <LegalPage title="Privacy Policy">
      <Section heading="The short version">
        <Callout>
          You can use PI Coach without an account, and most people do. We never keep your audio or video. Nothing you
          write is sold, rented, or used for advertising. If you sign in, you can ask us to delete everything and we
          will.
        </Callout>
      </Section>

      <Section heading="Who we are">
        <p>
          PI Coach is a practice tool for DECA-style role-plays. It writes original practice scenarios and scores them
          against our own independent evaluation framework. We are not affiliated with DECA Inc., these are not official
          DECA materials, and our feedback is never an official competition score.
        </p>
      </Section>

      <Section heading="Practicing without an account">
        <p>
          The core loop — get a scenario, present, get feedback — requires no account and stores nothing about you on
          our servers beyond ordinary web request logs. Your answer is sent to our grader, scored, and returned. We do
          not write it to a database.
        </p>
      </Section>

      <Section heading="What we collect if you make an account">
        <Bullets
          items={[
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your email address.</strong> If you
              sign in with Google, we receive your email and basic profile information from Google — never your Google
              password, and no access to anything else in your Google account.
            </>,
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your password</strong>, if you use
              email sign-up, is handled entirely by our authentication provider. We never see or store it.
            </>,
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your completed practice sessions:</strong>{" "}
              the scenario, the answer you typed or that we transcribed from your speech, your follow-up answer, your
              scores, and the written feedback. This is what makes progress tracking and "try this again" possible.
            </>,
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your study progress:</strong> which
              event you are studying for and which terms you have practiced.
            </>,
          ]}
        />
      </Section>

      <Section heading="What we never keep">
        <Bullets
          items={[
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your audio.</strong> A spoken rep is
              sent to our transcription provider, converted to text, and discarded. It is never written to our database.
              The recording itself stays in your browser, on your device, unless you choose to save it.
            </>,
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Your video.</strong> Camera practice
              is opt-in and no video file is ever created. Your browser samples occasional still frames, sends them to
              be analyzed, and drops them when the session ends. There is no recording to store or leak.
            </>,
            <>
              <strong className="font-semibold text-slate-900 dark:text-slate-100">Anything sold to anyone.</strong> We
              do not sell or rent your information, and we do not use it for advertising or ad targeting.
            </>,
          ]}
        />
      </Section>

      <Section heading="Analytics and session replay">
        <p>
          We use product analytics to see which parts of the app work and where people get stuck. This includes session
          replay, which records how the interface was used — clicks, scrolling, navigation, hesitation — so we can watch
          a confusing screen back rather than guess at it.
        </p>
        <p>
          Replay is deliberately blinded to your content. Passwords, email fields, and every free-text box are masked
          before anything leaves your browser, as is text we display back to you from your own work: your transcript,
          the quoted phrases in your feedback, and your email address in the header. Analytics events carry only coarse
          metadata — an event code, a level, a score number — never your response text, transcript, or scenario content.
        </p>
      </Section>

      <Section heading="Who else processes your data">
        <p>We use a small number of vendors to run the service. They process data on our behalf, not for their own purposes:</p>
        <Bullets
          items={[
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Anthropic</strong> — generates practice scenarios and grades your responses.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">AssemblyAI</strong> — transcribes spoken reps to text.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Supabase</strong> — authentication and the database holding your sessions.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">PostHog</strong> — product analytics and session replay.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Google</strong> — only if you choose to sign in with Google.</>,
            <><strong className="font-semibold text-slate-900 dark:text-slate-100">Render</strong> — hosting.</>,
          ]}
        />
      </Section>

      <Section heading="Storage on your device">
        <p>
          We use your browser's local storage for things that keep the app usable: your theme, whether you have seen the
          tour, how many free practice runs you have left, and your signed-in session. These are not advertising
          cookies, and we do not use any.
        </p>
      </Section>

      <Section heading="Students and minors">
        <p>
          PI Coach is built for high-school DECA competitors, so most of our users are minors. That shaped the design
          rather than being bolted on afterward: practice works without an account at all, raw audio and video are never
          retained, and analytics carries no schoolwork content.
        </p>
        <p>
          The service is not directed to children under 13, and they should not create an account. If you are a parent,
          guardian, or teacher and believe a child under 13 has made one, write to{" "}
          <a className="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          and we will delete it.
        </p>
      </Section>

      <Section heading="Your choices">
        <Bullets
          items={[
            <>Use the whole practice loop without an account, and we store nothing about you.</>,
            <>Sign out at any time, which also unlinks this browser from your account in our analytics.</>,
            <>Decline the camera. Video practice is opt-in and the rest of the app is unaffected by refusing it.</>,
            <>
              Ask us for a copy of your data, or ask us to delete it, at{" "}
              <a className="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>
              . Deleting your account deletes your saved sessions and study progress along with it.
            </>,
          ]}
        />
      </Section>

      <Section heading="Security">
        <p>
          Traffic is encrypted in transit. Database rows are protected by row-level security so a session can only ever
          be read by the account that created it, and our server keys never ship to the browser. No system is perfect,
          and we do not claim otherwise — but we hold much less about you than we could, which is the most reliable
          protection there is.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If we change what we collect or who processes it, we will update this page and the date at the top. Continuing
          to use PI Coach after a change means you accept the updated policy.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions, corrections, or deletion requests:{" "}
          <a className="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}

// --- /terms -----------------------------------------------------------------

export function TermsApp() {
  return (
    <LegalPage title="Terms of Service">
      <Section heading="Agreement">
        <p>
          By using PI Coach you agree to these terms. If you do not agree, please do not use the service. If you are
          under 18, you should have a parent, guardian, or teacher review these terms with you.
        </p>
      </Section>

      <Section heading="What PI Coach is, and is not">
        <Callout>
          PI Coach is independent practice software. It is not affiliated with, endorsed by, or sponsored by DECA Inc.,
          it does not reproduce official DECA materials, and its scores are practice coaching — never an official
          competition result or any indication of how a real judge will score you.
        </Callout>
        <p>
          Our scenarios are original, and we grade against our own evaluation framework rather than any organization's
          published materials.
        </p>
      </Section>

      <Section heading="Feedback is generated by AI, and can be wrong">
        <p>
          Scenarios, scores, and written feedback are produced by AI models. They can be mistaken, inconsistent between
          runs, or confidently wrong about business concepts. Treat the feedback as a sparring partner, not an
          authority: useful for reps and for spotting patterns, not a substitute for your instructor, your own judgment,
          or official competition guidelines. Do not rely on it for academic, financial, or professional decisions.
        </p>
      </Section>

      <Section heading="Your account">
        <p>
          Accounts are optional. If you make one, use an email address you control, keep your password to yourself, and
          do not share the account. Tell us promptly if you think someone else has access to it. You are responsible for
          what happens under your account.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <p>Please do not:</p>
        <Bullets
          items={[
            <>Scrape, bulk-download, or systematically extract our scenarios, evaluation framework, or study content.</>,
            <>Resell, sublicense, or republish any part of the service as your own.</>,
            <>Submit other people's personal information, or anything unlawful, harassing, or hateful.</>,
            <>Attempt to break, overload, or circumvent limits on the service, including its usage caps and rate limits.</>,
            <>Use the service in any way that breaks your competition's rules of conduct or your school's policies.</>,
          ]}
        />
        <p>We may suspend or remove accounts that do these things.</p>
      </Section>

      <Section heading="What you write stays yours">
        <p>
          You keep ownership of the responses you write or speak. You give us permission to process them for one
          purpose: running the service for you — transcribing, grading, showing your feedback, and tracking your
          progress. We do not claim your work, publish it, or sell it. See our{" "}
          <a className="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href="/privacy">
            Privacy Policy
          </a>{" "}
          for what is stored and for how to have it deleted.
        </p>
      </Section>

      <Section heading="What we own">
        <p>
          The software, the evaluation framework, the study corpus, the generated scenarios, and the PI Coach name and
          marks belong to us. Using the service does not transfer any of that to you.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          PI Coach is provided as is, without warranties of any kind. Practice runs may be limited, features may change
          or be removed, and the service may be unavailable at times. We may modify or discontinue it, and will try to
          give notice when a change is significant.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental, or consequential damages, or
          for any competition outcome, grade, or opportunity you attribute to using or being unable to use PI Coach. Our
          total liability is limited to the amount you have paid us, which for a free account is nothing.
        </p>
      </Section>

      <Section heading="Ending your use">
        <p>
          You can stop using PI Coach whenever you like and ask us to delete your account. We may suspend accounts that
          violate these terms. The sections about ownership, disclaimers, and liability survive after your account ends.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>These terms are governed by the laws of {GOVERNING_LAW}, without regard to its conflict-of-law rules.</p>
      </Section>

      <Section heading="Changes">
        <p>
          We may update these terms and will change the date at the top when we do. Continuing to use PI Coach after an
          update means you accept the new terms.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions about these terms:{" "}
          <a className="font-medium text-indigo-600 hover:underline dark:text-indigo-400" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
