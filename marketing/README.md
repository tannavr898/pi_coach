# Marketing assets

## Live demo
A no-login, pre-filled walkthrough of a finished session lives at **`/demo`**
(also reachable as `/?demo` or `/#demo` on any host). It shows:

- **Step 1** — an example scenario (marketing for the FreshBlend smoothie chain,
  Learn mode) plus a strong-but-imperfect sample response and the judge follow-up.
- **Step 2** — the full graded feedback (74%, Proficient). Every tab is live:
  Overview, Transcript (with phrase-level highlights), Delivery, and the
  per-criterion Criteria tab.

Nothing here calls the API — it's canned data in `frontend/src/demoData.ts`, so
it's safe to link from anywhere and costs nothing to run. Edit that one file to
change the worked example.

Share link once deployed: `https://trypicoach.com/demo`

## Screenshots (`screens/`)
Full-page captures at 1440px wide, 2× retina (so ~2880px — crisp for ads/print).

| File | What it shows |
|------|----------------|
| `01-landing-light.png` / `-dark.png` | Hero + "Set up a role-play" |
| `02-tips-light.png` | The DECA-method tips page (Define/Explain/Connect/Above & Beyond) |
| `03-demo-scenario-light.png` | Demo step 1 — scenario + sample response |
| `04-demo-feedback-light.png` / `-dark.png` | Demo step 2 — score 74% + strengths/focus |
| `05-demo-transcript-light.png` | Transcript with phrase-level criterion highlights |
| `06-demo-delivery-light.png` | Delivery metrics (pace, fillers, pauses, time) |
| `07-demo-criteria-light.png` | Per-criterion scoring |

Regenerate any time with the backend running on :8000 — see the capture script
note in the commit. Good source frames to drop into Claude design for an ad.
