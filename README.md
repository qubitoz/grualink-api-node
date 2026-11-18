# GRUALINK API: ejemplo en Node.js / TypeScript

[English](README.en.md)

Ejemplo listo para clonar y correr que integra tu sistema (aseguradora, asistencia, integrador) con la
API de GRUALINK: **pedir una grúa**, **consultar el estatus** y **recibir avisos firmados**.

Guía pública de la API: <https://grualink.mx/api>

Qué trae:

- Un **cliente mínimo** (`src/client.ts`): crea solicitudes con `Idempotency-Key`, consulta el estatus,
  errores tipados, reintentos con espera exponencial y tiempo máximo. Sin dependencias de ejecución.
- Un **receptor de avisos** (`src/webhooks.ts`, `src/webhook-server.ts`): verifica la firma sobre el
  cuerpo crudo, valida la ventana de tiempo, soporta el cambio de secreto y descarta duplicados.
- Dos **ejemplos ejecutables** (`examples/`).
- El **kit de contrato** (`contract/`): el contrato de la API en español e inglés y los casos de prueba
  de firma que comparten los ejemplos de todos los lenguajes.

No es un SDK: es código pensado para leerse y copiarse a tu proyecto.

## Requisitos

- Node.js 20 o superior.
- Una **llave de prueba** (`glk_test_…`). Te la da la empresa de grúas con la que trabajas.
- Para los avisos: el **secreto de firma** (`whsec_…`) que te entrega la misma empresa al registrar la
  dirección de tu sistema.

## Instalación

```bash
git clone <la dirección de este repositorio>
cd grualink-api-node
npm install
```

## Variables de entorno

Solo los nombres; los valores van en tu equipo y nunca en el repositorio. Hay una plantilla en
`.env.example`.

| Variable | Para qué |
|---|---|
| `GRUALINK_API_KEY` | Tu llave de **prueba** (`glk_test_…`) |
| `GRUALINK_WEBHOOK_SECRET` | Secreto de firma de los avisos (`whsec_…`), completo, con su prefijo |
| `GRUALINK_WEBHOOK_SECRET_PREVIOUS` | Opcional: el secreto anterior mientras dura un cambio de secreto |
| `GRUALINK_API_BASE_URL` | Opcional: otra dirección base (por omisión `https://grualink.mx/api/v1`) |
| `PORT` | Opcional: puerto del receptor de ejemplo (por omisión 8787) |

## Correr los ejemplos

### Pedir una grúa

```bash
export GRUALINK_API_KEY=...   # tu llave de prueba
npm run example:request
```

Con datos ficticios, el ejemplo envía una solicitud, imprime el precio estimado, la vuelve a enviar con
la misma `Idempotency-Key` para mostrar que no se duplica y consulta su estatus. Solo corre con llaves
de prueba.

Con una llave de prueba, el inicio de `external_ref` decide el estatus final: `TEST-CONFIRMAR`,
`TEST-EN-CURSO`, `TEST-TERMINAR`, `TEST-RECHAZAR`, `TEST-CANCELAR`.

### Recibir avisos

```bash
export GRUALINK_WEBHOOK_SECRET=...   # tu secreto de firma
npm run example:webhook
```

Queda escuchando en `http://localhost:8787/webhooks/grualink`. GRUALINK solo entrega a direcciones
`https` públicas en el puerto 443: publica el receptor detrás de tu dominio (o de un túnel `https` mientras
pruebas), dale esa dirección a la empresa y pídele que te mande un aviso de prueba.

## Uso en tu código

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
    { idempotencyKey: miRegistro.claveDeIdempotencia }, // guárdala antes de llamar
  );
  console.log(serviceRequest.id, serviceRequest.status, serviceRequest.quote.estimated_price?.total, replayed);
} catch (error) {
  if (error instanceof GrualinkValidationError) console.error(error.details);
  else throw error;
}
```

### Idempotencia y reintentos

- Cada solicitud lleva una `Idempotency-Key` tuya. Si repites la llamada con la misma clave y el mismo
  cuerpo en 24 horas, la API responde **`200`** con `Idempotent-Replayed: true` y no crea nada
  (`replayed` es `true`). La misma clave con otro cuerpo responde `409`.
- El cliente reintenta solo lo que tiene sentido: errores de red, tiempo agotado, `5xx` y
  `429 rate_limited` (esperando lo que diga `Retry-After`). Usa espera exponencial con jitter y reenvía
  siempre la misma clave y los mismos bytes.
- La llave nunca aparece en errores ni registros.

### Verificar un aviso

```ts
import { verifyWebhookSignature } from './src/index.js';

