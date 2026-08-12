---
target: the onboarding first-rep intro
total_score: 36
p0_count: 0
p1_count: 0
timestamp: 2026-07-17T03-33-35Z
slug: frontend-src-onboarding-tsx-presessionscreen
---
# Critique — Onboarding / first-rep intro (PI Coach)

⚠️ DEGRADED: single-context (sub-agents unavailable — session usage limit). One reviewer ran both the design read and the detector inline. Detector (detect.mjs on onboarding.tsx + onboardingData.ts): **exit 0, no findings**. Browser overlay unavailable.

Target: `PreSessionScreen` in frontend/src/onboarding.tsx (the guided first-rep intro shown only to brand-new accounts).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | The 4 steps preview exactly what's coming; can't-record state handled. |
| 2 | Match System / Real World | 4 | Plain, concrete language ("a friend's coffee cart"); no jargon. |
| 3 | User Control and Freedom | 4 | Type fallback + a clear "Skip the intro" escape (76). |
| 4 | Consistency and Standards | 4 | Uses shared primitives, one eyebrow, fully on-palette. |
| 5 | Error Prevention | 4 | Sets expectations BEFORE the mic turns on; disables speak when !canRecord and explains. |
| 6 | Recognition Rather Than Recall | 4 | Everything visible; nothing to remember. |
| 7 | Flexibility and Efficiency | 3 | Speak / type / skip — the right three paths. |
| 8 | Aesthetic and Minimalist | 4 | One clean Card, restrained; genuinely minimal. |
| 9 | Error Recovery | 3 | can't-record fallback is graceful; little else to recover. |
| 10 | Help and Documentation | 4 | The whole screen IS orienting help, done well. |
| **Total** | | **36/40** | **Good→Excellent — a textbook activation screen; the best-executed single surface in the app.** |

## Anti-Patterns Verdict
**LLM:** Clean. No gradients, no gradient text, no off-palette violet/fuchsia, no identical card grids, no side-stripes; exactly one Eyebrow (onboarding.tsx:25); rationed indigo (one BTN_PRIMARY on "speak", BTN_SECONDARY on "type"). The only drift is **three functional emoji** (🎙️ / ⌨️ on the mode buttons, 🎙️ in the privacy note) — purposeful icons, but the closest thing to the gamified pole here.
**Detector:** exit 0 — no findings on onboarding.tsx or onboardingData.ts.
**Browser:** Not available — fallback signal.

## What's Working
1. **Expectations set before the mic turns on** — the 4-step "here's exactly what's about to happen" list (33–45) is exactly the anxiety-reduction a nervous first-timer needs; it teaches through a preview of action, not a wall of text.
2. **Honest privacy note, in plain words** (47–51) — "transcribed to measure delivery… then discarded. Never stored or judged for tone or confidence." Trust-building and on-brand.
3. **Graceful voice-optional design** — speak is primary + "recommended", type is a first-class secondary, and !canRecord disables speak, explains why, and still delivers full content feedback (66–70). "Voice always paired with a typed path," done right.

## Priority Issues
**[P2] Possible time-promise mismatch** — the eyebrow says "Your first rep: 2 minutes" (25) while step 2 promises `{prepMin} minutes` to think + step 3 a 60–90s answer + feedback. If prepMin ≥ 2, the total exceeds the "2 minutes" headline. Verify the numbers reconcile, or soften the headline ("about 2 minutes of talking"). An anxious first-timer counts on that promise. → `/impeccable clarify`

**[P3] Functional emoji could be inline SVG** — 🎙️ / ⌨️ on the buttons and 🎙️ in the note render inconsistently across OS and are the one whiff of the gamified pole. Swap to a single muted inline-SVG mic/keyboard set for consistency with the rest of the system. → `/impeccable distill`

**[P3] Disabled "speak" button leans on a title tooltip** (58) — disabled buttons don't reliably surface `title`, and the reason is also (correctly) in the note below, so the tooltip is redundant-at-best. Minor; the note carries it. → `/impeccable harden`

**[P3] The privacy note is a soft panel-in-card** (47, border+tint inside the Card) — not a true nested Card, but the same panel-in-card texture flagged elsewhere; fine here given it's a single callout. Leave as-is unless standardizing.

## Emotional Journey (nervous brand-new user)
Near-ideal. The headline ("Let's do one quick round so you can see how this works") lowers stakes; the numbered preview removes fear-of-the-unknown; the privacy note pre-empts the "is my voice being judged?" worry; and the "recommended" nudge toward speaking, paired with an easy type escape, means no one feels trapped. The single clear next action (one indigo button) is exactly what a first-run screen should offer. This screen does the north star — nervous → ready — better than any other in the app.

## Persona Red Flags
- **Jordan (first-timer):** essentially none — this screen is built for Jordan. Only nit: if the "2 minutes" promise doesn't reconcile with the steps, Jordan notices.
- **Sam (a11y):** the `<ol>` + numbered badge slightly double-announces the step number; the disabled-button title is unreliable (covered by the note). Otherwise focus rings inherit from the shared buttons and copy contrast is above floor (slate-600/700).
- **Casey (mobile):** buttons go `sm:flex-1` and stack on mobile — good thumb targets; the card is `max-w-2xl` and reads fine one-handed.

## Minor Observations
- Copy is tight and coach-voiced throughout — no changes needed to tone.
- Body text is slate-600/700 (above the contrast floor) — no sub-floor problem here, notably unlike most other surfaces.
- No motion on this screen, so nothing to guard for reduced-motion.

## Questions to Consider
1. Does the "2 minutes" headline actually match prep + speak + feedback — and if not, is under-promising time the safer move for a nervous first-timer?
2. This is the app's best-behaved surface (on-palette, rationed indigo, honest, minimal). What did it get right that the dashboards didn't — and can that discipline be back-ported as the reference pattern?
