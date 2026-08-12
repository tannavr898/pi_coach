---
target: the home dashboard
total_score: 27
p0_count: 1
p1_count: 2
timestamp: 2026-07-16T20-58-51Z
slug: frontend-src-home-tsx-homepage
---
# Critique — Home dashboard (PI Coach)

Method: dual-agent (A: design-review · B: detector-evidence). Browser overlay unavailable (no browser tool) — deterministic detector + source grep only.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No loading state; returning users briefly see NEW-USER empty copy until fetch resolves (home.tsx:80–81,150). |
| 2 | Match System / Real World | 4 | Coach register throughout ("Keep showing up", "fillers/min"). |
| 3 | User Control and Freedom | 3 | Every tile links onward; nothing traps. |
| 4 | Consistency and Standards | 2 | Violates its own DESIGN.md (eyebrow, nested card, rationed indigo, scoring hue). |
| 5 | Error Prevention | 3 | Low-risk; fetch error caught. |
| 6 | Recognition Rather Than Recall | 3 | Everything on-screen; radar+list redundancy aids recognition at a density cost. |
| 7 | Flexibility and Efficiency | 3 | "Practice weakest" exists but buried below a chart. |
| 8 | Aesthetic and Minimalist | 2 | Radar + 13-row list double-encode; 3 primary CTAs; 7 cards at once. |
| 9 | Error Recovery | 2 | Prints raw exception string (home.tsx:126); no Retry. |
| 10 | Help and Documentation | 3 | Inline chart hints are genuinely good just-in-time help. |
| **Total** | | **27/40** | **Acceptable — excellent content strategy, docked hard on self-consistency + status.** |

## Anti-Patterns Verdict
**LLM:** Not slop in vibe — real coach voice, honest data — but trips FIVE of the eight named DON'Ts: eyebrow-on-every-section (×4: home.tsx:108,160,173,240), nested card (the indigo-50 "Your next focus" panel inside a Card, home.tsx:159 in :132), rationed-indigo broken (3 BTN_PRIMARY fills: 118,164,252), emerald as a decorative chart series (bends Earned-Green: home.tsx:218 / charts.tsx:21), and a stamped identical 3-up chart trio (204/215/226 in grid-cols-3 @130). CLEAN on gradient text/buttons and violet.
**Detector (exit 2):** Near-spotless — a single `design-system-font-size` advisory (`text-[10px]` on the "retry" pill, home.tsx:187). Zero gradient/violet/wide-grid/side-tab; the `nested-card` rule did NOT fire (A's nested card is a soft border+tint+radius+padding panel, not a literal Card-in-Card — a judgment call). Emerald hits (charts.tsx:17,21) are data-viz series maps, which B classifies as chart context, not decoration — so the emerald finding is a defensible disagreement (a delivery *series* color vs a scoring badge).
**Note:** The sub-floor contrast failures (below) are LLM-caught; the detector's gray-on-color rule targets gray-on-colored-bg, not gray-on-white, so it did not flag them.
**Browser:** Not available — fallback signal.

## What's Working
1. **Every number maps to an action.** The weakest-criterion nudge names the fix and gives both "Practice it" and "Study this criterion" (home.tsx:158–167); the flashcards card recommends the same criterion. Readiness-is-the-metric, executed well.
2. **Chart discipline is real** — single-series, one hue per chart, tabular-nums, recessive grid, no legend, full dark: parity (charts.tsx:15–22,52,126). Dataviz-grade restraint.
3. **Copy is coach, not scold** — empty states invite ("Do a couple of spoken reps…") rather than shame.

## Priority Issues
**[P0] Three indigo primaries fracture the "one action" rule** (home.tsx:118,164,252) — the page has no focal point and the highest-value action (Practice your weakest) is the least prominent. Fix: one indigo per view; let "Practice it →" own it, demote the others to secondary. → `/impeccable colorize` (+ quieter)

**[P1] The "what do I practice next" answer is buried below a decorative radar** — nudge (home.tsx:158) ranks third visually (radar → 13-row list → nudge). Fix: hoist "Your next focus" above the radar or into a full-width band under the hero; radar becomes supporting evidence. → `/impeccable layout`

**[P1] No loading state → returning users flash "new user" empty copy** (home.tsx:80–81 init 0/[]; consumed 134,150). Fix: a `loading` bool distinct from empty; skeleton/breathing-loader while progress===null; add Retry and stop printing raw `{error}` (126). → `/impeccable onboard` (+ harden)

**[P2] Radar conflates "not practiced" with "zero skill" + unreadable labels** — untouched domains render value:0 (home.tsx:86–90) so a 0-spoke looks like genuine-Novice; 8px labels (charts.tsx:72) on a 13-spoke radar fail legibility (worse on mobile). Fix: dashed/hollow spokes or render only practiced domains; labels ≥10px, or a grouped bar/list when n>8 (13 axes is past the radar ceiling). → `/impeccable dataviz`

**[P2] Sub-floor text contrast (WCAG 2.1 AA target)** — slate-300 (home.tsx:143, ~1.6:1), slate-400 (155,190, ~2.6:1), 9px slate-400 chart axis (charts.tsx:127,144,146,179,190), 8px radar labels (charts.tsx:71), indigo-500 kicker on indigo-50 (160, ~3:1). DESIGN floor is slate-500. Fix: raise meaning-bearing text ≥ slate-500 (metadata slate-600), chart ticks ≥10px, kicker to indigo-600/700. → `/impeccable harden` (+ colorize)

**[P3] Redundant radar + numeric list; emerald borrowed for decoration** (home.tsx:135–147; 218/charts.tsx:21). Fix: keep the radar OR the ranked list (list is more actionable + accessible); recolor the delivery series off emerald. → `/impeccable distill` (+ colorize)

## Persona Red Flags
- **Alex (power user):** can't jump to the highest-value action — must hunt past the radar to reach "Practice it" (164); radar+list redundancy wastes prime real estate.
- **Sam (a11y):** heading order breaks (h1 → chart h3 → weakest-criterion h2 → h3s: an h3 precedes an h2, scrambled SR outline); sub-floor contrast on core session metadata (190); session-row buttons rely on hover:opacity-80 with no focus-visible (182); generic chart aria-label with no trend summary (charts.tsx:123).
- **Casey (mobile):** radar 8px labels shrink further on ~340px (illegible, 13 crowded labels); long single-column scroll (hero + radar + 13-row list + 3 charts + sessions + flashcards) pushes the buried "Practice it" far below the fold.

## Minor Observations
- Delivery chart (fillers/min) is lower-is-better with no directional cue — a downward line naively reads as "worse"; add a "lower is better" micro-label.
- Recent-session content_score renders in plain slate (home.tsx:195) — the one place the scoring ramp would legitimately mean something and it's absent; make a deliberate call.
- TrendLine end-value label (charts.tsx:139) can crowd the final marker on short/flat series.
- `retry` badge (home.tsx:187) is a nice honest touch, correctly mono.

## Questions to Consider
1. Does this page need a 13-axis radar at all? For anyone under ~15 sessions it's mostly zeros — a ranked "weakest → strongest domain" bar list may be more honest, legible, mobile, AND remove the biggest density offender.
2. What is the one indigo thing on this page? The system can't currently answer that. If you deleted two of three primaries, which survives — and does the layout reflect that priority or contradict it?
3. Should a returning student ever see the radar before their next focus? Flip the DOM: open with "Your next focus: X → Practice it" as a full-width band, everything else evidence supporting that one sentence.
