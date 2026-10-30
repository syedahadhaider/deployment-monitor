# API — Cloudflare Worker + D1

Two endpoints. One authenticated writer, one public cached reader. Every
aggregation is SQL.

```
POST /ingest         bearer auth, validates and rejects, parameterised writes
GET  /summary        public, cached (edge 600s + a global cache in D1), fully aggregated
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

`api/explain_plans.py` is the gate for this: it builds a production-sized
replica from these migrations, runs `ANALYZE`, and **fails if any shipped query
plans as a `SCAN` of `checks`** — including a `SCAN ... USING COVERING INDEX`,
which reads every entry in the index and so costs the whole table. It runs as
section 15 of `verify_sql.py`, so the gate cannot be forgotten.


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
2. **Coverage** — `slots covered / slots expected`. A slot is one period of the
   cadence, aligned to the cron minutes the workflow asks for (:07 and :37); it
   is covered if it holds at least one check, however many it holds. Only slots
   that have fully ended inside the window are counted, so the slot in progress
   is neither covered nor missed. Reported **separately** from uptime. Low
   coverage means the scheduler missed runs; it never means a site was down.

   It counted *samples* until 24 October — `recorded / expected`, clamped to 1
   — which let a duplicate run pay for a missed one. The live data read 100%
   coverage from 348 checks against 336 expected while only 330 of 335 slots
   had actually been served. `slots_expected`, `slots_covered` and `extra_runs`
   are returned alongside it so the surplus is visible rather than absorbed.
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

## Read API and caching

`/summary` is cached twice, and the second layer is the one that matters.

| Layer | Scope | Period | Cost of a hit |
| --- | --- | --- | --- |
| Cache API | **per colo** | 600s | nothing — never reaches the Worker's database |
| `summary_cache` table | **global** | 2 collection slots (1 hour) | 1 row read |

The edge cache alone cannot bound how often the summary is recomputed, because
it is per colo: every colo that serves a request misses its own copy and
recomputes. The README used to budget as though it capped origin hits at
144/day; it caps them at 144/day **per edge location**, and the difference is
what exhausted this account's daily read quota and, with it, the collector's
ability to write. The D1-backed layer is the global backstop — one row, read by
primary key, shared by every colo.

Keyed on the slot grid rather than a wall clock, because the collector writes
one batch per slot: recomputing inside a period spends quota to produce a
byte-identical answer. Two slots rather than one is an arithmetic choice, set
out in `SUMMARY_CACHE_SLOTS` in `src/index.ts`.

That matters for correctness, not just speed: since **1 September 2026** D1
*fails* queries once the free tier's daily row limit is reached, and because
the limit is account-wide that failure takes the collector's **writes** down
with it. This is not hypothetical — it is what happened here daily from 19
October, losing about a third of each day's runs.

A D1 error — including that limit — returns `503` with
`"monitor data is temporarily unavailable"` and `Cache-Control: no-store`. It
never degrades into a page implying every site is down.

## D1 free tier budget

Rows **read** is the binding constraint. Everything below is measured, not
projected: D1 returns `meta.rows_read` per statement, so each figure is one
call against the live database on 2026-10-30, with 13,512 rows in `checks` and
2,048 in the 7-day window.

| Free tier | Limit | Use |
| --- | --- | --- |
| Rows written | 100,000 / day | 8 targets × 48 slots = **384/day (0.4%)** |
| Rows read | 5,000,000 / day | **~499,000/day (10%)** — see below |
| Storage | 5 GB account, 500 MB / database | ~17 MB/year |

Per call, before and after this pass:

| Statement | Before | After |
| --- | --- | --- |
| `SUMMARY_SQL` | 33,884 | **4,159** |
| `LATENCY_SQL` | 16,402 | **12,320** |
| `SERIES_SQL` | 4,270 | 4,270 |
| `INCIDENTS_SQL` | 26,655 | **0** when the window holds no failure; 3,083 per failing target |
| watchdog freshness, per tick | 13,512 | **2** |
| `/summary` cache hit | — | **1** |

A day, at the 48-slot collection cadence:

| | Before | After |
| --- | --- | --- |
| watchdog, 144 ticks | 1,945,728 | 288 |
| `/summary` recomputations | 57 × 81,211 = 4,629,027 | 24 × 20,750 = 498,000 |
| ingest writes + target validation | ~1,150 | ~1,150 |
| **total** | **~6,576,000 (132% of the limit)** | **~499,000 (10%)** |

The "before" total agrees with `wrangler d1 insights` over the preceding seven
days, which recorded 44,633,399 rows read — 6,376,200/day.

**The figure no longer grows with the table.** Every statement is bounded by the
7-day window, and the watchdog reads two rows whatever the history. Before this
pass the watchdog alone added ~53,000 rows/day to the daily cost for every day
the collector ran, which is why the failures started near midnight in October
and had moved to mid-afternoon within a week.

## Retention — proposed, not implemented

**Delete checks older than 90 days**, from the existing scheduled handler.

At 384 rows/day that caps `checks` near **34,560 rows** and storage near 4 MB,
against an unbounded ~140,000 rows and ~17 MB a year.

Two honest caveats on the recommendation:

- **It is not what fixes the quota, and must not be sold as that.** After this
  pass no query's cost depends on the table size, so deleting history saves
  nothing on reads. The reason to do it is storage and planner statistics, not
  the daily allowance. Had retention been applied *instead* of these changes,
  the watchdog would still have scanned 34,560 rows every ten minutes — 5
  million a day on its own, the entire allowance.
- **90 days keeps more than anything reads.** The dashboard window is 7 days and
  no query looks further back, so 90 days is for being able to answer questions
  about the past by hand, with ~13× headroom over what is actually queried.

Deliberately not done in this pass: it deletes data, which deserves its own
review rather than riding along with a read-volume fix.

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
