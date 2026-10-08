---
name: PI Coach
description: An AI DECA role-play trainer, practice the whole rep, get coached on the substance judges reward.
colors:
  indigo-primary: "#4f46e5"
  indigo-top: "#6366f1"
  indigo-tint: "#eef0ff"
  indigo-tint-line: "#c7d2fe"
  title-end: "#0284c7"
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
  level-ungraded: "#94a3b8"
typography:
  display:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 6vw, 4.5rem)"
    fontWeight: 600
    lineHeight: "1.04"
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: "1.15"
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "1.25"
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.625"
    letterSpacing: "normal"
  label:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.4"
    letterSpacing: "normal"
  metric:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "-0.03em"
  numeric:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.4"
    letterSpacing: "normal"
rounded:
  sm: "0.4375rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  dock: "0.875rem"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1.5rem"
  sheet-inset: "1.75rem"
  section: "7rem"
components:
  button-primary:
    backgroundColor: "{colors.indigo-primary}"
    textColor: "{colors.surface-light}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "#1e293b"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
  button-small:
    backgroundColor: "{colors.surface-light}"
    textColor: "#1e293b"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.625rem"
  input:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "0.625rem 0.75rem"
  filter-chip:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.body-light}"
    rounded: "9999px"
    padding: "0.125rem 0.625rem"
  sidebar-item-active:
    backgroundColor: "{colors.indigo-tint}"
    textColor: "{colors.indigo-primary}"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.625rem"
  dock:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.muted-slate}"
    rounded: "{rounded.dock}"
    padding: "0.3125rem"
---

# Design System: PI Coach

## 1. Overview

PI Coach looks like a precise working tool with some atmosphere, in the family of Linear, Raycast and Vercel. A page is one surface, organised by hairlines, a sidebar and tables. It is not a stack of cards.

Three ideas carry the whole system:

- **One sheet, not many boxes.** Content sits on a single white sheet that rises out of a grey canvas. Sections are separated by a hairline and space. A frame is reserved for things that really are separate objects: a dialog, the dock, the clock, a form control.
- **A sidebar holds the lists.** Anything you choose between (events, domains, tabs, past role-plays, the steps of a rep) lives in the sidebar on the canvas, so the sheet is left for the thing you are reading.
- **Colour means something.** Indigo is the brand and the one primary action. Red, amber, sky and emerald are the scoring ramp and are used for nothing else.

The personality is supportive, sharp and modern. It should never read as gamified or cartoonish, and never as clinical exam software.

## 2. Colors

### Primary

Indigo `#4f46e5` is the brand. It marks the one primary button on a page, the active dock item, the selected sidebar row, links, and page titles. Solid indigo buttons carry a lit finish: a slightly lighter top (`#6366f1`), a hairline sheen, and a soft glow underneath.

### The Scoring Ramp

Novice red `#ef4444`, Developing amber `#f59e0b`, Proficient sky `#0ea5e9`, Exemplary emerald `#10b981`. A term nobody has graded yet is slate `#94a3b8`.

The ramp appears as a 7px dot beside the level's name, as a thin stacked meter, and as a faint wash on a summary cell. Only the top band is green, so a page of green never passes for a perfect score.

### Neutral, The Slate Canvas

Canvas `#f6f7fb` (dark `#0a0f1f`), surface white (dark `#0f172a`), hairline `#e2e8f0` (dark `#1e293b`). Ink is slate 900, body slate 600, muted slate 500. Table header rows and bands use slate 50.

### Named Rules

- **The ramp is reserved.** Never use a scoring colour for decoration, a category, or a brand accent. Positive and warning states outside scoring borrow emerald and amber on the figure only.
- **No tinted panels.** A level, a warning or a bonus is shown by a dot, a coloured word or a coloured figure, not by filling a box with a pale version of the colour.
- **One accent.** The old violet, fuchsia and amber "four beats" accents are retired.

## 3. Typography

Instrument Sans for everything that is read. IBM Plex Mono for numbers that line up: scores, counts, clocks, codes.

### Hierarchy

- **Display** (landing hero only): 2.6rem to 4.5rem, 600, tracking -0.04em.
- **Headline** (landing and Tips section heads): 1.5rem to 1.875rem, 600, tracking -0.03em.
- **Title** (every page head): 1.5rem, 600, tracking -0.03em, filled indigo into sky.
- **Section head**: 0.875rem to 1rem, 600.
- **Body**: 0.875rem, 400, line height 1.625, lines kept under about 75 characters.
- **Label**: 0.75rem to 0.8125rem, 500, slate 500. Sentence case.
- **Metric**: 1.25rem, 600, tabular numbers.

