/**
 * Every aggregation in this project is SQL. Nothing here fetches rows and
 * reduces them in JavaScript: uptime, coverage, percentiles, the bucketed
 * series and the incidents are all computed by the database and arrive at the
 * Worker already in their final shape.
 *
 * All queries are parameterised. There is no string interpolation of any
 * caller-controlled value anywhere in this file. LATENCY_SQL builds a VALUES
 * list whose LENGTH varies with the number of targets; the generated text is
 * placeholders only (`(?4, ?5), (?6, ?7), ...`) and every value is still bound.
 *
 * READ COST IS A CORRECTNESS CONCERN HERE, not just a performance one. D1 bills
 * rows SCANNED and the free tier stops accepting WRITES once the daily read
 * quota is gone -- so an expensive read query does not merely run slowly, it
 * eventually costs the collector its data. Measured on the live database at
 * 13,512 rows:
 *
 *   SUMMARY_SQL    33,884 -> 4,159 rows read   (one grouped pass, not four)
 *   LATENCY_SQL    16,402 -> 12,328            (one window spec, not two)
 *   INCIDENTS_SQL  26,655 -> 0 when the window holds no failed check
 *   SERIES_SQL      4,270 unchanged            (rewrites measured worse)
 *
 * Every one of these is bounded by the WINDOW, never by the table, so the cost
 * stays flat as history accumulates. `api/explain_plans.py` is the gate: it
 * fails if any shipped query plans as a SCAN of `checks`.
 */

/**
 * Per target: availability, coverage and freshness over the window.
 *
 * Uptime and coverage are deliberately two different fractions:
 *   uptime   = ok / (ok + failed)        - of the checks that RAN, how many passed
 *   coverage = slots covered / expected  - how many of the schedule's slots got
 *                                          at least one check
 *
 * COVERAGE COUNTS SLOTS, NOT SAMPLES. It used to be recorded / expected, which
 * counted rows: a slot that ran twice silently paid for a slot that never ran
 * at all, so the figure read 100% while runs were genuinely being missed. On
 * the live data that was 349 checks against 336 expected -- reported as 100%
 * -- while only 332 of the schedule's slots actually held a check. The
 * sentence the dashboard prints, "low coverage means my scheduler missed
 * runs", was false under the old formula. It is true under this one.
 *
 * A SLOT is one period of the collection cadence, aligned to the cron minutes
 * the workflow actually asks for (:07 and :37, so the phase is 7*60 = 420s
 * past the hour, passed in as ?4). Aligning to the cron rather than to the
 * window's own start matters: the window start moves every time /summary is
 * requested, so window-relative slots would shift under the data and a run
 * could change which slot it belongs to between two reads of the same figure.
 * The cron phase is fixed, so a given check is always in the same slot.
 *
 * Only slots that have FULLY ENDED inside the window are counted. The slot
 * containing the window's start is usually clipped and the slot containing
 * "now" is still open; neither is covered nor missed, so both are excluded.
 * That is why a 7-day window at a 30-minute cadence expects 335 slots rather
 * than 336 whenever the window edge does not land exactly on a slot boundary.
 *
 * The LEFT JOIN from `targets` matters: a target with no checks at all in the
 * window still returns a row, with zero counts and NULL last_checked_at. It is
 * reported as "no data", never as down.
 *
 * ONE PASS over the window. This used to be four CTEs -- `scoped`, `agg`,
 * `latest`, `bounds`, `slots` -- each of which made SQLite re-read the window,
 * costing 33,884 rows to aggregate 2,048. Everything a target needs is now a
 * single GROUP BY, and "the newest check" is three point lookups that ride
 * (target_id, checked_at) backwards and read one row each. MATERIALIZED hints
 * were tried first and measured WORSE (24,468 at best), which is why the shape
 * changed instead.
 *
 * The slot grid uses each row's OWN `interval_seconds`, which is the column's
 * stated purpose: a row keeps the cadence it was really collected at. The
 * previous form used MIN(interval_seconds) across the target's window for
 * every row of it, so the two differ only for a target whose window spans a
 * cadence CHANGE -- no such row exists, and the cadence is stored per row
 * precisely so old rows are not reinterpreted. `slots_expected` still uses the
 * window-wide COALESCE(MIN(interval_seconds), ?3), unchanged.
 *
 * `latency_samples` is carried here so LATENCY_SQL does not need a second pass
 * over the window just to count its own inputs.
 */
