// End-to-end example: request a tow truck with fictitious data, print the quote and check the status.
//
//   GRUALINK_API_KEY=<your TEST key> npm run example:request
//
// Use a TEST key (glk_test_...). Test requests never become real services.
import { randomUUID } from 'node:crypto';
import {
  GrualinkApiError, GrualinkClient, GrualinkError, GrualinkValidationError, type ServiceRequest, type ServiceRequestInput,
} from '../src/index.js';

const apiKey = process.env['GRUALINK_API_KEY'];
if (!apiKey) {
  console.error('Set GRUALINK_API_KEY to your TEST key (it starts with glk_test_). See .env.example.');
  process.exit(1);
}
if (!apiKey.startsWith('glk_test_')) {
  console.error('This example only runs with a TEST key (glk_test_...).');
  process.exit(1);
}

const client = new GrualinkClient({
  apiKey,
  ...(process.env['GRUALINK_API_BASE_URL'] ? { baseUrl: process.env['GRUALINK_API_BASE_URL'] } : {}),
  onRetry: ({ attempt, delayMs, error }) => {
    console.warn(`Attempt ${attempt} failed (${error.name}); retrying in ${delayMs} ms`);
  },
});

// With a test key, the prefix of external_ref decides the final status: TEST-CONFIRMAR -> confirmed,
// TEST-EN-CURSO -> in_progress, TEST-TERMINAR -> completed, TEST-RECHAZAR -> rejected, TEST-CANCELAR -> cancelled.
const suffix = randomUUID().slice(0, 8);
const request: ServiceRequestInput = {
  external_ref: `TEST-CONFIRMAR-${suffix}`,
  contact: { name: 'Persona de Ejemplo', phone: '+525500000000' },
  vehicle: { make: 'Nissan', model: 'Versa', year: 2019, color: 'Gris', plate: 'ABC123A', type: 'auto' },
  pickup: { address: 'Av. Juárez 100, Centro, Guadalajara, Jal.', lat: 20.6767, lng: -103.3475 },
  destination: { address: 'Av. Patria 500, Zapopan, Jal.', lat: 20.7214, lng: -103.3918 },
  service: { reason: 'No arranca', category: 'vial', required_class: 'A' },
  notes: 'Datos ficticios de ejemplo.',
};

function printQuote(sr: ServiceRequest): void {
  const price = sr.quote.estimated_price;
  if (!price) {
    console.log(`  No estimated price (${sr.quote.unpriced_reason ?? 'unknown reason'}); the company will quote it.`);
    return;
  }
  console.log(`  Subtotal:  ${price.subtotal.toFixed(2)} ${price.currency}`);
  for (const tax of price.taxes) {
    const sign = tax.type === 'retention' ? '-' : '+';
    console.log(`  ${sign} ${tax.name} (${tax.rate}%): ${tax.amount.toFixed(2)}`);
  }
  console.log(`  Total:     ${price.total.toFixed(2)} ${price.currency} (estimate, extras not included)`);
}

try {
  const health = await client.health();
  console.log(`API status: ${health.status} (${health.version})`);

  // In your system, store this key next to your own record BEFORE calling, and reuse it if you have to retry.
  const idempotencyKey = randomUUID();

  const created = await client.createServiceRequest(request, { idempotencyKey });
  const sr = created.serviceRequest;
  console.log(`\nCreated ${sr.id} (${sr.mode}) with status "${sr.status}", reference ${sr.external_ref}`);
  printQuote(sr);

  // Sending it again with the same key and the same body creates nothing new.
  const again = await client.createServiceRequest(request, { idempotencyKey });
  console.log(`\nSent again with the same Idempotency-Key: replayed=${again.replayed}, same id=${again.serviceRequest.id === sr.id}`);

  const current = await client.getServiceRequest(sr.id);
  console.log(`\nStatus now: "${current.status}"${current.service?.folio ? `, folio ${current.service.folio}` : ''}`);

  const byRef = await client.findServiceRequestsByExternalRef(request.external_ref ?? '');
  console.log(`Requests with reference ${request.external_ref}: ${byRef.length}`);
} catch (error) {
  if (error instanceof GrualinkValidationError) {
    console.error(`Invalid fields: ${error.details.map((d) => `${d.field} (${d.issue})`).join(', ')}`);
  } else if (error instanceof GrualinkApiError) {
    console.error(`API error ${error.status} ${error.code}: ${error.message}`);
  } else if (error instanceof GrualinkError) {
    console.error(`${error.name}: ${error.message}`);
  } else {
    throw error;
  }
  process.exit(1);
}
