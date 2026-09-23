"""Configuration must fail loudly and early, never half-succeed."""

from __future__ import annotations

from pathlib import Path

import pytest

from monitor.config import ConfigError, Settings, load_settings, load_targets
from monitor.models import CheckResult
from monitor.publish import build_payload

GOOD = """
[[target]]
id = "a"
name = "A"
url = "https://a.test/"

[[target]]
id = "b"
name = "B"
url = "https://b.test/"
enabled = false
"""


def _write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "targets.toml"
    path.write_text(text, encoding="utf-8")
    return path


def test_disabled_targets_are_not_checked(tmp_path: Path) -> None:
    targets = load_targets(_write(tmp_path, GOOD))
    assert [t.id for t in targets] == ["a"]


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("", r"no \[\[target\]\] entries"),
        ('[[target]]\nid = "a"\nname = "A"\nurl = "ftp://a.test"\n', "must start with http"),
        ('[[target]]\nid = ""\nname = "A"\nurl = "https://a.test"\n', "non-empty string"),
        ('[[target]]\nname = "A"\nurl = "https://a.test"\n', "non-empty string"),
        (
            '[[target]]\nid = "a"\nname = "A"\nurl = "https://a.test"\n'
            '[[target]]\nid = "a"\nname = "B"\nurl = "https://b.test"\n',
            "duplicate target id",
        ),
        ('[[target]]\nid = "a"\nname = "A"\nurl = "https://a.test"\nenabled = false\n', "disabled"),
    ],
)
def test_bad_targets_file_is_rejected(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_targets(_write(tmp_path, body))


def test_missing_targets_file_is_reported(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_targets(tmp_path / "nope.toml")


def test_missing_credentials_are_named(monkeypatch) -> None:
    with pytest.raises(ConfigError, match="MONITOR_API_URL, MONITOR_API_TOKEN"):
        load_settings({})


def test_plaintext_api_url_is_refused() -> None:
    """The bearer token must never travel over http://."""
    with pytest.raises(ConfigError, match="https://"):
        Settings(api_url="http://api.test/ingest", api_token="t")


def test_payload_carries_the_interval_with_the_batch() -> None:
    result = CheckResult(
        target_id="a", checked_at=1_700_000_000, status="ok", http_status=200, latency_ms=12
    )
    payload = build_payload([result])
    assert payload["interval_seconds"] == 1800
    assert payload["checks"] == [
        {
            "target_id": "a",
            "checked_at": 1_700_000_000,
            "status": "ok",
            "http_status": 200,
            "latency_ms": 12,
            "failure_kind": None,
            "failure_detail": None,
        }
    ]
