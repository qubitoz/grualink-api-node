import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { inspect } from 'node:util';
import {
  GrualinkApiError, GrualinkAuthenticationError, GrualinkClient, GrualinkConfigError, GrualinkConnectionError,
  GrualinkError, GrualinkIdempotencyConflictError, GrualinkInvalidRequestError, GrualinkNotFoundError,
  GrualinkPermissionError, GrualinkRateLimitError, GrualinkServerError, GrualinkTimeoutError, GrualinkValidationError,
  type GrualinkClientOptions, type RetryInfo, type ServiceRequestInput,
} from '../src/index.js';
import { SERVICE_REQUEST, apiError, startFakeApi, type FakeApi } from './fake-api.js';

// Obviously fake: it only has the prefix the client checks.
const TEST_KEY = 'glk_test_FAKE_KEY_FOR_UNIT_TESTS_ONLY';

const INPUT: ServiceRequestInput = {
  external_ref: 'TEST-CONFIRMAR-0001',
  contact: { name: 'Persona de Ejemplo', phone: '+525500000000' },
  pickup: { address: 'Calle Ficticia 123, Ciudad Ejemplo', lat: 20.6767, lng: -103.3475 },
  destination: { address: 'Taller Ficticio, Avenida Ejemplo 456', lat: 20.7214, lng: -103.3918 },
};

let api: FakeApi;
let sleeps: number[];
let retries: RetryInfo[];

