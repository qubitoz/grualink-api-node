import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent } from './types.js';

export const SIGNATURE_HEADER = 'x-grualink-signature';
export const DELIVERY_HEADER = 'x-grualink-delivery';
export const EVENT_HEADER = 'x-grualink-event';
export const TIMESTAMP_HEADER = 'x-grualink-timestamp';
export const MODE_HEADER = 'x-grualink-mode';

/** Deliveries whose signed timestamp differs more than this from the current time are rejected. */
export const DEFAULT_TOLERANCE_SECONDS = 300;
/** A delivery body is never larger than 64 KB. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type SignatureVerificationReason =
  | 'ok'
  | 'missing_secret'
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export interface VerifyWebhookSignatureInput {
  /** The RAW request body exactly as received, before any JSON parsing. Prefer bytes; a string is encoded as UTF-8. */
  rawBody: Uint8Array | string;
  /** Value of the `X-GruaLink-Signature` header. */
  signatureHeader: string | null | undefined;
  /** Your signing secret, whole (with its `whsec_` prefix). Pass two during your own rotation window. */
  secret: string | readonly string[] | null | undefined;
  /** Current time in seconds since 1970 (UTC). Defaults to the system clock. */
  nowSeconds?: number;
  /** Defaults to 300 seconds. */
  toleranceSeconds?: number;
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason: SignatureVerificationReason;
}

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE_V1 = /^[0-9a-f]{64}$/;

const fail = (reason: SignatureVerificationReason): SignatureVerificationResult => ({ valid: false, reason });

