-- Deployment monitor schema.
--
-- Design rule that drives everything here: a row exists if and only if a check
-- actually ran. There is no 'no_data' status and no placeholder row. A check
-- that never executed leaves a GAP, and a gap is reported as missing coverage,
-- never as downtime. Every query below is written so an absent row can never
-- be mistaken for a failed one.

CREATE TABLE IF NOT EXISTS targets (
  id      TEXT PRIMARY KEY,           -- stable slug written by hand; never renamed
  name    TEXT NOT NULL,
  url     TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id      TEXT    NOT NULL REFERENCES targets(id) ON DELETE CASCADE,

  -- Unix seconds, UTC. Integer rather than TEXT because every window bound,
  -- bucket boundary and gap comparison in this file is arithmetic on it.
  checked_at     INTEGER NOT NULL,

  status         TEXT    NOT NULL CHECK (status IN ('ok', 'failed')),
  http_status    INTEGER CHECK (http_status IS NULL OR (http_status BETWEEN 100 AND 599)),
  latency_ms     INTEGER CHECK (latency_ms IS NULL OR (latency_ms >= 0 AND latency_ms <= 600000)),

  failure_kind   TEXT CHECK (
    failure_kind IS NULL OR
    failure_kind IN ('dns', 'connection_refused', 'tls_error', 'timeout', 'http_error')
  ),
  failure_detail TEXT,

  -- The cadence this row was collected at, stored per row rather than assumed
  -- globally. Coverage and incident-gap detection are both defined relative to
  -- the interval; if the schedule ever changes, old rows keep the cadence they
  -- were really collected at instead of silently acquiring a new meaning.
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),

  -- A row is only coherent if the two halves agree: 'ok' carries no failure,
  -- 'failed' always names a kind. Enforced here so no code path can write a
  -- half-populated check.
  CHECK (
    (status = 'ok'     AND failure_kind IS NULL) OR
    (status = 'failed' AND failure_kind IS NOT NULL)
  )
);

-- INDEX 1. Every read query filters a time window and then works per target
-- (partitioning for percentiles, grouping for uptime, ordering for incident
-- runs); this index serves that access pattern directly instead of scanning.
-- D1 bills rows *scanned*, so it is a cost control as much as a speed one.
-- UNIQUE additionally makes writes idempotent: a batch replayed after a
-- network timeout cannot insert the same check twice and inflate coverage.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_target_time ON checks (target_id, checked_at);

-- INDEX 2. The time series and the window bounds filter on checked_at ALONE,
-- with no target predicate. Index 1 cannot seek for those because target_id is
-- its leading column, so without this one they degrade to a full table scan.
CREATE INDEX IF NOT EXISTS idx_checks_time ON checks (checked_at);

-- No index on targets: it holds one row per monitored site (currently eight).
-- SQLite will scan it faster than it could consult an index, and an index there
-- would be cargo cult.
