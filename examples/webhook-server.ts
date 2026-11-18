// Example webhook receiver with node:http, no framework.
//
//   GRUALINK_WEBHOOK_SECRET=<your whsec_ secret> npm run example:webhook
//
// Expose it over https (GRUALINK only delivers to https addresses on port 443) and give that address to the
// towing company. Ask them to send a test event (webhook.test) to check the connection.
import { createServer } from 'node:http';
import { createWebhookListener, type WebhookEvent } from '../src/index.js';

const secrets = [process.env['GRUALINK_WEBHOOK_SECRET'], process.env['GRUALINK_WEBHOOK_SECRET_PREVIOUS']]
  .filter((s): s is string => typeof s === 'string' && s.length > 0);
if (secrets.length === 0) {
  console.error('Set GRUALINK_WEBHOOK_SECRET to your signing secret (it starts with whsec_). See .env.example.');
  process.exit(1);
}

const port = Number(process.env['PORT']) || 8787;
const path = '/webhooks/grualink';

// Stand-in for your own queue or database. Answer fast and do the real work elsewhere.
const queue: WebhookEvent[] = [];

function enqueue(event: WebhookEvent): void {
  queue.push(event);
  const sr = event.data.service_request;
  if (sr) {
    console.log(`[${event.mode}] ${event.type}: request ${sr.id} (${sr.external_ref ?? 'no reference'}) is now "${sr.status}"`);
  } else {
    console.log(`[${event.mode}] ${event.type}: ${event.data.message ?? ''}`);
  }
}

const server = createServer(createWebhookListener({
  path,
  secret: secrets,
  onEvent: enqueue,
  onResult: (result, request) => {
    // The reason stays in your logs; the caller only sees a generic answer.
    if (result.reason !== 'ok') {
      console.warn(`Delivery ${String(request.headers['x-grualink-delivery'] ?? '-')}: ${result.status} (${result.reason})`);
    }
  },
}));

server.listen(port, () => {
  console.log(`Listening for GRUALINK webhooks on http://localhost:${port}${path}`);
});
