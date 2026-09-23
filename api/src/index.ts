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
      env.DB.prepare(SUMMARY_SQL).bind(since, now, DEFAULT_INTERVAL_SECONDS),
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
      return {
        id: row.target_id,
        name: row.name,
        url: row.url,
        checks_recorded: recorded,
        checks_expected: expected,
        ok_count: row.ok_count,
        failed_count: row.failed_count,
        // Ratios are the only arithmetic done here, and only because a
        // fraction is a presentation choice; both numerator and denominator
        // were computed in SQL. `null` when there is nothing to divide -
        // never 0, which would read as "totally down" / "no coverage".
        uptime: recorded > 0 ? row.ok_count / recorded : null,
        coverage: expected > 0 ? Math.min(recorded / expected, 1) : null,
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

export default {
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
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true }, 200, corsHeaders(request, env));
    }

    return json({ error: 'not found' }, 404, corsHeaders(request, env));
  },
} satisfies ExportedHandler<Env>;
