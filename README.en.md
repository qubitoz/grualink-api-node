# GRUALINK API: Node.js / TypeScript example

[Español](README.md)

A clone-and-run example that integrates your system (insurer, roadside assistance, integrator) with the
GRUALINK API: **request a tow truck**, **check its status** and **receive signed webhooks**.

Public API guide: <https://grualink.mx/api>

What is inside:

- A **minimal client** (`src/client.ts`): creates requests with `Idempotency-Key`, reads the status,
  typed errors, retries with exponential backoff and a timeout. No runtime dependencies.
- A **webhook receiver** (`src/webhooks.ts`, `src/webhook-server.ts`): verifies the signature over the
  raw body, checks the time window, supports secret rotation and drops duplicates.
- Two **runnable examples** (`examples/`).
- The **contract kit** (`contract/`): the API contract in Spanish and English and the signature test
  cases shared by the examples in every language.

It is not an SDK: it is code meant to be read and copied into your project.

## Requirements

- Node.js 20 or later.
- A **test key** (`glk_test_…`). The towing company you work with gives it to you.
- For webhooks: the **signing secret** (`whsec_…`) the same company gives you when it registers the
  address of your system.

## Installation

```bash
git clone <this repository's address>
cd grualink-api-node
npm install
```

## Environment variables

Names only; the values live on your machine and never in the repository. There is a template in
`.env.example`.

| Variable | Purpose |
|---|---|
| `GRUALINK_API_KEY` | Your **test** key (`glk_test_…`) |
| `GRUALINK_WEBHOOK_SECRET` | Webhook signing secret (`whsec_…`), whole, with its prefix |
| `GRUALINK_WEBHOOK_SECRET_PREVIOUS` | Optional: the previous secret while a rotation is in progress |
| `GRUALINK_API_BASE_URL` | Optional: another base URL (default `https://grualink.mx/api/v1`) |
| `PORT` | Optional: port of the example receiver (default 8787) |

## Running the examples

### Request a tow truck

```bash
export GRUALINK_API_KEY=...   # your test key
npm run example:request
```

With fictitious data, the example sends a request, prints the estimated price, sends it again with the
same `Idempotency-Key` to show nothing is duplicated, and reads its status. It only runs with test keys.

With a test key, the start of `external_ref` decides the final status: `TEST-CONFIRMAR` (confirmed),
`TEST-EN-CURSO` (in progress), `TEST-TERMINAR` (completed), `TEST-RECHAZAR` (rejected), `TEST-CANCELAR`
(cancelled).

### Receive webhooks

```bash
export GRUALINK_WEBHOOK_SECRET=...   # your signing secret
npm run example:webhook
```

It listens on `http://localhost:8787/webhooks/grualink`. GRUALINK only delivers to public `https`
addresses on port 443: publish the receiver behind your domain (or an `https` tunnel while testing), give
that address to the company and ask for a test event.

## Using it in your code

```ts
import { GrualinkClient, GrualinkValidationError } from './src/index.js';

const client = new GrualinkClient({ apiKey: process.env.GRUALINK_API_KEY! });

try {
  const { serviceRequest, replayed } = await client.createServiceRequest(
    {
      external_ref: 'TEST-CONFIRMAR-0001',
      contact: { name: 'Persona de Ejemplo', phone: '+525500000000' },
      pickup: { address: 'Av. Juárez 100, Centro, Guadalajara, Jal.', lat: 20.6767, lng: -103.3475 },
      destination: { address: 'Av. Patria 500, Zapopan, Jal.', lat: 20.7214, lng: -103.3918 },
    },
    { idempotencyKey: myRecord.idempotencyKey }, // store it before calling
  );
  console.log(serviceRequest.id, serviceRequest.status, serviceRequest.quote.estimated_price?.total, replayed);
} catch (error) {
  if (error instanceof GrualinkValidationError) console.error(error.details);
  else throw error;
}
```

### Idempotency and retries

- Every request carries an `Idempotency-Key` of your own. If you repeat the call with the same key and
  the same body within 24 hours, the API answers **`200`** with `Idempotent-Replayed: true` and creates
  nothing (`replayed` is `true`). The same key with another body answers `409`.
- The client retries only what makes sense: network errors, timeouts, `5xx` and `429 rate_limited`
  (waiting what `Retry-After` says). It uses exponential backoff with jitter and always resends the same
  key and the same bytes.
- The key never appears in errors or logs.

### Verifying a webhook

```ts
import { verifyWebhookSignature } from './src/index.js';

const { valid, reason } = verifyWebhookSignature({
  rawBody,                                             // the bytes exactly as received
  signatureHeader: request.headers['x-grualink-signature'],
  secret: process.env.GRUALINK_WEBHOOK_SECRET,         // whole, with whsec_
});
```

What matters:

