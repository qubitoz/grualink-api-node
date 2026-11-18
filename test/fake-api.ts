import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings as they are. */
  body?: unknown;
  /** Wait before answering (to exercise the timeout). */
  delayMs?: number;
  /** Close the socket without answering (to exercise network errors). */
  destroy?: boolean;
}

export interface FakeApi {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Queue answers; the last one repeats once the queue is exhausted. */
  reply(...responses: (FakeResponse | ((request: RecordedRequest) => FakeResponse))[]): void;
  close(): Promise<void>;
}

/** A local stand-in for the API: records what it receives and answers what the test queued. */
export async function startFakeApi(): Promise<FakeApi> {
  const requests: RecordedRequest[] = [];
  let queue: (FakeResponse | ((request: RecordedRequest) => FakeResponse))[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const answer: FakeResponse = typeof next === 'function' ? next(recorded) : next ?? { status: 500, body: 'no reply queued' };
      if (answer.destroy) { req.socket.destroy(); return; }
      const send = () => {
        const isText = typeof answer.body === 'string';
        const payload = answer.body === undefined ? '' : isText ? (answer.body as string) : JSON.stringify(answer.body);
        res.writeHead(answer.status, { 'Content-Type': isText ? 'text/html' : 'application/json; charset=utf-8', ...answer.headers });
        res.end(payload);
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs); else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    reply(...responses) { queue = responses; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const apiError = (status: number, code: string, message = 'Mensaje de ejemplo.', details?: unknown, headers?: Record<string, string>): FakeResponse => ({
  status, body: { error: { code, message, ...(details ? { details } : {}) } }, ...(headers ? { headers } : {}),
});

export const SERVICE_REQUEST = {
  id: '11111111-2222-4333-8444-555555555555',
  object: 'service_request',
  status: 'quoted',
  mode: 'test',
  external_ref: 'TEST-CONFIRMAR-0001',
  created_at: '2026-11-18T10:00:00.000Z',
  resolved_at: null,
  rejection_reason: null,
  service: null,
  quote: {
    estimated_price: {
      currency: 'MXN', subtotal: 864.33, taxes: [{ name: 'IVA', type: 'tax', rate: 16, amount: 138.29 }],
      tax_total: 138.29, retention_total: 0, total: 1002.62,
    },
    includes_extras: false, approximate_distance: true, unpriced_reason: null, note: 'Precio estimado.',
  },
  assignment: null,
  timeline: null,
} as const;
