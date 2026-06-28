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