/** HMAC-SHA256, lowercase hex, of `<timestamp>.<raw body>` keyed with the secret exactly as issued. */
export function computeWebhookSignature(secret: string, timestamp: number | string, rawBody: Uint8Array | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** Builds the header the way GRUALINK sends it. Useful to test your own receiver locally. */
export function buildSignatureHeader(secrets: readonly string[], timestamp: number, rawBody: Uint8Array | string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeWebhookSignature(s, timestamp, rawBody)}`)].join(',');
}

/**
 * Verifies `X-GruaLink-Signature`. Pure and total: it never throws and has no side effects.
 *
 * Order of checks (shared by every language; the contract vectors pin it):
 *  1. no secret                                        -> missing_secret
 *  2. header absent or blank                           -> missing_header
 *  3. no `t` of 1-12 digits, or no well-formed `v1`    -> malformed_header
 *  4. |now - t| greater than the tolerance             -> timestamp_out_of_tolerance
 *  5. no `v1` equals the expected signature            -> signature_mismatch
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): SignatureVerificationResult {
  try {
    const secrets = (typeof input.secret === 'string' ? [input.secret] : Array.isArray(input.secret) ? input.secret : [])
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (secrets.length === 0) return fail('missing_secret');

    const header = input.signatureHeader;
    if (typeof header !== 'string' || header.trim() === '') return fail('missing_header');

    let timestampText: string | undefined;
    const candidates: string[] = [];
    for (const part of header.split(',')) {
      const item = part.trim();
      const eq = item.indexOf('=');
      if (eq < 0) continue;
      const key = item.slice(0, eq);
      const value = item.slice(eq + 1);
      if (key === 't' && timestampText === undefined) timestampText = value;
      // Anything that is not exactly 64 lowercase hex characters is ignored, as are unknown schemes.
      else if (key === 'v1' && SIGNATURE_V1.test(value)) candidates.push(value);
    }
    if (timestampText === undefined || !TIMESTAMP.test(timestampText)) return fail('malformed_header');
    if (candidates.length === 0) return fail('malformed_header');

    const now = input.nowSeconds ?? Date.now() / 1000;
    const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (Math.abs(now - Number(timestampText)) > tolerance) return fail('timestamp_out_of_tolerance');

    const body = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody;
    let matched = false;
    // Every pair is compared in constant time and the loop never exits early.
    for (const secret of secrets) {
      const expected = Buffer.from(computeWebhookSignature(secret, timestampText, body), 'utf8');
      for (const candidate of candidates) {
        if (timingSafeEqual(Buffer.from(candidate, 'utf8'), expected)) matched = true;
      }
    }
    return matched ? { valid: true, reason: 'ok' } : fail('signature_mismatch');
  } catch {
    return fail('malformed_header');
  }
}

export interface DeliveryDeduplicator {
  /** Returns `true` the first time an id is seen and `false` for a duplicate. */
  claim(deliveryId: string): boolean | Promise<boolean>;
  /** Forgets an id so a later retry is processed again (call it when processing failed). */
  release(deliveryId: string): void | Promise<void>;
}

/**
 * In-memory deduplication for a single process. Retries of one delivery span up to 24 hours, so ids are kept
 * for 48 hours by default. With several instances, use a shared store (a unique key in your database is enough).
 */
export class InMemoryDeliveryDeduplicator implements DeliveryDeduplicator {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 48 * 60 * 60 * 1000;
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#now = options.now ?? Date.now;
  }

  claim(deliveryId: string): boolean {
    const now = this.#now();
    for (const [id, expiresAt] of this.#seen) {
      if (expiresAt > now && this.#seen.size < this.#maxEntries) break;
      this.#seen.delete(id);
    }
    const expiresAt = this.#seen.get(deliveryId);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.#seen.delete(deliveryId);
    this.#seen.set(deliveryId, now + this.#ttlMs);
    return true;
  }

  release(deliveryId: string): void {
    this.#seen.delete(deliveryId);
  }
}

export interface WebhookDeliveryInput {
  /** The RAW body bytes. */
  rawBody: Uint8Array;
  /** Request headers with lowercase names (as `node:http` provides them). */
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookHandlerOptions {
  /** Signing secret (`whsec_...`), or current and previous during your rotation. */
  secret: string | readonly string[];
  /**
   * Called once per verified, non-duplicate delivery. Keep it fast (GRUALINK waits 10 seconds): store the event
   * or enqueue it and do the heavy work later. If it throws, the answer is 500 and the delivery is retried.
   */
  onEvent: (event: WebhookEvent) => void | Promise<void>;
  deduplicator?: DeliveryDeduplicator;
  toleranceSeconds?: number;
  /** Clock in seconds, for tests. */
  nowSeconds?: () => number;
}

export interface WebhookHandlerResult {
  /** HTTP status to answer with. */
  status: number;
  /** JSON body to answer with. */
  body: { received: boolean; duplicate?: boolean; error?: string };
  /** Internal detail for your logs; never send it back to the caller. */
  reason: SignatureVerificationReason | 'invalid_payload' | 'delivery_id_mismatch' | 'duplicate' | 'handler_failed';
}

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Framework-independent handling of one delivery: verify the signature over the raw body, parse, deduplicate and
 * dispatch. Mount it on any HTTP server that can give you the raw bytes.
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  const deduplicator = options.deduplicator ?? new InMemoryDeliveryDeduplicator();

  return async function handleWebhookDelivery(input: WebhookDeliveryInput): Promise<WebhookHandlerResult> {
    const verification = verifyWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: single(input.headers[SIGNATURE_HEADER]),
      secret: options.secret,
      ...(options.nowSeconds ? { nowSeconds: options.nowSeconds() } : {}),
      ...(options.toleranceSeconds !== undefined ? { toleranceSeconds: options.toleranceSeconds } : {}),
    });
    if (!verification.valid) {
      return { status: 401, body: { received: false, error: 'invalid_signature' }, reason: verification.reason };
    }

    let event: WebhookEvent;
    try {
      // Only now, with the signature verified, is the body parsed.
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody)) as WebhookEvent;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
        throw new Error('not an event');
      }
      event = parsed;
    } catch {
      return { status: 400, body: { received: false, error: 'invalid_payload' }, reason: 'invalid_payload' };
    }

    // The header is not covered by the signature; the `id` inside the signed body is. They must agree.
    const deliveryId = single(input.headers[DELIVERY_HEADER]);
    if (deliveryId !== event.id) {
      return { status: 400, body: { received: false, error: 'delivery_id_mismatch' }, reason: 'delivery_id_mismatch' };
    }

    if (!(await deduplicator.claim(deliveryId))) {
      return { status: 200, body: { received: true, duplicate: true }, reason: 'duplicate' };
    }
    try {
      await options.onEvent(event);
    } catch {
      await deduplicator.release(deliveryId);
      return { status: 500, body: { received: false, error: 'handler_failed' }, reason: 'handler_failed' };
    }
    return { status: 200, body: { received: true }, reason: 'ok' };
  };
}
