---
name: PI Coach
description: An AI DECA role-play trainer — practice the whole rep, get coached on the substance judges reward.
colors:
  indigo-primary: "#4f46e5"
  indigo-accent: "#6366f1"
  indigo-glow: "#818cf8"
  canvas-light: "#f6f7fb"
  canvas-dark: "#0a0f1f"
  surface-light: "#ffffff"
  surface-dark: "#0f172a"
  ink-light: "#0f172a"
  ink-dark: "#e2e8f0"
  body-light: "#475569"
  muted-slate: "#64748b"
  border-light: "#e2e8f0"
  border-dark: "#1e293b"
  level-novice: "#ef4444"
  level-developing: "#f59e0b"
  level-proficient: "#0ea5e9"
  level-exemplary: "#10b981"
  beat-answer: "#4f46e5"
  beat-explain: "#7c3aed"
  beat-connect: "#c026d3"
  beat-above: "#d97706"
typography:
  display:
    fontFamily: "Space Grotesk, Inter, sans-serif"
    fontSize: "clamp(1.875rem, 4vw, 2.25rem)"
    fontWeight: 600
    lineHeight: "1.08"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Space Grotesk, Inter, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: "1.15"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Space Grotesk, Inter, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: "1.3"
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.625"
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1.4"
    letterSpacing: "0.18em"
  microlabel:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "0.12em"
  metric:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: "1"
    letterSpacing: "normal"
rounded:
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1.25rem"
  lg: "2rem"
  section: "8rem"
components:
  button-primary:
    backgroundColor: "{colors.indigo-primary}"
    textColor: "{colors.surface-light}"
    rounded: "{rounded.md}"
    padding: "0.625rem 1.25rem"
  button-primary-hover:
    backgroundColor: "#4338ca"
    textColor: "{colors.surface-light}"
    rounded: "{rounded.md}"
    padding: "0.625rem 1.25rem"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "#334155"
    rounded: "{rounded.md}"
    padding: "0.625rem 1.25rem"
  card:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  input:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1rem"
  chip-tab:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.body-light}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
  eyebrow:
    textColor: "{colors.indigo-accent}"
    typography: "{typography.label}"
  level-badge:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.5rem"
---

# Design System: PI Coach

## 1. Overview

**Creative North Star: "The Competition Floor"**

PI Coach is where a DECA competitor rehearses the room before they're in it, so the interface carries the focus of game day without its dread. The feel is *supportive, sharp, modern*: a coach in the student's corner who is also exact enough to be believed. Indigo is the signal color — it marks the one thing to do next, the current selection, the live clock — against a cool slate canvas that stays quiet so the task can be loud. The register is a **product**: the tool disappears into the rep. Its ambition is earned trust, not decoration; every screen should visibly move a student from "nervous" toward "ready."

The system is deliberately built between two poles it refuses to become. It is **not gamified or cartoonish** — no mascots, confetti, badge-grinding, or playful blobs; the stakes are real and the tone respects that. It is **not clinical exam software** — none of the sterile gray, standardized-test coldness that would make practice feel like the pressure it's meant to relieve. Warmth comes from copy, generous spacing, and a coach's voice; sharpness comes from a precise type scale, a monospace data language, and an honest four-level scoring ramp. The signature backdrop — a faint indigo wash over a hairline diamond lattice, drawn entirely in CSS gradients — gives every surface the texture of graph paper on a competition table without costing a single image request.

**Key Characteristics:**
- Indigo as a rationed signal on a cool slate canvas; color means *status*, never garnish.
- One type system, three voices: Space Grotesk (display), Inter (text), JetBrains Mono (data/labels).
- A diverging four-level scoring ramp (red → amber → sky → emerald) that is the product's most saturated color and is reserved for real assessment.
- Flat by default, a gentle lift on hover; dark mode drops shadows for tonal layering.
- Full light/dark parity via a class-based `.dark` toggle; motion always has a reduced-motion path.

## 2. Colors

