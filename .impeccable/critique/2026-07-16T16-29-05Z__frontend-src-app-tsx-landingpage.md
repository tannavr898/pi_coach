---
target: the landing page
total_score: 31
p0_count: 1
p1_count: 2
timestamp: 2026-07-16T16-29-05Z
slug: frontend-src-app-tsx-landingpage
---
# Critique — Landing page (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable (no browser tool) — deterministic detector + source grep only.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Video autoplay, active-tab ring, form sending/done/error all present. |
| 2 | Match System / Real World | 4 | "prep/present/feedback", judge rubric weights, "rehearse the room" — fluent DECA language. |
| 3 | User Control and Freedom | 3 | Demo needs no account; no dismiss on autoplay video, no waitlist undo. |
| 4 | Consistency and Standards | 2 | Violates its own DESIGN.md: two CTA treatments, eyebrow-on-every-section, off-palette violet. |
| 5 | Error Prevention | 3 | type=email + required + disabled-until-valid button. |
| 6 | Recognition Rather Than Recall | 4 | Everything labeled and visible; tabs show state. |
| 7 | Flexibility and Efficiency | 3 | Three paths (start/demo/signup); header duplicates CTAs. |
| 8 | Aesthetic and Minimalist Design | 2 | Gradient text + gradient buttons + 6 eyebrows + emoji + two 3-grids = decorative noise. |
| 9 | Error Recovery | 3 | "Couldn't sign you up: check your connection" is human and specific. |
| 10 | Help and Documentation | 4 | Tips link, FAQ, competition tips, no-account demo. |
| **Total** | | **31/40** | **Good — content/IA strong; visual execution fights the brand's own rulebook.** |

## Anti-Patterns Verdict — does this look AI-generated? Yes, on the marquee tells.

**LLM assessment:** The page trips nearly every DON'T its own DESIGN.md names by name. Gradient text in the hero H1 (App.tsx:1867), gradient-fill CTAs (1881, 2097) that repaint the compliant BTN_PRIMARY into the forbidden state, off-palette violet-600 smuggled in via gradients (1806, 1867, 1881, 2055, 2097), a mono uppercase eyebrow above every section (1808, 1864, 1920, 1962, 2007, 2057 — six on a four-section page), and two back-to-back identical sm:grid-cols-3 card walls both topped with mono numbers (ProcessStrip ~1768 and FeedbackExplainer 1966 — the "identical card grids" + "hero-metric template" DON'Ts stacked). Emerald+🎉 success block (2066) spends the scoring ramp's most-promised hue on decoration and nicks the no-confetti line.

**Deterministic scan (detect.mjs, exit 2):** Agrees. gradient-text @1867; ai-color-palette (indigo/violet) 17 hits incl. landing 1806/1867/1881/2055/2097; side-tab border-l-2 @4128 (outside landing); gray-on-color 5 (mostly dashboard/FAQ, outside landing — largely light/dark variant pairs, partial false positives); design-system-font-size advisory ×20 (intentional small mono labels). Landing-range confirmed hits: gradient-text @1867, violet palette @1806/1867/1881/2055/2097, 10px font @1987.

**Visual overlays:** Not available — no browser tool exposed; reported as fallback signal.

## Overall Impression
Content, copy, and information architecture are genuinely strong — the feedback explainer *demonstrates* the product instead of asserting it. But the visual execution is at war with the project's own design system: the flagship page is the single biggest violator of DESIGN.md. Biggest opportunity: delete the tells (gradients, eyebrow-spam, one of the two grids) and the page instantly reads as designed rather than generated.