export const SUMMARY_SQL = `
WITH agg AS (
  SELECT
    target_id,
    COUNT(*)                                            AS checks_recorded,
    SUM(CASE WHEN status = 'ok'     THEN 1 ELSE 0 END)  AS ok_count,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)  AS failed_count,
    MIN(checked_at)                                     AS first_checked_at,
    MAX(checked_at)                                     AS last_checked_at,
    MIN(interval_seconds)                               AS interval_seconds,
    -- Slots this target actually covered, and how many checks fell inside
    -- them. The difference is the number of runs beyond the first in a slot.
    COUNT(DISTINCT CASE
      WHEN CAST((checked_at - ?4) / interval_seconds AS INTEGER)
           BETWEEN CAST(((?1 - ?4) + interval_seconds - 1) / interval_seconds AS INTEGER)
               AND CAST((?2 - ?4) / interval_seconds AS INTEGER) - 1
      THEN CAST((checked_at - ?4) / interval_seconds AS INTEGER)
    END)                                                AS slots_covered,
    SUM(CASE
      WHEN CAST((checked_at - ?4) / interval_seconds AS INTEGER)
           BETWEEN CAST(((?1 - ?4) + interval_seconds - 1) / interval_seconds AS INTEGER)
               AND CAST((?2 - ?4) / interval_seconds AS INTEGER) - 1
      THEN 1 ELSE 0
    END)                                                AS checks_in_slots,
    -- Percentile inputs, counted here so LATENCY_SQL need not re-read the
    -- window to discover its own sample size.
    SUM(CASE WHEN status = 'ok' AND latency_ms IS NOT NULL THEN 1 ELSE 0 END)
                                                        AS latency_samples
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
  GROUP BY target_id
)
SELECT
  t.id                                   AS target_id,
  t.name                                 AS name,
  t.url                                  AS url,
  COALESCE(a.checks_recorded, 0)         AS checks_recorded,
  COALESCE(a.ok_count, 0)                AS ok_count,
  COALESCE(a.failed_count, 0)            AS failed_count,
  a.first_checked_at                     AS first_checked_at,
  a.last_checked_at                      AS last_checked_at,
  -- The newest check's own columns. ORDER BY checked_at DESC LIMIT 1 walks
  -- (target_id, checked_at) backwards and stops on the first row, so each of
  -- these reads one row rather than ranking the window. (target_id,
  -- checked_at) is UNIQUE, so "the newest" is never ambiguous.
  (SELECT c.status       FROM checks c
     WHERE c.target_id = t.id AND c.checked_at >= ?1 AND c.checked_at <= ?2
     ORDER BY c.checked_at DESC LIMIT 1) AS last_status,
  (SELECT c.http_status  FROM checks c
     WHERE c.target_id = t.id AND c.checked_at >= ?1 AND c.checked_at <= ?2
     ORDER BY c.checked_at DESC LIMIT 1) AS last_http_status,
  (SELECT c.failure_kind FROM checks c
     WHERE c.target_id = t.id AND c.checked_at >= ?1 AND c.checked_at <= ?2
     ORDER BY c.checked_at DESC LIMIT 1) AS last_failure_kind,
  a.interval_seconds                     AS interval_seconds,
  -- Expected ticks in the window at the cadence the data was collected at.
  -- Kept for backward compatibility: it is a count of SAMPLES, and it is the
  -- denominator coverage no longer uses.
  CAST((?2 - ?1) / COALESCE(a.interval_seconds, ?3) AS INTEGER) AS checks_expected,
  -- The coverage denominator: slots that fully ended inside the window.
  CAST(MAX(
    (CAST((?2 - ?4) / COALESCE(a.interval_seconds, ?3) AS INTEGER) - 1)
    - CAST(((?1 - ?4) + COALESCE(a.interval_seconds, ?3) - 1) / COALESCE(a.interval_seconds, ?3) AS INTEGER)
    + 1, 0) AS INTEGER)                  AS slots_expected,
  CAST(COALESCE(a.slots_covered, 0) AS INTEGER)                 AS slots_covered,
  -- Runs beyond the first in a slot. Never negative: checks_in_slots counts the
  -- same rows slots_covered is distinct over.
  CAST(COALESCE(a.checks_in_slots, 0) - COALESCE(a.slots_covered, 0) AS INTEGER) AS extra_runs,
  COALESCE(a.latency_samples, 0)         AS latency_samples
FROM targets t
LEFT JOIN agg a ON a.target_id = t.id
WHERE t.enabled = 1
ORDER BY t.name
`;