A cool, disciplined palette: one indigo family doing the pointing, a slate ramp doing everything else, and a saturated diverging scale held in reserve for scoring.

### Primary
- **Signal Indigo** (`#4f46e5`): The primary action color — the one CTA per screen, the "generate," the "submit." Also the current-selection and live-clock color. Rarity is the point; when everything is indigo, nothing is.
- **Accent Indigo** (`#6366f1`): Eyebrow labels, active pills, focus rings, small interactive accents. A half-step lighter so it reads as secondary emphasis, not a second primary.
- **Glow Indigo** (`#818cf8`): Dark-mode accent and the loader's pulse; the lightness that survives on the near-black canvas.

### Secondary — The Scoring Ramp
A diverging four-stop scale that is the visual heart of feedback. It runs low-to-high so a screen full of green genuinely reads as mastery, never as "all fine."
- **Novice Red** (`#ef4444`): Lowest band. Badge, transcript highlight, and progress-pip fill.
- **Developing Amber** (`#f59e0b`): Second band.
- **Proficient Sky** (`#0ea5e9`): Third band — the "you cleared the bar" blue.
- **Exemplary Emerald** (`#10b981`): Top band. Green is earned, not default.

### Tertiary — The Four-Beats Accent Set
A **sanctioned four-hue set** that encodes the four steps of a strong role-play answer, and *only* that. Like the scoring ramp, it is a system with fixed meaning — each hue is a step, never decoration — which is exactly why it is allowed to break the one-accent-per-surface rule *as a set*. It appears on the study/Tips method surfaces (the "how to answer" teaching) and in the flashcard method legend.
- **Answer Indigo** (`#4f46e5`): Beat 1 — state the recommendation. Same Signal Indigo; the method begins in the brand color.
- **Explain Violet** (`#7c3aed`): Beat 2 — justify it.
- **Connect Fuchsia** (`#c026d3`): Beat 3 — tie it to the business/indicators. The highest-value beat, so it carries the most saturated accent.
- **Above Amber** (`#d97706`): Beat 4 — go above and beyond. (Distinct in context from Developing Amber in the scoring ramp; the two never share a surface.)

### Named Rules for the Four-Beats
**The One-Accent Rule.** Outside the four-beats set and the scoring ramp, a single surface uses **one** accent hue plus indigo — never a confetti of violets, fuchsias, and ambers picked for variety. If four hues appear together, they must *be* the four beats, labeled as such.
**The No-Gradient-Fill Rule.** The beats are solid fills and solid accents. **Never** blend them into each other or into indigo (`indigo→violet` washes on buttons, bars, or cards are forbidden — a fade-to-transparent hairline or loading sweep is not a fill and is fine).
**The Beats-Off-Scoring Rule.** The four beats never touch a graded result. Scores, bands, deltas, and progress-toward-mastery stay on the red→amber→sky→emerald ramp; the beats stay on teaching surfaces.

### Neutral — The Slate Canvas
- **Canvas** (`#f6f7fb` light / `#0a0f1f` dark): The page body, carrying the indigo-wash diamond lattice.
- **Surface** (`#ffffff` light / `#0f172a` dark): Cards, panels, inputs — the raised task surface.
- **Ink** (`#0f172a` light / `#e2e8f0` dark): Headings and primary text.
- **Body** (`#475569`): Paragraph text. Sits at ≥4.5:1 on both canvas and surface — the readable middle, never a decorative light gray.
- **Muted Slate** (`#64748b`): Captions, metadata, helper text. The floor for text; nothing lighter carries meaning.
- **Border** (`#e2e8f0` light / `#1e293b` dark): Hairline dividers and card strokes.

### Named Rules
**The Rationed Indigo Rule.** Signal Indigo marks at most one primary action per view. If two things on a screen are indigo-filled, one of them is lying about its importance — demote it to secondary.

**The Earned-Green Rule.** The scoring ramp is the only place saturated red/amber/sky/emerald appear. Never borrow Exemplary Emerald for a generic "success" flourish or Novice Red for decoration; those hues are promised to assessment and must keep meaning it.

