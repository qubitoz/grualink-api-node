import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import {
  InMemoryDeliveryDeduplicator, buildSignatureHeader, createWebhookListener,
  type WebhookEvent, type WebhookHandlerResult,
} from '../src/index.js';

const SECRET = 'whsec_TEST_ONLY_FAKE_SECRET_0001';
const PREVIOUS = 'whsec_TEST_ONLY_FAKE_SECRET_0000';
const NOW = 1795000000;

let server: Server;
let url: string;
let received: WebhookEvent[];
let results: WebhookHandlerResult[];
let failNext = false;
let clock = NOW;

before(async () => {
  server = createServer(createWebhookListener({
    path: '/webhooks/grualink',
    secret: [SECRET],
    nowSeconds: () => clock,
    onEvent: (event) => {
      if (failNext) { failNext = false; throw new Error('database is down'); }
      received.push(event);
    },
    onResult: (result) => { results.push(result); },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/grualink`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { received = []; results = []; failNext = false; clock = NOW; });

let counter = 0;
function delivery(overrides: { type?: string; id?: string } = {}) {
  const id = overrides.id ?? `bbbbbbbb-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const type = overrides.type ?? 'service_request.confirmed';
  // Deliberately not what JSON.stringify would produce, and with non-ASCII text.
  const body = `{"id": "${id}", "data": {"previous_status": "quoted", "service_request": {"id": "11111111-2222-4333-8444-555555555555", "status": "confirmed", "external_ref": "TEST-CONFIRMAR-ÑU"}}, "mode": "test", "type": "${type}", "object": "event", "created_at": "2026-11-18T10:05:01.000Z"}`;
  return { id, type, body };
}

async function post(body: string | Uint8Array, headers: Record<string, string>, method = 'POST', target = url) {
  const response = await fetch(target, { method, headers, ...(method === 'POST' ? { body } : {}) });
  return { status: response.status, json: await response.json() as Record<string, unknown>, headers: response.headers };
}

const signedHeaders = (d: { id: string; type: string; body: string }, secrets = [SECRET], t = NOW) => ({
  'Content-Type': 'application/json; charset=utf-8',
  'X-GruaLink-Event': d.type,
  'X-GruaLink-Delivery': d.id,
  'X-GruaLink-Timestamp': String(t),
  'X-GruaLink-Mode': 'test',
  'X-GruaLink-Signature': buildSignatureHeader(secrets, t, d.body),
});

test('a signed delivery is accepted and handed to onEvent', async () => {
  const d = delivery();
  const response = await post(d.body, signedHeaders(d));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { received: true });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.id, d.id);
  assert.equal(received[0]!.data.service_request?.external_ref, 'TEST-CONFIRMAR-ÑU');
  assert.equal(results[0]!.reason, 'ok');
});

test('a retry of the same delivery answers 200 but is processed once', async () => {
  const d = delivery();
  assert.equal((await post(d.body, signedHeaders(d))).status, 200);
  const again = await post(d.body, signedHeaders(d, [SECRET], NOW + 60));
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { received: true, duplicate: true });
  assert.equal(received.length, 1);
});

test('when onEvent fails the answer is 500 and the retry is processed', async () => {
  const d = delivery();
  failNext = true;
  const first = await post(d.body, signedHeaders(d));
  assert.equal(first.status, 500);
  assert.equal(received.length, 0);
  const retry = await post(d.body, signedHeaders(d));
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, { received: true });
  assert.equal(received.length, 1);
});

test('during a rotation a delivery signed with both secrets is accepted', async () => {
  const d = delivery();
  assert.equal((await post(d.body, signedHeaders(d, ['whsec_TEST_ONLY_FAKE_SECRET_NEXT', SECRET]))).status, 200);
  const old = delivery();
  assert.equal((await post(old.body, signedHeaders(old, [PREVIOUS]))).status, 401);
});

test('a tampered body, a missing signature and a stale timestamp are rejected with 401', async () => {
  const d = delivery();
  const tampered = await post(d.body.replace('confirmed', 'completed'), signedHeaders(d));
  assert.equal(tampered.status, 401);
  assert.deepEqual(tampered.json, { received: false, error: 'invalid_signature' });

  const { 'X-GruaLink-Signature': _signature, ...unsigned } = signedHeaders(d);
  assert.equal((await post(d.body, unsigned)).status, 401);

  clock = NOW + 301;
  assert.equal((await post(d.body, signedHeaders(d))).status, 401);

  assert.deepEqual(results.map((r) => r.reason), ['signature_mismatch', 'missing_header', 'timestamp_out_of_tolerance']);
  assert.equal(received.length, 0);
});

test('the body parsed and serialized again does not verify', async () => {
  const d = delivery();
  const reserialized = JSON.stringify(JSON.parse(d.body));
  assert.notEqual(reserialized, d.body);
  assert.equal((await post(reserialized, signedHeaders(d))).status, 401);
});

test('a delivery header that disagrees with the signed id is rejected', async () => {
  const d = delivery();
  const headers = { ...signedHeaders(d), 'X-GruaLink-Delivery': 'cccccccc-0000-4000-8000-000000000000' };
  const response = await post(d.body, headers);
  assert.equal(response.status, 400);
  assert.equal(results[0]!.reason, 'delivery_id_mismatch');
  assert.equal(received.length, 0);
});

test('a signed body that is not an event is a 400', async () => {
  const body = '[1, 2, 3]';
  const response = await post(body, signedHeaders({ id: 'x', type: 'webhook.test', body }));
  assert.equal(response.status, 400);
  assert.equal(results[0]!.reason, 'invalid_payload');
});

test('other methods, other paths and oversized bodies are refused', async () => {
  const get = await post('', {}, 'GET');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await post('{}', {}, 'POST', url.replace('/webhooks/grualink', '/other'))).status, 404);
  const big = await post(Buffer.alloc(64 * 1024 + 1, 0x20), { 'Content-Type': 'application/json' });
  assert.equal(big.status, 413);
  assert.equal(received.length, 0);
});

test('InMemoryDeliveryDeduplicator: claim, release, expiry and size cap', () => {
  let now = 0;
  const dedup = new InMemoryDeliveryDeduplicator({ ttlMs: 1000, maxEntries: 3, now: () => now });
  assert.equal(dedup.claim('a'), true);
  assert.equal(dedup.claim('a'), false);
  dedup.release('a');
  assert.equal(dedup.claim('a'), true);

  now = 1001;
  assert.equal(dedup.claim('a'), true, 'an expired id can be claimed again');

  assert.equal(dedup.claim('b'), true);
  assert.equal(dedup.claim('c'), true);
  assert.equal(dedup.claim('d'), true, 'the oldest entry is evicted when the cap is reached');
  assert.equal(dedup.claim('d'), false);
  assert.equal(dedup.claim('a'), true, 'the evicted id is no longer remembered');
});
