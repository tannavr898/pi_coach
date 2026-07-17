---
target: the feedback screen
total_score: 34
p0_count: 0
p1_count: 2
timestamp: 2026-07-16T21-00-50Z
slug: frontend-src-app-tsx-feedbackscreen
---
# Critique — Feedback screen (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable — deterministic detector + source grep only.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Active tab/score/badges clear; but tab switch fires no aria-live (SR not told the panel changed). |
| 2 | Match System / Real World | 4 | Novice→Exemplary, "Focus next time", "Could've said" — coach register. |
| 3 | User Control and Freedom | 4 | Try-again / new-scenario / study paths; rows collapse; tabs free. |
| 4 | Consistency and Standards | 3 | Own law broken (border-l-2, fuchsia, borrowed emerald); tabs are plain buttons. |
| 5 | Error Prevention | 3 | Server-recomputed math check prevents a false "you were right." |
| 6 | Recognition Rather Than Recall | 4 | LevelLegend decodes the ramp in place; badges carry labels + points. |
| 7 | Flexibility and Efficiency | 3 | Sticky rail; but transcript highlights are mouse-only. |
| 8 | Aesthetic and Minimalist | 3 | 60/25/15 weighting explained twice; legend renders twice. |
| 9 | Error Recovery | 4 | This IS the recovery surface — "To raise the level, add", one_key_fix. Genuinely strong. |
| 10 | Help and Documentation | 3 | Abundant inline explanation (arguably too much). |
| **Total** | | **34/40** | **Good — a genuinely coaching screen, held back by a11y gaps + self-inflicted palette leaks.** |

## Anti-Patterns Verdict
**LLM:** Mostly clean and disciplined where it matters most. Three DESIGN.md Don'ts live here: (1) `border-l-2` accent stripes on the AnalysisTab evidence blockquotes (App.tsx:2938 indigo, 2990 fuchsia, 3013 emerald); (2) scoring-hue decoration — the Depth bonus borrows Exemplary Emerald (2997/3005/3013) for a "+bonus" flourish; (3) off-system color — the Creativity bonus imports **fuchsia** (2976/2982/2990), a hue nowhere in the palette. NOT violated: gradient text/buttons, eyebrow-spam (Eyebrow used sparingly), nested cards, identical grids (the 2-up Strengths/Focus is semantically opposed, not a clone).
**Detector (exit 2):** The named FeedbackScreen/CriteriaTab/AnalysisTab/DeliveryTab/LEVEL_TONE/LEVEL_FILL bodies have ZERO warning-severity findings (only advisory font-size). Corrections/additions: the recurring `side-tab` @L4188 is **TipsPage's MethodCard, NOT Feedback** (routed to the Tips critique); the three feedback `border-l-2` are 2px blockquote accents the detector did not flag (no card container) — lower risk than a true side-tab but still the §6 Don't. `SPEAKER_BAR` (3204) = `["bg-indigo-500","bg-teal-500","bg-amber-500","bg-rose-500"]` uses score-like hues (teal/amber/rose) as **categorical speaker identity** in TalkBalance — a real leak B adds. TabBar gray-on-color @2827 is a **ternary false positive** (slate-600/300 live on the inactive branch, never on bg-indigo-600).
**Browser:** Not available — fallback signal.

## What's Working
1. **The headline % is deliberately un-colorized** (App.tsx:2645, neutral slate) — color lives one level down in the LevelMeter pips. Textbook "coaching, never a verdict": a 45% doesn't arrive as a wall of red. The single most on-brand decision on the screen.
2. **Constructive scaffolding is real** — GapList "To raise the level, add" (3325), first-person "💡 Could've said" rewrites (3423), suggestions suppressed for exemplary criteria (3383), one-look read leading with a Strength (2858).
3. **Bidirectional transcript ↔ note linking with gentle scrollIntoView** (3386) — thoughtful on mobile where notes sit below.