/**
 * Latency percentiles per target, gated on sample count.
 *
 * SQLite has no percentile function, so this ranks each target's successful
 * latencies with ROW_NUMBER() and picks the nearest-rank value. Only 'ok'
 * checks contribute: a timeout would otherwise enter the distribution as
 * "10000ms", which is the timeout setting, not a measurement.
 *
 * The gate is in SQL, not in the caller. Below MIN_SAMPLES the percentile
 * columns come back NULL and only the count is returned, so there is no code
 * path that can report a p95 derived from a dozen points.
 *
 * ONE window spec, not two. `ROW_NUMBER() OVER (...)` and `COUNT(*) OVER (...)`
 * are different window definitions over the same partition, so SQLite sorted
 * the window twice: measured 16,402 rows read where a single spec costs 8,201.
 * The sample count now arrives from SUMMARY_SQL's grouped pass, which was
 * already reading these rows, and is bound in through `{{WANT}}`.
 *
 * The rank arithmetic stays in SQL, derived from the bound `n`, so the
 * definition of p50 and p95 lives in exactly one place and the caller cannot
 * disagree with it. Values were compared against the previous form on all
 * eight live targets and matched exactly.
 *
 * `{{WANT}}` is expanded by `latencySql(count)` into `(?4, ?5), (?6, ?7), ...`
 * -- placeholders only. Targets with no samples are left out of the list
 * entirely, which is what the previous form did implicitly by producing no
 * group for them.
 */
export const LATENCY_SQL = `
WITH want0(target_id, n) AS (VALUES {{WANT}}),
want AS (
  SELECT
    target_id,
    n,
    CAST((n - 1) * 0.50 AS INTEGER) + 1 AS p50_rn,
    CAST((n - 1) * 0.95 AS INTEGER) + 1 AS p95_rn
  FROM want0
),
samples AS (
  SELECT
    target_id,
    latency_ms,
    ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY latency_ms) AS rn
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
    AND status = 'ok'
    AND latency_ms IS NOT NULL
)
SELECT
  w.target_id                                                               AS target_id,
  w.n                                                                       AS sample_count,
  CASE WHEN w.n >= ?3 THEN MAX(CASE WHEN s.rn = w.p50_rn THEN s.latency_ms END) END AS p50_ms,
  CASE WHEN w.n >= ?3 THEN MAX(CASE WHEN s.rn = w.p95_rn THEN s.latency_ms END) END AS p95_ms,
  CASE WHEN w.n >= ?3 THEN 0 ELSE 1 END                                     AS insufficient_data
FROM want w
JOIN samples s
  ON s.target_id = w.target_id
 AND s.rn IN (w.p50_rn, w.p95_rn)
GROUP BY w.target_id, w.n
`;

/** First bound parameter of the `{{WANT}}` list. ?1-?3 are since, now, gate. */
const LATENCY_WANT_FIRST_PARAM = 4;

/**
 * Expand `{{WANT}}` for `count` targets.
 *
 * Generates placeholders and nothing else -- no caller value is interpolated.
 * Throws on a count of zero rather than emitting `VALUES ()`, which is a
 * syntax error: a window with no latency samples anywhere has no percentiles
 * to ask for, and the caller must skip the query instead.
 */
export function latencySql(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`latencySql needs at least one target, got ${count}`);
  }
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = LATENCY_WANT_FIRST_PARAM + i * 2;
    rows.push(`(?${base}, ?${base + 1})`);
  }
  return LATENCY_SQL.replace('{{WANT}}', rows.join(', '));
}