## What's Working
1. **Feedback explainer proves the pitch** (1933) — renders the app's ACTUAL CriteriaTab/AnalysisTab/DeliveryTab on real DEMO_SCORE data (2010–2012), not a mockup. "Shows its work" is the whole pitch, demonstrated.
2. **Coach-voiced, honest copy** — "we judge whether you actually demonstrated it or only name-dropped it" (1940); "We never judge tone, confidence, or charisma" (1954). Nails the personality and pre-empts the fear of being judged on delivery.
3. **Disciplined frame** — SiteFooter (1204) handles DECA-affiliation + audio-privacy with restraint; BTN_PRIMARY/Card in ui.tsx are correctly built. The system is sound; only the landing's local overrides break it.

## Priority Issues

**[P0] Gradient text + gradient buttons + off-palette violet** — the two loudest "AI made this" tells, violating DESIGN.md's first two Don'ts and dissolving the rationed-indigo signal. Fix: solid ink / single text-indigo-600 for the hero phrase (1867); bare BTN_PRIMARY on CTAs (1881, 2097); purge violet from panels (1806, 2055). → `/impeccable colorize`

**[P1] Eyebrow on every section (six)** — reads as machine grammar and flattens hierarchy; the anti-pattern is baked into SectionHeading (1837) itself. Fix: keep one deliberate eyebrow, strip the rest; let H2s carry themselves. → `/impeccable distill`

**[P1] Two stacked grid-cols-3 card walls** — ProcessStrip (~1768) + FeedbackExplainer (1966), both mono-number-topped. Fix: give one a different affordance — e.g. the 60/25/15 weighting as a single horizontal weighted bar; ProcessStrip as a stepped timeline. Break the symmetry. → `/impeccable layout`

**[P2] "get scored like the real thing" contradicts positioning** — PRODUCT.md is "coaching, never a judge score"; the hero's first seven words manufacture the anxiety the product cures. Fix: "…see exactly where you stand." → `/impeccable clarify`

**[P2] Emerald + 🎉 success block** — spends Earned-Green on decoration, pokes anti-gamification. Fix: neutral/indigo success styling, drop the confetti. → `/impeccable quieter`

**[P3] Page ends on a cold email capture** — WaitlistCTA (2057) deflates the readiness arc (peak-end). Fix: close on the readiness payoff, demote email to secondary. → `/impeccable bolder`

## Persona Red Flags
- **Jordan (first-timer):** four competing above-the-fold actions (header Sign up 1402, header Log in, hero gradient CTA 1881, tips link 1909); two filled-indigo buttons both claim "primary"; meets "get scored" (1866) before any reassurance.
- **Riley (stress tester):** gradient hero H1 (1867) clips descenders / vanishes if the gradient fails to paint (no fallback color); hero gradient button's violet focus ring mismatches BTN_PRIMARY's indigo focus-visible outline; two sm:grid-cols-3 blocks collapse to identical single-column stacks.
- **Casey (mobile):** below 640px everything is one column of near-identical tall cards (metric + heading + 3-line body + "Looks for" + CTA) before the real-feedback panel — long scroll to the proof, amplified templated feel on the primary device.

## Minor Observations
- SectionHeading (1837) hard-couples an eyebrow into the component — the anti-pattern is in the primitive.
- Emoji in chrome (💬 nav 1387/1441; 🎉/🙌 states 2067/1253) drift toward the cartoonish pole.
- Hero video shadow (1890) is a generic shadow-xl, not DESIGN.md's specified indigo-tinted hero-media shadow.
- Header wordmark kicker "DECA role-play practice" (1365) repeats verbatim as the hero eyebrow (1864) within one viewport.
- Eyebrow is defined twice (ui.tsx:25 and a local shadow at App.tsx:1575).

## Questions to Consider
1. Your DESIGN.md forbids gradient text/buttons in its first two Don'ts — the hero does both. Who is the design system for if the flagship page is exempt?
2. Positioning is "coaching, never a score," yet the first seven words are "get scored like the real thing." Is the headline selling the product, or the anxiety it's meant to cure?
3. If you deleted five of six eyebrows and one of the two three-up grids, would the page lose any information — or just lose the tell that a template generated it?