## Priority Issues
**[P1] Meaningful helper/instruction text fails WCAG AA** — `text-slate-400` (#94a3b8 ≈2.9:1) on meaning-bearing copy: AnalysisTab descriptions (2965/2980/3001), AnalysisRow blurbs (2930), transcript instructions (3490/3492), note descriptions (3352). DESIGN floor is slate-500. Direct AA failure on the flagship screen. Fix: promote to slate-500 / keep dark:slate-400. → `/impeccable harden`

**[P1] Transcript highlights are mouse-only (keyboard inaccessible)** — `<mark onClick … className="cursor-pointer">` has no tabIndex/role/onKeyDown (3563–3568). The screen's signature affordance is unreachable by keyboard + invisible to SR — WCAG 2.1.1, and PRODUCT.md commits to "fully keyboard-navigable." Fix: real `<button>` (or tabIndex=0 + role + Enter/Space + aria-label + focus ring). → `/impeccable harden`

**[P2] Palette-discipline leaks in AnalysisTab** — fuchsia (off-system) + borrowed Exemplary Emerald + three border-l-2 stripes, on the screen whose whole trust premise is "the ramp means something." Fix: recolor both bonus cards to Accent Indigo (bonuses are additive signal); replace the border-l-2 quote stripes with a 1px hairline + tint or a leading glyph. Also recolor SPEAKER_BAR off score hues (or accept teal/rose as a deliberate non-score categorical set). → `/impeccable colorize`

**[P2] Weighting + legend each explained twice** — rail weighting (2654) restated below tabs (2689); LevelLegend on rail (2660) + in TranscriptNotes (3371). Inflates a nervous student's reading load. Fix: weighting in the rail only; drop the transcript-notes legend copy. → `/impeccable distill`

**[P3] Tabs lack ARIA tab semantics and change silently** — TabBar (2813) is plain buttons, no role=tablist/tab/aria-selected, no live announcement, panels not associated. Fix: wire the tabs pattern (or aria-live heading), roving tabIndex. → `/impeccable harden`

## Emotional Journey (nervous student, mediocre score)
- **Peak (open):** neutral headline number + Strength-first one-look read (2858→2864→2870) — protects the student; "coaching not verdict" delivered.
- **Dip (middle):** Transcript paints the student's OWN words in ramp-colored marks (3567); a Novice-heavy run becomes "a lot of red on my own sentences." Tints are faint and every gap is reframed constructively, but the aggregate read is the one spot tone drifts toward judgment.
- **End (peak-end):** strong — closes on "Try this scenario again" ("the fastest way to see your feedback pay off", 2730) + "Study your weak criteria." Leaves with a next rep, not a grade.

## Persona Red Flags
- **Jordan (low score):** protected at the open, but Transcript/Criteria render a wall of red/amber; and the fix path is present but NOT threaded — "Focus next time" (Overview) and the red badges (Indicators, the LAST tab) are three tabs apart.
- **Sam (a11y):** Delivery bars (3138) + Stat tiles (3261) convey good/warn/bad by hue ALONE (deuteranope can't tell the emerald "good" pace bar from red) — add a threshold label or ✓/! glyph; transcript highlights non-focusable (P1); tabs have no ARIA/live (P3); headline score reads as fragments.
- **Casey (mobile):** rail is lg:sticky only, so the score scrolls away and the 5 tabs become a horizontal strip with "Indicators" (the 60% chunk) partly off-screen; the duplicated weighting box adds a full scroll of redundancy.

## Minor Observations
- ScorePill weight labels are 9px slate-400 (2587/2592) — the "60%" is the least-glanceable text on the most-glanced element.
- `<mark>` classes have no dark variant (4318) → bright pastel blocks on the dark canvas (readable but off-system tonally).
- Transcript quote-matching is case-insensitive substring (3541); paraphrased evidence silently won't highlight, with no fallback.
- richText bolds via `**` (4348) — an odd number of `**` leaks raw asterisks into the coach's voice.
- OverviewTab has no empty-state floor (2843) — if summary/final/strengths/improvements are all empty it renders a near-blank div; the default tab should never look blank.

## Questions to Consider
1. If the headline number is deliberately neutral to avoid "verdict," why is the transcript — the student's own words — the most saturated ramp surface? Should it highlight what EARNED credit more loudly than what fell short?
2. The Indicators tab is 60% of the grade and the LAST tab. Is "what to fix" (one-look read → weak criteria → study) a treasure hunt across three tabs that should be one guided flow?
3. You wrote a strict Earned-Green law, then borrowed emerald for a bonus and imported fuchsia for another. If the rule can't survive its own bonus cards, is it too strict — or do the bonuses want an official fifth non-assessment accent?