### Named Rules

- **No uppercase labels.** Small labels are sentence case in the body face with normal tracking. `index.css` enforces this app wide by switching off the `uppercase` utility.
- **No emoji in the interface.** Buttons, bullets and headings use words. Typographic marks (a check, a cross, a star for flags) are fine.
- **No arrows on buttons.** A button says what it does.
- **Gradient text is for titles only.** The page title and one phrase of the landing headline. Never on body text, metrics or labels.

## 4. Elevation

The system is nearly flat. Depth comes from the canvas, the glow and the sheet, not from shadows on content.

### Shadow Vocabulary

- **Dock and clock**: `0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.25)`, with a gradient border.
- **Dialogs**: one large soft shadow over a dark scrim.
- **Primary button**: inset sheen plus `0 6px 16px -8px #4f46e5`.
- **Everything else**: none.

### Named Rules

- **Sections do not float.** No shadow, no hover lift and no border radius on a page section.
- **No backdrop blur on large areas.** It costs frames on scroll. Scrims are a flat dark colour.

## 5. Components

### The Frame

`AppFrame` is the canvas. It draws a soft glow of indigo, sky and emerald at the top, a dot grid that fades out, and a cursor light that follows a real mouse. `Shell` holds the sheet, and a `Sidebar` rendered anywhere inside a page appears to its left from `lg` up and stacks above (or below, for history) on a phone.

The sheet is clear at the top so the glow shows through behind the page title, and solid further down. Its side hairlines fade in the same way. There is never a hard edge where the colour stops.

### The Dock

A floating bar sized to its contents, with a gradient border. A pill slides behind the active item. Below `md` it collapses to the brand, the theme toggle and a menu button.

### Page Head and Strip

`PageHead` is a quiet line of context, the title, an optional one-paragraph blurb, and the page's actions on the right. `Strip` is the row of figures under it: full width, ruled, with a dot and wash on any cell that stands for a scoring level. Whole numbers count up on arrival.

### Sidebar

`SideGroup` is a titled list. `SideItem` is one row: a label, an optional second line, and something small on the right (a count, a score, a meter). The selected row is an indigo tint with a hairline ring.

### Sections, Tables and Rows

`Card` is a section: a top hairline and space, nothing else. Passing it a border or fill colour makes it a framed callout, which should be rare. Lists of things are tables: a slate 50 header row, hairline rows that tint on hover, full width via `pic-bleed` with `pic-inset` on the rows. Form steps are labelled rows with the label in a fixed left column.

### Buttons

Primary: solid indigo with the lit finish, 7px corners, one per page. Secondary: white with a hairline. Small: the same, tighter, for table rows. Text actions are indigo words.

### Chips and Toggles

`FilterChip` is a pill toggle in a filter row above a table. Two or three exclusive choices use the segmented control: a slate track with a white selected segment.

### Inputs

White, hairline border, 7px corners, indigo focus ring. 16px text on touch devices to stop iOS zooming.

### The Clock

A small floating bar in the dock's material that follows the page down. A warning colours the figure and its bar, never the whole bar.

### Dialogs

Flashcards, the quiz, Blitz, login and feedback are real dialogs and keep a frame, a 12px to 16px radius and a shadow. Inside them the same rules apply: rows and hairlines, no tinted boxes.

### Signature, The Breathing Target Loader

The brand mark as a rippling target. It is the only loader, at whatever size fits.

### Motion

Everything is a transform or an opacity change, and all of it stops under reduced motion (the loader keeps breathing so a wait never looks hung). Pages ease in with a short stagger, bars grow from the left, the trend line draws itself, the glow drifts slowly, table rows tint on hover.

## 6. Do's and Don'ts

### Do:

- Put choices in the sidebar and the chosen thing on the sheet.
- Separate with a hairline and space before reaching for a frame.
- Show a list as a table with one clear action per row.
- Use a dot and a word for a level.
- Keep one primary button per page.
- Check both themes and phone width.

### Don't:

- Don't stack rounded, shadowed cards down a page.
- Don't tint a panel to signal meaning.
- Don't use uppercase tracked labels, emoji, or arrows on buttons.
- Don't use gradient text beyond titles.
- Don't animate layout properties or add blur to large surfaces.
- Don't use a scoring colour for anything but a score.
