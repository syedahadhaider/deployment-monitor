/**
 * Deployment monitor API.
 *
 *   POST /ingest   authenticated, validating, parameterised writes
 *   GET  /summary  public, cached, everything aggregated in SQL
 *
 * The read endpoint is the only thing the portfolio talks to, and it is a
 * plain public GET. That is what keeps the portfolio repo free of any database
 * client, driver or credential.
 */

import {
  ENABLED_TARGETS_SQL,
  INCIDENTS_SQL,
  INSERT_CHECK_SQL,
  LATENCY_SQL,
  SERIES_SQL,
  SUMMARY_SQL,
} from './queries';
import { ValidationError, timingSafeEqual, validateBatch } from './validate';

export interface Env {
  DB: D1Database;
  /** Bearer token for /ingest. Set with `wrangler secret put`, never committed. */
  INGEST_TOKEN: string;
  /** Comma-separated origins allowed to read /summary from a browser. */
  ALLOWED_ORIGINS?: string;
  /**
   * `owner/repo` whose workflow the watchdog nudges. Unset disables the
   * watchdog entirely, which is a supported configuration - the collector
   * still runs on GitHub's own schedule, just less reliably.
   */
  GITHUB_REPO?: string;
  /**
   * Fine-grained PAT with Contents: read and write on that repo, which is the
   * permission `POST /dispatches` requires. Secret; never committed.
   */
  GITHUB_DISPATCH_TOKEN?: string;
}

// --- tuning, stated once and reported to the client ------------------------

/** The window every figure on the dashboard describes. */
const WINDOW_SECONDS = 7 * 24 * 3600;

/** Time-series bucket: 7 days / 3h = 56 points, enough to see shape and gaps. */
const BUCKET_SECONDS = 3 * 3600;

/**
 * Below this many successful checks, percentiles are withheld. A p95 drawn
 * from a dozen samples is noise wearing a statistic's clothes.
 */
const MIN_LATENCY_SAMPLES = 50;

/**
 * Two scheduled intervals. A failed check arriving within this of the previous
 * failed check continues the same incident; anything later is a scheduler gap
 * and starts a new one. Generous because GitHub Actions cron runs late.
 */
const GAP_TOLERANCE_INTERVALS = 2;

/** Fallback cadence, used only for a target that has no rows to read one from. */
const DEFAULT_INTERVAL_SECONDS = 1800;

const MAX_INCIDENTS = 50;

/**
 * Cache TTL.
 *
 * Checks arrive every 30 minutes, so anything below that is mostly spent
 * re-running the same aggregation over identical rows. Ten minutes bounds
 * worst-case staleness to a third of the collection interval while cutting
 * origin hits to at most 144/day per edge location — which matters, because
 * since 1 September 2026 D1 *fails* queries once the free tier's daily row-read
 * limit is reached, and that failure would take the collector's writes down
 * with it. The TTL is a correctness control, not just a speed one.
 */
const CACHE_TTL_SECONDS = 600;

/**
 * Where a slot starts, in seconds past the hour.
 *
 * The workflow asks for `7,37 * * * *`, so slots begin at :07 and :37 and the
 * phase is 7*60. Coverage and the watchdog both align to this, so a check
 * always belongs to the same slot however it was triggered.
 */
const SLOT_PHASE_SECONDS = 420;