/**
 * Incidents, DERIVED - never stored.
 *
 * Gap-and-island detection over the check sequence. A new incident starts at a
 * failed check unless the immediately preceding check was ALSO failed AND
 * arrived close enough in time to be the next scheduled tick.
 *
 * That second condition is the important one. `checked_at - prev_at <=
 * interval_seconds * GAP_TOLERANCE` is what makes an incident terminate at a
 * scheduler gap: if the collector went quiet for two hours between two failed
 * checks, the difference exceeds the tolerance, `starts_run` flips to 1, and
 * the running SUM() assigns a NEW run id. Failed -> gap -> failed is therefore
 * reported as TWO observed incidents with an unknown window between them, not
 * as one long outage. The data cannot support the longer claim, so the query
 * does not make it.
 *
 * The tolerance is a multiple rather than an exact interval because GitHub
 * Actions cron is routinely minutes late; a tick that arrives inside two
 * intervals is still "the next check", one that arrives later is a gap.
 *
 * Resolution is classified in SQL from the check that FOLLOWS the last failure:
 *   resolved - the next check was ok and arrived on schedule
 *   ongoing  - there is no later check at all
 *   unknown  - a later check exists but a gap sits between, so the moment
 *              recovery happened was never observed
 *
 * This is the most expensive query in the project -- 26,655 rows read against
 * a 2,048-row window -- because LAG/LEAD have to walk every check in the
 * window, not just the failed ones, to tell a continuing outage from a
 * scheduler gap. It cannot be narrowed to failed ROWS without losing the
 * neighbour each one is compared against.
 *
 * It CAN be narrowed to failed TARGETS, which `{{TARGETS}}` does. Every window
 * function here partitions by target_id, so a target's results depend on no
 * other target's rows; and a target with no failed check in the window
 * contributes no row to `failures` and therefore no incident. Excluding those
 * targets is exact, not approximate. The caller gets the list free: SUMMARY_SQL
 * already counted `failed_count` per target in its own pass, and when that is
 * zero everywhere this query is skipped entirely.
 */
export const INCIDENTS_SQL = `
WITH scoped AS (
  SELECT target_id, checked_at, status, failure_kind, failure_detail, interval_seconds
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
    AND target_id IN ({{TARGETS}})
),
seq AS (
  SELECT
    target_id, checked_at, status, failure_kind, failure_detail, interval_seconds,
    LAG(checked_at)  OVER w AS prev_at,
    LAG(status)      OVER w AS prev_status,
    LEAD(checked_at) OVER w AS next_at,
    LEAD(status)     OVER w AS next_status
  FROM scoped
  WINDOW w AS (PARTITION BY target_id ORDER BY checked_at)
),
marked AS (
  SELECT
    seq.*,
    CASE
      WHEN status <> 'failed' THEN 0
      WHEN prev_status = 'failed'
       AND prev_at IS NOT NULL
       AND (checked_at - prev_at) <= interval_seconds * ?3 THEN 0
      ELSE 1
    END AS starts_run
  FROM seq
),
runs AS (
  SELECT
    marked.*,
    SUM(starts_run) OVER (
      PARTITION BY target_id ORDER BY checked_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS run_id
  FROM marked
),
failures AS (
  SELECT
    runs.*,
    ROW_NUMBER() OVER (PARTITION BY target_id, run_id ORDER BY checked_at DESC) AS rn_desc
  FROM runs
  WHERE status = 'failed'
)
SELECT
  target_id,
  MIN(checked_at)                                          AS first_failure_at,
  MAX(checked_at)                                          AS last_failure_at,
  COUNT(*)                                                 AS failed_checks,
  MAX(checked_at) - MIN(checked_at)                        AS observed_seconds,
  group_concat(DISTINCT failure_kind)                      AS failure_kinds,
  MAX(CASE WHEN rn_desc = 1 THEN failure_detail END)       AS last_detail,
  MAX(CASE WHEN rn_desc = 1 THEN next_at END)              AS next_check_at,
  CASE
    WHEN MAX(CASE WHEN rn_desc = 1 THEN next_at END) IS NULL THEN 'ongoing'
    WHEN MAX(CASE WHEN rn_desc = 1 THEN next_at END) - MAX(checked_at)
         > MAX(CASE WHEN rn_desc = 1 THEN interval_seconds END) * ?3 THEN 'unknown'
    WHEN MAX(CASE WHEN rn_desc = 1 THEN next_status END) = 'ok' THEN 'resolved'
    ELSE 'unknown'
  END                                                      AS resolution
FROM failures
GROUP BY target_id, run_id
ORDER BY first_failure_at DESC
LIMIT ?4
`;

