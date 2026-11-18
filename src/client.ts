import { randomUUID } from 'node:crypto';
import {
  GrualinkApiError, GrualinkConfigError, GrualinkConnectionError, GrualinkError, GrualinkRateLimitError,
  GrualinkServerError, GrualinkTimeoutError, apiErrorFromStatus, type ErrorDetail,
} from './errors.js';
import type { ServiceRequest, ServiceRequestInput, ServiceRequestList } from './types.js';

export const DEFAULT_BASE_URL = 'https://grualink.mx/api/v1';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RETRIES = 3;

const API_KEY_PREFIX = /^glk_(test|live)_\S+$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const MAX_BODY_BYTES = 16 * 1024;
/** The API never asks to wait more than 60 seconds. */
const MAX_RETRY_AFTER_SECONDS = 60;

export interface RetryInfo {
  /** Attempt that just failed, starting at 1. */
  attempt: number;
  /** Time the client will wait before the next attempt. */
  delayMs: number;
  /** Why it failed. Never contains the API key. */
  error: GrualinkError;
}

export interface GrualinkClientOptions {
  /** `glk_test_...` or `glk_live_...`. Read it from the environment; never hard-code it. */
  apiKey: string;
  /** Defaults to `https://grualink.mx/api/v1`. */
  baseUrl?: string;
  /** Maximum time for each attempt, in milliseconds (default 15,000). */
  timeoutMs?: number;
  /** Retries after the first attempt for 429 `rate_limited`, 5xx, timeouts and network errors (default 3). */
  maxRetries?: number;
  /** First backoff step in milliseconds (default 500). */
  retryBaseDelayMs?: number;
  /** Ceiling of the exponential backoff in milliseconds (default 8,000). */
  retryMaxDelayMs?: number;
  /** Called before each wait. Use it for your own logging. */
  onRetry?: (info: RetryInfo) => void;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface CreateServiceRequestOptions {
  /**
   * 1 to 255 visible ASCII characters, unique per request you want to create. Store it with your record
   * before calling: sending it again with the same body returns the original response instead of a duplicate.
   * Generated (UUID v4) when omitted.
   */
  idempotencyKey?: string;
}

export interface CreateServiceRequestResult {
  serviceRequest: ServiceRequest;
  /** `true` when the API answered 200 with `Idempotent-Replayed: true` (nothing new was created). */
  replayed: boolean;
  /** The key that was sent (yours or the generated one). */
  idempotencyKey: string;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^[0-9]{1,9}$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

function isRetryable(error: GrualinkError): boolean {
  if (error instanceof GrualinkConnectionError || error instanceof GrualinkTimeoutError) return true;
  if (error instanceof GrualinkServerError) return true;
  // too_many_open_requests only clears when the company resolves a request: waiting a few seconds does not help.
  if (error instanceof GrualinkRateLimitError) return error.code !== 'too_many_open_requests';
  return false;
}

export class GrualinkClient {
  // Private fields: the key is not enumerable, not serialized and not shown by console.log or util.inspect.
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #onRetry: ((info: RetryInfo) => void) | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GrualinkClientOptions) {
    const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
    if (!apiKey) throw new GrualinkConfigError('apiKey is required (set GRUALINK_API_KEY).');
    if (!API_KEY_PREFIX.test(apiKey)) {
      throw new GrualinkConfigError('apiKey must start with glk_test_ or glk_live_.');
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new GrualinkConfigError('baseUrl is not a valid URL.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      throw new GrualinkConfigError('baseUrl must use https (http is only accepted for localhost).');
    }
    if (parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new GrualinkConfigError('baseUrl must not contain credentials, query or fragment.');
    }
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.#maxRetries = nonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries');
    this.#retryBaseDelayMs = positive(options.retryBaseDelayMs, 500, 'retryBaseDelayMs');
    this.#retryMaxDelayMs = positive(options.retryMaxDelayMs, 8_000, 'retryMaxDelayMs');
    this.#onRetry = options.onRetry;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** `test` or `live`, from the key prefix. */
  get mode(): 'test' | 'live' {
    return this.#apiKey.startsWith('glk_live_') ? 'live' : 'test';
  }

  /** `GET /health`. Sent without the key. */
  async health(): Promise<{ status: string; version: string }> {
    const res = await this.#request('GET', '/health', { authenticated: false });
    return res.body as { status: string; version: string };
  }

  /**
   * `POST /service-requests`. The body is serialized once and the exact same bytes and Idempotency-Key are
   * reused on every retry, so a retry can never create a second request.
   */
  async createServiceRequest(
    input: ServiceRequestInput,
    options: CreateServiceRequestOptions = {},
  ): Promise<CreateServiceRequestResult> {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new GrualinkConfigError('idempotencyKey must be 1 to 255 visible ASCII characters.');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new GrualinkConfigError('The service request must be an object.');
    }
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new GrualinkConfigError('The service request exceeds 16 KB.');
    }
    const res = await this.#request('POST', '/service-requests', {
      body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    });
    return {
      serviceRequest: res.body as ServiceRequest,
      replayed: res.status === 200 && res.headers.get('idempotent-replayed') === 'true',
      idempotencyKey,
    };
  }

  /** `GET /service-requests/{id}`. */
  async getServiceRequest(id: string): Promise<ServiceRequest> {
    if (typeof id !== 'string' || !id.trim()) throw new GrualinkConfigError('id is required.');
    const res = await this.#request('GET', `/service-requests/${encodeURIComponent(id.trim())}`);
    return res.body as ServiceRequest;
  }

  /** `GET /service-requests?external_ref=...`: up to 20 of your requests with that reference, newest first. */
  async findServiceRequestsByExternalRef(externalRef: string): Promise<ServiceRequest[]> {
    if (typeof externalRef !== 'string' || !externalRef.trim()) {
      throw new GrualinkConfigError('externalRef is required.');
    }
    const query = new URLSearchParams({ external_ref: externalRef }).toString();
    const res = await this.#request('GET', `/service-requests?${query}`);
    return (res.body as ServiceRequestList).data;
  }

  /** Replaces the API key with a marker in any text that will leave this class. */
  #redact(text: string): string {
    return text.split(this.#apiKey).join('[REDACTED]');
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: string; headers?: Record<string, string>; authenticated?: boolean } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    if (init.authenticated !== false) headers['Authorization'] = `Bearer ${this.#apiKey}`;
    const url = `${this.#baseUrl}${path}`;

    for (let attempt = 1; ; attempt++) {
      let failure: GrualinkError;
      try {
        const response = await this.#fetch(url, {
          method,
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          // A redirect is never followed: the key must not travel to another address.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        const text = await response.text();
        if (response.status >= 200 && response.status < 300) {
          try {
            return { status: response.status, headers: response.headers, body: JSON.parse(text) as unknown };
          } catch {
            failure = new GrualinkApiError({
              status: response.status, code: 'unexpected_response', message: 'The API answered with a body that is not JSON.',
            });
          }
        } else {
          failure = this.#toApiError(response, text);
        }
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : '';
        failure = name === 'TimeoutError' || name === 'AbortError'
          ? new GrualinkTimeoutError(`No response from the GRUALINK API within ${this.#timeoutMs} ms.`)
          : new GrualinkConnectionError(this.#redact(`Could not reach the GRUALINK API: ${describeCause(cause)}`));
      }

      failure.attempts = attempt;
      if (!isRetryable(failure) || attempt > this.#maxRetries) throw failure;
      const delayMs = this.#retryDelay(attempt, failure);
      this.#onRetry?.({ attempt, delayMs, error: failure });
      await this.#sleep(delayMs);
    }
  }

  /** Exponential backoff with full jitter; `Retry-After` is a floor when the API sends it. */
  #retryDelay(attempt: number, failure: GrualinkError): number {
    const ceiling = Math.min(this.#retryMaxDelayMs, this.#retryBaseDelayMs * 2 ** (attempt - 1));
    const jitter = this.#random() * ceiling;
    const retryAfter = failure instanceof GrualinkApiError ? failure.retryAfterSeconds : undefined;
    if (retryAfter === undefined) return Math.round(jitter);
    return Math.round(Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000 + jitter);
  }

  #toApiError(response: Response, text: string): GrualinkApiError {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), Date.now());
    let code = 'unexpected_response';
    let message = `The API answered HTTP ${response.status}.`;
    let details: ErrorDetail[] | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
      const error = parsed?.error;
      if (error && typeof error.code === 'string') {
        code = this.#redact(error.code);
        if (typeof error.message === 'string') message = this.#redact(error.message);
        if (Array.isArray(error.details)) {
          details = error.details
            .filter((d): d is { field: unknown; issue: unknown } => typeof d === 'object' && d !== null)
            .map((d) => ({ field: this.#redact(String(d.field ?? '')), issue: this.#redact(String(d.issue ?? '')) }));
        }
      }
    } catch {
      // Not JSON (for example an HTML page from a proxy): keep the generic message; the body is not echoed.
    }
    return apiErrorFromStatus({ status: response.status, code, message, details, retryAfterSeconds });
  }
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return 'unknown error';
  const inner = (cause as { cause?: unknown }).cause;
  const code = typeof inner === 'object' && inner !== null ? (inner as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? `${cause.message} (${code})` : cause.message;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GrualinkConfigError(`${name} must be a positive number.`);
  }
  return value;
}

function nonNegativeInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new GrualinkConfigError(`${name} must be a non-negative integer.`);
  return value;
}
