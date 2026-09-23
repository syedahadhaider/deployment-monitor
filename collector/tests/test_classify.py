"""The classification logic is the part worth testing hardest.

Every case builds the exception the way httpx actually raises it — wrapping the
underlying OS or TLS error — because unwrapping that chain correctly is the
whole job. A test that passes a bare ``ssl.SSLError`` would pass while the real
code path stayed broken.
"""

from __future__ import annotations

import socket
import ssl

import httpx
import pytest

from monitor.classify import (
    MAX_DETAIL,
    TRANSIENT_KINDS,
    classify_exception,
    classify_status,
    is_transient,
)


def _wrapped(inner: BaseException, outer: type[Exception] = httpx.ConnectError) -> Exception:
    """Rebuild how httpx surfaces a transport failure: outer raised *from* inner."""
    try:
        try:
            raise inner
        except BaseException as exc:
            raise outer(str(inner)) from exc
    except Exception as exc:  # noqa: BLE001 - we want the constructed object
        return exc


# --------------------------------------------------------------------------
# DNS
# --------------------------------------------------------------------------


def test_gaierror_is_dns() -> None:
    exc = _wrapped(socket.gaierror(-2, "Name or service not known"))
    kind, detail = classify_exception(exc)
    assert kind == "dns"
    assert "Name or service not known" in detail


@pytest.mark.parametrize(
    "message",
    [
        "nodename nor servname provided, or not known",
        "Temporary failure in name resolution",
        "getaddrinfo failed",
        "No address associated with hostname",
    ],
)
def test_platform_dns_wordings_are_dns(message: str) -> None:
    """The same failure is worded differently on Linux, macOS and Windows."""
    assert classify_exception(httpx.ConnectError(message))[0] == "dns"


# --------------------------------------------------------------------------
# connection refused
# --------------------------------------------------------------------------


def test_connection_refused_errno_is_refused() -> None:
    exc = _wrapped(ConnectionRefusedError(111, "Connection refused"))
    kind, detail = classify_exception(exc)
    assert kind == "connection_refused"
    assert "Connection refused" in detail


def test_windows_actively_refused_wording() -> None:
    exc = httpx.ConnectError(
        "No connection could be made because the target machine actively refused it"
    )
    assert classify_exception(exc)[0] == "connection_refused"


# --------------------------------------------------------------------------
# TLS
# --------------------------------------------------------------------------


def test_expired_certificate_is_tls_error() -> None:
    inner = ssl.SSLCertVerificationError(1, "certificate verify failed: certificate has expired")
    kind, detail = classify_exception(_wrapped(inner))
    assert kind == "tls_error"
    assert "expired" in detail


def test_hostname_mismatch_is_tls_error() -> None:
    inner = ssl.SSLCertVerificationError(
        1, "Hostname mismatch, certificate is not valid for 'x'"
    )
    assert classify_exception(_wrapped(inner))[0] == "tls_error"


def test_tls_beats_the_connect_error_wrapping_it() -> None:
    """A TLS failure arrives as a ConnectError; it must not be read as refused."""
    exc = _wrapped(ssl.SSLError(1, "wrong version number"))
    assert classify_exception(exc)[0] == "tls_error"


# --------------------------------------------------------------------------
# timeout
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectTimeout("timed out"),
        httpx.ReadTimeout("timed out"),
        httpx.WriteTimeout("timed out"),
        httpx.PoolTimeout("timed out"),
    ],
)
def test_every_timeout_flavour_is_timeout(exc: httpx.TimeoutException) -> None:
    assert classify_exception(exc)[0] == "timeout"


def test_connect_timeout_is_timeout_not_connection_error() -> None:
    """ConnectTimeout subclasses TransportError too - ordering must favour timeout."""
    assert isinstance(httpx.ConnectTimeout("x"), httpx.TransportError)
    assert classify_exception(httpx.ConnectTimeout("x"))[0] == "timeout"


# --------------------------------------------------------------------------
# fallback
# --------------------------------------------------------------------------


def test_unknown_transport_error_falls_back_to_connection_level() -> None:
    kind, detail = classify_exception(httpx.RemoteProtocolError("peer closed connection"))
    assert kind == "connection_refused"
    assert "RemoteProtocolError" in detail


def test_detail_is_bounded_and_single_line() -> None:
    exc = httpx.ConnectError("x\n" * 500)
    _, detail = classify_exception(exc)
    assert len(detail) <= MAX_DETAIL
    assert "\n" not in detail


def test_self_referential_context_terminates() -> None:
    """A cycle in the exception chain must not hang the walk."""
    a = httpx.ConnectError("a")
    b = httpx.ConnectError("b")
    a.__context__ = b
    b.__context__ = a
    assert classify_exception(a)[0] == "connection_refused"


# --------------------------------------------------------------------------
# status codes
# --------------------------------------------------------------------------


@pytest.mark.parametrize("code", [200, 201, 204, 301, 302, 304, 399])
def test_2xx_and_3xx_are_up(code: int) -> None:
    assert classify_status(code) is None


@pytest.mark.parametrize("code", [400, 401, 403, 404, 429, 500, 502, 503, 504])
def test_4xx_and_5xx_are_http_errors(code: int) -> None:
    result = classify_status(code)
    assert result is not None
    kind, detail = result
    assert kind == "http_error"
    assert detail == f"HTTP {code}"


# --------------------------------------------------------------------------
# retry policy
# --------------------------------------------------------------------------


def test_only_network_blips_are_retried() -> None:
    assert is_transient("dns")
    assert is_transient("connection_refused")
    assert is_transient("timeout")
    # A bad certificate and a 500 are real answers, not blips. Retrying them
    # would hide the very thing the monitor exists to catch.
    assert not is_transient("tls_error")
    assert not is_transient("http_error")


def test_transient_set_is_a_subset_of_the_known_kinds() -> None:
    known = {"dns", "connection_refused", "tls_error", "timeout", "http_error"}
    assert TRANSIENT_KINDS.issubset(known)
