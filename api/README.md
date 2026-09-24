# API — Cloudflare Worker + D1

Two endpoints. One authenticated writer, one public cached reader. Every
aggregation is SQL.

```
POST /ingest         bearer auth, validates and rejects, parameterised writes
GET  /summary        public, cached 600s, fully aggregated
POST /watchdog/run   bearer auth, runs the watchdog now and reports its decision
GET  /health         liveness
```

`/watchdog/run` exists because a watchdog that declines to act is
indistinguishable from one that is broken. It returns the action taken
(`dispatched`, `skipped_fresh`, `not_configured`, `dispatch_rejected`,
`threw`), the age of the newest check against the threshold, GitHub's status
and body when a dispatch is rejected, and whether a token is present **with its
length only** — never the value. That last field is the one that matters: an
empty secret and a healthy one look identical to `wrangler secret list`.

## Why the backend lives here

The portfolio site fetches `/summary` and renders it. That is the entire
coupling. No database client, no driver, no ORM and no credential ever enters
the portfolio repository, so the front-end bundle cannot regress because of
this project.

## Schema

See [`migrations/0001_init.sql`](migrations/0001_init.sql). The rule that
drives it: **a row exists if and only if a check actually ran.** There is no
`no_data` status and no placeholder row. A check that never executed leaves a
gap, and a gap is reported as missing *coverage* — never as downtime.

`CHECK` constraints enforce coherence in the database itself, not only in the
validator: latency cannot be negative, `status` and `failure_kind` must agree
(an `ok` row carrying a failure kind is rejected, as is a `failed` row without
one), and `failure_kind` is restricted to the five classified values.

`interval_seconds` is stored **per row**. Coverage and incident-gap detection
are both defined relative to the cadence, so keeping it on the row means older
data retains the cadence it was really collected at instead of silently
acquiring a new meaning if the schedule ever changes. *(This one column is an
addition to the originally sketched schema; everything else matches.)*

### Indexes, and why each exists

| Index | Why |
| --- | --- |
| `idx_checks_target_time (target_id, checked_at)` **UNIQUE** | Every read filters a time window then works per target — partitioning for percentiles, grouping for uptime, ordering for incident runs — so this index serves the real access pattern instead of a scan; `UNIQUE` additionally makes writes idempotent, so a replayed batch cannot insert the same check twice and inflate coverage. |
| `idx_checks_time (checked_at)` | The time series filters on `checked_at` **alone** with no target predicate, which index 1 cannot seek for because `target_id` is its leading column — without this one, the series degrades to a full table scan. |

`targets` has no index: it holds one row per monitored site (eight), which
SQLite scans faster than it could consult an index.

Verified with `EXPLAIN QUERY PLAN` against 20,000 rows — **no query full-scans
`checks`**:

```
SUMMARY/LATENCY/INCIDENTS  SEARCH checks USING INDEX idx_checks_target_time
                                  (ANY(target_id) AND checked_at>? AND checked_at<?)
SERIES                     SEARCH c USING INDEX idx_checks_time
                                  (checked_at>? AND checked_at<?)
```

This is a cost control, not only a speed one — see the D1 budget below.

## Aggregations

All five live in [`src/queries.ts`](src/queries.ts) and all are parameterised;
there is no string-concatenated SQL anywhere in this project.

1. **Uptime** — `ok / (ok + failed)` per target over the window.
2. **Coverage** — `recorded / expected`, where expected comes from the window
   length divided by the cadence stored on the rows. Reported **separately**
   from uptime. Low coverage means the scheduler missed runs; it never means a
   site was down.
3. **Latency p50/p95** — `ROW_NUMBER()` ranking, nearest-rank, over successful
   checks only (a timeout would otherwise enter the distribution as the timeout
   *setting*, not a measurement). **Gated in SQL at 50 samples**: below that the
   percentile columns return `NULL` and only the sample count plus an
   `insufficient_data` flag come back, so no code path can report a p95 built
   from a dozen points.
4. **Incidents** — derived, never stored. See below.
5. **Time series** — 3-hour buckets across the 7-day window.

### Incidents terminate at scheduler gaps

Gap-and-island detection. A new incident starts at a failed check *unless* the
previous check was also failed **and** arrived close enough to be the next
scheduled tick:

```sql
CASE
  WHEN status <> 'failed' THEN 0
  WHEN prev_status = 'failed'
   AND prev_at IS NOT NULL
   AND (checked_at - prev_at) <= interval_seconds * ?3 THEN 0
  ELSE 1
END AS starts_run
```