const { valid, reason } = verifyWebhookSignature({
  rawBody,                                             // los bytes tal como llegaron
  signatureHeader: request.headers['x-grualink-signature'],
  secret: process.env.GRUALINK_WEBHOOK_SECRET,         // completo, con whsec_
});
```

Lo importante:

1. Verifica el **cuerpo crudo**, antes de convertirlo a JSON. Si lo conviertes y lo vuelves a
   serializar, la firma ya no coincide.
2. Usa el secreto **completo**, con su prefijo `whsec_`.
3. Rechaza marcas de tiempo con más de 5 minutos de diferencia.
4. Tras un cambio de secreto llegan dos firmas `v1` durante 24 horas: acepta si cualquiera coincide.
5. Los avisos pueden repetirse: guarda el `id` de los ya procesados y responde `2xx` sin reprocesar.
6. Responde `2xx` en menos de 10 segundos y haz el trabajo pesado después.

### Montarlo en Express o Fastify

El punto delicado es conseguir el **cuerpo crudo**. `createWebhookHandler` no depende de ningún
framework: recibe los bytes y las cabeceras y devuelve el estatus y el cuerpo de la respuesta.

Express: usa `express.raw` en esa ruta (no `express.json`, que entrega el cuerpo ya convertido).

```ts
const handle = createWebhookHandler({ secret: process.env.GRUALINK_WEBHOOK_SECRET!, onEvent });

app.post('/webhooks/grualink', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const result = await handle({ rawBody: req.body, headers: req.headers });
  res.status(result.status).json(result.body);
});
```

Fastify: registra un lector de contenido que entregue un `Buffer` para esa ruta.

```ts
app.register(async (scope) => {
  scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
  scope.post('/webhooks/grualink', async (request, reply) => {
    const result = await handle({ rawBody: request.body as Buffer, headers: request.headers });
    return reply.code(result.status).send(result.body);
  });
});
```

Con varias instancias, sustituye `InMemoryDeliveryDeduplicator` por uno que use tu base de datos (basta
una clave única sobre el `id` del aviso).

## Errores

Todos los errores de la API tienen la forma `{ "error": { "code", "message", "details"? } }`. El `code`
es estable; decide con él, no con el `message`.

| HTTP | `code` | Qué pasó | Clase | ¿Se reintenta? |
|---|---|---|---|---|
| 400 | `invalid_request` | La petición no es válida | `GrualinkInvalidRequestError` | no |
| 400 | `invalid_json` | El cuerpo no es JSON válido | `GrualinkInvalidRequestError` | no |
| 400 | `key_in_query` | La llave se envió en la URL; pide que la revoquen | `GrualinkInvalidRequestError` | no |
| 400 | `idempotency_key_required` | Falta `Idempotency-Key` | `GrualinkInvalidRequestError` | no |
| 400 | `invalid_idempotency_key` | `Idempotency-Key` inválida (1 a 255 caracteres ASCII visibles) | `GrualinkInvalidRequestError` | no |
| 401 | `unauthorized` | Llave ausente, inválida, vencida o revocada | `GrualinkAuthenticationError` | no |
| 403 | `insufficient_scope` | La llave no tiene permiso para esto | `GrualinkPermissionError` | no |
| 403 | `customer_unavailable` | Tu cuenta de cliente con la empresa no está disponible | `GrualinkPermissionError` | no |
| 403 | `live_mode_unavailable` | Las solicitudes reales aún no están habilitadas | `GrualinkPermissionError` | no |
| 403 | `browser_not_allowed` | Llave real usada desde un navegador | `GrualinkPermissionError` | no |
| 404 | `not_found` | No existe o no es tuya | `GrualinkNotFoundError` | no |
| 405 | `method_not_allowed` | Método no permitido para esa ruta | `GrualinkInvalidRequestError` | no |
| 409 | `idempotency_conflict` | Esa `Idempotency-Key` ya se usó con otro cuerpo | `GrualinkIdempotencyConflictError` | no |
| 413 | `payload_too_large` | El cuerpo excede 16 KB | `GrualinkInvalidRequestError` | no |
| 415 | `unsupported_media_type` | El cuerpo debe ir como `application/json` | `GrualinkInvalidRequestError` | no |
| 422 | `validation_error` | Campos inválidos; `details` dice cuáles | `GrualinkValidationError` | no |
| 429 | `rate_limited` | Demasiadas peticiones; espera `Retry-After` | `GrualinkRateLimitError` | sí |
| 429 | `too_many_open_requests` | Demasiadas solicitudes sin resolver con la empresa | `GrualinkRateLimitError` | no |
| 500 | `internal_error` | Error interno | `GrualinkServerError` | sí |

Además: `GrualinkConnectionError` (sin respuesta, se reintenta), `GrualinkTimeoutError` (tiempo agotado,
se reintenta) y `GrualinkConfigError` (configuración o argumento inválido; no se envió nada).

El contrato completo, con campos, límites y el orden de las comprobaciones, está en
[`contract/API.es.md`](contract/API.es.md).

## Pruebas

```bash
npm test             # compila y corre node:test
npm run typecheck    # tipos estrictos, sin código sin usar
npm run vectors:check
```

Las pruebas no llaman a la API real: usan un servidor falso local. Cubren todos los casos de
`contract/signature-vectors.json`, cada código de error, los reintentos, la idempotencia y que la llave
no aparezca en errores ni registros.

## Estructura

```
contract/     contrato de la API (es/en), casos de prueba de firma y lista de verificación
src/          cliente, errores, tipos, verificación de avisos y receptor
examples/     request-tow.ts y webhook-server.ts
test/         pruebas (node:test) y servidor falso
scripts/      generador de los casos de prueba de firma
```

## Licencia

[MIT](LICENSE)