const client = (overrides: Partial<GrualinkClientOptions> = {}) => new GrualinkClient({
  apiKey: TEST_KEY,
  baseUrl: api.baseUrl,
  sleep: async (ms) => { sleeps.push(ms); },
  random: () => 0.5,
  onRetry: (info) => { retries.push(info); },
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<GrualinkError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GrualinkError, `expected a GrualinkError, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the call to fail');
}

before(async () => { api = await startFakeApi(); });
after(async () => { await api.close(); });
beforeEach(() => { api.requests.length = 0; sleeps = []; retries = []; });

// ── Success ────────────────────────────────────────────────────────────────────────────────────────────────────
test('createServiceRequest sends the key, the Idempotency-Key and the JSON body', async () => {
  api.reply({ status: 201, body: SERVICE_REQUEST });
  const result = await client().createServiceRequest(INPUT, { idempotencyKey: 'order-0001' });

  assert.equal(result.serviceRequest.id, SERVICE_REQUEST.id);
  assert.equal(result.serviceRequest.quote.estimated_price?.total, 1002.62);
  assert.equal(result.replayed, false);
  assert.equal(result.idempotencyKey, 'order-0001');

  assert.equal(api.requests.length, 1);
  const sent = api.requests[0]!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/api/v1/service-requests');
  assert.equal(sent.headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(sent.headers['idempotency-key'], 'order-0001');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.body), INPUT);
});

test('createServiceRequest generates an Idempotency-Key when none is given', async () => {
  api.reply({ status: 201, body: SERVICE_REQUEST });
  const result = await client().createServiceRequest(INPUT);
  assert.match(result.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(api.requests[0]!.headers['idempotency-key'], result.idempotencyKey);
});

test('a repeated request is a 200 with Idempotent-Replayed: true and is reported as replayed', async () => {
  api.reply(
    { status: 201, body: SERVICE_REQUEST },
    { status: 200, body: SERVICE_REQUEST, headers: { 'Idempotent-Replayed': 'true' } },
  );
  const c = client();
  const first = await c.createServiceRequest(INPUT, { idempotencyKey: 'order-0002' });
  const second = await c.createServiceRequest(INPUT, { idempotencyKey: 'order-0002' });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.serviceRequest, first.serviceRequest);
  assert.equal(api.requests[0]!.body, api.requests[1]!.body, 'the same bytes are sent both times');
});

test('getServiceRequest and findServiceRequestsByExternalRef', async () => {
  api.reply({ status: 200, body: SERVICE_REQUEST });
  const one = await client().getServiceRequest(SERVICE_REQUEST.id);
  assert.equal(one.status, 'quoted');
  assert.equal(api.requests[0]!.method, 'GET');
  assert.equal(api.requests[0]!.path, `/api/v1/service-requests/${SERVICE_REQUEST.id}`);

  api.reply({ status: 200, body: { object: 'list', data: [SERVICE_REQUEST] } });
  const list = await client().findServiceRequestsByExternalRef('SIN 2026/001 ñ');
  assert.equal(list.length, 1);
  assert.equal(api.requests[1]!.path, '/api/v1/service-requests?external_ref=SIN+2026%2F001+%C3%B1');
});

test('health is sent without the key', async () => {
  api.reply({ status: 200, body: { status: 'ok', version: 'v1' } });
  assert.deepEqual(await client().health(), { status: 'ok', version: 'v1' });
  assert.equal(api.requests[0]!.path, '/api/v1/health');
  assert.equal(api.requests[0]!.headers.authorization, undefined);
});

// ── Every documented error ─────────────────────────────────────────────────────────────────────────────────────
const ERROR_TABLE: [number, string, new (...args: never[]) => GrualinkApiError][] = [
  [400, 'invalid_request', GrualinkInvalidRequestError],
  [400, 'invalid_json', GrualinkInvalidRequestError],
  [400, 'key_in_query', GrualinkInvalidRequestError],
  [400, 'idempotency_key_required', GrualinkInvalidRequestError],
  [400, 'invalid_idempotency_key', GrualinkInvalidRequestError],
  [401, 'unauthorized', GrualinkAuthenticationError],
  [403, 'insufficient_scope', GrualinkPermissionError],
  [403, 'customer_unavailable', GrualinkPermissionError],
  [403, 'live_mode_unavailable', GrualinkPermissionError],
  [403, 'browser_not_allowed', GrualinkPermissionError],
  [404, 'not_found', GrualinkNotFoundError],
  [405, 'method_not_allowed', GrualinkInvalidRequestError],
  [409, 'idempotency_conflict', GrualinkIdempotencyConflictError],
  [413, 'payload_too_large', GrualinkInvalidRequestError],
  [415, 'unsupported_media_type', GrualinkInvalidRequestError],
  [422, 'validation_error', GrualinkValidationError],
  [429, 'too_many_open_requests', GrualinkRateLimitError],
];

for (const [status, code, ErrorClass] of ERROR_TABLE) {
  test(`${status} ${code} becomes ${ErrorClass.name} and is not retried`, async () => {
    api.reply(apiError(status, code, 'Mensaje de ejemplo.'));
    const error = await rejection(client().createServiceRequest(INPUT));
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Mensaje de ejemplo.');
    assert.equal(error.attempts, 1);
    assert.equal(api.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });
}

test('422 exposes the invalid fields in details', async () => {
  const details = [{ field: 'contact.phone', issue: 'invalid_format' }, { field: 'pickup', issue: 'invalid_value' }];
  api.reply(apiError(422, 'validation_error', 'Hay campos inválidos.', details));
  const error = await rejection(client().createServiceRequest(INPUT));
  assert.ok(error instanceof GrualinkValidationError);
  assert.deepEqual(error.details, details);
});

test('an error body that is not JSON becomes unexpected_response without echoing the body', async () => {
  api.reply({ status: 404, body: '<html>proxy page</html>' });
  const error = await rejection(client().getServiceRequest('abc'));
  assert.ok(error instanceof GrualinkNotFoundError);
  assert.equal(error.code, 'unexpected_response');
  assert.ok(!error.message.includes('proxy page'));
});

test('a redirect is not followed and the key does not travel to the new address', async () => {
  api.reply({ status: 302, headers: { Location: `${api.baseUrl}/elsewhere` } });
  const error = await rejection(client().getServiceRequest(SERVICE_REQUEST.id));
  assert.ok(error instanceof GrualinkApiError);
  assert.equal(error.status, 302);
  assert.equal(api.requests.length, 1);
});

// ── Retries ────────────────────────────────────────────────────────────────────────────────────────────────────
test('429 rate_limited waits at least Retry-After and retries with the same key and body', async () => {
  api.reply(
    apiError(429, 'rate_limited', 'Demasiadas peticiones.', undefined, { 'Retry-After': '7' }),
    { status: 201, body: SERVICE_REQUEST },
  );
  const result = await client().createServiceRequest(INPUT, { idempotencyKey: 'order-0003' });
  assert.equal(result.serviceRequest.id, SERVICE_REQUEST.id);
  assert.equal(api.requests.length, 2);
  // 7 s from the header plus half (random = 0.5) of the first backoff step (500 ms).
  assert.deepEqual(sleeps, [7250]);
  assert.equal(retries[0]!.attempt, 1);
  assert.ok(retries[0]!.error instanceof GrualinkRateLimitError);
  assert.equal(api.requests[0]!.headers['idempotency-key'], 'order-0003');
  assert.equal(api.requests[1]!.headers['idempotency-key'], 'order-0003');
  assert.equal(api.requests[0]!.body, api.requests[1]!.body);
});

test('5xx is retried with exponential backoff and jitter, then succeeds', async () => {
  api.reply(
    apiError(500, 'internal_error'), { status: 502, body: '<html>bad gateway</html>' }, apiError(503, 'internal_error'),
    { status: 201, body: SERVICE_REQUEST },
  );
  const result = await client().createServiceRequest(INPUT);
  assert.equal(result.serviceRequest.id, SERVICE_REQUEST.id);
  assert.equal(api.requests.length, 4);
  // random = 0.5 over ceilings of 500, 1000 and 2000 ms.
  assert.deepEqual(sleeps, [250, 500, 1000]);
  assert.equal(new Set(api.requests.map((r) => r.headers['idempotency-key'])).size, 1);
});

test('the backoff is capped and the jitter comes from the injected random source', async () => {
  api.reply(apiError(500, 'internal_error'));
  const error = await rejection(client({ maxRetries: 6, random: () => 1 }).getServiceRequest(SERVICE_REQUEST.id));
  assert.ok(error instanceof GrualinkServerError);
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000, 8000, 8000]);
});

test('it gives up after maxRetries and reports how many attempts were made', async () => {
  api.reply(apiError(500, 'internal_error', 'Error interno.'));
  const error = await rejection(client({ maxRetries: 2 }).createServiceRequest(INPUT));
  assert.ok(error instanceof GrualinkServerError);
  assert.equal(error.code, 'internal_error');
  assert.equal(error.attempts, 3);
  assert.equal(api.requests.length, 3);
  assert.equal(sleeps.length, 2);
});

test('maxRetries: 0 disables retries', async () => {
  api.reply(apiError(500, 'internal_error'));
  const error = await rejection(client({ maxRetries: 0 }).getServiceRequest(SERVICE_REQUEST.id));
  assert.equal(error.attempts, 1);
  assert.equal(api.requests.length, 1);
});

test('a network error is retried and surfaces as GrualinkConnectionError', async () => {
  api.reply({ status: 0, destroy: true }, { status: 200, body: SERVICE_REQUEST });
  const found = await client().getServiceRequest(SERVICE_REQUEST.id);
  assert.equal(found.id, SERVICE_REQUEST.id);
  assert.ok(retries[0]!.error instanceof GrualinkConnectionError);

  api.reply({ status: 0, destroy: true });
  const error = await rejection(client({ maxRetries: 1 }).getServiceRequest(SERVICE_REQUEST.id));
  assert.ok(error instanceof GrualinkConnectionError);
  assert.equal(error.attempts, 2);
});

test('a slow answer hits the timeout, is retried and surfaces as GrualinkTimeoutError', async () => {
  api.reply({ status: 200, body: SERVICE_REQUEST, delayMs: 400 });
  const error = await rejection(client({ timeoutMs: 50, maxRetries: 1 }).getServiceRequest(SERVICE_REQUEST.id));
  assert.ok(error instanceof GrualinkTimeoutError);
  assert.equal(error.attempts, 2);
  assert.equal(api.requests.length, 2);
});

// ── Local validation: nothing is sent ──────────────────────────────────────────────────────────────────────────
test('invalid configuration and arguments fail before any request', async () => {
  assert.throws(() => new GrualinkClient({ apiKey: '' }), GrualinkConfigError);
  assert.throws(() => new GrualinkClient({ apiKey: 'not-a-key' }), GrualinkConfigError);
  assert.throws(() => new GrualinkClient({ apiKey: TEST_KEY, baseUrl: 'http://example.com/api/v1' }), GrualinkConfigError);
  assert.throws(() => new GrualinkClient({ apiKey: TEST_KEY, baseUrl: `https://example.com/api/v1?key=${TEST_KEY}` }), GrualinkConfigError);
  assert.throws(() => new GrualinkClient({ apiKey: TEST_KEY, timeoutMs: 0 }), GrualinkConfigError);
  assert.throws(() => new GrualinkClient({ apiKey: TEST_KEY, maxRetries: -1 }), GrualinkConfigError);

  for (const idempotencyKey of ['', 'with space', 'ñ', 'x'.repeat(256)]) {
    assert.ok(await rejection(client().createServiceRequest(INPUT, { idempotencyKey })) instanceof GrualinkConfigError);
  }
  const tooLarge = { ...INPUT, notes: 'x'.repeat(17 * 1024) };
  assert.ok(await rejection(client().createServiceRequest(tooLarge)) instanceof GrualinkConfigError);
  assert.ok(await rejection(client().getServiceRequest(' ')) instanceof GrualinkConfigError);
  assert.ok(await rejection(client().findServiceRequestsByExternalRef('')) instanceof GrualinkConfigError);
  assert.equal(api.requests.length, 0);
});

