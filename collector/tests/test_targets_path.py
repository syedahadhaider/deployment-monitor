"""Regression tests for locating ``targets.toml``.

The bug these exist to prevent: the default path was computed as
``Path(__file__).resolve().parents[2] / "targets.toml"``. That is the repo root
in a source checkout or an editable install, so it passed locally and in every
test — but the workflow runs a NON-editable ``pip install .``, where the same
expression points at the interpreter's ``lib`` directory, and the file was not
in the wheel at all. CI failed with:

    configuration error: targets file not found:
    /opt/hostedtoolcache/Python/3.12.14/x64/lib/python3.12/targets.toml

The lesson is that a test which only runs against the source tree cannot catch
this. `test_default_targets_is_inside_the_package` is the one that does: it
asserts the file travels WITH the package, which is false for any
walk-up-from-__file__ scheme regardless of how the tests are invoked. The
wheel-install job in CI closes the loop end to end.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import monitor
from monitor.config import TARGETS_FILENAME, default_targets_path, load_targets

PACKAGE_DIR = Path(monitor.__file__).resolve().parent


def test_default_targets_is_inside_the_package() -> None:
    """The file must ship inside the package, not next to the source tree.

    This is the assertion the old implementation could not satisfy: its default
    pointed two levels ABOVE the package, which only happens to be the repo
    root when running from a checkout.
    """
    path = default_targets_path()
    assert path.parent == PACKAGE_DIR, (
        f"{TARGETS_FILENAME} must live inside the package so it is installed with it; "
        f"got {path}, package is at {PACKAGE_DIR}"
    )


def test_packaged_targets_file_exists_and_parses() -> None:
    path = default_targets_path()
    assert path.is_file(), f"{path} is missing - is it included in the wheel?"
    targets = load_targets(path)
    assert len(targets) >= 1
    assert all(t.url.startswith("https://") for t in targets)


def test_default_path_does_not_depend_on_the_working_directory(tmp_path: Path) -> None:
    """Resolution must be identical no matter where the process started."""
    import os

    before = default_targets_path()
    cwd = os.getcwd()
    try:
        os.chdir(tmp_path)
        after = default_targets_path()
    finally:
        os.chdir(cwd)
    assert before == after
    assert after.is_file()


def test_cli_finds_its_config_from_an_unrelated_directory(tmp_path: Path) -> None:
    """End to end, in a subprocess, from a directory with nothing in it.

    ``--check-config`` is offline, so this stays fast and cannot fail because a
    monitored site happened to be down.
    """
    result = subprocess.run(
        [sys.executable, "-m", "monitor", "--check-config"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert "enabled target(s)" in result.stdout
    assert "targets file not found" not in result.stderr


def test_explicit_targets_argument_still_wins(tmp_path: Path) -> None:
    """The packaged default must not override an explicitly supplied file."""
    custom = tmp_path / "custom.toml"
    custom.write_text(
        '[[target]]\nid = "only"\nname = "Only"\nurl = "https://only.test/"\n',
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-m", "monitor", "--check-config", "--targets", str(custom)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert "only" in result.stdout
    assert "1 enabled target(s)" in result.stdout
