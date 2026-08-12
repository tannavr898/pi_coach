---
target: the mastery blitz
total_score: 30
p0_count: 0
p1_count: 2
timestamp: 2026-07-17T03-33-36Z
slug: frontend-src-blitz-tsx-masteryblitz
---
# Critique — Mastery Blitz (PI Coach)

⚠️ DEGRADED: single-context (sub-agents unavailable — session usage limit). One reviewer ran both the design read and the detector inline. Detector (detect.mjs on blitz.tsx): exit 2 — 2 advisory `text-[10px]` findings (blitz.tsx:281, 323), both intentional mono micro-labels. Browser overlay unavailable.

Target: `MasteryBlitz` in frontend/src/blitz.tsx — a timed term-drill overlay (intro → drill → scoring → results).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Timer + progress bar + phase clear; but timer isn't announced and turns urgent by color only. |
| 2 | Match System / Real World | 4 | "Drill", "Define it, then Connect it", coach copy. |
| 3 | User Control and Freedom | 2 | Backdrop-click closes and loses the round (183); no Esc; no pause; auto-advance can't be stopped. |
| 4 | Consistency and Standards | 3 | Shared primitives + a legitimately-earned verdict ramp; some gamified drift; slate-400 counts. |
| 5 | Error Prevention | 2 | Backdrop-click-to-close mid-drill is a data-loss trap; no confirm on the terminal grade. |
| 6 | Recognition Rather Than Recall | 3 | Mode pills, term counter, scenario shown each term. |
| 7 | Flexibility and Efficiency | 3 | Type/speak; no pause, no back, no keyboard shortcuts for a rapid drill. |
| 8 | Aesthetic and Minimalist | 3 | Clean, but ⚡ + streak/best theatrics + emoji brush the gamified pole. |
| 9 | Error Recovery | 4 | Genuinely thorough — scenario/score/mic errors all surface with a fallback. |
| 10 | Help and Documentation | 3 | Intro explains the loop clearly. |
| **Total** | | **30/40** | **Acceptable — smart, robust drill; timed-a11y + modal safety are the gaps.** |

## Anti-Patterns Verdict
**LLM:** Cleaner than the other study surfaces. **No off-palette violet/fuchsia and no gradients** in blitz.tsx itself (the indigo→violet Blitz *launcher* banner lives in flashcards.tsx/course.tsx, not here). Crucially, the **scoring ramp is used correctly here** — results tone the verdict cards emerald/amber/red for correct/partial/missed (378–380), and this surface *actually grades* (a real batched model call at the end, 155), so the hues are **earned assessment, not decoration** — the exact thing Flashcards' flip was missing. Drift: the ⚡ emoji (186), "Session streak / Best" theatrics (391–394), and ✍️/🎙️/✓ emoji brush the "badge-grinding / no playful blobs" anti-reference. One soft leak: "✓ Answer captured" is text-emerald-700 (345) — Exemplary Emerald for a capture confirmation, not a score.
**Detector:** exit 2 — only two advisory `text-[10px]` micro-labels (281 "Your scenario", 323 "Use this term"). No warning-severity findings.
**Browser:** Not available — fallback signal.

## What's Working
1. **The verdict ramp is earned.** Because Blitz runs a real batched grade (155) and tones results by actual verdict (378–380), emerald/amber/red mean assessment here — the legitimate home the ramp was reserved for. This is where Flashcards' missing self-grade actually lives.
2. **Robust error/edge handling** — scenario-load error (277), score error (368), mic error (338), private-mode stats fallback (40), and background transcription that never blocks the drill (106–111). Unusually thorough.
3. **Smart model-free loop** — one scenario, per-term timer, a single cheap batched grade at the end; the drill stays fast and the latency hides behind the timer.

## Priority Issues
**[P1] The timer is invisible to assistive tech** (same theme as the Practice flow) — the countdown (blitz.tsx:314) and the progress bar (317) have no `role="timer"`/`aria-live`/`aria-label`; the ≤10s urgency is conveyed by **color alone** (309/314/317, red), and at 0 the drill **auto-advances** (142) with no announcement. A screen-reader or color-blind student gets no time signal and is silently advanced. PRODUCT.md commits timed steps to "must not depend on hearing alone" + WCAG 2.1 AA (and 1.4.1 color-alone). Fix: an aria-live region announcing remaining time + threshold ("10 seconds left"), a non-color urgency cue, and an announced auto-advance. → `/impeccable harden`