test('a bad key is never echoed by the configuration error', () => {
  const almost = 'glk_prod_FAKE_BUT_SHOULD_NOT_BE_ECHOED';
  assert.throws(() => new GrualinkClient({ apiKey: almost }), (error: Error) => !inspect(error).includes(almost));
});

// ── The key never leaks ────────────────────────────────────────────────────────────────────────────────────────
test('the API key never appears in errors, logs or the client itself', async () => {
  const written: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): boolean => { written.push(String(chunk)); return true; };
  const errors: GrualinkError[] = [];
  let c: GrualinkClient;

  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    c = client({ maxRetries: 1, onRetry: (info) => { console.error('retrying', info); } });
    console.log(c);
    console.log('%o', c);

    // A server that (wrongly) echoes the Authorization header back in every field of the error.
    const echo = (status: number) => (request: { headers: { authorization?: string } }) => apiError(
      status, `code ${request.headers.authorization}`, `message ${request.headers.authorization}`,
      [{ field: `field ${request.headers.authorization}`, issue: `issue ${request.headers.authorization}` }],
    );
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
      api.reply(echo(status));
      errors.push(await rejection(c.createServiceRequest(INPUT)));
    }
    api.reply({ status: 0, destroy: true });
    errors.push(await rejection(c.getServiceRequest(SERVICE_REQUEST.id)));
    api.reply({ status: 200, body: SERVICE_REQUEST, delayMs: 300 });
    errors.push(await rejection(client({ timeoutMs: 30, maxRetries: 0 }).getServiceRequest(SERVICE_REQUEST.id)));
    // A transport that throws an error mentioning the key.
    const leakyFetch = (async () => { throw new TypeError(`connect failed for Bearer ${TEST_KEY}`); }) as unknown as typeof fetch;
    errors.push(await rejection(client({ fetch: leakyFetch, maxRetries: 0 }).getServiceRequest(SERVICE_REQUEST.id)));

    for (const error of errors) {
      console.error(error);
      console.log(JSON.stringify(error), String(error), error.stack);
    }
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  assert.equal(errors.length, 11);
  assert.ok(api.requests.some((r) => r.headers.authorization === `Bearer ${TEST_KEY}`), 'the key was really sent');
  assert.ok(written.length > 20, 'the output was really captured');
  const everything = [
    ...written,
    inspect(c, { depth: 10, showHidden: true }),
    JSON.stringify(c),
    ...errors.flatMap((e) => [inspect(e, { depth: 10, showHidden: true }), JSON.stringify(e), e.message, e.stack ?? '',
      JSON.stringify(Object.getOwnPropertyDescriptors(e))]),
  ].join('\n');
  assert.ok(!everything.includes(TEST_KEY), 'the API key leaked');
  assert.ok(!everything.includes(TEST_KEY.slice(9)), 'part of the API key leaked');
  assert.ok(everything.includes('[REDACTED]'), 'echoed keys are replaced by a marker');
});
