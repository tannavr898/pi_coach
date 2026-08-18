# Deploying PI Coach

PI Coach ships as **one Docker image**: the Vite SPA is built and served by the
FastAPI process, which also serves `/api/*`. One service, one origin, no CORS,
keys in one place. The image is host-agnostic — these steps use **Render's free
tier**; Railway and Fly.io run the same `Dockerfile` (notes at the bottom).

> **Why a server with HTTPS is required:** the microphone (`getUserMedia`) only
> works in a secure context. Render/Railway/Fly all give you HTTPS automatically.

> **Speed reality check:** grading latency is the AI calls (a Claude scoring call
> + AssemblyAI transcription), not the host. A bigger server won't make grading
> faster — it mainly avoids cold-start delay on the first hit.

---

## 1. Protect your wallet first (5 min, do this before going public)

A public URL means anyone can spend your API credits. Three layers, set them up
*before* sharing the link:

1. **Anthropic spend cap** — console.anthropic.com → Billing → set a monthly
   limit (e.g. $10–20 to start).
2. **AssemblyAI spend cap** — you've done this; confirm it's still set.
3. **App-level daily guard** — `DAILY_REQUEST_CAP` (set in step 3) stops paid
   calls for the day with a friendly message *before* the hard provider cap is
   hit. Tune it to your budget; ~500/day is a safe start.

There's also a per-IP burst limit (`RATE_LIMIT_PER_MIN`, default 20/min).

## 2. Push the code to GitHub

The remote already exists. Make sure the branch you want to deploy is pushed:

```bash
git push origin HEAD          # push the current branch
# (or merge into main first and deploy from main)
```

## 3. Create the Render service (Blueprint)

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint** → pick the `deca_roleplay_trainer` repo. Render reads
   [`render.yaml`](./render.yaml) and proposes the `pi-coach` web service.