## 3. Typography

**Display Font:** Space Grotesk (with Inter, sans-serif fallback)
**Body Font:** Inter (with ui-sans-serif, system-ui fallback)
**Label/Mono Font:** JetBrains Mono (with ui-monospace fallback)

**Character:** A humanist-workhorse body (Inter) paired on a real contrast axis with a geometric, slightly mechanical display (Space Grotesk) and a true monospace for anything that is data — scores, weights, timers, kickers. The three are distinct enough that the eye never confuses a heading for a label; the mono is what gives the product its "instrument" sharpness.

### Hierarchy
- **Display** (Space Grotesk 600, `clamp(1.875rem, 4vw, 2.25rem)`, line-height 1.08, tracking -0.02em): Hero and top-of-screen H1. The only place fluid sizing is allowed; capped so it never shouts.
- **Headline** (Space Grotesk 600, 1.875rem, tracking -0.02em): Section H2s.
- **Title** (Space Grotesk 600, ~1.06rem): Card and panel headings (H3).
- **Body** (Inter 400, 1rem, line-height 1.625): Paragraphs and UI prose. Cap running prose at 65–75ch.
- **Label / Eyebrow** (JetBrains Mono 500, 0.6875rem, uppercase, tracking 0.18em, Accent Indigo): Kickers and micro-labels.
- **Micro-label** (JetBrains Mono 600, `0.625rem`, uppercase, tracking 0.12em): The dense data badges — "most points", "team event", "Definition", pip counts, term indices. The instrument's smallest legible type; used only for mono system tags at 9–11px, never for prose. Kept at 600 weight so it stays crisp at size.
- **Metric** (JetBrains Mono 700, ~1.875rem): Big data figures — rubric weights, percentages, pace/WPM.

### Named Rules
**The Fixed-Scale Rule.** Outside the hero H1, type is a fixed rem scale, not fluid clamps. This is a product UI viewed at consistent DPI; a heading that shrinks inside a panel looks broken, not responsive.

**The Mono-Means-Data Rule.** JetBrains Mono is reserved for things that are literally numeric or system labels (scores, timers, weights, kickers). Never set body copy or button text in mono for "flavor."

## 4. Elevation

Flat by default, with a restrained two-layer ambient shadow that lifts on interaction. Depth is a response to state, not a decoration at rest. In dark mode the system abandons shadows entirely and conveys depth through **tonal layering** — a `#0f172a` surface floating on the `#0a0f1f` canvas — because shadows read as mud on a near-black background.

### Shadow Vocabulary
- **Resting card** (`box-shadow: 0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)`): The default soft seat under a surface in light mode.
- **Lifted card** (`box-shadow: 0 6px 24px rgba(15,23,42,0.08)`): Hover/active state only; pairs with a 2px upward translate on interactive cards.
- **Hero media** (`box-shadow: 0 20px 25px -5px rgba(99,102,241,0.10)`): The one indigo-tinted shadow, under the demo video only.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow appears only as a response to hover, focus, or elevation. If a static card has a heavy drop shadow doing nothing, delete it.

**The Shadowless-Dark Rule.** In dark mode, no drop shadows. Separate layers by surface tone and hairline borders instead.

## 5. Components

### Buttons
- **Shape:** Gently rounded (`0.75rem` / rounded-xl). Consistent across every button in the app.
- **Primary:** Signal Indigo fill, white text, `0.625rem 1.25rem` padding, `shadow-sm`. Hover deepens to `#4338ca`. Focus shows a 2px offset indigo outline (`focus-visible`).
- **Secondary / Ghost:** White (or slate-900 in dark) surface, slate-200 border, slate-700 text, same shape and padding. For the alternative action beside a primary.
- **Text link action:** Bare Accent Indigo, medium weight, for tertiary "or just start practicing →" moves.

