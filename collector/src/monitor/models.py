"""The two shapes that cross a boundary: a target to check, a result to send."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .classify import FailureKind


@dataclass(frozen=True, slots=True)
class Target:
    """One endpoint to check.

    ``id`` is a stable slug, not a database row number: it is written by hand in
    ``targets.toml``, travels in the payload and is what the API joins on. That
    keeps the collector free of any knowledge of the database.
    """

    id: str
    name: str
    url: str
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class CheckResult:
    """The outcome of ONE check, retry included.

    A retried attempt does not produce a second result. The retry is part of
    the same observation — the schedule fired once, so one row is written —
    and ``retried`` only annotates the detail string. Recording it as a second
    check would inflate both the check count and the coverage figure.
    """

    target_id: str
    checked_at: int
    """Unix seconds, UTC. Integer because every window and gap calculation in
    SQL is arithmetic on this column."""
    status: str
    """``'ok'`` or ``'failed'``."""
    http_status: int | None = None
    latency_ms: int | None = None
    failure_kind: FailureKind | None = None
    failure_detail: str | None = None
    retried: bool = False

    def to_payload(self) -> dict[str, Any]:
        """The wire form. Keys match the API's validator exactly."""
        detail = self.failure_detail
        if detail and self.retried:
            detail = f"{detail} (failed again on retry)"
        return {
            "target_id": self.target_id,
            "checked_at": self.checked_at,
            "status": self.status,
            "http_status": self.http_status,
            "latency_ms": self.latency_ms,
            "failure_kind": self.failure_kind,
            "failure_detail": detail,
        }