/** First bound parameter of `{{TARGETS}}`. ?1-?4 are since, now, gap, limit. */
const INCIDENTS_TARGETS_FIRST_PARAM = 5;

/**
 * Expand `{{TARGETS}}` for `count` targets.
 *
 * Placeholders only; the ids themselves are bound by the caller. Throws on
 * zero rather than emitting `IN ()`: a window with no failed check anywhere has
 * no incidents to look for, and the caller must skip the query instead.
 */
export function incidentsSql(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`incidentsSql needs at least one target, got ${count}`);
  }
  const holes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    holes.push(`?${INCIDENTS_TARGETS_FIRST_PARAM + i}`);
  }
  return INCIDENTS_SQL.replace('{{TARGETS}}', holes.join(', '));
}

/**
 * Bucketed time series across all targets.
 *
 * The recursive CTE generates EVERY bucket in the window before joining, so a
 * bucket in which no check ran comes back with checks = 0 instead of being
 * absent from the result. That is the whole point: the chart can then draw the
 * gap as "no data" rather than letting a missing bar read as an outage, and
 * the scheduler's reliability becomes visible next to the sites'.
 */
export const SERIES_SQL = `
WITH RECURSIVE buckets(bucket_start) AS (
  SELECT CAST(?1 / ?3 AS INTEGER) * ?3
  UNION ALL
  SELECT bucket_start + ?3 FROM buckets WHERE bucket_start + ?3 <= ?2
)
SELECT
  b.bucket_start                                        AS bucket_start,
  COUNT(c.id)                                           AS checks,
  SUM(CASE WHEN c.status = 'ok'     THEN 1 ELSE 0 END)  AS ok_count,
  SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END)  AS failed_count
FROM buckets b
LEFT JOIN checks c
  ON c.checked_at >= b.bucket_start
 AND c.checked_at <  b.bucket_start + ?3
GROUP BY b.bucket_start
ORDER BY b.bucket_start
`;

/**
 * The computed /summary payload, cached in the database.
 *
 * One row, read by primary key, so a cache HIT costs one row read instead of
 * the ~21,000 a recomputation costs. The Cache API still sits in front of this
 * and absorbs repeat traffic without touching D1 at all; this layer exists
 * because that one is per-colo and therefore cannot bound how often the
 * database is recomputed from.
 *
 * The slot and the version are both part of the match, so a payload is served
 * only when it was computed in the current collection slot AND under the
 * current response shape. Anything else misses and is recomputed.
 */
export const SUMMARY_CACHE_GET_SQL = `
SELECT payload, computed_at
FROM summary_cache
WHERE id = 1 AND version = ?1 AND slot_start = ?2
`;

export const SUMMARY_CACHE_PUT_SQL = `
INSERT OR REPLACE INTO summary_cache (id, version, slot_start, payload, computed_at)
VALUES (1, ?1, ?2, ?3, ?4)
`;

/**
 * The watchdog's two questions, each answered by one row.
 *
 * These were a single statement -- MAX(checked_at) together with a
 * SUM(CASE ...) over the same table -- and the SUM forced a full pass: SQLite
 * can satisfy a bare MAX() from the tail of an index, but not a MAX beside a
 * conditional count. Measured, that one statement read 13,512 rows on every
 * tick, 144 times a day, and grew by ~370 rows a day as history accumulated.
 * Split apart, each reads a single row and neither grows.
 */
export const WATCHDOG_LAST_CHECK_SQL = `SELECT MAX(checked_at) AS last FROM checks`;

export const WATCHDOG_SLOT_FILLED_SQL = `
SELECT EXISTS(SELECT 1 FROM checks WHERE checked_at >= ?1) AS in_slot
`;

/** Targets, for the ingest validator to check membership against. */
export const ENABLED_TARGETS_SQL = `SELECT id FROM targets WHERE enabled = 1`;

/**
 * Insert one check. OR IGNORE because (target_id, checked_at) is UNIQUE: a
 * replayed batch is silently idempotent rather than a duplicate-key error or,
 * worse, a second row that inflates both check count and coverage.
 */
export const INSERT_CHECK_SQL = `
INSERT OR IGNORE INTO checks
  (target_id, checked_at, status, http_status, latency_ms, failure_kind, failure_detail, interval_seconds)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
`;
