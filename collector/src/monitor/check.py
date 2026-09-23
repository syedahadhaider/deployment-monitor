"""Perform the checks.

One HTTP GET per target, concurrently, each fully isolated: a target that
raises cannot stop the others from being recorded. The retry for transient
network failures happens inside a single check, so the schedule firing once
always produces exactly one result per target.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

import httpx

from .classify import classify_exception, classify_status, is_transient
from .config import Settings
from .models import CheckResult, Target

log = logging.getLogger(__name__)

#: A short pause before the single retry. Long enough to clear a momentary
#: blip, short enough that the run still finishes well inside the schedule.
RETRY_DELAY_SECONDS = 2.0

#: Sent on every request so the operators of the checked sites can see who is
#: calling and why, rather than finding an anonymous robot in their logs.
USER_AGENT = (
    "deployment-monitor/1.0 (+https://github.com/syedahadhaider/deployment-monitor; "
    "synthetic availability check)"
)


def _now() -> int:
    return int(datetime.now(tz=UTC).timestamp())


async def _attempt(client: httpx.AsyncClient, target: Target) -> tuple[int, int]:
    """One GET. Returns (status_code, latency_ms) or raises.

    ``perf_counter`` is used rather than wall time so a clock adjustment during
    the request cannot produce a negative or absurd latency — a value the API
    would reject anyway.
    """
    started = time.perf_counter()
    response = await client.get(target.url)
    latency_ms = int((time.perf_counter() - started) * 1000)
    return response.status_code, latency_ms


async def check_target(client: httpx.AsyncClient, target: Target) -> CheckResult:
    """Check one target, retrying once on a transient network failure."""
    checked_at = _now()
    retried = False

    for attempt in (1, 2):
        try:
            status_code, latency_ms = await _attempt(client, target)
        except Exception as exc:  # noqa: BLE001 - deliberately broad; see below
            # Broad by design: this loop is the isolation boundary for one
            # target. Anything at all that goes wrong here must become a
            # recorded failed check, never an exception that ends the run.
            kind, detail = classify_exception(exc)
            if attempt == 1 and is_transient(kind):
                log.warning("%s: %s (%s) - retrying once", target.id, kind, detail)
                retried = True
                await asyncio.sleep(RETRY_DELAY_SECONDS)
                continue
            log.warning("%s: %s (%s)", target.id, kind, detail)
            return CheckResult(
                target_id=target.id,
                checked_at=checked_at,
                status="failed",
                failure_kind=kind,
                failure_detail=detail,
                retried=retried,
            )

        failure = classify_status(status_code)
        if failure is None:
            log.info("%s: ok %s in %sms", target.id, status_code, latency_ms)
            return CheckResult(
                target_id=target.id,
                checked_at=checked_at,
                status="ok",
                http_status=status_code,
                latency_ms=latency_ms,
                retried=retried,
            )

        # A status code is a real answer from the server, not a blip: it is
        # recorded as-is and never retried. Latency is still meaningful — a
        # 500 that takes four seconds is a different problem from an instant
        # one — so it is kept.
        kind, detail = failure
        log.warning("%s: %s in %sms", target.id, detail, latency_ms)
        return CheckResult(
            target_id=target.id,
            checked_at=checked_at,
            status="failed",
            http_status=status_code,
            latency_ms=latency_ms,
            failure_kind=kind,
            failure_detail=detail,
            retried=retried,
        )

    raise AssertionError("unreachable: the loop always returns")


async def run_checks(targets: list[Target], settings: Settings) -> list[CheckResult]:
    """Check every target concurrently and return one result per target."""
    limits = httpx.Limits(max_connections=10, max_keepalive_connections=0)
    async with httpx.AsyncClient(
        timeout=settings.timeout,
        follow_redirects=True,
        limits=limits,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        settled = await asyncio.gather(
            *(check_target(client, target) for target in targets),
            return_exceptions=True,
        )

    results: list[CheckResult] = []
    for target, outcome in zip(targets, settled, strict=True):
        if isinstance(outcome, BaseException):
            # check_target already catches everything; reaching here means a
            # bug in the checker itself. Record it rather than losing the
            # target silently, and make the detail say so.
            log.error("%s: checker raised %s", target.id, outcome)
            kind, detail = classify_exception(outcome)
            results.append(
                CheckResult(
                    target_id=target.id,
                    checked_at=_now(),
                    status="failed",
                    failure_kind=kind,
                    failure_detail=f"collector error: {detail}",
                )
            )
        else:
            results.append(outcome)
    return results