**[P1] Modal safety: no dialog semantics, no Esc, and backdrop-click loses the round** — the overlay (183) is `fixed inset-0 z-50` with `onClick={onClose}` (backdrop dismiss) but has no `role="dialog"`/`aria-modal`/`aria-labelledby`, no focus-in on open, no focus trap, no focus restore, and no Esc handler. A stray tap on the backdrop mid-drill **discards the whole timed round** with no confirm. Fix: real dialog semantics + focus trap/restore; remove backdrop-click-to-close during the drill (or confirm), keep the explicit ✕. → `/impeccable harden`

**[P2] Gamified drift** — ⚡ "Mastery Blitz" (186) + "Session streak / Best" (391–394) + emoji lean into the badge-grinding energy the brand explicitly rejects. A drill can be time-pressured without arcade theatrics. Fix: drop ⚡, keep a single quiet mono "streak" stat if any, and let the earned verdict cards carry the reward. → `/impeccable quieter`

**[P2] Sub-floor contrast** — the "Term 1/5" counter (313, slate-400), the scoring subtext (225, slate-400), the results denominator "/5" (388, slate-300), and the overlay chrome (186/187, white/85 & white/70 over a 70% scrim) sit below the meaning-bearing floor. Fix: raise counts to slate-500; give overlay chrome a solid backing or darker text. → `/impeccable harden`

**[P3] "✓ Answer captured" borrows Exemplary Emerald** (345) for a capture confirmation. Fix: neutral/indigo confirmation; reserve emerald for the graded verdict cards. → `/impeccable colorize`

## Emotional Journey
The intro is calm and clear ("Ready to drill 5 terms?" + exactly what happens). The drill itself is a genuine focus rush — the 45s clock and the red ≤10s ramp create productive pressure. The payoff (a real per-term verdict with notes) is satisfying and *earned*, and the emerald/amber/red cards read honestly. The dips: the ⚡/streak framing nudges the serious tool toward an arcade for a beat; and a mis-tap on the backdrop can vaporize a round, turning focus into frustration. Net: engaging and rewarding, with two sharp edges (timed-a11y, accidental dismissal).

## Persona Red Flags
- **Alex (power user):** no keyboard shortcuts for a rapid drill (no Enter-to-advance beyond the button, no hotkeys), no pause, no back; the mode toggle can't change mid-drill; a fast typist is well-served but can't accelerate past the per-term timer.
- **Sam (a11y — timed keyboard drill, SR on the clock):** the most-failed persona — the clock announces nothing and auto-advances silently; ≤10s urgency and the progress bar are color-only; the overlay isn't a dialog and doesn't trap/restore focus; no Esc.
- **Casey (mobile):** the record button and Next are reachable; but backdrop-tap-to-close (183) is a real hazard for a thumb near the panel edge during a timed round; the overlay chrome text (white/70) can be low-contrast over a bright page.

## Minor Observations
- The scoring spinner uses `pic-spin` (223), which is correctly exempt from the reduced-motion freeze — good.
- The "Recording…" pulse (341, animate-pulse) will be frozen by the global reduced-motion rule; paired with the "Recording…" label it still reads, but the only motion cue is gone — consider a non-motion recording indicator.
- Streak persistence is sessionStorage-only by design (no account) — fine, but "Best" resets each session, which undercuts the streak's motivational point.
- Results list caps at max-h-72 with overflow — fine for 5 terms.

## Questions to Consider
1. This is the one study surface that *actually grades*, so its emerald/amber/red is earned — should Flashcards' flip route into this instead of pretending to self-assess without recording anything?
2. A timed drill that auto-advances on a silent clock and can be dismissed by a stray backdrop tap — is the pressure coming from the content, or from the interface's own hazards?
3. "⚡ Mastery Blitz / streak / best": at what point does motivational framing become the badge-grinding the brand swore off — and does the earned verdict already provide the reward without it?
