"""Entry point: ``python -m monitor``.

Exit codes are for the scheduler, not for the sites being watched:

* ``0`` - the run completed and the batch was accepted. Targets being *down*
  is a successful run; recording a failure is the job working.
* ``1`` - the run could not be completed or stored (bad config, unreachable or
  rejecting API). This is the only case worth a red tick in Actions.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections import Counter
from pathlib import Path

from .check import run_checks
from .config import ConfigError, load_settings, load_targets
from .publish import PublishError, publish

DEFAULT_TARGETS = Path(__file__).resolve().parents[2] / "targets.toml"


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="monitor", description=__doc__)
    parser.add_argument(
        "--targets", type=Path, default=DEFAULT_TARGETS, help="path to targets.toml"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run the checks and print the payload without sending it (needs no token)",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="log every check")
    return parser.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    targets = load_targets(args.targets)
    logging.info("checking %d target(s)", len(targets))

    if args.dry_run:
        # A dry run must not require credentials: it exists so the checks can
        # be exercised locally without the ability to write to the database.
        from .config import Settings
        from .publish import build_payload

        settings = Settings(api_url="https://example.invalid", api_token="unused")
        results = await run_checks(targets, settings)
        import json

        print(json.dumps(build_payload(results), indent=2))
    else:
        settings = load_settings()
        results = await run_checks(targets, settings)
        await publish(results, settings)

    tally = Counter(result.status for result in results)
    kinds = Counter(r.failure_kind for r in results if r.failure_kind)
    summary = f"{tally.get('ok', 0)} ok, {tally.get('failed', 0)} failed"
    if kinds:
        summary += " (" + ", ".join(f"{kind}: {n}" for kind, n in sorted(kinds.items())) + ")"
    logging.info("run complete: %s", summary)
    print(summary)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        return asyncio.run(_run(args))
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 1
    except PublishError as exc:
        print(f"publish failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
