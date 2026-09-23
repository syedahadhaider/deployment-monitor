"""Turn a failed HTTP attempt into a *classified* reason.

"Failed" on its own is not a useful signal: a DNS record that stopped
resolving, a TLS certificate that expired and an origin returning 503 are three
different problems with three different fixes. Everything in this module is a
pure function over an exception or a status code, which is what makes it
directly testable without touching the network.

The classification is deliberately coarse. Five kinds cover the failures a
synthetic check can actually distinguish from the outside; inventing more
would imply knowledge the checker does not have.
"""

from __future__ import annotations

import socket
import ssl
from typing import Final, Literal

import httpx

FailureKind = Literal["dns", "connection_refused", "tls_error", "timeout", "http_error"]

#: Kinds worth one retry. A name that does not resolve, a refused connection or
#: a timeout can all be a momentary blip between two datacenters. A TLS error is
#: a real misconfiguration and an HTTP error is a real answer from the server —
#: retrying either would only hide the finding.
TRANSIENT_KINDS: Final[frozenset[str]] = frozenset({"dns", "connection_refused", "timeout"})

#: Upper bound on the stored detail string. The column is for a human reading
#: the dashboard, not for a stack trace.
MAX_DETAIL: Final[int] = 200

# Substrings that identify a name-resolution failure across platforms. Python
# raises socket.gaierror for these, but the text differs between Linux, macOS
# and Windows, and httpx wraps the original in a ConnectError.
_DNS_MARKERS: Final[tuple[str, ...]] = (
    "name or service not known",
    "nodename nor servname",
    "temporary failure in name resolution",
    "no address associated with hostname",
    "getaddrinfo failed",
    "name does not resolve",
)


def _causes(exc: BaseException) -> list[BaseException]:
    """The exception and everything it was raised from, outermost first.

    httpx wraps the underlying OS or TLS error, so the useful signal is usually
    two or three levels down. The walk is depth-bounded and tracks identity to
    survive a self-referential ``__context__``.
    """
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen and len(chain) < 10:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _truncate(text: str) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= MAX_DETAIL:
        return collapsed
    return collapsed[: MAX_DETAIL - 1] + "…"


def classify_exception(exc: BaseException) -> tuple[FailureKind, str]:
    """Map a raised exception to a failure kind and a short detail string.

    Order matters. TLS and DNS are checked before the generic connection
    errors that wrap them, and timeouts are checked before network errors
    because ``ConnectTimeout`` is both.
    """
    chain = _causes(exc)

    # --- TLS: certificate expiry, hostname mismatch, verification failure ----
    for link in chain:
        if isinstance(link, ssl.SSLError):
            reason = getattr(link, "verify_message", None) or str(link)
            return "tls_error", _truncate(f"{type(link).__name__}: {reason}")

    # --- timeouts (ConnectTimeout is also a TransportError, so check first) --
    for link in chain:
        if isinstance(link, httpx.TimeoutException):
            return "timeout", _truncate(f"{type(link).__name__}: {link}")

    # --- DNS: socket.gaierror, or a ConnectError whose text names resolution -
    for link in chain:
        if isinstance(link, socket.gaierror):
            return "dns", _truncate(f"gaierror: {link}")
    joined = " ".join(str(link).lower() for link in chain)
    if any(marker in joined for marker in _DNS_MARKERS):
        return "dns", _truncate(f"{type(exc).__name__}: {exc}")

    # --- refused: nothing listening on the port -----------------------------
    for link in chain:
        if isinstance(link, ConnectionRefusedError):
            return "connection_refused", _truncate(f"ConnectionRefusedError: {link}")
    if "connection refused" in joined or "actively refused" in joined:
        return "connection_refused", _truncate(f"{type(exc).__name__}: {exc}")

    # --- anything else that reached the transport ---------------------------
    # Reported as connection_refused would be a lie, and as a timeout worse. A
    # reset, an unreachable network or a protocol error is a connection-level
    # failure; the detail string carries the specific type.
    return "connection_refused", _truncate(f"{type(exc).__name__}: {exc}")


def classify_status(status_code: int) -> tuple[FailureKind, str] | None:
    """``None`` when the response counts as up, otherwise the failure.

    2xx and 3xx are treated as up: a redirect is a working endpoint answering
    correctly, and the collector follows redirects anyway, so a recorded 3xx
    means the chain ended there deliberately.
    """
    if 200 <= status_code < 400:
        return None
    return "http_error", f"HTTP {status_code}"


def is_transient(kind: FailureKind) -> bool:
    """Whether this kind of failure earns exactly one retry."""
    return kind in TRANSIENT_KINDS
