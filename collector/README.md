# Collector

A scheduled Python job that performs a **synthetic availability check** against
a fixed list of public URLs, classifies any failure, and posts the batch to the
write API in one authenticated request.

```
python -m monitor --check-config   # find and validate the targets file, print it, exit
python -m monitor --dry-run -v     # run the checks, print the payload, send nothing
python -m monitor                  # run and publish (needs the two env vars)
```

## What it does

For each target in [`targets.toml`](src/monitor/targets.toml), concurrently:

1. `GET` the URL with a 10-second timeout, following redirects.
2. Measure elapsed time to response with `perf_counter` (a monotonic clock, so
   an NTP adjustment mid-request cannot produce a nonsensical latency).
3. Record the HTTP status, the latency in milliseconds, and on failure a
   **classified** reason plus a short detail string.
4. Retry **once**, after 2 seconds, if — and only if — the failure was a
   transient network one.

Then POST every result as a single authenticated batch.

### Failure classification

`"failed"` on its own is a hobby metric. A name that stopped resolving, an
expired certificate and an origin returning 503 are three different problems
with three different fixes, so each check stores which one it was:

| Kind                 | Means                                         | Retried? |
| -------------------- | --------------------------------------------- | -------- |
| `dns`                | the hostname did not resolve                   | yes      |
| `connection_refused` | reached the host, nothing accepted the socket  | yes      |
| `timeout`            | no response inside 10s                         | yes      |
| `tls_error`          | certificate expired, hostname mismatch, verify failed | no |
| `http_error`         | the server answered with 4xx or 5xx            | no       |

Only the first three are retried. A bad certificate and a 500 are *real answers*
— retrying them would hide the exact thing the monitor exists to catch.

The classification walks the exception's `__cause__`/`__context__` chain,
because httpx wraps the underlying `socket.gaierror` or `ssl.SSLError` in a
`ConnectError`. Getting that unwrapping right is the substance of
[`classify.py`](src/monitor/classify.py), and it is what the tests exercise
hardest — including the platform-dependent wording of DNS failures on Linux,
macOS and Windows.

### One schedule tick, one row

A retry is part of the **same** check, not a second one. The schedule fired
once, so exactly one row is written per target per run; a retry that also failed
is annotated on the detail string. Recording the retry separately would inflate
both the check count and the coverage figure, and coverage is the one number
that has to stay honest.

### Isolation

Every target is checked inside its own error boundary, and the batch is
gathered with `return_exceptions=True`. One target failing — in any way,
including a bug in the checker itself — can never stop the others from being
recorded.

## What it deliberately does not do

- **It contains no source from the applications it checks.** It knows three
  things: a list of URLs, an API endpoint, and a token. It could be pointed at
  anyone's sites without changing a line.
- **It does not measure browser performance.** These are HTTP round-trips from
  a GitHub-hosted runner in a datacenter. They are *endpoint latency*, not
  LCP, INP or any other Core Web Vital, and they are not a substitute for one.
- **It does not decide what is storable.** The API validates and rejects; the
  collector never pre-filters to make its own data look acceptable.
- **It does not write a row for a check that did not happen.** There is no
  `no_data` status anywhere in this system. A run that never fired leaves a
  gap, and a gap is reported as missing coverage — never as downtime.
- **It does not alert.** There is no paging, escalation or on-call anything.
  It records; the dashboard displays.
- **It does not do security-posture checks.** HSTS, CSP, TLS expiry dates and
  redirect behaviour are out of scope here.

## Configuration

`targets.toml` is checked in on purpose: anyone reading the repo can see
exactly what is watched and confirm nothing private is probed. Each `id` is a
stable slug and must never be changed once it has recorded checks — renaming
one orphans its history.

It lives **inside the package**, at `src/monitor/targets.toml`, so it is
installed alongside the code and is found via `importlib.resources` rather than
by a relative path or by walking up from `__file__`. Those alternatives work in
a source checkout and in an editable install, then break under a real
`pip install .` — which is exactly how it failed in CI once. Pass `--targets`
to use a different file:

```bash
python -m monitor --check-config                  # find, parse and print the config; no network
python -m monitor --check-config --targets ./my-targets.toml
```

Credentials come only from the environment, never from a file:

| Variable                  | Required | Purpose                                     |
| ------------------------- | -------- | ------------------------------------------- |
| `MONITOR_API_URL`         | yes      | write endpoint; **must** be `https://`      |
| `MONITOR_API_TOKEN`       | yes      | bearer token, from GitHub Actions secrets   |
| `MONITOR_TIMEOUT_SECONDS` | no       | per-request timeout, default `10`           |

A non-HTTPS `MONITOR_API_URL` is refused at startup rather than leaking the
bearer token to anything on the path.

## Exit codes

`0` when the run completed and the batch was accepted — **including when
targets were down**. Recording a failure is the job working correctly. `1` only
when the run itself could not complete or store its results: bad configuration,
or an API that was unreachable or rejected the batch. Red ticks in Actions
should mean the *monitor* is broken, never that a monitored site is.

## Operational realities

These are known constraints of running on free, best-effort infrastructure.
They are not bugs, and the dashboard is designed to report them honestly rather
than paper over them.

- **GitHub Actions cron is best-effort.** Scheduled runs are frequently delayed
  under platform load and are sometimes **skipped entirely**. The schedule asks
  for every 30 minutes; the real interval varies and occasionally a tick never
  happens. This is precisely why the dashboard reports **coverage separately
  from uptime**: missing runs are the *scheduler's* gaps, and must never be
  read as the monitored site being down.
- **GitHub disables scheduled workflows after 60 days of repository
  inactivity.** If there are no commits for 60 days, the cron stops firing
  silently and must be re-enabled by hand in the Actions tab. A long flat gap
  in the data is far more likely to be this than an outage.
- **The runner is a single region.** A failure recorded here means the endpoint
  was unreachable *from that runner*, which is not the same as globally down.
  With one vantage point that distinction cannot be made, so the dashboard
  never claims it.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
pytest          # unit tests, fully offline (httpx MockTransport)
ruff check .
mypy
```

The tests cover the failure classification in depth, the retry semantics
(one retry, one row), the isolation guarantee that one broken target still
yields a complete batch, and that the packaged `targets.toml` is found from any
working directory and from an installed wheel.

That last one has its own CI job. The test suite runs against an *editable*
install, where walking up from `__file__` still lands in the repo root — so a
file missing from the wheel looks fine there. The `wheel` job builds a real
wheel, installs it into a clean environment and runs the CLI from an unrelated
directory, which is the only way that class of bug shows up before production.
