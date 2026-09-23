"""Send the batch to the write API.

One authenticated POST for the whole run. The API is the only thing that
decides what is storable — this module never tries to second-guess it, and a
rejection is surfaced with the API's own message rather than swallowed.
"""

from __future__ import annotations

import logging

import httpx

from .config import INTERVAL_SECONDS, Settings
from .models import CheckResult

log = logging.getLogger(__name__)

PUBLISH_TIMEOUT_SECONDS = 20.0


class PublishError(RuntimeError):
    """The batch was not accepted."""


def build_payload(results: list[CheckResult]) -> dict[str, object]:
    """The request body.

    ``interval_seconds`` travels with the batch so the API stores the cadence
    the data was actually collected at. Coverage and incident-gap detection are
    computed from the stored value, so changing the schedule later does not
    silently rewrite the meaning of older rows.
    """
    return {
        "interval_seconds": INTERVAL_SECONDS,
        "checks": [result.to_payload() for result in results],
    }


async def publish(results: list[CheckResult], settings: Settings) -> dict[str, object]:
    """POST the batch. Raises :class:`PublishError` on any non-2xx reply."""
    if not results:
        raise PublishError("refusing to publish an empty batch")

    payload = build_payload(results)
    async with httpx.AsyncClient(timeout=PUBLISH_TIMEOUT_SECONDS) as client:
        try:
            response = await client.post(
                settings.api_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.api_token}",
                    "Content-Type": "application/json",
                },
            )
        except httpx.HTTPError as exc:
            raise PublishError(f"could not reach the write API: {exc}") from exc

    if response.status_code >= 400:
        # The API's message is the useful part (which field, which row). The
        # token is never echoed back, so this is safe to log.
        raise PublishError(f"write API returned {response.status_code}: {response.text[:400]}")

    try:
        body = response.json()
    except ValueError:
        body = {}
    log.info("published %d checks: %s", len(results), body)
    return body if isinstance(body, dict) else {}
