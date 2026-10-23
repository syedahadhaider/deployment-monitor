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
- **Coverage** — of the schedule's *slots*, how many held at least one check.

Coverage counts **slots, not samples**. A slot is one period of the cadence,
aligned to the cron minutes the workflow asks for (:07 and :37), and it counts
once however many runs landed in it. That distinction is not academic: it used
to be `recorded / expected`, counting rows, so a slot that ran twice silently
paid for a slot that never ran at all. Over one seven-day window that read
**100% while 5 of 335 slots had genuinely been missed** — 348 checks against
336 expected, with 17 duplicate runs covering the gap. Only slots that have
fully ended inside the window are counted; the one in progress is neither
covered nor missed.

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

**Scheduling** — GitHub Actions cron is best-effort and, on a low-activity
repository, mostly does not fire: in the first nine hours here **one scheduled
run landed out of roughly ten expected**, and that one was fifteen minutes
late. The cron expression was never wrong; `*/30` simply asks for :00 and :30,
the two most oversubscribed minutes on the platform.

Two changes address it, and neither moves the checks out of Python:

1. The schedule now asks for `7,37` instead of `*/30` — offset minutes are
   measurably more likely to actually run.
2. A **watchdog** on Cloudflare, whose cron *is* reliable. Every ten minutes it
   asks the database one question — does the slot in progress hold a check
   yet? — and only if that slot is already 20 minutes old and still empty does
   it nudge the same workflow via `repository_dispatch`. Python still performs
   every check; only the *triggering* becomes dependable.

   **It can double-collect, and it did.** Earlier it triggered on the age of
   the newest check with a threshold of 25 minutes — below the 30-minute
   cadence — so it fired five minutes *before* the next scheduled run was even
   due. Over seven days that produced 17 slots holding both a dispatched run
   and the scheduled run it pre-empted. Triggering on the slot instead of on an
   age cannot pre-empt the next run, because it never looks past the current
   slot. A duplicate is still possible when GitHub's own run arrives after the
   watchdog has given up on a slot — measured lateness here reaches 29m31s —
   but that no longer distorts the figure: the slot counts once, and the
   surplus is reported separately as `extra_runs`.

   On this repository the watchdog is not a backstop but the **primary**
   scheduler: in the same window GitHub's cron fired 41 of 336 expected ticks
   and the watchdog fired 326.

`repository_dispatch` also sidesteps the 60-day inactivity disable that
silently stops `schedule:`.

To enable the watchdog, create a **fine-grained PAT**:

| Setting | Value |
| --- | --- |
| Repository access | Only select repositories -> `syedahadhaider/deployment-monitor` |
| Repository permissions | **Contents: Read and write** |
| (auto-added) | Metadata: Read-only |

`Contents: Read and write` is what `POST /repos/{owner}/{repo}/dispatches`
requires. A classic PAT works too, with the `repo` scope.

Then set it. **Prefer the dashboard**: Workers & Pages -> `deployment-monitor-api`
-> Settings -> Variables and Secrets -> Add, type `Secret`, name
`GITHUB_DISPATCH_TOKEN`. The interactive `wrangler secret put` prompt does not
capture typed input in some Windows terminals — it returns instantly and stores
an **empty** value, and `wrangler secret list` still shows the name, so nothing
looks wrong. If you use the CLI, pipe the value and verify afterwards:

```bash
cd api
echo "<the-pat>" | npx wrangler secret put GITHUB_DISPATCH_TOKEN
npx wrangler deploy

# Confirm it actually took. Reports presence and LENGTH, never the value:
curl -s -X POST https://<your-worker>.workers.dev/watchdog/run   -H "Authorization: Bearer <INGEST_TOKEN>" | jq
```

A healthy reply is `"action": "dispatched"` or `"skipped_fresh"`.
`"not_configured"` with `"token": {"present": false, "length": 0}` means the
secret is empty.

Leaving `GITHUB_DISPATCH_TOKEN` unset is supported: the watchdog disables
itself — and now says so in the logs on every tick — and the collector simply
runs on GitHub's own schedule, less reliably.

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
