/**
 * Payload validation for the write API.
 *
 * The rule this enforces: the database is the record of what was actually
 * observed, so anything that could not have been observed is refused at the
 * door. A negative latency, a timestamp from next week, a status outside the
 * enum or a target that does not exist are all rejected with 400 and a message
 * naming the offending field — not silently coerced, clamped or dropped.
 *
 * Validation returns a typed row, so by the time anything reaches SQL the
 * shape is already guaranteed.
 */

export const FAILURE_KINDS = [
  'dns',
  'connection_refused',
  'tls_error',
  'timeout',
  'http_error',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Clock skew allowed between the runner and Cloudflare before a timestamp is "future". */
export const FUTURE_SKEW_SECONDS = 300;
/** A batch older than this is stale enough that accepting it would distort coverage. */
export const MAX_AGE_SECONDS = 86_400;
/** Eight targets checked every 30 minutes; anything near this is a bug or an abuse. */
export const MAX_BATCH = 200;
/** The longest a check can plausibly take: ten minutes, far beyond the 10s timeout. */
export const MAX_LATENCY_MS = 600_000;
/** Truncated rather than rejected - a long detail is untidy, not dishonest. */
export const MAX_DETAIL_CHARS = 500;

export interface ValidCheck {
  target_id: string;
  checked_at: number;
  status: 'ok' | 'failed';
  http_status: number | null;
  latency_ms: number | null;
  failure_kind: FailureKind | null;
  failure_detail: string | null;
}

export interface ValidBatch {
  interval_seconds: number;
  checks: ValidCheck[];
}

export class ValidationError extends Error {}

function fail(message: string): never {
  throw new ValidationError(message);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(`${field}: expected an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : integer(value, field);
}

/**
 * Validate a decoded JSON body.
 *
 * `knownTargets` comes from the database, not from the payload: a batch cannot
 * introduce a target by naming one. `now` is injected so the timestamp rules
 * are testable without mocking the clock.
 */
export function validateBatch(body: unknown, knownTargets: Set<string>, now: number): ValidBatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('body: expected a JSON object');
  }
  const root = body as Record<string, unknown>;

  const interval = integer(root.interval_seconds, 'interval_seconds');
  if (interval < 60 || interval > 86_400) {
    fail(`interval_seconds: must be between 60 and 86400, got ${interval}`);
  }

  if (!Array.isArray(root.checks)) fail('checks: expected an array');
  if (root.checks.length === 0) fail('checks: must not be empty');
  if (root.checks.length > MAX_BATCH) {
    fail(`checks: at most ${MAX_BATCH} per batch, got ${root.checks.length}`);
  }

  const checks: ValidCheck[] = [];
  const seen = new Set<string>();

  root.checks.forEach((raw, index) => {
    const at = `checks[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(`${at}: expected an object`);
    }
    const row = raw as Record<string, unknown>;

    // --- target must already exist; a payload cannot create one ------------
    const targetId = row.target_id;
    if (typeof targetId !== 'string' || targetId.length === 0) {
      fail(`${at}.target_id: expected a non-empty string`);
    }
    if (!knownTargets.has(targetId)) {
      fail(`${at}.target_id: unknown or disabled target '${targetId}'`);
    }

    // --- timestamp sanity --------------------------------------------------
    const checkedAt = integer(row.checked_at, `${at}.checked_at`);
    if (checkedAt > now + FUTURE_SKEW_SECONDS) {
      fail(`${at}.checked_at: ${checkedAt} is in the future (now ${now})`);
    }
    if (checkedAt < now - MAX_AGE_SECONDS) {
      fail(`${at}.checked_at: ${checkedAt} is more than ${MAX_AGE_SECONDS}s old`);
    }

    // --- one row per target per instant, within the batch ------------------
    const key = `${targetId}@${checkedAt}`;
    if (seen.has(key)) fail(`${at}: duplicate check for '${targetId}' at ${checkedAt}`);
    seen.add(key);

    // --- status enum -------------------------------------------------------
    const status = row.status;
    if (status !== 'ok' && status !== 'failed') {
      fail(`${at}.status: expected 'ok' or 'failed', got ${JSON.stringify(status)}`);
    }

    // --- http status -------------------------------------------------------
    const httpStatus = optionalInteger(row.http_status, `${at}.http_status`);
    if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) {
      fail(`${at}.http_status: ${httpStatus} is not a valid HTTP status`);
    }

    // --- latency -----------------------------------------------------------
    const latency = optionalInteger(row.latency_ms, `${at}.latency_ms`);
    if (latency !== null && latency < 0) {
      fail(`${at}.latency_ms: ${latency} is negative`);
    }
    if (latency !== null && latency > MAX_LATENCY_MS) {
      fail(`${at}.latency_ms: ${latency} exceeds the ${MAX_LATENCY_MS}ms ceiling`);
    }

    // --- failure fields must agree with status -----------------------------
    const kindRaw = row.failure_kind ?? null;
    if (kindRaw !== null && !FAILURE_KINDS.includes(kindRaw as FailureKind)) {
      fail(
        `${at}.failure_kind: expected one of ${FAILURE_KINDS.join(', ')}, ` +
          `got ${JSON.stringify(kindRaw)}`,
      );
    }
    const kind = kindRaw as FailureKind | null;
    if (status === 'ok' && kind !== null) {
      fail(`${at}: an 'ok' check cannot carry a failure_kind`);
    }
    if (status === 'failed' && kind === null) {
      fail(`${at}: a 'failed' check must name a failure_kind`);
    }
    if (status === 'ok' && latency === null) {
      fail(`${at}: an 'ok' check must report a latency`);
    }

    const detailRaw = row.failure_detail ?? null;
    if (detailRaw !== null && typeof detailRaw !== 'string') {
      fail(`${at}.failure_detail: expected a string or null`);
    }

    checks.push({
      target_id: targetId,
      checked_at: checkedAt,
      status,
      http_status: httpStatus,
      latency_ms: latency,
      failure_kind: kind,
      failure_detail:
        typeof detailRaw === 'string' ? detailRaw.slice(0, MAX_DETAIL_CHARS) : null,
    });
  });

  return { interval_seconds: interval, checks };
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A naive `===` on strings short-circuits at the first differing byte, which
 * over enough requests reveals the token prefix by prefix. This always walks
 * the full length. The length check before it is deliberate and safe: the
 * length of a token is not the secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
