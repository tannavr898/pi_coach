---
target: the landing page
total_score: 36
p0_count: 0
p1_count: 1
timestamp: 2026-07-16T16-54-40Z
slug: frontend-src-app-tsx-landingpage
---
# Critique — Landing page (PI Coach), redesign re-critique

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable (no browser tool) — deterministic detector + source grep only. Score: **36/40 (was 31)**.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Tab selection + waitlist send/done/error states. |
| 2 | Match System / Real World | 4 | DECA-native copy throughout. |
| 3 | User Control and Freedom | 3 | Autoplay loop video has no pause, ignores reduced-motion. |
| 4 | Consistency and Standards | 3 | Landing max-w-[88rem] vs header/footer max-w-5xl; ARIA tablist incomplete. |
| 5 | Error Prevention | 4 | email + required + disabled states. |
| 6 | Recognition Rather Than Recall | 4 | Embeds the real feedback component with sample data. |
| 7 | Flexibility and Efficiency | 3 | Tablist has no arrow-key roving focus. |
| 8 | Aesthetic and Minimalist Design | 3 | "Rehearse the room" repeats (hero + waitlist H2); hero double-subhead. |
| 9 | Error Recovery | 4 | Specific, actionable waitlist error. |
| 10 | Help and Documentation | 4 | Tips, FAQ, /demo, honest footer. |
| **Total** | | **36/40** | **Good→Excellent. Deductions are craft bugs in the new bar + width shell.** |

## Anti-Patterns Verdict — does it look AI-generated? No longer.
**LLM:** "Not AI slop. A deliberately composed page that broke every one of its own listed DON'Ts." Gradient text ABSENT; gradient buttons ABSENT from landing; eyebrow reduced to one (hero); the 3-card feedback grid replaced by a single proportional 60/25/15 bar that IS the selector; ProcessStrip differentiated into a connected numbered timeline. Residual violet is cosmetic (HERO_POSTER SVG stop only).
**Detector (exit 2):** Inside the landing region (1764–2147) only ONE finding remains — a `design-system-font-size` advisory at L2039 (the intentional "Looks for" 10px micro-label = false positive). Zero gradient-text, zero gradient-fill, zero violet classes, zero emerald/🎉 in region. All six prior grep tells eliminated or reduced.
**Browser:** Not available — fallback signal.

## Before → After (landing region)
| Tell | Before | After |
|---|---|---|
| Gradient text | 1 (hero) | 0 |
| Gradient-fill buttons | 5 | 0 |
| Off-palette violet class | present | 0 (only cosmetic poster SVG stop) |
| Eyebrows | 5 | 1 (hero) |
| grid-cols-3 | 2 | 1 (ProcessStrip timeline — differentiated) |
| emerald + 🎉 | present | 0 |
| Health score | 31/40 | 36/40 |

## What's Working
1. The 60/25/15 proportional bar folding rubric weighting into the selector is genuinely original information design — the anti-slop move done right.
2. Shows, not tells — renders the app's real graded tabs on sample data; Earned-Green rule intact.
3. Voice + typographic discipline: mono confined to data, Space Grotesk to headings, text-balance/pretty applied, varied 8→10→8rem rhythm.

## Priority Issues that REMAIN
**[P1] Landing inherits the dashboard's 88rem shell** — content (max-w-[88rem], L627) misaligns with header/footer (max-w-5xl). On wide desktop the hero sits ~190px left of the wordmark and the bar stretches to ~1400px. Fix: give the landing its own container matching the frame (max-w-6xl/5xl), or widen the frame. [pre-existing, not from redesign]
**[P2] ProcessStrip connector overshoots the last node** — `left-5 right-5` line runs past node 3 (left-aligned nodes) leaving a ⅓-width tail. Fix: anchor line to node centers or center nodes in columns. [redesign regression]
**[P2] 15% tab clipped/unlabeled on mobile** — flexBasis:15% ≈48px; the 18px "15%" overflows and the label ellipsizes. Fix: enforce min-w per segment below sm, or stacked segmented control; keep proportional bar as a non-interactive visual. [redesign regression]
**[P2] Hero underline distorts on wrap** — inline-block span + preserveAspectRatio=none: when the phrase wraps at text-5xl on mobile, the single stretched path renders across the two-line box. Fix: per-line underline (background-image or box-decoration-break: clone) or prevent wrap. [redesign regression]
**[P2] Footer/caption contrast** — text-slate-400 (#94a3b8) ≈ 2.9:1, below 4.5:1 AA and DESIGN's muted-slate floor. Legal/affiliation text. Fix: slate-500/600. [pre-existing]
**[P2] Rubric tabs are an incomplete ARIA widget** — role=tablist/tab/aria-selected but no ids, no role=tabpanel/aria-labelledby, no arrow-key roving focus. Fix: wire it up or drop the tab roles for plain buttons. [redesign regression]
**[P3] Autoplay video ignores reduced-motion** — while index.css:114 honors it everywhere else. Fix: gate autoplay on the media query, fall back to poster. [pre-existing]
**[P3] Signature line repeats + hero double-subhead** — "Rehearse the room…" is hero subhead AND waitlist H2. Fix: let it own one spot. [redesign]

## Persona Red Flags
- **Jordan:** the embedded real sample likely shows red Novice badges at the emotional peak — can read as judgment, softening "coaching, not judging"; consider a mid-progress sample. 7-item nav to parse.
- **Riley:** incomplete tablist (no arrow keys/tabpanel), un-pausable autoplay, ProcessStrip connector tail, wrapping-underline distortion on resize.
- **Casey (mobile):** clipped 15% number + ellipsized label; hero underline distorts on wrap. (88rem misalignment is desktop-only, so Casey is spared that.)

## Minor Observations
- Header sub-label "DECA role-play practice" (L1365) duplicates the hero eyebrow (L1882).
- Hero video shadow (0.35) heavier than DESIGN hero-media token (0.10) — on-palette, conscious call.
- One decorative gradient hairline under the header (L1426) — on-palette indigo.
- HERO_POSTER text is baked SVG (no i18n) and carries the lone violet stop (pre-video-load only).

## Questions to Consider
1. Is the landing entitled to the dashboard's 1408px shell at all — or is that why the hero and its own header don't share a left edge?
2. The best asset is showing REAL feedback — if that sample is full of red "Novice," is it selling readiness or previewing failure? Use a mid-progress rep?
3. The 60/25/15 bar is the boldest idea and the most fragile mobile control — is the proportional tap target worth the legibility cost?
