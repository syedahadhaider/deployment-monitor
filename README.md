# Deployment monitor

A working availability monitor for my own deployments. A scheduled Python job
performs **synthetic checks** against eight public URLs, classifies any
failure, and posts the batch to an authenticated API; Cloudflare D1 stores the
checks and SQL derives everything the dashboard shows.

Live dashboard: **https://syedahadhaider.com/monitor**

```
collector/   Python. Performs the checks, classifies failures, publishes a batch.
             GitHub Actions cron, every 30 minutes.
api/         Cloudflare Worker + D1. Authenticates, validates, persists,
             and aggregates entirely in SQL.
```

```
GitHub Actions (cron)
      │
      ▼
Python collector ──authenticated HTTPS POST──▶ Worker /ingest
                                                    │  validate · reject · bind
                                                    ▼
                                                   D1
                                                    │  SQL aggregation
                                                    ▼
                          Next.js page ◀──fetch── Worker /summary (cached 600s)
```

The portfolio does a plain `fetch` against a public read endpoint and renders
the result. **No database client, driver, ORM or credential exists in the
portfolio repository** — that separation is the reason the backend lives here.

## What this is, and what it is not

It is a real monitor recording real checks against sites I deploy. It is **not**
observability infrastructure, not enterprise monitoring, and not evidence of
SaaS, DevOps or production security experience. It watches eight of my own
pages from one scheduled runner.

The measurements are **synthetic checks** and **endpoint latency**: HTTP
round-trips from a GitHub-hosted runner in a datacenter. They are not browser
performance metrics and are **not** a substitute for LCP, INP or any other Core
Web Vital, which measure something different for real users on real devices.

Nothing here is seeded, backfilled or simulated. The dashboard shows recorded
checks or it shows an empty state.

## The distinction the whole project is built around

**Uptime and coverage are different questions and are never mixed:**

- **Uptime** — of the checks that *ran*, how many passed.
- **Coverage** — of the checks that *should have* run, how many actually did.

GitHub Actions cron is best-effort: runs are delayed and sometimes skipped
entirely. Those are the *scheduler's* gaps. A missing check is missing
information, never evidence that a site was down — so there is no `no_data`
row anywhere in the schema, and an incident **terminates at a gap** rather than
being reported as one long outage across a period nobody observed.

## Documentation

- [`collector/README.md`](collector/README.md) — failure classification, retry
  semantics, isolation, and the operational realities of Actions cron.
- [`api/README.md`](api/README.md) — schema, indexes and why each exists, the
  incident-derivation SQL, validation, cache TTL, and the D1 free-tier budget.

## Setup

Both halves need credentials that are never committed.

**Cloudflare**

```bash
cd api
npm install
npx wrangler login
npx wrangler d1 create deployment-monitor        # put the id in wrangler.toml
npx wrangler d1 migrations apply deployment-monitor --remote
npx wrangler secret put INGEST_TOKEN             # paste a long random string
npx wrangler deploy
```

**GitHub** — in this repository's *Settings → Secrets and variables → Actions*:

| Secret | Value |
| --- | --- |
| `MONITOR_API_URL` | `https://<your-worker>.workers.dev/ingest` |
| `MONITOR_API_TOKEN` | the same string given to `wrangler secret put` |

Then run the **availability check** workflow once by hand to confirm it works.

> GitHub disables scheduled workflows after **60 days without repository
> activity**. If the data goes flat, check the Actions tab before suspecting an
> outage.

## Development

```bash
cd collector && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
pytest && ruff check . && mypy
python -m monitor --dry-run          # real checks, no credentials, sends nothing

cd ../api && npm install
npm run migrate:local && npm run dev
python verify_sql.py                 # the shipped SQL, against real SQLite
```
