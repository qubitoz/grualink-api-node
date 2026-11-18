/** One entry of `error.details` in a 400/422 response. */
export interface ErrorDetail {
  /** Dotted path of the offending field, e.g. `contact.phone`. */
  field: string;
  /** One of: required, invalid_type, too_long, invalid_format, out_of_range, unknown_field, invalid_value, duplicate. */
  issue: string;
}

/** Base class of every error thrown by this library. */
export class GrualinkError extends Error {
  /** Number of HTTP attempts made before giving up (0 when no request was sent). */
  attempts = 0;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The client was configured or called with an invalid argument. Nothing was sent. */
export class GrualinkConfigError extends GrualinkError {}

/** The request never got an HTTP response (DNS, connection reset, TLS...). Retried automatically. */
export class GrualinkConnectionError extends GrualinkError {}

/** No response within the configured timeout. Retried automatically. */
export class GrualinkTimeoutError extends GrualinkError {}

export interface GrualinkApiErrorInit {
  status: number;
  code: string;
  message: string;
  details?: ErrorDetail[] | undefined;
  retryAfterSeconds?: number | undefined;
}

/**
 * The API answered with an error. `code` is the stable machine-readable code from
 * `{ "error": { "code", "message", "details"? } }`; `message` may change over time.
 * When the body is not the documented error shape, `code` is `unexpected_response`.
 */
export class GrualinkApiError extends GrualinkError {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];
  /** Value of the `Retry-After` header in seconds, when present. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: GrualinkApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** 400, 405, 413, 415: the request is malformed. Fix the request; do not retry. */
export class GrualinkInvalidRequestError extends GrualinkApiError {}
/** 401 `unauthorized`: key missing, invalid, expired or revoked (always the same answer). */
export class GrualinkAuthenticationError extends GrualinkApiError {}
/** 403: the key is not allowed to do this (scope, customer unavailable, live mode, browser). */
export class GrualinkPermissionError extends GrualinkApiError {}
/** 404 `not_found`: it does not exist or does not belong to your key. */
export class GrualinkNotFoundError extends GrualinkApiError {}
/** 409 `idempotency_conflict`: the Idempotency-Key was already used with a different body. */
export class GrualinkIdempotencyConflictError extends GrualinkApiError {}
/** 422 `validation_error`: see `details` for the invalid fields. */
export class GrualinkValidationError extends GrualinkApiError {}
/** 429 `rate_limited` (retried automatically) or `too_many_open_requests` (not retried). */
export class GrualinkRateLimitError extends GrualinkApiError {}
/** 5xx: retried automatically; safe because the same Idempotency-Key is reused. */
export class GrualinkServerError extends GrualinkApiError {}

/** Maps an HTTP status to the error class that represents it. */
export function apiErrorFromStatus(init: GrualinkApiErrorInit): GrualinkApiError {
  const s = init.status;
  if (s === 401) return new GrualinkAuthenticationError(init);
  if (s === 403) return new GrualinkPermissionError(init);
  if (s === 404) return new GrualinkNotFoundError(init);
  if (s === 409) return new GrualinkIdempotencyConflictError(init);
  if (s === 422) return new GrualinkValidationError(init);
  if (s === 429) return new GrualinkRateLimitError(init);
  if (s >= 500) return new GrualinkServerError(init);
  if (s === 400 || s === 405 || s === 413 || s === 415) return new GrualinkInvalidRequestError(init);
  return new GrualinkApiError(init);
}