3. Choose the branch to deploy, then **Apply**.
4. When prompted (or in the service's **Environment** tab), set the two secrets —
   they are `sync: false` so they live only in the dashboard, never in git:
   - `ANTHROPIC_API_KEY`
   - `TRANSCRIPTION_API_KEY`
   `ANTHROPIC_MODEL`, `DAILY_REQUEST_CAP`, and `RATE_LIMIT_PER_MIN` come from
   `render.yaml` — adjust in the dashboard anytime.
5. Render builds the Docker image and deploys. First build takes a few minutes.
   Health check: `GET /api/health`. When it's live you get a
   `https://pi-coach-xxxx.onrender.com` URL — open it and run a full loop.

> **Free-tier cold starts:** the free instance sleeps after ~15 min idle, so the
> first request then takes ~30–50s. Two fixes: (a) a free keep-alive — create a
> job at [cron-job.org](https://cron-job.org) that GETs `/api/health` every
> 10 min; or (b) upgrade to `plan: starter` ($7/mo, always warm) in `render.yaml`.

## 4. Custom domain (your ~$12)

1. Buy a domain — [Porkbun](https://porkbun.com) or
   [Cloudflare](https://www.cloudflare.com/products/registrar/) are cheapest.
   A **`.app`** domain (~$12–14/yr) is a nice fit: the whole TLD is HTTPS-only
   (HSTS-preloaded), which the mic feature needs anyway. `picoach.app` /
   `getpicoach.app` if available.
2. In Render: service → **Settings → Custom Domains → Add** your domain.
3. Render shows a DNS record to add at your registrar (a `CNAME` for `www` /
   subdomains, or an `ALIAS`/`A` for the apex). Add it; Render issues the TLS
   cert automatically (a few minutes).

## 5. After it's live

- Run a full **typed** loop, then a **spoken** loop (allow mic), and confirm the
  Delivery tab numbers look right.
- Watch the first day's provider usage; tighten `DAILY_REQUEST_CAP` if needed.
- Going truly public? Consider a shared access passcode or Cloudflare Access in
  front of it — the spend guards cap the damage, but a gate prevents it.

## 6. Accounts: Supabase auth + Google sign-in

Login is optional in the product, so this whole section is optional too — with
`SUPABASE_URL` / `SUPABASE_ANON_KEY` unset, the app hides every account feature
and anonymous practice is unaffected.

### 6a. Enable the Google provider

1. **Google Cloud Console** → create (or pick) a project → **APIs & Services →
   OAuth consent screen**. Choose **External**, then fill in:
   - **App name:** `PI Coach`. Setting this alone does **not** change what users
     see — read 6b before assuming it did.
   - **App logo:** upload [`brand/logo-120.png`](./brand/logo-120.png) — the
     bullseye mark at Google's 120×120 limit. Do not skip this: without a logo
     and a verified brand, Google shows only your app *domain*, which is the
     whole problem you are trying to fix.
   - **Application home page:** `https://trypicoach.com`
   - **Privacy policy URL:** `https://trypicoach.com/privacy` and **Terms of
     service URL:** `https://trypicoach.com/terms`. Both ship with the app
     (`frontend/src/legal.tsx`) and both are required for branding. Before
     pointing Google at them, set `CONTACT_EMAIL` and `GOVERNING_LAW` at the top
     of that file — the contact address must be one you actually monitor.
   - **Authorized domain:** `trypicoach.com`. You can only save this if the
     domain is already verified in [Google Search
     Console](https://search.google.com/search-console) under the *same* Google
     account as the Cloud project.
   - **Scopes:** leave the defaults. We only need `email` and `profile`, which
     are *non-sensitive* — so no Google security review is required, and users
     see no "unverified app" interstitial.
2. Set publishing status to **In production**. In *Testing* only addresses you
   list by hand can sign in, capped at 100 — a silent way to lose every real
   signup.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins:** `https://trypicoach.com`
   - **Authorized redirect URI:** `https://<project-ref>.supabase.co/auth/v1/callback`
     (or your Supabase custom domain — see 6b). Copy this exactly from the
     Supabase provider page; a trailing-slash mismatch is the usual cause of
     `redirect_uri_mismatch`.
4. **Supabase dashboard → Authentication → Providers → Google**: enable it and
   paste the client ID + client secret.
5. **Supabase → Authentication → URL Configuration**:
   - **Site URL:** `https://trypicoach.com`
   - **Redirect URLs:** add `https://trypicoach.com/**` (and
     `http://localhost:5173/**` for dev). The wildcard matters — the app returns
     you to the exact path you left from, not just the root.

### 6b. Making the consent screen say "trypicoach.com"

Google's screen reads *"to continue to `<project-ref>.supabase.co`"* because it
displays the host that owns the **callback URL**, not your App name. Typing an
App name into the consent screen changes nothing on its own — this is the part
that surprises everyone. Two ways out:

- **Google brand verification** (free, slow). Google swaps the hostname for your
  App name only once it has verified your brand. To get there you need *all* of
  6a: the domain verified in Search Console, an uploaded logo (the upload is what
  submits you for review), live privacy-policy and terms URLs on that domain, and
  publishing status **In production**. Non-sensitive scopes mean no security
  review, but the logo/brand review still takes days. Miss any one of these and
  you keep seeing the raw `*.supabase.co` host.
- **A Supabase custom domain** (paid, immediate). Supabase serves auth from
  `auth.trypicoach.com` instead of `<project-ref>.supabase.co`, so the callback
  host *is* yours and there is nothing for Google to verify. It also fixes the
  host shown under *"see details"* and the links in confirmation emails. It's a
  **paid add-on on a paid plan** (Supabase → Settings → General → Custom
  Domains); check the current price before committing. After enabling it, update
  the redirect URI in the Google credential (step 6a.3) to the new host.

The two are independent — the custom domain works whether or not Google ever
verifies your brand, which is why it's the reliable option if you need this
fixed on a deadline.

**Confirmation emails** are a third, separate surface: they're sent from
Supabase's shared address until you configure **custom SMTP** (Supabase → Auth →
SMTP Settings) with a provider like Resend or Postmark on a domain you own. The
shared sender is also heavily rate-limited, so this is worth doing before any
real signup volume regardless of branding.

### 6c. Session replay and what it records

Replay masking is configured in `frontend/src/analytics.ts` — read the comment
at the top of that file before changing it. The short version: the product's own
UI records as readable text so you can see where people get stuck, while
passwords, email fields, every textarea, and any rendered text tagged `PH_MASK`
(transcripts, evidence quotes, the signed-in address) are masked. If you add a
surface that displays what a student wrote or said, tag it `PH_MASK`; if you add
a free-text input holding anything personal, make it a `textarea` or
`type="email"` so the input mask covers it.

---

## Other hosts (same Dockerfile)

- **Railway** — New Project → Deploy from repo → it detects the `Dockerfile`. Add
  the same env vars. No cold starts; usage-based after a small monthly credit.
- **Fly.io** — `fly launch` (it detects the `Dockerfile`), set secrets with
  `fly secrets set ANTHROPIC_API_KEY=… TRANSCRIPTION_API_KEY=…`. Keep one machine
  warm within the free allowance to avoid cold starts.

## Scaling note

The rate limiter and daily budget are **in-memory and per-process**, so run a
**single instance/worker** (the Dockerfile does). If you later scale to multiple
instances, move those counters to a shared store (e.g. Redis) so the limits hold
across replicas.
