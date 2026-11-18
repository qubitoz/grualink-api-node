import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  MAX_WEBHOOK_BODY_BYTES, createWebhookHandler, type WebhookHandlerOptions, type WebhookHandlerResult,
} from './webhooks.js';

export interface WebhookListenerOptions extends WebhookHandlerOptions {
  /** Only this path is served (default: any path). */
  path?: string;
  /** Called after each delivery with the outcome, for your logs. The body and the secret are never passed. */
  onResult?: (result: WebhookHandlerResult, request: IncomingMessage) => void;
}

/** Reads the raw body with a hard cap, without ever buffering more than `limit` bytes. */
export function readRawBody(request: IncomingMessage, limit: number = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > limit) {
      request.resume();
      resolve('too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.byteLength;
      if (total > limit) {
        done = true;
        chunks.length = 0;
        request.resume();
        resolve('too_large');
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    request.on('error', (error) => { if (!done) { done = true; reject(error); } });
  });
}

function send(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extra,
  });
  response.end(text);
}

/** A `node:http` request listener that receives GRUALINK webhooks. No framework needed. */
export function createWebhookListener(options: WebhookListenerOptions): RequestListener {
  const handle = createWebhookHandler(options);

  return (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (options.path !== undefined && pathname !== options.path) {
        request.resume();
        send(response, 404, { received: false, error: 'not_found' });
        return;
      }
      if (request.method !== 'POST') {
        request.resume();
        send(response, 405, { received: false, error: 'method_not_allowed' }, { Allow: 'POST' });
        return;
      }
      const rawBody = await readRawBody(request);
      if (rawBody === 'too_large') {
        send(response, 413, { received: false, error: 'payload_too_large' }, { Connection: 'close' });
        return;
      }
      const result = await handle({ rawBody, headers: request.headers });
      send(response, result.status, result.body);
      options.onResult?.(result, request);
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { received: false, error: 'internal_error' });
      else response.end();
    });
  };
}
