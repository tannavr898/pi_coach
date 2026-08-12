---
target: the flashcards surface
total_score: 27
p0_count: 0
p1_count: 2
timestamp: 2026-07-16T21-11-05Z
slug: frontend-src-flashcards-tsx-flashcards
---
# Critique — Flashcards (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable — deterministic detector + source grep only. Scope: FlashcardLibrary + Flashcards study overlay + FlipCard in flashcards.tsx.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | X/Y counter, loading/error/empty present; but flip/card-change have no aria-live. |
| 2 | Match System / Real World | 3 | "Four beats", worked example land well; Blitz copy hardcodes "5 terms, 45s". |
| 3 | User Control and Freedom | 3 | Esc/Prev/Next/flag work; backdrop-click closes instantly, focus never restored. |
| 4 | Consistency and Standards | 2 | Off-palette violet/fuchsia; a span role=button nested in a button; multiple indigo primaries. |
| 5 | Error Prevention | 2 | Accidental backdrop-dismiss, no focus trap, broken disabled label "Study : →". |
| 6 | Recognition Rather Than Recall | 3 | Keyboard legend + search + domain grouping; flag has no hotkey. |
| 7 | Flexibility and Efficiency | 3 | Arrows/space/Esc help; no shuffle, flag hotkey, jump-to-index, or self-grade filter. |
| 8 | Aesthetic and Minimalist | 2 | Gradient banner + 4-hue beats + amber overload + ⚡ emoji + 3 CTAs = busy. |
| 9 | Error Recovery | 3 | Error states surface the real message. |
| 10 | Help and Documentation | 3 | Inline hints, flag title/aria-label. |
| **Total** | | **27/40** | **Acceptable — solid study bones, dragged by color garnish + overlay a11y.** |

## Anti-Patterns Verdict
**LLM:** Biggest signal is chromatic. Off-palette: the four BEATS are indigo→**violet**→**fuchsia**→amber (flashcards.tsx:17–20), fuchsia repeats at :162. Gradient wash: the Mastery Blitz banner is `bg-gradient-to-br from-indigo-50 to-violet-50` (:279) — the exact indigo→violet wash the Don'ts name. Scoring-hue misuse: amber (Developing, #f59e0b) does TRIPLE duty — flag star (:189/:350), Flagged-set tone (:371), "Common mistake" box (:171–173) — and everything weak is painted amber (:324/:342), erasing the red (novice) band even though weakIds includes both (:226). CLEAN: exactly one Eyebrow (:266); no literal nested Card; no gradient text.
**Detector (exit 2):** Confirms ai-color-palette @279 (indigo→violet gradient) + 6 font-size advisories (text-[9/10px] micro-labels). violet @18/279, fuchsia @19/162 confirmed by grep. amber usage is semantic. No side-tabs, no wide grids, no arbitrary z-index. **Reduced-motion:** no file-local guard, but the 0.5s inline flip (:125) is overridden to instant by the global index.css:114 `!important` rule (the `!important` beats the inline transition) — so the flip collapses cleanly, no freeze/spin.
**Browser:** Not available — fallback signal.

## What's Working
1. **Motion discipline holds** — the flip (:125) is correctly overridden to instant by the global reduced-motion carve-out; no bespoke motion escapes the system.
2. **Mental-model consistency** — reuses the Tips four beats (:16–21) + plain-def / worked-example / one-mistake back, so a student learns one method everywhere; loading/error/empty states all speak specifically.
3. **Readiness is visibly the metric** — weak criteria pulled from real progress, surfaced as "Recommended for you", per-domain "N to drill" badges; flag state persists.

## Priority Issues
**[P1] Off-palette + overloaded color** — violet/fuchsia (17–20/162) are undefined hues; the Blitz gradient (279) is the forbidden wash; amber does triple duty so the ramp stops meaning "assessment". Fix: recolor the four beats within-system (ink weight + a single Accent-Indigo for "most points"); flat indigo-tinted Blitz banner; reserve amber for assessment-derived weakness only; give **flag** a non-ramp affordance (indigo/neutral star); make the "Common mistake" box slate. → `/impeccable colorize`

