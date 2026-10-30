"""EXPLAIN QUERY PLAN for every query the Worker and the watchdog issue.

D1 bills rows SCANNED, and since 1 September 2026 it REFUSES queries once the
free tier's daily row-read allowance is gone -- which takes the collector's
writes down with the dashboard's reads. So a plan that scans `checks` is not a
performance note here, it is the mechanism by which this service breaks: the
cost grows with history until a normal day exhausts the quota before midnight.

This is the gate for that. It builds a local SQLite database from the real
migrations, fills it to roughly production size, runs ANALYZE so the planner
has statistics rather than defaults, and fails if any shipped query plans as a
SCAN of `checks`.

A SCAN is a full pass WHETHER OR NOT it rides an index. "SCAN checks USING
COVERING INDEX idx_checks_time" reads every entry in that index, which is every
row in the table, and D1 bills all of them -- that exact plan was the watchdog
query costing 13,512 rows a tick. Only SEARCH is bounded.

Local SQLite on purpose: D1 runs SQLite, the schema is the migration itself and
the queries are extracted from the shipped file, so the plans correspond -- and
asking the live database would spend the very reads this exists to remove.

    python explain_plans.py     # reports every plan; exits 1 on any SCAN of checks
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

HERE = Path(__file__).parent
MIGRATIONS = sorted((HERE / "migrations").glob("*.sql"))
QUERIES = (HERE / "src" / "queries.ts").read_text(encoding="utf-8")

INTERVAL = 1800
SLOT_PHASE = 420
GAP_TOLERANCE = 2
MAX_INCIDENTS = 50
MIN_SAMPLES = 50
BUCKET = 10800

# Roughly production shape: 8 targets, 48 slots a day, five weeks of history.
TARGETS = 8
DAYS = 36
NOW = 1_793_000_000
SINCE = NOW - 604_800


def sql(name: str) -> str:
    match = re.search(rf"export const {name} = `(.*?)`;", QUERIES, re.S)
    if not match:
        raise SystemExit(f"could not find {name} in queries.ts")
    return match.group(1)


def latency_sql(count: int) -> str:
    """Expand LATENCY_SQL's `{{WANT}}`, mirroring `latencySql(count)`."""
    match = re.search(r"LATENCY_WANT_FIRST_PARAM = (\d+)", QUERIES)
    if not match:
        raise SystemExit("could not find LATENCY_WANT_FIRST_PARAM in queries.ts")
    first = int(match.group(1))
    rows = [f"(?{first + i * 2}, ?{first + i * 2 + 1})" for i in range(count)]
    return sql("LATENCY_SQL").replace("{{WANT}}", ", ".join(rows))


def incidents_sql(count: int) -> str:
    """Expand INCIDENTS_SQL's `{{TARGETS}}`, mirroring `incidentsSql(count)`."""
    match = re.search(r"INCIDENTS_TARGETS_FIRST_PARAM = (\d+)", QUERIES)
    if not match:
        raise SystemExit("could not find INCIDENTS_TARGETS_FIRST_PARAM in queries.ts")
    first = int(match.group(1))
    holes = ", ".join(f"?{first + i}" for i in range(count))
    return sql("INCIDENTS_SQL").replace("{{TARGETS}}", holes)


def build() -> tuple[sqlite3.Connection, int]:
    con = sqlite3.connect(":memory:")
    for migration in MIGRATIONS:
        con.executescript(migration.read_text(encoding="utf-8"))
    ids = [f"t{i}" for i in range(TARGETS)]
    con.executemany(
        "INSERT OR IGNORE INTO targets (id, name, url) VALUES (?, ?, ?)",
        [(i, i.upper(), f"https://{i}.test/") for i in ids],
    )
    start = NOW - DAYS * 86400
    base = start - (start - SLOT_PHASE) % INTERVAL + SLOT_PHASE
    rows = [
        (tid, base + slot * INTERVAL, "ok", 200, 120 + (slot % 90), None, None, INTERVAL)
        for slot in range(DAYS * 48)
        for tid in ids
    ]
    con.executemany(
        "INSERT INTO checks (target_id, checked_at, status, http_status, latency_ms,"
        " failure_kind, failure_detail, interval_seconds) VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    con.execute("ANALYZE")
    return con, len(rows)


def cases() -> list[tuple[str, str, tuple[object, ...]]]:
    want: list[object] = [SINCE, NOW, MIN_SAMPLES]
    for i in range(TARGETS):
        want.extend([f"t{i}", 256])
    return [
        ("SUMMARY_SQL", sql("SUMMARY_SQL"), (SINCE, NOW, INTERVAL, SLOT_PHASE)),
        ("LATENCY_SQL", latency_sql(TARGETS), tuple(want)),
        ("INCIDENTS_SQL", incidents_sql(TARGETS),
         (SINCE, NOW, GAP_TOLERANCE, MAX_INCIDENTS, *[f"t{i}" for i in range(TARGETS)])),
        ("SERIES_SQL", sql("SERIES_SQL"), (SINCE, NOW, BUCKET)),
        ("ENABLED_TARGETS_SQL", sql("ENABLED_TARGETS_SQL"), ()),
        ("INSERT_CHECK_SQL", sql("INSERT_CHECK_SQL"),
         ("t0", NOW, "ok", 200, 100, None, None, INTERVAL)),
        ("SUMMARY_CACHE_GET_SQL", sql("SUMMARY_CACHE_GET_SQL"), ("3", NOW)),
        ("WATCHDOG_LAST_CHECK_SQL", sql("WATCHDOG_LAST_CHECK_SQL"), ()),
        ("WATCHDOG_SLOT_FILLED_SQL", sql("WATCHDOG_SLOT_FILLED_SQL"), (NOW - 600,)),
    ]


def scan_failures(report: bool = False) -> list[str]:
    """Names of shipped queries whose plan contains a full SCAN of `checks`."""
    con, n = build()
    if report:
        print(f"local replica: {n:,} rows in checks, {TARGETS} targets, {DAYS} days\n")
    bad: list[str] = []
    for name, text, params in cases():
        lines = [
            row[3] for row in con.execute(f"EXPLAIN QUERY PLAN {text}", params).fetchall()
        ]
        scans = [line for line in lines if line.startswith("SCAN") and "checks" in line]
        if report:
            print(f"=== {name}: {'SCAN of checks' if scans else 'bounded'}")
            for line in lines:
                print(f"      {line}{'   <-- FULL SCAN' if line in scans else ''}")
            print()
        if scans:
            bad.append(name)
    con.close()
    return bad


def main() -> int:
    bad = scan_failures(report=True)
    if bad:
        print(f"FAIL: {len(bad)} query/queries scan the whole checks table: {', '.join(bad)}")
        return 1
    print("OK: every shipped query is bounded by the window, not by the table")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
