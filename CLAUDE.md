# Vocero CRM — Guía para Claude

Vocero es un CRM de WhatsApp open source (MIT), self-hosted, con agente de IA y
Laboratorio de auto-evaluación. Una instancia = un negocio. Este archivo guía a
Claude Code (u otro asistente) para operar y **modificar** este repositorio —
el caso típico: una agencia adaptando Vocero para un cliente.

## Stack

**Next.js 15 (App Router) + React 19** en monolito · TypeScript estricto
(`strict` + `noUncheckedIndexedAccess`) · Tailwind CSS (sistema de diseño de la
marca Vocero, el mismo de vocerocrm.com: tokens en `src/app/globals.css`, tema
claro/oscuro, acento white-label por defecto `#0d5bff`, fuentes Archivo +
Instrument Serif + IBM Plex Mono self-hosted vía `next/font`; el logo vive en
`src/lib/brand.ts` y se dibuja con `src/components/brand-mark.tsx`) ·
**PostgreSQL + Drizzle ORM** (migraciones versionadas en
`drizzle/`, aplicadas al ARRANCAR el contenedor) · **Better Auth** + plugin
organization · **Zod** en todo input externo · nanoid con prefijos (`ct_`,
`cv_`, `msg_`…) · pnpm · Vitest (unit) + guiones E2E en `tests/e2e/`
conducidos con Playwright · Docker multi-stage (standalone, healthcheck
`/api/health`) · deploy en Coolify (Ruta A) o docker compose + Caddy (Ruta B).

Tiempo real por **SSE** (`/api/events`): heartbeat `: ping` ~25s, headers
anti-buffering, catch-up por refetch con `since=`. Sin WebSockets, sin colas
externas: el trabajo en segundo plano (agente, Laboratorio) es in-process.

## Mapa del código (fronteras de modificación)

| Quieres cambiar… | Toca… |
|---|---|
| El cerebro/proveedor LLM | `src/lib/ai/` (adaptador OpenRouter-compatible, `chatJson<T>`) |
| El comportamiento/prompt del agente | `src/server/ai/prompts.ts` |
| Las acciones que puede tomar el agente | `src/server/ai/actions.ts` + ejecución en `src/server/ai/pipeline.ts` |
| Qué pasa cuando el modelo no responde con el formato pedido | `src/lib/ai/` (clasificación, reintentos, `response_format`) + `src/server/ai/recovery.ts` (texto plano) + `handleModelFailure` en `pipeline.ts` — spec [023](specs/023-respuesta-estructurada-agente/spec.md) |
| Las personas o el juez del Laboratorio | `src/server/lab/personas.ts` · `src/server/lab/judge.ts` |
| El canal WhatsApp (Graph API) | `src/lib/meta/` (cliente único) + `src/server/whatsapp/` |
| Los canales opcionales (Instagram, Messenger; ADR-001) | `src/lib/channels.ts` (catálogo) · `src/server/channels/` (capacidades y bandera `CHANNELS`) · `src/server/instagram/` · `src/server/messenger/` · `src/server/zernio/` (transporte y firma de la API unificada, compartido) |
| Campos/tablas | `src/lib/db/schema.ts` → `pnpm db:generate` → migración nueva en `drizzle/` |
| Qué disponibilidad ve y afirma el agente (consultas por día/hora/rango, listas parciales vs completas) | `src/server/agenda/availability-query.ts` (`answerQuery` pura) + `src/lib/time/day-expressions.ts` + `alternatives.ts` — spec [025](specs/025-consultas-disponibilidad-calendario/spec.md). El motor (`computeAvailability`) es la única fuente de verdad; **nunca** se afirma «no hay» sobre una lista truncada (`exhaustive`/`hasMore`) |
| La ingesta/envío de mensajes | `src/server/inbox/` (ingest idempotente, send con guard de sandbox, ventana 24h) |
| Qué pasa cuando Meta rechaza o no responde un envío (reintentos, estados, reenvío) | `src/server/outbox/` (`policy.ts` clasifica por CÓDIGO de Meta + etapa; `index.ts` encola, reclama e intenta) — spec [024](specs/024-entrega-integra-mensajes-salientes/spec.md). El payload se persiste ANTES del primer intento y no cambia: un reintento **jamás** llama a IA, pipeline ni agenda |
| Cómo se identifica a un contacto | `src/server/inbox/identity.ts` (teléfono normalizado o `bsuid:<id>`) |
| Conectar TU propio bot en vez del agente | `src/app/api/bot/*` + `src/server/bot/auth.ts` (X-API-Key) |
| La agenda (horarios, huecos, citas) | `src/server/agenda/` — detrás de la bandera `AGENDA` (`flag.ts`) |
| Cómo se entrega la reunión (Zoom, Meet…) | `src/server/agenda/connectors/` + catálogo en `src/lib/agenda-connectors.ts` · guía: [docs/agenda-conectores.md](docs/agenda-conectores.md) |
| La atribución de anuncios y el reporte a Meta | `src/server/attribution/` — detrás de la bandera `ATRIBUCION` (`flag.ts`) + `src/lib/meta/capi.ts` · guía: [docs/atribucion-capi.md](docs/atribucion-capi.md) |
| UI | `src/components/` + `src/app/(app)/` |

