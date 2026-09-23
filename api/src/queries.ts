/**
 * Every aggregation in this project is SQL. Nothing here fetches rows and
 * reduces them in JavaScript: uptime, coverage, percentiles, the bucketed
 * series and the incidents are all computed by the database and arrive at the
 * Worker already in their final shape.
 *
 * All five queries are parameterised. There is no string interpolation of any
 * caller-controlled value anywhere in this file.
 */

/**
 * Per target: availability, coverage and freshness over the window.
 *
 * Uptime and coverage are deliberately two different fractions:
 *   uptime   = ok / (ok + failed)  - of the checks that RAN, how many passed
 *   coverage = recorded / expected - how many of the checks that SHOULD have
 *                                    run actually did
 * Expected comes from the cadence stored on the rows themselves. A scheduler
 * that skipped half its ticks produces low coverage and leaves uptime
 * untouched, which is the only honest way to report it.
 *
 * The LEFT JOIN from `targets` matters: a target with no checks at all in the
 * window still returns a row, with zero counts and NULL last_checked_at. It is
 * reported as "no data", never as down.
 */
export const SUMMARY_SQL = `
WITH scoped AS (
  SELECT target_id, status, checked_at, http_status, failure_kind, interval_seconds
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
),
agg AS (
  SELECT
    target_id,
    COUNT(*)                                            AS checks_recorded,
    SUM(CASE WHEN status = 'ok'     THEN 1 ELSE 0 END)  AS ok_count,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)  AS failed_count,
    MIN(checked_at)                                     AS first_checked_at,
    MAX(checked_at)                                     AS last_checked_at,
    MIN(interval_seconds)                               AS interval_seconds
  FROM scoped
  GROUP BY target_id
),
latest AS (
  SELECT target_id, status, http_status, failure_kind
  FROM (
    SELECT target_id, status, http_status, failure_kind,
           ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY checked_at DESC) AS rn
    FROM scoped
  )
  WHERE rn = 1
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
  l.status                               AS last_status,
  l.http_status                          AS last_http_status,
  l.failure_kind                         AS last_failure_kind,
  a.interval_seconds                     AS interval_seconds,
  -- Expected ticks in the window at the cadence the data was collected at.
  -- Falls back to the caller-supplied default only when the target has no rows
  -- to read a cadence from.
  CAST((?2 - ?1) / COALESCE(a.interval_seconds, ?3) AS INTEGER) AS checks_expected
FROM targets t
LEFT JOIN agg    a ON a.target_id = t.id
LEFT JOIN latest l ON l.target_id = t.id
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
 */
export const LATENCY_SQL = `
WITH samples AS (
  SELECT
    target_id,
    latency_ms,
    ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY latency_ms) AS rn,
    COUNT(*)    OVER (PARTITION BY target_id)                      AS n
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
    AND status = 'ok'
    AND latency_ms IS NOT NULL
),
ranked AS (
  SELECT
    target_id, latency_ms, rn, n,
    CAST((n - 1) * 0.50 AS INTEGER) + 1 AS p50_rn,
    CAST((n - 1) * 0.95 AS INTEGER) + 1 AS p95_rn
  FROM samples
)
SELECT
  target_id,
  n AS sample_count,
  CASE WHEN n >= ?3 THEN MAX(CASE WHEN rn = p50_rn THEN latency_ms END) END AS p50_ms,
  CASE WHEN n >= ?3 THEN MAX(CASE WHEN rn = p95_rn THEN latency_ms END) END AS p95_ms,
  CASE WHEN n >= ?3 THEN 0 ELSE 1 END                                       AS insufficient_data
FROM ranked
GROUP BY target_id, n
`;

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
 */
export const INCIDENTS_SQL = `
WITH scoped AS (
  SELECT target_id, checked_at, status, failure_kind, failure_detail, interval_seconds
  FROM checks
  WHERE checked_at >= ?1 AND checked_at <= ?2
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
