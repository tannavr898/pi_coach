---
target: the practice flow
total_score: 33
p0_count: 0
p1_count: 2
timestamp: 2026-07-16T21-01-53Z
slug: frontend-src-app-tsx-practiceflow
---
# Critique — Practice flow (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable — deterministic detector + source grep only. Scope: PickScreen → Loading → Ready → Prep → Walk-in → Respond → Follow-up.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong visually (sticky timer, staged loader); zero for AT — TimerBar (3710) has no role/aria-live; error banner (628) no role=alert. |
| 2 | Match System / Real World | 4 | Best-in-class: "Enter the room", "The judge asks you"; Walk-in is a real achievement. |
| 3 | User Control and Freedom | 3 | Clock on your cue, re-record; but auto-start seizes the clock, no Respond→Prep back, silent pause on "Continue". |
| 4 | Consistency and Standards | 3 | Gradient CTA breaks BTN_PRIMARY; two toggle components for near-identical choices. |
| 5 | Error Prevention | 3 | Generate gated on event; silent-clip caught; auto-start can create an unwanted running clock. |
| 6 | Recognition Rather Than Recall | 4 | Focus chips, cover sheet, scenario re-openable in Respond. |
| 7 | Flexibility and Efficiency | 3 | ⌘/Ctrl+Enter to generate but undocumented; prefetch is a nice invisible win. |
| 8 | Aesthetic and Minimalist | 3 | Triple-labeling, gradient CTA, emoji density drift toward the cartoonish pole. |
| 9 | Error Recovery | 3 | Excellent, actionable copy; but banner un-announced and can scroll off-screen on mobile. |
| 10 | Help and Documentation | 4 | Tips link, Learn-mode teaching, RubricNote, HonestyNote, cover-sheet explainer. |
| **Total** | | **33/40** | **Good — emotionally intelligent flow, one systemic a11y gap + a few forbidden DON'Ts leaking in.** |

## Anti-Patterns Verdict
**LLM:** Gradient-filled CTA — PickScreen primary is `bg-gradient-to-r from-indigo-600 to-violet-600` (App.tsx:1741), the exact indigo→violet wash the doc forbids, and inconsistent (Hero primary is solid). Scoring-hue garnish — Exemplary Emerald as "✓ Recorded" (2475) and decorative "🧮 math-checked" pills (1662, 2190). Borderline eyebrow cadence (three of the first four screens carry a mono kicker: 1613/2175/3683). Minor nested card — CriterionBrief tiles are bordered surfaces inside the CoverSheet Card on Prep (3652/3660). Plus non-codified **triple-labeling** on PickScreen: eyebrow "Set up your role-play" (1613) + H1 "Build your role-play" (1615) + card H2 "Set up a role-play" (1631) — three synonyms for one concept in one viewport. CLEAN: gradient text, identical grids, side-stripe borders.
**Detector (exit 2):** In-range confirms: ai-color-palette @1741 (the gradient CTA + violet), text-[10px] advisories @1658/1662, gray-on-color @2514 (FollowupScreen — one real light-mode slate-800-on-indigo-50, borderline). Adds **6 `text-slate-400` body-copy hints** posing a contrast risk: 1669/1705/1719 (PickScreen hints), 2284 (Walk-in note), 2348 (Respond hint), 2539 (Follow-up hint) + 3798 (Loading step). Emerald decorative at 1662/2190/3806. onboarding.tsx clean. Whole-file side-tab @4188 is TipsPage (out of flow).
**Browser:** Not available — fallback signal.

## What's Working
1. **The walk-in beat + honest on-your-cue clock.** WalkinScreen ("You're up next", door motif, "won't start until you begin", 2282) + "the prep clock only starts when you press the button" (2181) is the "rehearse the room" north star made literal, with restraint. Auto-start countdown respects agency.
2. **Error copy that coaches** — mic/transcription branches (2434–2440, 544–549) are specific, calm, and always offer the typed fallback (honors "voice always paired with typed").
3. **Load discipline** — scenario behind `<details>`, criteria only when useful, Learn/Competition gating the teaching layer, prefetch hiding latency. One decision per screen.

