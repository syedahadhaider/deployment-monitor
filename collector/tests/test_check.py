"""Retry semantics and isolation - the two behaviours that shape the data.

These use httpx's MockTransport rather than a live server, so the tests are
deterministic and run offline.
"""

from __future__ import annotations

import httpx
import pytest

from monitor.check import check_target, run_checks
from monitor.config import Settings
from monitor.models import Target

TARGET = Target(id="demo", name="Demo", url="https://demo.test/")


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)


async def test_success_records_status_and_latency() -> None:
    async with _client(lambda _req: httpx.Response(200)) as client:
        result = await check_target(client, TARGET)
    assert result.status == "ok"
    assert result.http_status == 200
    assert result.latency_ms is not None and result.latency_ms >= 0
    assert result.failure_kind is None
    assert result.retried is False


async def test_http_error_is_recorded_with_latency_and_not_retried() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503)

    async with _client(handler) as client:
        result = await check_target(client, TARGET)

    assert calls == 1, "a status code is an answer, not a blip - it must not be retried"
    assert result.status == "failed"
    assert result.failure_kind == "http_error"
    assert result.http_status == 503
    assert result.latency_ms is not None


async def test_transient_failure_retries_once_and_can_succeed(monkeypatch) -> None:
    monkeypatch.setattr("monitor.check.RETRY_DELAY_SECONDS", 0)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectTimeout("first attempt timed out", request=request)
        return httpx.Response(200)

    async with _client(handler) as client:
        result = await check_target(client, TARGET)

    assert calls == 2
    assert result.status == "ok"
    # The retry succeeded, so nothing about the failure is recorded - but the
    # result is still ONE check, not two.
    assert result.retried is True


async def test_retry_exhausted_produces_one_result_not_two(monkeypatch) -> None:
    monkeypatch.setattr("monitor.check.RETRY_DELAY_SECONDS", 0)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectTimeout("timed out", request=request)

    async with _client(handler) as client:
        result = await check_target(client, TARGET)

    assert calls == 2, "exactly one retry"
    assert result.status == "failed"
    assert result.failure_kind == "timeout"
    assert result.retried is True
    # The schedule fired once, so one row is written. The retry is annotated on
    # the detail rather than inflating the check count or the coverage figure.
    payload = result.to_payload()
    assert "failed again on retry" in payload["failure_detail"]


async def test_tls_failure_is_not_retried(monkeypatch) -> None:
    monkeypatch.setattr("monitor.check.RETRY_DELAY_SECONDS", 0)
    import ssl

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        try:
            raise ssl.SSLCertVerificationError(1, "certificate has expired")
        except BaseException as inner:
            raise httpx.ConnectError("certificate has expired", request=request) from inner

    async with _client(handler) as client:
        result = await check_target(client, TARGET)

    assert calls == 1
    assert result.failure_kind == "tls_error"
    assert result.retried is False


async def test_one_failing_target_does_not_abort_the_others(monkeypatch) -> None:
    """The whole point of the run: a broken target still yields every result."""
    monkeypatch.setattr("monitor.check.RETRY_DELAY_SECONDS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "broken.test":
            raise httpx.ConnectError("boom", request=request)
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def patched(*_args, **kwargs):
        kwargs.pop("transport", None)
        kwargs.pop("limits", None)
        return real_client(transport=transport, follow_redirects=True)

    monkeypatch.setattr("monitor.check.httpx.AsyncClient", patched)

    targets = [
        Target(id="up-1", name="Up 1", url="https://fine.test/"),
        Target(id="broken", name="Broken", url="https://broken.test/"),
        Target(id="up-2", name="Up 2", url="https://fine.test/"),
    ]
    results = await run_checks(targets, Settings(api_url="https://x.test", api_token="t"))

    assert [r.target_id for r in results] == ["up-1", "broken", "up-2"]
    assert [r.status for r in results] == ["ok", "failed", "ok"]


@pytest.mark.parametrize("code", [301, 302])
async def test_redirects_are_followed_not_recorded_as_failures(code: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(code, headers={"Location": "https://demo.test/final"})
        return httpx.Response(200)

    async with _client(handler) as client:
        result = await check_target(client, TARGET)

    assert result.status == "ok"
    assert result.http_status == 200
