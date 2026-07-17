---
target: the study course
total_score: 28
p0_count: 0
p1_count: 3
timestamp: 2026-07-17T02-58-40Z
slug: frontend-src-course-tsx-studycourse
---
# Critique — Study Course (PI Coach)

Method: **single-assessment (A: design-review only).** ⚠️ Assessment B (detector) did not complete — session usage limit interrupted it — so the deterministic scan for `course.tsx` is unverified; findings below are line-precise from source review but were not corroborated by the detector. Browser overlay also unavailable.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Headline number + per-unit bars; but bare-text loading, no spinner, bars lack role=progressbar/aria-valuenow. |
| 2 | Match System / Real World | 4 | "Core path", "Everything", event clusters, coach voice. Best-in-class. |
| 3 | User Control and Freedom | 3 | "Change event" escape is good; enroll has no undo. |
| 4 | Consistency and Standards | 2 | Violates its own system: gradient bars/banner, off-palette violet, borrowed scoring hues, slate-400 below floor, TierTab off-primitive. |
| 5 | Error Prevention | 3 | Empty-id launches guarded; 404 treated as "not picked"; Blitz disabled when no ids. |
| 6 | Recognition Rather Than Recall | 3 | Good labels; but no "start here/next up" despite the ordered-path promise. |
| 7 | Flexibility and Efficiency | 2 | No resume, jump-to-next-unfinished, shortcuts, or unit deep-link. |
| 8 | Aesthetic and Minimalist | 3 | Clean, but the gradient ⚡ Blitz banner + emoji inject gamified noise. |
| 9 | Error Recovery | 2 | Raw e.message dump in red (109); no retry. |
| 10 | Help and Documentation | 3 | Copy is self-documenting. |
| **Total** | | **28/40** | **Acceptable — legible + well-written, pulled down by self-inconsistency (color), thin edges, power-user gaps.** |

## Anti-Patterns Verdict (design review; detector unverified)
Course **partially reuses the off-palette DECA sequence — and in the two most load-bearing places on the screen (the progress display itself):**
- **Off-palette violet + gradient fill** — the Blitz banner is `bg-gradient-to-br from-indigo-50 to-violet-50` (course.tsx:173); **every progress Bar is `bg-gradient-to-r from-indigo-500 to-violet-500`** (255). The exact "indigo→violet wash" the Don'ts name, applied to the element whose whole job is to communicate mastery.
- **Scoring-hue decoration** — emerald "✓ done" unit badge (206) borrows Exemplary Emerald for a generic completion flourish; amber signed-out notice (155) borrows Developing Amber for a warning.
- **Identical unit stack** — units are one Card template ×N (189–231) with no asymmetry/scale/"next" affordance.
- **Per-unit eyebrow** — the mono domain micro-label is stamped on every unit card (197).
- PASS: no nested cards, no side-stripes, no gradient text, single top eyebrow per view.

## What's Working
1. **Copy is the coach** (126/167/296) — specific, encouraging, non-coddling; does real IA work (Core vs Everything without a tooltip).
2. **Tier-aware progress math** (91–99) recomputes counts against the visible tier, with a comment explaining why ("0/8 next to a 4-term core unit makes the path look unfinishable"). Design empathy in logic.
3. **Structural restraint** — no nested cards, deferred term-loading (76–89), a sensible "Change event" escape.

## Priority Issues
**[P1] The progress bar is an indigo→violet gradient — the mastery display itself is off-system** (course.tsx:255, inherited by every bar). A triple hit: banned gradient fill + off-palette violet + on the one element whose job is status. Fix: solid `bg-indigo-500` track (or the legitimate home for the scoring ramp if you want low/high reading). → `/impeccable colorize`

**[P1] Two Signal-Indigo primaries + a gamified Blitz banner compete on one view** — headline "Start this path" (162) and the Blitz banner button (181) on the violet gradient panel (173) with a ⚡ emoji (175). Fix: flatten the banner to a hairline Card, make its action BTN_SECONDARY, reserve the one indigo primary for "Start this path"; drop/demote the emoji. → `/impeccable quieter`

**[P1] Accessibility floor breached** — slate-400 meaningful text (197 domain, 213 done/total, 285 loading), slate-300 metric denominator (144); TierTab has no focus-visible ring (240); EventPicker buttons no focus ring (310); Bar has no role=progressbar/aria-valuenow (251); tier "selected" is color-only (no aria-pressed/role=tab). Fix: lift metadata to slate-500/600; add the shared focus-visible pattern; label the bars; expose tier state. → `/impeccable harden`

**[P2] "Ordered path" promise unmet** — copy sells an ordered path you finish one unit at a time (296), but the UI is a flat, all-unlocked, identical stack with no order cue/"start here"/next-up/locked state; a returning student can't tell where they left off. Fix: a single "Next up/Continue" affordance (first unit with done<total) with distinct emphasis; subtle done/in-progress/untouched treatment. → `/impeccable clarify`

**[P2] Scoring ramp spent on decoration** — emerald "✓ done" (206), amber signed-out notice (155). Fix: unit completion in indigo/neutral-ink + check (status, not scoring); signed-out notice in neutral slate. → `/impeccable colorize`

**[P3] Thin edge states** — bare "Loading events…" (285), raw e.message in red with no retry (109), no explicit empty-course state ("across 0 units" will print, 127). Fix: skeleton for the picker, friendly error + Retry, explicit empty state. → `/impeccable polish`

## Emotional Journey
Warm, human opener ("What are you competing in?", 293); the big mono readiness number + percent (142–145) deliver the nervous→ready payoff. Then the drift: the gradient-and-⚡ Blitz banner (173) pulses toward the gamified pole, and the eye bounces between two indigo CTAs; the promised "path" resolves into an undifferentiated identical stack with no "you are here"; completing a unit gives an emerald ✓ (206) that spends the exact green the scoring screen should own. Net: supportive and readable, undercut by borrowed sparkle and a missing sense of direction.

## Persona Red Flags
- **Alex (power user):** no resume/continue, no jump-to-next-unfinished, no shortcuts/deep-link, no ordering despite the path framing — re-scans an identical stack every session; two indigo CTAs slow the "just start" reflex.
- **Sam (a11y):** focus invisible on the tier toggle (240) and event buttons (310); progress bars announce nothing (251); meaningful counts at slate-400/300 below 4.5:1 (213/144/197); tier selected state is color-only; ✓/⚡/→ glyphs carry meaning without labels.
- **Casey (mobile):** mostly responsive; the unit row's right cluster (done/total + ⚡ Blitz + Study →, 212–226) crowds/wraps on narrow screens; headline metric + tier tabs (137–151) compete for one line.

## Minor Observations
- Card always attaches a hover-lift shadow (ui.tsx:18) even for non-interactive containers — tension with Flat-By-Default.
- TierTab reimplements button styling inline (240–244) instead of composing the shared primitives — why it drifted (no focus ring). A shared toggle primitive would prevent recurrence.
- The headline "/total" at slate-300 (144) is nearly invisible — arguably the more anxiety-relevant figure.
- Even one ⚡ lightning bolt (175/218) is worth questioning against "not gamified".

## Questions to Consider
1. Is this a path or a menu wearing a path's copy? Every unit is unlocked, identical, orderless — if order matters, why can't the UI say where to start?
2. Have you spent your green before the student earns it? When a unit flips emerald for browsing flashcards (206), does the real feedback screen still have color left to mean something?
3. Which button is "the one thing to do next?" Two Signal-Indigo primaries + the gradient-and-lightning Blitz treatment out-shout the readiness number that should be the hero.