## Priority Issues
**[P1, borders P0] The timer is invisible to assistive tech** — TimerBar (3710) has no role="timer"/aria-live/aria-label; "5:00" reads ambiguously; state transitions ("Wrap up soon", "Time's up") and the auto-start "Starting in 5…" (2254) change silently, so a blind student is auto-started with no warning and never hears time run out. PRODUCT.md commits the timed steps to "must not depend on hearing alone" + WCAG 2.1 AA. Fix: aria-live region with a spoken-form label ("5 minutes 0 seconds remaining"); announce amber/expiry + the auto-start countdown. → `/impeccable harden`

**[P1] Gradient primary CTA** (App.tsx:1741) violates the explicit Don't and un-rations indigo (inconsistent with the solid Hero primary). Fix: solid BTN_PRIMARY. → `/impeccable colorize`

**[P2] Scoring hues as generic success garnish** — Exemplary Emerald on "✓ Recorded" (2475) + math pills (1662/2190). Green stops meaning "earned" on the feedback screen. Fix: neutral/slate for confirmations; reserve emerald for scores. → `/impeccable colorize`

**[P2] Errors shown but not announced, can scroll off-screen** — banner (628) is a plain div at top of main, no role="alert"; on the spoken path a mic failure returns to Respond with the message pinned far above the recorder (may be off-screen on mobile). Fix: role="alert"; render the mic/transcription error INSIDE VoiceRecorder (local err slot at 2458). → `/impeccable harden`

**[P2] Sub-floor contrast on flow hints** — six `text-slate-400` body hints (1669/1705/1719/2284/2348/2539 + loader 3798) below the slate-500 floor. Fix: promote meaning-bearing hints to slate-500. → `/impeccable harden`

**[P3] Triple-labeling + card-in-card on setup/prep** — three synonymous headings on PickScreen (1613/1615/1631); CriterionBrief bordered tiles nested in the CoverSheet Card (3652/3660). Fix: one heading + supporting line; flatten criterion tiles to hairline-divided rows. → `/impeccable distill`

## Emotional Journey (the flow's strongest dimension)
Deliberately paced to metabolize nerves: Ready reassures ("prep clock only starts when you press"), Prep gives an honest running clock, **Walk-in is the peak** (breather, door, opening script — the north star made literal), Respond's PresentClock coaches not punishes ("Clock paused. It starts the moment you begin"; "Time's up. You can still finish"). Gaps: (1) **no exhale before grading on the typed path** — spoken runs get DeliveryFirstScreen, typists jump straight to a bare loader; (2) **prep timer never warns** — pinned indigo the whole window, no "one minute left" before auto-advance; (3) **the silent pause mismatch** — "Continue to the judge's questions" pauses the window while the copy sells a continuous shared clock (trains for a kinder room than a real judge's).

## Persona Red Flags
- **Jordan (anxious first-timer):** disabled "Generate" button just fades — no "Pick an event first"; triple heading creates a "did I do this right?" wobble; scenario collapsed by default on Respond (2321) — mid-present panic + hidden situation. Net still calming thanks to the reassurance copy.
- **Sam (keyboard + SR on the clock):** the clock is the persona-defining failure (no name/role/live region — remaining time, thresholds, auto-start all silent); 40s+5s can elapse while reading via SR then start unannounced; Segmented (3598) + ModeToggle (2366) buttons lack aria-pressed/radiogroup. Keyboard operability is otherwise fine.
- **Casey (mobile, one-handed):** "Start recording" ≈36px tall (2460), under the 44px minimum (yet re-record uses min-h-11 — standard known but not applied to the primary record action); sticky clock + w-full Continue/Submit are good.

## Minor Observations
- Prep timer never ramps tone (2235 fixed indigo) — add an amber wrap-up like the present clock.
- The 40s idle grace is uncommunicated; select caret ▾ (1654) isn't aria-hidden; ⌘/Ctrl+Enter generate (1686) is undiscoverable.
- No explicit mid-flow "start over" on the loop screens (relies on header nav).
- Emoji density (🚪✏️⏱️🎯🗣️❓🧮) across Ready/Walk-in leans toward the school-worksheet register the brand's anti-reference rejects — worth a deliberate audit.

## Questions to Consider
1. The clock is your highest-stakes element and the one thing a screen-reader user cannot perceive at all — would you ship a timer you couldn't operate with your eyes closed?
2. The shared present window silently pauses on "Continue to the judge's questions," but a real judge's clock never stops — are you rehearsing them for a kinder room than the one they'll walk into?
3. You explicitly refuse "cartoonish," yet the flow leans on 🚪✏️⏱️🎯🗣️❓🧮 — where does reassuring warmth become the emoji-sticker register you claim to reject?
