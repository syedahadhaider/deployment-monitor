"""Configuration: targets from a file, credentials from the environment.

The split is deliberate. Targets are public facts about which sites are being
watched and belong in version control where anyone can audit them. The API
endpoint and token are not, and are only ever read from the environment.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .models import Target

DEFAULT_TIMEOUT_SECONDS = 10.0

#: How often the schedule is *meant* to fire. The API stores this alongside the
#: checks so coverage and incident gaps are computed against the real cadence
#: rather than a number hard-coded in two places that can drift apart.
INTERVAL_SECONDS = 1800


class ConfigError(RuntimeError):
    """Raised when configuration is missing or unusable."""


@dataclass(frozen=True, slots=True)
class Settings:
    api_url: str
    api_token: str
    timeout: float = DEFAULT_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        if not self.api_url.startswith("https://"):
            # The token is a bearer credential; sending it over plaintext HTTP
            # would leak it to anything on the path.
            raise ConfigError("MONITOR_API_URL must be an https:// URL")


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """Read credentials from the environment, failing loudly if absent."""
    source = os.environ if env is None else env
    api_url = source.get("MONITOR_API_URL", "").strip()
    api_token = source.get("MONITOR_API_TOKEN", "").strip()
    missing = [
        name
        for name, value in (("MONITOR_API_URL", api_url), ("MONITOR_API_TOKEN", api_token))
        if not value
    ]
    if missing:
        raise ConfigError(f"missing required environment variable(s): {', '.join(missing)}")
    timeout = float(source.get("MONITOR_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    return Settings(api_url=api_url, api_token=api_token, timeout=timeout)


def load_targets(path: Path) -> list[Target]:
    """Parse ``targets.toml`` and return the enabled targets.

    Every field is validated here rather than at the point of use, so a typo in
    the file fails the run immediately with a clear message instead of
    producing a half-populated check.
    """
    if not path.is_file():
        raise ConfigError(f"targets file not found: {path}")
    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    entries = raw.get("target")
    if not isinstance(entries, list) or not entries:
        raise ConfigError(f"{path} defines no [[target]] entries")

    targets: list[Target] = []
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        for field in ("id", "name", "url"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                raise ConfigError(
                    f"[[target]] #{index + 1} in {path}: '{field}' must be a non-empty string"
                )
        target_id = entry["id"].strip()
        if target_id in seen:
            raise ConfigError(f"duplicate target id '{target_id}' in {path}")
        if not entry["url"].strip().startswith(("http://", "https://")):
            raise ConfigError(f"target '{target_id}': url must start with http:// or https://")
        seen.add(target_id)
        targets.append(
            Target(
                id=target_id,
                name=entry["name"].strip(),
                url=entry["url"].strip(),
                enabled=bool(entry.get("enabled", True)),
            )
        )

    enabled = [t for t in targets if t.enabled]
    if not enabled:
        raise ConfigError(f"every target in {path} is disabled")
    return enabled
