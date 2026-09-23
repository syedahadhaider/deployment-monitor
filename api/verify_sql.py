"""Prove the aggregation SQL against real SQLite before it ever runs on D1.

The fixtures here are synthetic and exist ONLY inside this script's in-memory
database. Nothing it creates is written to D1 and nothing reaches the
dashboard: the dashboard shows recorded checks or it shows an empty state.

The claim under test is the one the whole project rests on:
an incident MUST terminate at a scheduler gap.

    python verify_sql.py
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
SCHEMA = (HERE / "migrations" / "0001_init.sql").read_text(encoding="utf-8")
QUERIES = (HERE / "src" / "queries.ts").read_text(encoding="utf-8")

INTERVAL = 1800  # 30 minutes
GAP_TOLERANCE = 2  # a tick inside 2 intervals is "next"; beyond that is a gap
MIN_SAMPLES = 50

failures: list[str] = []


def sql(name: str) -> str:
    """Pull a query out of queries.ts so the tested text IS the shipped text."""
    match = re.search(rf"export const {name} = `(.*?)`;", QUERIES, re.S)
    if not match:
        raise SystemExit(f"could not find {name} in queries.ts")
    # SQLite uses ?1-style numbered parameters, same as D1.
    return match.group(1)


def check(label: str, got: object, want: object) -> None:
    if got == want:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}\n        got:  {got!r}\n        want: {want!r}")
        failures.append(label)


def fresh() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    con.execute("INSERT INTO targets (id, name, url) VALUES ('a', 'A', 'https://a.test/')")
    con.execute("INSERT INTO targets (id, name, url) VALUES ('b', 'B', 'https://b.test/')")
    return con


def add(con: sqlite3.Connection, target: str, at: int, status: str, latency: int | None = None,
        kind: str | None = None) -> None:
    con.execute(
        "INSERT INTO checks (target_id, checked_at, status, http_status, latency_ms,"
        " failure_kind, failure_detail, interval_seconds) VALUES (?,?,?,?,?,?,?,?)",
        (
            target, at, status,
            200 if status == "ok" else 503,
            latency if status == "ok" else None,
            kind if status == "failed" else None,
            "synthetic" if status == "failed" else None,
            INTERVAL,
        ),
    )


def incidents(con: sqlite3.Connection, since: int, until: int) -> list[sqlite3.Row]:
    return con.execute(sql("INCIDENTS_SQL"), (since, until, GAP_TOLERANCE, 50)).fetchall()


# ---------------------------------------------------------------------------
print("\n1. an incident terminates at a scheduler gap")
# ---------------------------------------------------------------------------
con = fresh()
t = 1_700_000_000
add(con, "a", t + 0 * INTERVAL, "ok", 100)
add(con, "a", t + 1 * INTERVAL, "failed", kind="timeout")
add(con, "a", t + 2 * INTERVAL, "failed", kind="timeout")
add(con, "a", t + 3 * INTERVAL, "failed", kind="http_error")
# --- scheduler goes quiet for four ticks; NOTHING is written for them --------
add(con, "a", t + 8 * INTERVAL, "failed", kind="timeout")
add(con, "a", t + 9 * INTERVAL, "failed", kind="timeout")
add(con, "a", t + 10 * INTERVAL, "ok", 120)

rows = incidents(con, t, t + 20 * INTERVAL)
check("two observed incidents, not one continuous outage", len(rows), 2)

older, newer = rows[1], rows[0]
check("first incident starts at the first failure", older["first_failure_at"], t + 1 * INTERVAL)
check("first incident ends at the last failure BEFORE the gap",
      older["last_failure_at"], t + 3 * INTERVAL)
check("first incident counts only its own failures", older["failed_checks"], 3)
check("first incident's recovery was never observed", older["resolution"], "unknown")
check("second incident starts AFTER the gap", newer["first_failure_at"], t + 8 * INTERVAL)
check("second incident counts 2 failures", newer["failed_checks"], 2)
check("second incident was seen to recover", newer["resolution"], "resolved")
check("observed duration spans only checks we actually have",
      older["observed_seconds"], 2 * INTERVAL)

# ---------------------------------------------------------------------------
print("\n2. consecutive failures with no gap are ONE incident")
# ---------------------------------------------------------------------------
con = fresh()
add(con, "a", t, "ok", 100)
for i in range(1, 6):
    add(con, "a", t + i * INTERVAL, "failed", kind="timeout")
add(con, "a", t + 6 * INTERVAL, "ok", 100)
rows = incidents(con, t, t + 10 * INTERVAL)
check("one incident", len(rows), 1)
check("covering all five failures", rows[0]["failed_checks"], 5)
check("resolved", rows[0]["resolution"], "resolved")

# ---------------------------------------------------------------------------
print("\n3. a late-but-acceptable tick does not split an incident")
# ---------------------------------------------------------------------------
con = fresh()
add(con, "a", t, "failed", kind="timeout")
# 55 minutes later: cron was late, but still inside 2 intervals (60 min).
add(con, "a", t + 3300, "failed", kind="timeout")
rows = incidents(con, t - INTERVAL, t + 10 * INTERVAL)
check("a merely late tick stays one incident", len(rows), 1)
check("counting both failures", rows[0]["failed_checks"], 2)

con = fresh()
add(con, "a", t, "failed", kind="timeout")
# 61 minutes later: past the tolerance, so this is a gap.
add(con, "a", t + 3660, "failed", kind="timeout")
rows = incidents(con, t - INTERVAL, t + 10 * INTERVAL)
check("one tick beyond the tolerance splits it", len(rows), 2)

# ---------------------------------------------------------------------------
print("\n4. an unresolved incident is 'ongoing', never silently closed")
# ---------------------------------------------------------------------------
con = fresh()
add(con, "a", t, "ok", 100)
add(con, "a", t + INTERVAL, "failed", kind="dns")
rows = incidents(con, t, t + 10 * INTERVAL)
check("still open", rows[0]["resolution"], "ongoing")
check("a single failed check has zero OBSERVED duration", rows[0]["observed_seconds"], 0)

# ---------------------------------------------------------------------------
print("\n5. incidents never merge across targets")
# ---------------------------------------------------------------------------
con = fresh()
add(con, "a", t + INTERVAL, "failed", kind="timeout")
add(con, "b", t + 2 * INTERVAL, "failed", kind="timeout")
rows = incidents(con, t, t + 10 * INTERVAL)
check("two separate incidents", len(rows), 2)
check("different targets", sorted(r["target_id"] for r in rows), ["a", "b"])

# ---------------------------------------------------------------------------
print("\n6. uptime and coverage are independent")
# ---------------------------------------------------------------------------
con = fresh()
# 24 ticks expected over 12 hours; only 12 actually ran, and 3 of those failed.
window = 12 * 3600
for i in range(12):
    add(con, "a", t + i * INTERVAL, "ok" if i % 4 else "failed", 100, kind="timeout")
rows = con.execute(sql("SUMMARY_SQL"), (t, t + window, INTERVAL)).fetchall()
row = next(r for r in rows if r["target_id"] == "a")
check("recorded what actually ran", row["checks_recorded"], 12)
check("expected comes from the cadence", row["checks_expected"], 24)
check("ok count", row["ok_count"], 9)
check("failed count", row["failed_count"], 3)
check("uptime is of checks that RAN (9/12)", round(row["ok_count"] / row["checks_recorded"], 4), 0.75)
check("coverage is a separate fraction (12/24)",
      round(row["checks_recorded"] / row["checks_expected"], 4), 0.5)

b_row = next(r for r in rows if r["target_id"] == "b")
check("a target with no checks still returns a row", b_row["checks_recorded"], 0)
check("...with no last status, so it reads as 'no data' not 'down'", b_row["last_status"], None)

# ---------------------------------------------------------------------------
print("\n7. percentiles are gated below the minimum sample count")
# ---------------------------------------------------------------------------
con = fresh()
for i in range(10):
    add(con, "a", t + i * INTERVAL, "ok", 100 + i)
rows = con.execute(sql("LATENCY_SQL"), (t, t + 100 * INTERVAL, MIN_SAMPLES)).fetchall()
check("sample count is reported", rows[0]["sample_count"], 10)
check("p50 withheld below the gate", rows[0]["p50_ms"], None)
check("p95 withheld below the gate", rows[0]["p95_ms"], None)
check("flagged as insufficient", rows[0]["insufficient_data"], 1)

con = fresh()
for i in range(100):  # latencies 1..100
    add(con, "a", t + i * INTERVAL, "ok", i + 1)
# a failed check must not enter the latency distribution at all
add(con, "a", t + 200 * INTERVAL, "failed", kind="timeout")
rows = con.execute(sql("LATENCY_SQL"), (t, t + 300 * INTERVAL, MIN_SAMPLES)).fetchall()
check("only successful checks are sampled", rows[0]["sample_count"], 100)
check("p50 of 1..100 (nearest rank)", rows[0]["p50_ms"], 50)
check("p95 of 1..100 (nearest rank)", rows[0]["p95_ms"], 95)
check("not flagged", rows[0]["insufficient_data"], 0)

# ---------------------------------------------------------------------------
print("\n8. the series emits empty buckets instead of omitting them")
# ---------------------------------------------------------------------------
con = fresh()
bucket = 3 * 3600
start = (t // bucket) * bucket
add(con, "a", start + 60, "ok", 100)
add(con, "a", start + 120, "failed", kind="timeout")
# nothing at all in the next two buckets
add(con, "a", start + 3 * bucket + 60, "ok", 100)
rows = con.execute(sql("SERIES_SQL"), (start, start + 3 * bucket, bucket)).fetchall()
check("every bucket in the window is present", len(rows), 4)
check("first bucket counted both checks", rows[0]["checks"], 2)
check("empty bucket reports zero checks, not zero uptime", rows[1]["checks"], 0)
check("...and zero failures, so it cannot read as an outage", rows[1]["failed_count"], 0)
check("last bucket has the later check", rows[3]["checks"], 1)

# ---------------------------------------------------------------------------
print("\n9. the schema refuses incoherent rows")
# ---------------------------------------------------------------------------
con = fresh()
for label, args in {
    "negative latency": ("a", t, "ok", 200, -5, None, None, INTERVAL),
    "unknown status": ("a", t, "down", 200, 5, None, None, INTERVAL),
    "unknown failure kind": ("a", t, "failed", 500, None, "gremlins", "x", INTERVAL),
    "ok row carrying a failure kind": ("a", t, "ok", 200, 5, "timeout", "x", INTERVAL),
    "failed row with no kind": ("a", t, "failed", 500, None, None, None, INTERVAL),
    "impossible http status": ("a", t, "ok", 99, 5, None, None, INTERVAL),
}.items():
    try:
        con.execute(
            "INSERT INTO checks (target_id, checked_at, status, http_status, latency_ms,"
            " failure_kind, failure_detail, interval_seconds) VALUES (?,?,?,?,?,?,?,?)", args)
    except sqlite3.IntegrityError:
        print(f"  PASS  rejected: {label}")
    else:
        print(f"  FAIL  accepted: {label}")
        failures.append(f"schema accepted {label}")

print("\n10. a replayed batch cannot double-count")
con = fresh()
for _ in range(3):
    con.execute(sql("INSERT_CHECK_SQL"), ("a", t, "ok", 200, 100, None, None, INTERVAL))
check("three identical inserts produce one row",
      con.execute("SELECT COUNT(*) c FROM checks").fetchone()["c"], 1)

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("all SQL behaviour verified")
