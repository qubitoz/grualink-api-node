import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSignatureHeader, verifyWebhookSignature } from '../src/index.js';

interface VectorCase {
  name: string;
  description: string;
  secret: string;
  headers: Record<string, string>;
  body: string | null;
  body_base64: string;
  now: number;
  expected: { valid: boolean; reason: string };
}
interface VectorFile { version: number; tolerance_seconds: number; reasons: string[]; cases: VectorCase[] }

// Compiled tests live in dist/test; the contract kit stays at the repository root.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const vectors = JSON.parse(readFileSync(`${ROOT}contract/signature-vectors.json`, 'utf8')) as VectorFile;

test('the vector file has the expected shape', () => {
  assert.equal(vectors.version, 1);
  assert.equal(vectors.tolerance_seconds, 300);
  assert.ok(vectors.cases.length >= 30);
  assert.equal(new Set(vectors.cases.map((c) => c.name)).size, vectors.cases.length, 'case names are unique');
  assert.ok(vectors.cases.some((c) => c.expected.valid) && vectors.cases.some((c) => !c.expected.valid));
  for (const reason of vectors.reasons) {
    assert.ok(vectors.cases.some((c) => c.expected.reason === reason), `no case covers the reason ${reason}`);
  }
});

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    const rawBody = Buffer.from(c.body_base64, 'base64');
    if (c.body !== null) assert.deepEqual(Buffer.from(c.body, 'utf8'), rawBody, 'body and body_base64 agree');
    const result = verifyWebhookSignature({
      rawBody,
      signatureHeader: c.headers['x-grualink-signature'],
      secret: c.secret,
      nowSeconds: c.now,
      toleranceSeconds: vectors.tolerance_seconds,
    });
    assert.deepEqual(result, c.expected, c.description);
  });
}

test('a string body is verified as its UTF-8 bytes', () => {
  const c = vectors.cases.find((x) => x.name === 'valid_non_ascii_body');
  assert.ok(c && c.body !== null);
  const result = verifyWebhookSignature({
    rawBody: c.body, signatureHeader: c.headers['x-grualink-signature'], secret: c.secret, nowSeconds: c.now,
  });
  assert.deepEqual(result, { valid: true, reason: 'ok' });
});

test('the receiver may hold two secrets during its own rotation', () => {
  const c = vectors.cases.find((x) => x.name === 'valid_basic');
  assert.ok(c);
  const rawBody = Buffer.from(c.body_base64, 'base64');
  const header = c.headers['x-grualink-signature'];
  const ok = verifyWebhookSignature({ rawBody, signatureHeader: header, secret: ['whsec_TEST_ONLY_FAKE_NEXT', c.secret], nowSeconds: c.now });
  assert.equal(ok.valid, true);
  const none = verifyWebhookSignature({ rawBody, signatureHeader: header, secret: [], nowSeconds: c.now });
  assert.deepEqual(none, { valid: false, reason: 'missing_secret' });
});

test('verification never throws on hostile input', () => {
  const hostile: unknown[] = [undefined, null, 42, {}, [], 'x'.repeat(100_000), 't=1,v1=' + 'a'.repeat(64) + ','.repeat(5000)];
  for (const header of hostile) {
    for (const secret of [undefined, null, 42, 'whsec_TEST_ONLY_FAKE_SECRET_0001']) {
      const result = verifyWebhookSignature({
        rawBody: Buffer.from('{}'), signatureHeader: header as string, secret: secret as string, nowSeconds: 1,
      });
      assert.equal(result.valid, false);
    }
  }
});

test('buildSignatureHeader produces what the verifier accepts (two implementations agree)', () => {
  const body = Buffer.from('{"id": "x"}');
  const header = buildSignatureHeader(['whsec_TEST_ONLY_FAKE_A', 'whsec_TEST_ONLY_FAKE_B'], 1795000000, body);
  assert.match(header, /^t=1795000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  for (const secret of ['whsec_TEST_ONLY_FAKE_A', 'whsec_TEST_ONLY_FAKE_B']) {
    assert.equal(verifyWebhookSignature({ rawBody: body, signatureHeader: header, secret, nowSeconds: 1795000001 }).valid, true);
  }
});

test('the committed vectors match what the generator produces', () => {
  execFileSync(process.execPath, [`${ROOT}scripts/generate-signature-vectors.mjs`, '--check'], { stdio: 'pipe' });
});