/**
 * How far into a slot the watchdog waits before filling it.
 *
 * THE PREVIOUS VALUE WAS A BUG. It was 1500s measured from the newest check,
 * described as firing "only once a scheduled run has demonstrably been
 * skipped". It did the opposite: at a 1800s cadence a check at T made the
 * watchdog dispatch at T+1500, five minutes BEFORE the next scheduled run was
 * even due. Measured over seven days that produced 17 slots holding both a
 * dispatched run and the scheduled run it pre-empted.
 *
 * It is also why the cadence held up at all: because the trigger was an age
 * since the last check, the cadence it produced equalled the threshold. Simply
 * raising the threshold to "interval + grace" would therefore have pushed every
 * subsequent check later too, stretching the cadence to 45-55 minutes and
 * dropping real coverage to around 60% -- on this repository GitHub's own cron
 * fired just 41 of 336 expected ticks, so the watchdog is the primary
 * scheduler, not a backstop.
 *
 * So the trigger is now the SLOT, not the age. The watchdog fires only when the
 * slot in progress still holds no check and is already this old. That cannot
 * pre-empt the next slot, because it never looks past the current one.
 *
 * 1200s is chosen against the tick phase, not picked round. Cloudflare's cron
 * runs every ten minutes on the hour, so inside a slot starting at :07 the
 * ticks land at +180s, +780s and +1380s. A threshold of 1200s qualifies exactly
 * one of them (+1380s, 23 minutes in), leaving ~7 minutes for the dispatched run
 * to land inside its own slot. Raising it past 1380 would mean no tick ever
 * qualifies and the watchdog would never fire at all.
 *
 * It also gives GitHub's own run 23 minutes to show up first; the measured
 * median lateness of a scheduled run here is 12m39s, so most arrive well before
 * the watchdog considers the slot abandoned.
 */
const SLOT_FILL_AFTER_SECONDS = 1200; // 20 minutes into a 30-minute slot

