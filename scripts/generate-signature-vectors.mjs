// Generates contract/signature-vectors.json: the signature test cases shared by every language.
//
// The signer below reproduces the algorithm GRUALINK uses to sign a delivery, written with WebCrypto on purpose:
// the verifier in src/webhooks.ts uses node:crypto, so the test suite crosses two independent implementations.
//
//   node scripts/generate-signature-vectors.mjs           rewrites the file
//   node scripts/generate-signature-vectors.mjs --check   fails if the committed file differs
//
// Every secret and every value here is fictitious.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT = fileURLToPath(new URL('../contract/signature-vectors.json', import.meta.url));

const hex = (buffer) => [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 (hex) of "<t>.<body>" keyed with the secret as is, `whsec_` prefix included. */
async function sign(secret, t, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
}

/** "t=<seconds>,v1=<signature>[,v1=<signature with the previous secret>]" */
async function signatureHeader(secrets, t, body) {
  const signatures = await Promise.all(secrets.map((s) => sign(s, t, body)));
  return [`t=${t}`, ...signatures.map((s) => `v1=${s}`)].join(',');
}

/**
 * Serializes with a spacing and key order that differ from JSON.stringify. Nothing guarantees how a delivery body is
 * formatted, so a receiver must verify the bytes it received, never an object it parsed and serialized again.
 */
function wireJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(wireJson).join(', ')}]`;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${wireJson(value[k])}`).join(', ')}}`;
}

const SECRET = 'whsec_TEST_ONLY_FAKE_SECRET_0001';
const SECRET_PREVIOUS = 'whsec_TEST_ONLY_FAKE_SECRET_0000';
const SECRET_OTHER = 'whsec_TEST_ONLY_FAKE_SECRET_9999';
const T = 1795000000;
const TOLERANCE = 300;

const serviceRequest = (overrides = {}) => ({
  id: '11111111-2222-4333-8444-555555555555',
  object: 'service_request',
  status: 'confirmed',
  mode: 'test',
  external_ref: 'TEST-CONFIRMAR-0001',
  created_at: '2026-11-18T10:00:00.000Z',
  resolved_at: '2026-11-18T10:05:00.000Z',
  rejection_reason: null,
  service: { folio: 'PRUEBA-000001', status: 'confirmed' },
  quote: {
    estimated_price: {
      currency: 'MXN', subtotal: 864.33,
      taxes: [{ name: 'IVA', type: 'tax', rate: 16, amount: 138.29 }],
      tax_total: 138.29, retention_total: 0, total: 1002.62,
    },
    includes_extras: false, approximate_distance: true, unpriced_reason: null,
    note: 'Precio estimado. No incluye extras como casetas o maniobras; la empresa confirma el precio final.',
  },
  assignment: null,
  timeline: null,
  ...overrides,
});

const event = (id, type, data) => ({ id, object: 'event', type, mode: 'test', created_at: '2026-11-18T10:05:01.000Z', data });

const BODY_CONFIRMED = wireJson(event('aaaaaaaa-0000-4000-8000-000000000001', 'service_request.confirmed', {
  previous_status: 'quoted', service_request: serviceRequest({ quote: { ...serviceRequest().quote, note: 'Estimated price.' } }),
}));
const BODY_NON_ASCII = wireJson(event('aaaaaaaa-0000-4000-8000-000000000002', 'service_request.rejected', {
  previous_status: 'quoted',
  service_request: serviceRequest({
    status: 'rejected', external_ref: 'TEST-RECHAZAR-ÑANDÚ-0002', service: null,
    rejection_reason: 'Sin grúa disponible en la zona — intente más tarde 🚚',
  }),
}));
const BODY_TEST_EVENT = wireJson(event('aaaaaaaa-0000-4000-8000-000000000003', 'webhook.test', {
  message: 'Aviso de prueba. Si lo recibes y la firma es válida, tu receptor está listo.',
}));

const utf8 = (text) => Buffer.from(text, 'utf8');

async function build() {
  const cases = [];

  /**
   * @param {object} c
   * @param {string} c.name
   * @param {string} c.description
   * @param {string} c.secret            secret configured in the RECEIVER
   * @param {string | null} c.header     X-GruaLink-Signature as received (null = header absent)
   * @param {Buffer} c.body              raw body as received
   * @param {number} c.now               receiver clock, seconds since 1970
   * @param {boolean} c.valid
   * @param {string} c.reason
   * @param {string} [c.type]
   */
  const add = (c) => {
    const text = c.body.toString('utf8');
    const roundTrips = Buffer.from(text, 'utf8').equals(c.body);
    let id = '00000000-0000-4000-8000-000000000000';
    let type = 'service_request.confirmed';
    try { ({ id, type } = JSON.parse(text)); } catch { /* altered bodies keep the defaults */ }
    const t = /(?:^|,)\s*t=([0-9]+)/.exec(c.header ?? '')?.[1] ?? String(T);
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'GRUALINK-Avisos/1.0',
      'x-grualink-event': type,
      'x-grualink-delivery': id,
      'x-grualink-timestamp': t,
      'x-grualink-mode': 'test',
    };
    if (c.header !== null) headers['x-grualink-signature'] = c.header;
    cases.push({
      name: c.name,
      description: c.description,
      secret: c.secret,
      headers,
      body: roundTrips ? text : null,
      body_base64: c.body.toString('base64'),
      now: c.now,
      expected: { valid: c.valid, reason: c.reason },
    });
  };

  const good = await signatureHeader([SECRET], T, BODY_CONFIRMED);
  const goodSignature = good.split('v1=')[1];

  // ── Valid ──────────────────────────────────────────────────────────────────────────────────────────────────
  add({
    name: 'valid_basic', description: 'A delivery signed with the current secret, received two seconds later.',
    secret: SECRET, header: good, body: utf8(BODY_CONFIRMED), now: T + 2, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_non_ascii_body',
    description: 'The body has accented letters, a dash and an emoji. The signature covers its UTF-8 bytes.',
    secret: SECRET, header: await signatureHeader([SECRET], T, BODY_NON_ASCII), body: utf8(BODY_NON_ASCII), now: T + 2,
    valid: true, reason: 'ok',
  });
  add({
    name: 'valid_test_event', description: 'The webhook.test event the company can send on request.',
    secret: SECRET, header: await signatureHeader([SECRET], T, BODY_TEST_EVENT), body: utf8(BODY_TEST_EVENT), now: T + 1,
    valid: true, reason: 'ok',
  });
  add({
    name: 'valid_tolerance_edge_past', description: 'Exactly 300 seconds old: still inside the tolerance (the limit is inclusive).',
    secret: SECRET, header: good, body: utf8(BODY_CONFIRMED), now: T + TOLERANCE, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_tolerance_edge_future',
    description: 'Timestamp exactly 300 seconds ahead of the receiver clock (clock skew): still accepted.',
    secret: SECRET, header: good, body: utf8(BODY_CONFIRMED), now: T - TOLERANCE, valid: true, reason: 'ok',
  });
  const rotated = await signatureHeader([SECRET, SECRET_PREVIOUS], T, BODY_CONFIRMED);
  add({
    name: 'valid_rotation_receiver_has_new_secret',
    description: 'During a rotation the header carries two v1 (new secret first, previous second). The receiver already has the new secret.',
    secret: SECRET, header: rotated, body: utf8(BODY_CONFIRMED), now: T + 2, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_rotation_receiver_has_previous_secret',
    description: 'Same header with two v1; the receiver still has the previous secret. Any matching v1 is enough.',
    secret: SECRET_PREVIOUS, header: rotated, body: utf8(BODY_CONFIRMED), now: T + 2, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_header_with_spaces', description: 'Spaces around the comma-separated parts are ignored.',
    secret: SECRET, header: good.replace(',', ' , '), body: utf8(BODY_CONFIRMED), now: T + 2, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_unknown_scheme_ignored',
    description: 'Parts with an unknown name (a future scheme) are ignored; the v1 still decides.',
    secret: SECRET, header: `${good},v2=${'0'.repeat(64)}`, body: utf8(BODY_CONFIRMED), now: T + 2, valid: true, reason: 'ok',
  });
  add({
    name: 'valid_malformed_v1_ignored_when_another_matches',
    description: 'A v1 that is not 64 lowercase hex characters is ignored; a second, well-formed v1 matches.',
    secret: SECRET, header: `t=${T},v1=not-a-signature,v1=${goodSignature}`, body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: true, reason: 'ok',
  });

  // ── Invalid: the body or the secret is not what was signed ─────────────────────────────────────────────────
  const oneByte = utf8(BODY_CONFIRMED);
  oneByte[oneByte.indexOf('confirmed')] = 'k'.charCodeAt(0);
  add({
    name: 'invalid_body_one_byte_changed', description: 'One byte of the body was altered in transit.',
    secret: SECRET, header: good, body: oneByte, now: T + 2, valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_body_reserialized',
    description: 'Same JSON value, but parsed and serialized again (compact, other key order). The bytes differ, so the signature does not match: always verify the raw body.',
    secret: SECRET, header: good, body: utf8(JSON.stringify(JSON.parse(BODY_CONFIRMED))), now: T + 2,
    valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_body_trailing_newline', description: 'A line break was appended to the body.',
    secret: SECRET, header: good, body: utf8(`${BODY_CONFIRMED}\n`), now: T + 2, valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_body_wrong_encoding',
    description: 'The non-ASCII body was re-encoded as Latin-1 (these bytes are not valid UTF-8, so "body" is null: use body_base64).',
    secret: SECRET, header: await signatureHeader([SECRET], T, BODY_NON_ASCII),
    body: Buffer.from(BODY_NON_ASCII.replace('🚚', '?').replace('—', '-'), 'latin1'), now: T + 2,
    valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_wrong_secret', description: 'The receiver has a different secret.',
    secret: SECRET_OTHER, header: good, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_secret_without_prefix',
    description: 'The receiver removed the whsec_ prefix from its secret. The prefix is part of the key.',
    secret: SECRET.slice('whsec_'.length), header: good, body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_rotation_unrelated_secret', description: 'Two v1 in the header, and the receiver secret matches neither.',
    secret: SECRET_OTHER, header: rotated, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_timestamp_replaced',
    description: 'Replay attempt: an old delivery is sent again with t changed to the current time. The signature covers t, so it no longer matches.',
    secret: SECRET, header: `t=${T + 86400},v1=${goodSignature}`, body: utf8(BODY_CONFIRMED), now: T + 86400,
    valid: false, reason: 'signature_mismatch',
  });
  add({
    name: 'invalid_signature_of_body_only',
    description: 'The v1 is the HMAC of the body alone, without the "<t>." prefix.',
    secret: SECRET, header: `t=${T},v1=${await bodyOnly(SECRET, BODY_CONFIRMED)}`,
    body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'signature_mismatch',
  });

  // ── Invalid: timestamp outside the tolerance ───────────────────────────────────────────────────────────────
  add({
    name: 'invalid_timestamp_too_old', description: 'Correctly signed, but 301 seconds old.',
    secret: SECRET, header: good, body: utf8(BODY_CONFIRMED), now: T + TOLERANCE + 1,
    valid: false, reason: 'timestamp_out_of_tolerance',
  });
  add({
    name: 'invalid_timestamp_in_the_future', description: 'Correctly signed, but 301 seconds ahead of the receiver clock.',
    secret: SECRET, header: good, body: utf8(BODY_CONFIRMED), now: T - TOLERANCE - 1,
    valid: false, reason: 'timestamp_out_of_tolerance',
  });
  add({
    name: 'invalid_precedence_timestamp_before_signature',
    description: 'Old AND signed with another secret: the timestamp is checked first.',
    secret: SECRET_OTHER, header: good, body: utf8(BODY_CONFIRMED), now: T + 3600,
    valid: false, reason: 'timestamp_out_of_tolerance',
  });

  // ── Invalid: header missing or malformed ───────────────────────────────────────────────────────────────────
  add({
    name: 'invalid_header_missing', description: 'The request has no X-GruaLink-Signature header.',
    secret: SECRET, header: null, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'missing_header',
  });
  add({
    name: 'invalid_header_empty', description: 'The header is present but blank.',
    secret: SECRET, header: '  ', body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'missing_header',
  });
  add({
    name: 'invalid_header_without_timestamp', description: 'There is a v1 but no t.',
    secret: SECRET, header: `v1=${goodSignature}`, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_header_timestamp_not_numeric', description: 't is not 1 to 12 decimal digits.',
    secret: SECRET, header: `t=${T}.5,v1=${goodSignature}`, body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_header_without_v1', description: 'There is a t but no v1.',
    secret: SECRET, header: `t=${T}`, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_header_signature_truncated', description: 'The only v1 has 63 hex characters: it is not a candidate.',
    secret: SECRET, header: `t=${T},v1=${goodSignature.slice(0, 63)}`, body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_header_signature_uppercase',
    description: 'The v1 is the right signature in UPPERCASE hex. Signatures are lowercase; do not normalize.',
    secret: SECRET, header: `t=${T},v1=${goodSignature.toUpperCase()}`, body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_header_wrong_separator', description: 'Parts separated by ";" instead of ",".',
    secret: SECRET, header: good.replace(',', ';'), body: utf8(BODY_CONFIRMED), now: T + 2,
    valid: false, reason: 'malformed_header',
  });
  add({
    name: 'invalid_precedence_malformed_before_timestamp',
    description: 'Old AND without any well-formed v1: the header format is checked before the timestamp.',
    secret: SECRET, header: `t=${T}`, body: utf8(BODY_CONFIRMED), now: T + 3600, valid: false, reason: 'malformed_header',
  });

  // ── Invalid: receiver without a secret ─────────────────────────────────────────────────────────────────────
  add({
    name: 'invalid_secret_not_configured',
    description: 'The receiver has an empty secret. It must reject, never accept everything.',
    secret: '', header: good, body: utf8(BODY_CONFIRMED), now: T + 2, valid: false, reason: 'missing_secret',
  });

  return {
    version: 1,
    description: 'Signature verification cases for GRUALINK webhooks, shared by every language. Generated by scripts/generate-signature-vectors.mjs in the Node.js repository; do not edit by hand. All secrets and data are fictitious.',
    algorithm: 'v1 = lowercase hex of HMAC-SHA256(key = secret as issued, including its whsec_ prefix; message = "<t>." followed by the raw body bytes)',
    signature_header: 'x-grualink-signature',
    tolerance_seconds: TOLERANCE,
    reasons: ['ok', 'missing_secret', 'missing_header', 'malformed_header', 'timestamp_out_of_tolerance', 'signature_mismatch'],
    fields: {
      secret: 'Signing secret configured in the receiver (a fake test value).',
      headers: 'Request headers as received, lowercase names. x-grualink-signature may be absent.',
      body: 'Raw body as a string when it is valid UTF-8, otherwise null.',
      body_base64: 'Raw body bytes in base64. Authoritative: verify against these bytes.',
      now: 'Receiver clock, in seconds since 1970 (UTC). Inject it; do not read the system clock.',
      expected: 'valid: whether to accept. reason: why (see reasons).',
    },
    cases,
  };
}

/** HMAC of the body alone: a common mistake, used by one invalid case. */
async function bodyOnly(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

const json = `${JSON.stringify(await build(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUTPUT, 'utf8') !== json) {
    console.error('contract/signature-vectors.json is out of date. Run: npm run vectors');
    process.exit(1);
  }
  console.log('contract/signature-vectors.json is up to date.');
} else {
  writeFileSync(OUTPUT, json);
  console.log(`Wrote ${OUTPUT}`);
}