A running `SUM()` over that flag assigns run ids. If the collector went quiet
between two failed checks, the time difference exceeds the tolerance,
`starts_run` flips to 1, and a **new** run begins. **Failed → gap → failed is
therefore two observed incidents with an unknown window between them, not one
long outage.** The data cannot support the longer claim, so the query does not
make it.

Resolution is classified in SQL from the check *following* the last failure:
`resolved` (next check was ok and on schedule), `ongoing` (no later check at
all), or `unknown` (a later check exists but a gap sits between it and the
failure, so recovery was never observed).

The tolerance is two intervals rather than exactly one because GitHub Actions
cron routinely runs minutes late; a tick inside two intervals is still "the
next check", one later than that is a gap.

### The series emits empty buckets

A recursive CTE generates every bucket in the window *before* joining, so a
bucket with no checks returns `checks = 0` rather than being absent. The chart
can then draw it as "no data" instead of letting a missing bar read as an
outage — the scheduler's reliability is visible next to the sites'.

## Write API

- **Bearer token**, compared with a constant-time equality so the token cannot
  be recovered byte by byte through response timing. Unauthenticated requests
  get `401` and a body that says nothing about which part was wrong.
- **Every field validated** — types, ranges, enum membership, timestamp sanity
  (no future timestamps beyond 300s of clock skew, nothing older than 24h),
  batch size, and cross-field coherence. Rejections are `400` with a message
  naming the offending field and index.
- **Targets cannot be created by a payload.** `target_id` is checked against
  the enabled rows already in the database.
- **Parameterised only.** Every value is bound.
- **Idempotent.** `INSERT OR IGNORE` against the unique index, so a replayed
  batch reports `duplicates_ignored` instead of double-counting.

Verified against the running Worker:

| Request | Result |
| --- | --- |
| no token / wrong token | `401 unauthorized` |
| unknown target | `400 checks[0].target_id: unknown or disabled target 'evil'` |
| negative latency | `400 checks[0].latency_ms: -5 is negative` |
| future timestamp | `400 checks[0].checked_at: … is in the future` |
| bad status enum | `400 checks[0].status: expected 'ok' or 'failed'` |
| `ok` row with a failure kind | `400 checks[0]: an 'ok' check cannot carry a failure_kind` |
| `'; DROP TABLE checks;--` as target_id | `400` unknown target (and bound, never interpolated) |
| replayed batch | `{"received":8,"inserted":0,"duplicates_ignored":8}` |

## Read API and the cache TTL

`/summary` is public and cached for **600 seconds**.

Checks arrive every 30 minutes, so a shorter TTL would mostly re-run the same
aggregation over identical rows. Ten minutes bounds worst-case staleness to a
third of the collection interval while capping origin hits at 144/day per edge
location.

That cap matters for correctness, not just speed: since **1 September 2026**
D1 *fails* queries once the free tier's daily row limit is reached, and because
the limit is account-wide that failure would take the collector's **writes**
down with it. The TTL is a safety margin.

A D1 error — including that limit — returns `503` with
`"monitor data is temporarily unavailable"` and `Cache-Control: no-store`. It
never degrades into a page implying every site is down.

## D1 free tier budget

Confirmed 2026-09-24 from Cloudflare's pricing page:

| Free tier | Limit | Projected use |
| --- | --- | --- |
| Rows written | 100,000 / day | 8 targets × 48 checks = **384/day (0.4%)** |
| Rows read | 5,000,000 / day | **~13,400 per uncached `/summary`** |
| Storage | 5 GB account, 500 MB / database | ~17 MB/year |

The read figure is the binding constraint, so it is the one that was designed
against. 2,688 rows fall in a 7-day window; the four statements scan that range
via index (never the table), giving ≈13,400 rows per uncached request — about
**370 uncached requests/day** of headroom, against a cache that admits at most
144/day per edge location.

If traffic ever outgrew that, the fix is a rollup table maintained on write
rather than a bigger plan; read-time aggregation is kept here because
demonstrating the queries is the point of the project.

## Local development

```bash
npm install
npm run migrate:local
echo 'INGEST_TOKEN = "local-test-token"' > .dev.vars   # gitignored
npm run dev
python verify_sql.py     # runs the shipped SQL against real SQLite
```

`verify_sql.py` extracts the queries **from `queries.ts`** so the text under
test is the text that ships, builds synthetic fixtures in an in-memory
database, and asserts the behaviour that matters — above all that an incident
terminates at a scheduler gap. Those fixtures never touch D1 and never reach
the dashboard.