1. Verify the **raw body**, before parsing it as JSON. If you parse and serialize it again, the
   signature no longer matches.
2. Use the **whole** secret, with its `whsec_` prefix.
3. Reject timestamps more than 5 minutes away from your clock.
4. After a secret rotation two `v1` signatures arrive for 24 hours: accept if either matches.
5. Deliveries can repeat: keep the `id` of the ones you processed and answer `2xx` without reprocessing.
6. Answer `2xx` within 10 seconds and do the heavy work afterwards.

### Mounting it on Express or Fastify

The delicate part is getting the **raw body**. `createWebhookHandler` depends on no framework: it takes
the bytes and the headers and returns the status and body to answer with.

Express: use `express.raw` on that route (not `express.json`, which hands you the parsed body).

```ts
const handle = createWebhookHandler({ secret: process.env.GRUALINK_WEBHOOK_SECRET!, onEvent });

app.post('/webhooks/grualink', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const result = await handle({ rawBody: req.body, headers: req.headers });
  res.status(result.status).json(result.body);
});
```

Fastify: register a content parser that yields a `Buffer` for that route.

```ts
app.register(async (scope) => {
  scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
  scope.post('/webhooks/grualink', async (request, reply) => {
    const result = await handle({ rawBody: request.body as Buffer, headers: request.headers });
    return reply.code(result.status).send(result.body);
  });
});
```

With several instances, replace `InMemoryDeliveryDeduplicator` with one backed by your database (a
unique key on the event `id` is enough).

## Errors

Every API error has the shape `{ "error": { "code", "message", "details"? } }`. `code` is stable; branch
on it, not on `message` (which is written in Spanish and may change).

| HTTP | `code` | What happened | Class | Retried? |
|---|---|---|---|---|
| 400 | `invalid_request` | The request is not valid | `GrualinkInvalidRequestError` | no |
| 400 | `invalid_json` | The body is not valid JSON | `GrualinkInvalidRequestError` | no |
| 400 | `key_in_query` | The key was sent in the URL; have it revoked | `GrualinkInvalidRequestError` | no |
| 400 | `idempotency_key_required` | `Idempotency-Key` is missing | `GrualinkInvalidRequestError` | no |
| 400 | `invalid_idempotency_key` | Invalid `Idempotency-Key` (1 to 255 visible ASCII characters) | `GrualinkInvalidRequestError` | no |
| 401 | `unauthorized` | Key missing, invalid, expired or revoked | `GrualinkAuthenticationError` | no |
| 403 | `insufficient_scope` | The key is not allowed to do this | `GrualinkPermissionError` | no |
| 403 | `customer_unavailable` | Your customer account with the company is unavailable | `GrualinkPermissionError` | no |
| 403 | `live_mode_unavailable` | Live requests are not enabled yet | `GrualinkPermissionError` | no |
| 403 | `browser_not_allowed` | Live key used from a browser | `GrualinkPermissionError` | no |
| 404 | `not_found` | It does not exist or is not yours | `GrualinkNotFoundError` | no |
| 405 | `method_not_allowed` | Method not allowed for that path | `GrualinkInvalidRequestError` | no |
| 409 | `idempotency_conflict` | That `Idempotency-Key` was already used with another body | `GrualinkIdempotencyConflictError` | no |
| 413 | `payload_too_large` | The body exceeds 16 KB | `GrualinkInvalidRequestError` | no |
| 415 | `unsupported_media_type` | The body must be `application/json` | `GrualinkInvalidRequestError` | no |
| 422 | `validation_error` | Invalid fields; `details` says which | `GrualinkValidationError` | no |
| 429 | `rate_limited` | Too many requests; wait `Retry-After` | `GrualinkRateLimitError` | yes |
| 429 | `too_many_open_requests` | Too many unresolved requests with the company | `GrualinkRateLimitError` | no |
| 500 | `internal_error` | Internal error | `GrualinkServerError` | yes |

Also: `GrualinkConnectionError` (no response, retried), `GrualinkTimeoutError` (timed out, retried) and
`GrualinkConfigError` (invalid configuration or argument; nothing was sent).

The full contract, with fields, limits and the order of checks, is in [`contract/API.md`](contract/API.md).

## Tests

```bash
npm test             # builds and runs node:test
npm run typecheck    # strict types, no unused code
npm run vectors:check
```

The tests never call the real API: they use a local fake server. They cover every case in
`contract/signature-vectors.json`, each error code, retries, idempotency, and that the key never shows up
in errors or logs.

## Layout

```
contract/     API contract (es/en), signature test cases and checklist
src/          client, errors, types, webhook verification and receiver
examples/     request-tow.ts and webhook-server.ts
test/         tests (node:test) and fake server
scripts/      generator of the signature test cases
```

## License

[MIT](LICENSE)