### Chips / Tabs
- **Style:** Rounded-xl, hairline slate-200 border, white surface, body-slate text.
- **State:** Active tab inverts to Signal Indigo fill + white text (or an indigo-tinted surface with an indigo ring for the softer "selected card" variant). Unselected hover lifts to slate-50.

### Cards / Containers
- **Corner Style:** `1rem` (rounded-2xl); larger CTA panels use `1.5rem` (rounded-3xl).
- **Background:** Surface white / slate-900. **Never a nested card inside a card.**
- **Shadow Strategy:** Resting → Lifted per the Elevation section; shadowless in dark.
- **Border:** Hairline slate-200 / slate-800.
- **Internal Padding:** `1.25rem` (p-5) standard.

### Inputs / Fields
- **Style:** Rounded-lg/xl, slate-300 border, white surface, `0.75rem 1rem` padding.
- **Focus:** Border shifts to Signal Indigo plus a soft `ring-2` at ~20% indigo. Never remove the focus ring.
- **Placeholder:** Must clear 4.5:1 — no faint gray placeholders.

### Navigation
- **Style:** Top site header, Space Grotesk wordmark, text nav items in body-slate; active view in ink/indigo. A theme toggle and auth actions sit right. Collapses to a compact mobile header.

### Signature — The Breathing Target Loader
Concentric indigo rings around a center dot that pulse outward in a staggered wave (`pic-wave`), paired with a staged checklist of what the app is doing ("Choosing the indicators…", "Writing the situation…"). It is the brand mark in motion. Under reduced-motion it keeps a slow pulse rather than freezing, because a frozen loader reads as hung.

### Signature — The Diamond-Lattice Canvas
The page background is a CSS-only composite: a top indigo radial wash over two crisscrossed hairline repeating-linear-gradients forming a faint diamond lattice. GPU-cheap, image-free, and the same in both themes at different opacities. It is the "competition table" texture the whole product sits on.

## 6. Do's and Don'ts

### Do:
- **Do** ration Signal Indigo (`#4f46e5`) to one primary action per view; use Accent Indigo for smaller emphasis.
- **Do** keep the scoring ramp (red → amber → sky → emerald) exclusively for assessment, so green always means *earned*.
- **Do** set every score, weight, timer, and kicker in JetBrains Mono; keep prose in Inter and headings in Space Grotesk.
- **Do** keep body text at Body Slate (`#475569`) or darker — it must clear 4.5:1 on canvas and surface.
- **Do** let surfaces sit flat and lift only on hover/focus; in dark mode separate layers by tone, not shadow.
- **Do** give every animation a `prefers-reduced-motion` path (crossfade or slow pulse), never a hard freeze on essential feedback.
- **Do** vary section rhythm around an 8rem base so the page feels hand-paced, not stamped.

### Don't:
- **Don't** use gradient text (`background-clip: text` over a gradient) or gradient-filled buttons, bars, or cards. Emphasis comes from weight, size, and a single solid hue — not indigo→violet washes. (A hairline fade-to-transparent divider or an indeterminate loading sweep is not a fill and is allowed.)
- **Don't** scatter violet / fuchsia / amber across a surface for variety. Those three are the **four-beats accent set** (with indigo) and may appear together *only* when they label the four answer beats; anywhere else, use one accent hue plus indigo.
- **Don't** stamp a mono uppercase eyebrow above every section. One deliberate kicker is voice; an eyebrow on every heading is AI grammar. Vary the cadence.
- **Don't** ship identical card grids — same-size icon/number + heading + text repeated in a rigid `grid-cols-3`. Break the sameness with asymmetry, scale, or an entirely different affordance.
- **Don't** drift gamified or cartoonish: no mascots, confetti, badge-grinding, or playful blobs. The stakes are real.
- **Don't** drift clinical or sterile: no standardized-test grays, no proctoring-tool coldness. Warmth lives in copy, spacing, and the coach's voice.
- **Don't** borrow the scoring hues for decoration, or use Novice Red / Exemplary Emerald as generic error/success garnish.
- **Don't** nest a card inside a card, ever.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe; use a full border, a tint, or a leading number instead.