Los mocks del entorno de pruebas viven en `src/app/api/dev/` (wa-mock +
ai-mock) tras un gate único (`src/lib/dev-guard.ts`): 404 incondicional en
producción.

**Identidad de contacto**: Meta está migrando de teléfono a Business-Scoped
User IDs, así que `from` puede no venir. La llave estable es
`contact.wa_identity` (teléfono normalizado 521→52, o `bsuid:<id>`); `phone` es
un atributo OPCIONAL. Nunca asumas que un contacto tiene teléfono.

**Cerebro externo**: `/api/bot/*` (autenticada por `BOT_API_KEY`) deja que un
microservicio propio conduzca la conversación sin que el token de WhatsApp
salga del CRM: marcar leído + "escribiendo…", descargar adjuntos y reiniciar la
conversación de pruebas. Respeta `conversation.ai_enabled`/`handoff_at` igual
que el agente in-process. Sin la key, esa superficie responde 401 y el CRM
funciona igual.

## Reglas de la constitución (no negociables)

Ver [.specify/memory/constitution.md](.specify/memory/constitution.md).

- **Soberanía (II, endurecida — 1.4.0)**: el NÚCLEO depende solo de WhatsApp
  Cloud API + proveedor LLM OpenRouter-compatible opcional; prohibido meterle
  S3/R2, email, billing u otros terceros. Un servicio de terceros solo entra
  como **conector opcional**: apagado por defecto tras bandera (patrón
  ADR-001), aislado tras adaptador con contrato público, con camino sin
  dependencia externa y degradación definida (su fallo jamás bloquea la
  operación core), credenciales del negocio cifradas, y CI que lo prueba
  apagado y encendido. Auth y BD self-hosted.
- **Seguridad (I)**: secretos cifrados en reposo (AES-256-GCM, `lib/crypto`);
  jamás al cliente ni a logs. El token de WhatsApp solo muestra sus últimos 4.
- **Multi-tenancy (III)**: `organization_id` NOT NULL en toda tabla de dominio;
  toda query pasa por `scoped()` de `src/lib/db/tenant.ts`.
- **Idempotencia (IV)**: webhooks dedup por `wa_message_id` UNIQUE; estados
  monotónicos; seeds y migraciones re-ejecutables.
- **Sandbox del Laboratorio**: las conversaciones `is_test` JAMÁS tocan la API
  real — el sender lanza excepción (no lo "arregles": es un guardrail). Lo
  mismo vale para la agenda: una cita de prueba nunca llega a un conector.
- **Módulos opcionales (015, 016)**: lo que no usa toda instancia va detrás de una
  bandera de despliegue, apagado por defecto, con su superficie en 404 y la
  migración aplicada igual. Nunca en una rama aparte
  ([ADR-001](docs/adr-001-canales-opcionales.md),
  [ADR-002](docs/adr-002-conectores-de-agenda.md)).

## Variables de entorno

