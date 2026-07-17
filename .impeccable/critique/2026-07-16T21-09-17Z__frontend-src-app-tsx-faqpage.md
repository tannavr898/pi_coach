---
target: the faq page
total_score: 30
p0_count: 0
p1_count: 1
timestamp: 2026-07-16T21-09-17Z
slug: frontend-src-app-tsx-faqpage
---
# Critique — FAQ page (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable — deterministic detector + source grep only. FAQ range App.tsx:3827–3985.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Open/close clear (group-open:rotate-45 ＋→×, open:shadow-md). |
| 2 | Match System / Real World | 4 | Questions mirror real anxieties ("Is using it against the rules?"). |
| 3 | User Control and Freedom | 3 | Native details open/close freely; no forced flow. |
| 4 | Consistency and Standards | 2 | CTA gradient+violet + font-display uppercase group titles diverge from the mono Eyebrow. |
| 5 | Error Prevention | 3 | No inputs; single unambiguous CTA. |
| 6 | Recognition Rather Than Recall | 3 | Grouped, question-first, but all answers collapsed. |
| 7 | Flexibility and Efficiency | 2 | No search, expand-all, or anchor/deep links. |
| 8 | Aesthetic and Minimalist | 3 | Clean; the gradient/violet card is the one non-minimal note. |
| 9 | Error Recovery | 3 | N/A surface. |
| 10 | Help and Documentation | 4 | This IS help; closes with "Still have a question?" → Feedback. |
| **Total** | | **30/40** | **Acceptable — disciplined bones, undercut by a palette break and a hidden reassurance.** |

## Anti-Patterns Verdict
**LLM:** Largely disciplined. Two failures: (1) **gradient + off-palette violet CTA card** (App.tsx:3974, `bg-gradient-to-br from-indigo-50 to-violet-50` — breaks the gradient-fill AND off-palette rules at once); (2) **per-section eyebrow cadence** — every FAQGroup h2 is `uppercase tracking-wider text-indigo-500` across all four groups (3842/3864/3898/3939/3953) on top of the real hero Eyebrow (3852), and these are font-display uppercase while the shared Eyebrow (1577) is font-mono — two competing eyebrow treatments. PASS: gradient text, gradient buttons (CTA is solid BTN_PRIMARY), side-stripes, nested cards.
**Detector (exit 2):** In-range confirms: ai-color-palette @3842 (indigo group label) + @3974 (the indigo→violet gradient card, both light/dark halves), design-system-font-size advisory @3831 (text-[15px] question title). No in-range side-tab, no body-text slate-400 (only the decorative ＋ icon), no grid-cols-3. Uses **native `<details>` accordion** — the correct accessible pattern (keyboard + expanded-state come free).
**Browser:** Not available — fallback signal.

## What's Working
1. **Native `<details>/<summary>` accordion** (3829–3835) — keyboard operability + focusability + expanded-state semantics come free and correct. The right primitive.
2. **Copy is on-brand and specific** — "It can't tell you you're wrong when you're right" (3886), "not trusted to do arithmetic" (3884). The "coaching, never a score" positioning in prose.
3. **Question-first IA** — 4 semantic groups matching real student worries (trust, differentiation, legality, improvement).

## Priority Issues
**[P1] Gradient + off-palette violet CTA card** (App.tsx:3974) — breaks two DESIGN.md rules at once (gradient fill + violet, outside the single indigo family); the one place the page stops modeling its own system. Fix: flatten to `bg-indigo-50 dark:bg-indigo-950/40` + full `border-indigo-200`; delete the to-violet stops. → `/impeccable colorize`

**[P2] The trust answer is collapsed** (App.tsx:3876–3878) — the single most anxiety-dissolving line ("practice coaching, not an official or predicted competition score") is hidden behind a click with every item closed. A nervous skimmer leaves with the question, not the answer. Fix: add `open` to that FAQItem, or lift a one-line reassurance into the intro block (3858). → `/impeccable clarify`

**[P2] Per-section eyebrow cadence + mixed eyebrow styles** (App.tsx:3842 ×4) — an uppercase indigo label on all four groups competes with the hero Eyebrow and uses a different (font-display) treatment than the mono Eyebrow. Fix: quiet group titles to sentence-case slate-900 font-display (no uppercase, no indigo); let only the hero carry the kicker. → `/impeccable quieter`

**[P3] No focus ring on `<summary>`** (App.tsx:3830) — `list-none` + no focus-visible leaves toggles on the browser default while the rest of the app uses explicit indigo rings (WCAG 2.4.7). Fix: add the standard focus-visible indigo ring. → `/impeccable harden`

**[P3] Prose measure runs ~90ch** (App.tsx:3834) — answer text fills max-w-3xl with no inner cap; DESIGN caps prose at 65–75ch. Fix: `max-w-[68ch]` on the answer wrapper. → `/impeccable typeset`

## Emotional Journey
Reassuring frame at the top ("Honest answers about the AI…"), and a nervous student spots their exact fear as a visible question ("Can I trust the score? Is the AI just making things up?", 3876). **But the sentence that dissolves it (3878) is collapsed behind a click** — the relief is optional. Arc: reassure → wall of closed questions → (only if they click) relief.

## Persona Red Flags
- **Jordan (first-timer):** the one anxiety-dissolving sentence is collapsed (3878); four uppercase indigo labels + a violet gradient card give competing accents but no single reassurance focal point; a closed 9-question wall reads as homework.
- **Sam (a11y):** **FAQ questions are `<span>`, not headings** (3831) — they sit outside the heading outline, so AT users can't jump question-to-question (the core FAQ navigation); no visible focus indicator on summary (3830); the ＋ glyph (3832) isn't aria-hidden (may be announced "plus"). Heading order otherwise correct.
- **Casey (mobile):** largely safe (~56px tap target, flex-wrap CTA); the hard `<br/>` in the hero headline (3855) can look awkward at mid widths — let it wrap.

## Minor Observations
- 💬 emoji in the CTA subcopy (3978) flirts with the gamified anti-reference — the only playful note on a serious page.
- Curly quotes used consistently (good typographic care).
- Multiple items open at once (independent details) — appropriate for a compare-answers FAQ.
- Container correctly falls to max-w-3xl for FAQ (627) — right call for prose.

## Questions to Consider
1. If "coaching, never an official score" is the trust the product trades on, why must an anxious student CLICK to read it (3878) instead of it being the first sentence they see?
2. Why is the FAQ — the surface meant to model the product's rigor — the one place that re-introduces a violet gradient (3974) and four uppercase indigo eyebrows (3842), the exact things the system forbids?
3. Should each question be a real heading so find-in-page and screen-reader users can jump between them?