/** The event type the workflow listens for on `repository_dispatch`. */
const DISPATCH_EVENT = 'run-checks';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // The data is public, so a permissive default is honest rather than risky —
  // but when an allow-list is configured it is respected exactly.
  if (allowed.length === 0) return { 'Access-Control-Allow-Origin': '*' };
  if (origin && allowed.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  // A request from somewhere else still gets a valid header naming the
  // canonical origin, so the browser blocks it cleanly instead of erroring.
  return { 'Access-Control-Allow-Origin': allowed[0] ?? '*', Vary: 'Origin' };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

async function ingest(request: Request, env: Env): Promise<Response> {
  // --- auth --------------------------------------------------------------
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!env.INGEST_TOKEN) {
    return json({ error: 'server is not configured with an ingest token' }, 500);
  }
  if (!token || !timingSafeEqual(token, env.INGEST_TOKEN)) {
    // Deliberately says nothing about which part was wrong.
    return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }

  if (request.headers.get('Content-Type')?.includes('application/json') !== true) {
    return json({ error: 'expected Content-Type: application/json' }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  // --- validate ----------------------------------------------------------
  const targetRows = await env.DB.prepare(ENABLED_TARGETS_SQL).all<{ id: string }>();
  const known = new Set((targetRows.results ?? []).map((r) => r.id));
  if (known.size === 0) {
    return json({ error: 'no enabled targets; run the seed migration first' }, 503);
  }

  let batch;
  try {
    batch = validateBatch(body, known, Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    throw error;
  }

  // --- write -------------------------------------------------------------
  // Every value is bound, never interpolated. D1's batch() is one round trip
  // and is atomic, so a partially written run is not possible.
  const statement = env.DB.prepare(INSERT_CHECK_SQL);
  const writes = batch.checks.map((c) =>
    statement.bind(
      c.target_id,
      c.checked_at,
      c.status,
      c.http_status,
      c.latency_ms,
      c.failure_kind,
      c.failure_detail,
      batch.interval_seconds,
    ),
  );

  try {
    const results = await env.DB.batch(writes);
    const inserted = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    return json({
      received: batch.checks.length,
      inserted,
      // Non-zero means a replayed batch was correctly ignored rather than
      // double-counted; the collector logs it and it is not an error.
      duplicates_ignored: batch.checks.length - inserted,
    });
  } catch (error) {
    return json({ error: `write failed: ${(error as Error).message}` }, 502);
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

interface SummaryRow {
  target_id: string;
  name: string;
  url: string;
  checks_recorded: number;
  ok_count: number;
  failed_count: number;
  first_checked_at: number | null;
  last_checked_at: number | null;
  last_status: string | null;
  last_http_status: number | null;
  last_failure_kind: string | null;
  interval_seconds: number | null;
  checks_expected: number;
  slots_expected: number;
  slots_covered: number;
  extra_runs: number;
}

interface LatencyRow {
  target_id: string;
  sample_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  insufficient_data: number;
}

async function summary(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const now = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_SECONDS;

  let targets: SummaryRow[];
  let latency: LatencyRow[];
  let incidents: Record<string, unknown>[];
  let series: Record<string, unknown>[];

  try {
    // Four statements, four indexed range scans over the same window. Each one
    // returns finished aggregates; no raw check rows ever cross this boundary.
    const batched = await env.DB.batch([
      env.DB.prepare(SUMMARY_SQL).bind(since, now, DEFAULT_INTERVAL_SECONDS, SLOT_PHASE_SECONDS),
      env.DB.prepare(LATENCY_SQL).bind(since, now, MIN_LATENCY_SAMPLES),
      env.DB.prepare(INCIDENTS_SQL).bind(since, now, GAP_TOLERANCE_INTERVALS, MAX_INCIDENTS),
      env.DB.prepare(SERIES_SQL).bind(since, now, BUCKET_SECONDS),
    ]);
    if (batched.length !== 4) throw new Error('unexpected D1 batch result shape');
    const rowsAt = (index: number): Record<string, unknown>[] =>
      (batched[index]?.results ?? []) as unknown as Record<string, unknown>[];
    targets = rowsAt(0) as unknown as SummaryRow[];
    latency = rowsAt(1) as unknown as LatencyRow[];
    incidents = rowsAt(2);
    series = rowsAt(3);
  } catch (error) {
    // A D1 failure - including the free tier's daily row limit - must degrade
    // to a stated "unavailable", never to a page implying everything is down.
    return json(
      { error: 'monitor data is temporarily unavailable', detail: (error as Error).message },
      503,
      { 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
    );
  }

  const latencyById = new Map(latency.map((row) => [row.target_id, row]));

  const payload = {
    generated_at: now,
    window: { since, until: now, seconds: WINDOW_SECONDS },
    config: {
      check_interval_seconds: DEFAULT_INTERVAL_SECONDS,
      bucket_seconds: BUCKET_SECONDS,
      cache_ttl_seconds: CACHE_TTL_SECONDS,
      min_latency_samples: MIN_LATENCY_SAMPLES,
      gap_tolerance_intervals: GAP_TOLERANCE_INTERVALS,
    },
    targets: targets.map((row) => {
      const lat = latencyById.get(row.target_id);
      const recorded = row.checks_recorded;
      const expected = Math.max(row.checks_expected, 0);
      const slotsExpected = Math.max(row.slots_expected, 0);
      const slotsCovered = Math.max(row.slots_covered, 0);
      return {
        id: row.target_id,
        name: row.name,
        url: row.url,
        checks_recorded: recorded,
        checks_expected: expected,
        // Slots, and the runs beyond the first in one. extra_runs > 0 with
        // coverage < 1 is the shape the old formula hid: duplicate runs paying
        // for missed ones.
        slots_expected: slotsExpected,
        slots_covered: slotsCovered,
        extra_runs: Math.max(row.extra_runs, 0),
        ok_count: row.ok_count,
        failed_count: row.failed_count,
        // Ratios are the only arithmetic done here, and only because a
        // fraction is a presentation choice; both numerator and denominator
        // were computed in SQL. `null` when there is nothing to divide -
        // never 0, which would read as "totally down" / "no coverage".
        uptime: recorded > 0 ? row.ok_count / recorded : null,
        // Slots covered, not samples recorded. No Math.min is needed or wanted:
        // the numerator is DISTINCT slots drawn from the same bounded range as
        // the denominator, so it cannot exceed it, and clamping would hide it
        // if it ever did.
        coverage: slotsExpected > 0 ? slotsCovered / slotsExpected : null,
        last_checked_at: row.last_checked_at,
        last_status: row.last_status,
        last_http_status: row.last_http_status,
        last_failure_kind: row.last_failure_kind,
        latency: {
          sample_count: lat?.sample_count ?? 0,
          p50_ms: lat?.p50_ms ?? null,
          p95_ms: lat?.p95_ms ?? null,
          insufficient_data: (lat?.insufficient_data ?? 1) === 1,
        },
      };
    }),
    incidents,
    series,
  };

  const response = json(payload, 200, {
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
    ...corsHeaders(request, env),
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

/**
 * Fill the gaps GitHub's scheduler leaves.
 *
 * GitHub Actions cron is best-effort and, on a low-activity repository, mostly
 * does not run: in the first nine hours here, one scheduled tick fired out of
 * roughly ten expected, and that one arrived fifteen minutes late. The `*​/30`
 * expression was never the problem -- it asked for the two most oversubscribed
 * minutes on the platform, and GitHub simply dropped the rest.
 *
 * The fix is deliberately NOT "move the checks into this Worker". The checks
 * are Python on purpose. Instead this is a watchdog: Cloudflare's cron is
 * reliable, so every ten minutes it asks the database one question -- how old
 * is the newest check? -- and only if a run has actually been missed does it
 * nudge the SAME GitHub workflow via `repository_dispatch`. Python still
 * performs every check.
 *
 * IT CAN produce a second collection alongside a healthy one, and for seven
 * days it did: 17 slots held both a dispatched run and the scheduled run it
 * fired ahead of. The old trigger was an age since the newest check, set below
 * the collection interval, so it went off before the next scheduled run was
 * due. The claim that previously stood here -- that it "cannot produce a second
 * collection alongside a healthy one" -- was wrong, and coverage counting
 * samples rather than slots is what kept it from showing.
 *
 * It now fires on the SLOT instead: at most one dispatch per slot, and only
 * when that slot is already SLOT_FILL_AFTER_SECONDS old and still holds no
 * check. Two dispatches in one slot are not reachable in practice -- the first
 * one's run writes its checks within a couple of minutes and the next tick is
 * ten minutes later, by which point the slot is no longer empty.
 *
 * A duplicate is still possible when GitHub's own scheduled run arrives after
 * the watchdog has already given up on the slot: measured lateness here runs to
 * 29m31s at worst. That is now harmless to the figure, because coverage counts
 * the slot once however many runs landed in it, and the surplus is reported
 * separately as extra_runs.
 */
interface WatchdogResult {
  action:
    | 'dispatched'
    | 'skipped_fresh'
    | 'skipped_slot_young'
    | 'not_configured'
    | 'dispatch_rejected'
    | 'threw';
  detail: string;
  last_checked_at: number | null;
  age_seconds: number | null;
  /** Start of the slot in progress, and how far into it this tick is. */
  slot_started_at: number | null;
  slot_age_seconds: number | null;
  slot_has_check: boolean | null;
  slot_fill_after_seconds: number;
  /** Never the token. Only whether one is present and how long it is. */
  token: { present: boolean; length: number };
  repo: string | null;
  github_status?: number;
  github_body?: string;
}

async function watchdog(env: Env): Promise<WatchdogResult> {
  // Length, never the value. This is precisely what distinguishes "the secret
  // exists but is empty" from "the secret is fine" -- `wrangler secret list`
  // shows only the name, so an empty value is otherwise invisible.
  const token = env.GITHUB_DISPATCH_TOKEN ?? '';
  const tokenInfo = { present: token.length > 0, length: token.length };
  const repo = env.GITHUB_REPO ?? null;

  const base: WatchdogResult = {
    action: 'not_configured',
    detail: '',
    last_checked_at: null,
    age_seconds: null,
    slot_started_at: null,
    slot_age_seconds: null,
    slot_has_check: null,
    slot_fill_after_seconds: SLOT_FILL_AFTER_SECONDS,
    token: tokenInfo,
    repo,
  };

  if (!repo || !token) {
    // Previously this returned silently, which is why a bad token looked
    // identical to a healthy watchdog: zero dispatches and zero logs.
    base.detail = !repo
      ? 'GITHUB_REPO is not set'
      : `GITHUB_DISPATCH_TOKEN is missing or empty (length ${token.length})`;
    console.error(`watchdog: not configured - ${base.detail}`);
    return base;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    // The slot in progress, on the same phase the coverage query uses.
    const slotStart =
      Math.floor((now - SLOT_PHASE_SECONDS) / DEFAULT_INTERVAL_SECONDS) * DEFAULT_INTERVAL_SECONDS +
      SLOT_PHASE_SECONDS;
    const slotAge = now - slotStart;

    // One statement, two facts: the newest check anywhere (for the log and the
    // response) and whether THIS slot already holds one. Bound parameter, as
    // everywhere else in this project.
    const row = await env.DB
      .prepare(
        'SELECT MAX(checked_at) AS last, ' +
          'SUM(CASE WHEN checked_at >= ?1 THEN 1 ELSE 0 END) AS in_slot FROM checks',
      )
      .bind(slotStart)
      .first<{ last: number | null; in_slot: number | null }>();

    const last = row?.last ?? 0;
    const inSlot = (row?.in_slot ?? 0) > 0;
    base.last_checked_at = last || null;
    base.age_seconds = last ? now - last : null;
    base.slot_started_at = slotStart;
    base.slot_age_seconds = slotAge;
    base.slot_has_check = inSlot;

    if (inSlot) {
      base.action = 'skipped_fresh';
      base.detail = `slot started ${slotAge}s ago already holds a check`;
      console.log(`watchdog: ${base.detail}`);
      return base;
    }

    if (slotAge < SLOT_FILL_AFTER_SECONDS) {
      // The slot is empty but young: GitHub's own run may still be on its way,
      // and firing now is what used to pre-empt it.
      base.action = 'skipped_slot_young';
      base.detail = `slot is ${slotAge}s old, under the ${SLOT_FILL_AFTER_SECONDS}s fill threshold`;
      console.log(`watchdog: ${base.detail}`);
      return base;
    }

    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        // GitHub rejects API requests without one.
        'User-Agent': 'deployment-monitor-watchdog',
      },
      body: JSON.stringify({ event_type: DISPATCH_EVENT }),
    });

    base.github_status = response.status;
    // 204 No Content on success, so a body only exists on failure.
    base.github_body = (await response.text()).slice(0, 300);

    if (!response.ok) {
      base.action = 'dispatch_rejected';
      base.detail = `GitHub returned ${response.status}`;
      // Logged, not thrown: a failed nudge must not look like a failed check.
      console.error(`watchdog: dispatch rejected ${response.status} ${base.github_body}`);
      return base;
    }

    base.action = 'dispatched';
    base.detail =
      `slot started ${slotAge}s ago was still empty; ` +
      `dispatched '${DISPATCH_EVENT}' to ${repo}`;
    console.log(`watchdog: ${base.detail}`);
    return base;
  } catch (error) {
    base.action = 'threw';
    base.detail = (error as Error).message;
    console.error(`watchdog: threw - ${base.detail}`);
    return base;
  }
}

// ---------------------------------------------------------------------------

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Logged before anything can return early, so "the cron never fired" and
    // "the cron fired and decided to do nothing" are never confusable again.
    console.log(`watchdog: scheduled tick (cron ${event.cron})`);
    ctx.waitUntil(watchdog(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname === '/ingest' && request.method === 'POST') return ingest(request, env);
    if (url.pathname === '/summary' && request.method === 'GET') {
      return summary(request, env, ctx);
    }
    // Same bearer token as /ingest. Runs the watchdog now and returns exactly
    // what it decided and why -- including the GitHub status and body when a
    // dispatch is rejected. The token itself is never returned or logged, only
    // whether one is present and its length.
    if (url.pathname === '/watchdog/run' && request.method === 'POST') {
      const header = request.headers.get('Authorization') ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!env.INGEST_TOKEN || !supplied || !timingSafeEqual(supplied, env.INGEST_TOKEN)) {
        return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      return json(await watchdog(env), 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true }, 200, corsHeaders(request, env));
    }

    return json({ error: 'not found' }, 404, corsHeaders(request, env));
  },
} satisfies ExportedHandler<Env>;