**[P1] Study-overlay accessibility** — the overlay has no role="dialog"/aria-modal/labelledby, never moves focus in, never traps, never restores on close (:89–116). The FlipCard is a bare `div` + onClick (:124) — not focusable, no role/aria-pressed; the only keyboard flip is the global space handler, which preventDefaults space (:75) and hijacks it from any focused Prev/Next/Close. Both faces are always in the DOM (backface-visibility is visual only) so a screen reader reads front AND back at once. In the library, a `<span role="button" tabIndex={-1}>` is nested inside the chip `<button>` (:337–353) — invalid interactive nesting + keyboard-unreachable flag. Fix: real dialog (role/aria-modal/labelledby, focus-in/trap/restore); card as `<button aria-pressed>` (or role=button tabIndex=0 + Enter/Space scoped) and stop globally preventDefaulting space; aria-hidden the non-visible face + an aria-live "card N of M"; split the flag out of the chip button. → `/impeccable harden`

**[P2] No self-grade on the flip (core-loop gap)** — the product's thesis is honest self-assessment, yet the flip offers only Prev/Next/Flag — no "knew it / didn't" (:104–113). All grading is exiled to the separate Mastery Blitz; the flip is passive recognition, the weakest study form. Fix: a two/three-way self-grade on the back ("Missed it / Got it") wired to keys 1/2/3, feeding the weak-set + next-card ordering; keep flag as the orthogonal "revisit". → `/impeccable clarify`

**[P2] Rationed-indigo broken on the library** — "Blitz weak terms" (:288) + both SetCard "Study" buttons (:377) are all BTN_PRIMARY on one view. Fix: one primary for the view (likely "Blitz weak terms"), demote the rest to secondary/ghost. → `/impeccable quieter`

**[P3] Contrast + copy polish** — text-slate-400 carries meaning below AA at :100/:138/:260; overlay chrome is text-white/85–/60 over a merely 60%-dimmed backdrop (:93/:108/:111), unreliable over light content; the disabled SetCard renders the literal "Study : →" (:378); heading order jumps h1→h3 before h2. Fix: raise hints to slate-500; solid/darker scrim behind overlay text; fix the empty-count label; reorder headings. → `/impeccable polish`

## Emotional Journey
The library greeting is warm and orienting ("All N terms, by domain", weak spots as "to drill"). The flip is a nice moment of focus. Then frictions accumulate: the reveal is **tap-only with no "did I get it?" beat**, so studying feels like passive browsing, not testing; the ⚡ banner + multicolor beats add a faint carnival note; a keyboard/SR student quietly falls off the path. Net: confident → engaged → subtly under-served, exactly at the moment the product's thesis (honest self-assessment) should pay off.

## Persona Red Flags
- **Alex (rapid study):** space is stolen from focused buttons (:75); no shuffle (static order); no flag hotkey; no self-grade to drill misses; Prev/Next dead-end at edges (:86) with no wraparound; no jump-to-index.
- **Sam (a11y):** the most-failed persona — card not focusable + announces nothing on flip/advance; both faces read at once; modal isn't a dialog and doesn't trap/restore focus; library flag is tabIndex=-1 inside another button (invalid + unreachable).
- **Casey (mobile):** flag stars in the TOP corners of a 24rem card (:130–132) — hardest one-handed reach; tap targets under ~44px (:189/:346); backdrop-tap-to-close (:90) invites losing your place; fixed height:24rem risks clipping in landscape.

## Minor Observations
- Blitz banner claims "5 terms, 45s each" (:283) while launching sets of arbitrary size — copy and behavior disagree.
- Global keydown rebinds every render (:70–79); arrow keys can also scroll the back-face overflow region (competing behaviors).
- ⚡ emoji (:281/290/328/380) is the one whiff of the gamified pole; a mono "BLITZ" label reads sharper.
- The two SetCards could break sameness (asymmetry/scale) rather than mirror each other.

## Questions to Consider
1. If the trust proposition is honest self-assessment, why does the flip let a student reveal the answer but never record whether they knew it — is a "study later" flag quietly substituting for the self-grade that should exist?
2. Amber already means "Developing" on the sacred ramp. Once it's also the flag color, the mistake box, and every weak chip, has the ramp's earned meaning already leaked out of assessment?
3. Should tapping really be the sole reveal mechanic when the keyboard/SR student has no focusable card and hears both faces at once — is the flip an interaction or just an animation that happens to be mouse-operable?