Ver `.env.example` (cada una con guía inline). Las claves: `APP_BASE_URL`,
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` (32 bytes base64),
`META_WEBHOOK_VERIFY_TOKEN` (segmento secreto del webhook), `META_APP_SECRET`
(opcional, firma), y para IA:

```bash
OPENROUTER_API_TOKEN=sk-or-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_JUDGE_MODEL=anthropic/claude-haiku-4.5   # opcional: juez más barato
```

Respuesta estructurada del agente (spec 023): `AI_RESPONSE_FORMAT` (`auto` por
defecto | `json_schema` | `json_object` | `off`) y `AI_FALLBACK_MESSAGE` (mensaje
fijo de degradación cuando el modelo no entrega una respuesta utilizable). Un
turno del agente hace ≤ 3 llamadas al proveedor (presupuesto compartido); no
bajes de `response_format` ante un 400 genérico (ver `rejection.ts`). Todo
esquema enviado al proveedor se registra en `src/server/ai/schemas.ts`. Las
pruebas reales contra OpenRouter (`pnpm test:ai-live`, y `pnpm test:ai-live-025` para
las consultas de disponibilidad) consumen saldo: nunca las corras sin autorización
expresa (y con el tope de llamadas que traen). Los
logs de IA (`src/lib/ai/log.ts`) llevan sólo datos operativos: jamás contenido
del cliente ni del modelo — no agregues `raw`/`detail` con texto del modelo.

Para el self-test local existe además el modo de pruebas interno (mocks) —
ver `specs/001-vocero-core/quickstart.md`. Nunca actives mocks en producción.

## Manejo de credenciales (obligatorio)

Cuando una feature necesite una variable/credencial nueva: (1) agrégala a
`.env` como placeholder `REEMPLAZA_...` (append), (2) deja guía inline `#` de
cómo obtenerla, (3) resume en el chat y sigue. `.env` está gitignored; para
deploy, las vars van también en la plataforma de hosting (runtime, no build).

## Definición de Hecho REFORZADA (obligatoria)

"Typecheck + lint + build (+ tests)" es el piso, NO el techo. Una feature no
está "Hecha" hasta correr el **self-test de COMPORTAMIENTO de punta a punta**
(Playwright + mocks: `WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock,
`OPENROUTER_BASE_URL` → ai-mock) y dejarlo verde: flujo real como usuario,
resultado observable, y el camino infeliz degradando sin colgarse. Prohibido
delegar la prueba al usuario. Si algo depende de un LLM/proveedor externo,
todo turno tolera formato inesperado con extracción robusta + reintentos — un
hipo del proveedor nunca tumba el turno. Al detectar un fallo: diagnostica,
corrige y re-verifica tú mismo hasta verde (loop de auto-corrección).

Gate técnico:

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:integration
```

`pnpm test:integration` (spec 024) corre el pipeline, la ingesta, el outbox y las
migraciones contra un Postgres REAL (una base `vocero_it_*` desechable por
archivo, creada y borrada en el servidor de `DATABASE_URL`); sólo Meta, la IA y
la disponibilidad están simuladas.

Guiones E2E por historia en `tests/e2e/*.md`. Parte de ellos ya están
automatizados: con la app viva y los mocks encendidos, `pnpm test:e2e`
(`scripts/e2e-selftest.mjs`) los conduce contra la app real y sale distinto de
cero si algo falla. Al agregar una historia, extiende el arnés en vez de dejar
solo el `.md`.

## Modo Objetivo — Loop SDD

Cuando el dueño da una META (no prompts paso a paso): Discover → Plan →
Execute → Verify → Iterate, de forma autónoma, volviendo solo con el objetivo
verificado en vivo o con un bloqueo real (decisión de producto, credenciales,
acción irreversible/costosa). Agrupa TODAS las preguntas bloqueantes al inicio.
El estado durable son los artefactos SDD en `specs/` (spec/plan/tasks) —
manténlos al día. Invocable como `/loop-sdd <objetivo>`.

## Memoria persistente

Memoria de archivos en `memory/` (índice `memory/MEMORY.md`, cargado por
sesión). Persiste decisiones, gotchas y correcciones; no dupliques lo que el
repo ya registra. Los subagentes con `memory: project` usan
`.claude/agent-memory/`.

## Arquitectura de agentes

1. **Orquestador** = la sesión principal de Claude Code (este CLAUDE.md + skill
   `loop-sdd`).
2. **Subagentes** (`.claude/agents/`): `deploy-ops` (deploy/logs/healthchecks,
   no escribe código de app) · `public-site-builder` (páginas públicas/legales
   y config de paneles externos).
