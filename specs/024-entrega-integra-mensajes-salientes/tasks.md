# 024 — Tareas

Estado: implementadas y verificadas. Resultados de las compuertas al final.

## Fase 1 — Diagnóstico

- [X] T1 Arnés de integración: Postgres real desechable por archivo + sólo Meta/IA/disponibilidad simuladas (`vitest.integration.config.ts`, `tests/integration/{setup,helpers}`)
- [X] T2 Reproducción determinista del incidente, **roja antes de corregir** (`outbound-incident.test.ts`): intento 2 = 1 línea, 2 filas `message`, 8 `offered_slot` escritas antes del envío
- [X] T3 Hipótesis descartadas con pruebas verdes sobre el código anterior (`outbound-diagnosis.test.ts`: evento duplicado, acuse `failed`)
- [X] T4 Causa exacta documentada (spec §1)

## Fase 2–3 — Especificación y política

- [X] T5 `spec.md`, `plan.md`, `data-model.md` (antes del código)
- [X] T6 `server/outbox/policy.ts`: clasificación por código + etapa + red; backoff con jitter; constantes
- [X] T7 Cliente Meta: `subcode`, `network` (connect/timeout/unknown), `timeoutMs` (sin timeout un Meta colgado bloqueaba el turno)

## Fase 4 — Implementación

- [X] T8 Migración `0023` (columnas de `message`, `message_delivery_attempt`, `offered_slot.{message_id,state}`, trigger de inmutabilidad, índice parcial) — aditiva, re-ejecutable, con `lock_timeout`
- [X] T9 `server/outbox/index.ts`: `enqueueText`, reclamo atómico, `attemptDelivery`, `applyAsyncFailure`, `runDueDeliveries`, huérfanos, trabajador (sondeo + temporizador puntual, barrido re-solicitado no se descarta)
- [X] T10 `sendText` = persistir → intentar; `resendText` (manual, un intento); `SendError.transport`
- [X] T11 Pipeline: el envío sale del `try` del motor (causa raíz); `agent-turn:<inbound>` como respuesta lógica única
- [X] T12 `offerSlots` puro; ofertas `pending` ligadas al mensaje, `active` al aceptar Meta; `getOffers` sólo lee `active`
- [X] T13 Webhook de estado: `failed` con `wamid` → misma fila, política por código
- [X] T14 Arranque: `startOutboxWorker()` junto al sweeper
- [X] T15 UI: «Reintentando», «Sin confirmar» + Reenviar, «No se entregó» + Reenviar; `pending.ts`/consultas cuentan `delivery_unknown`; ruta `POST /api/conversations/:id/messages/:messageId/resend`
- [X] T16 `wa-mock`: `POST /api/dev/wa-mock/fail-next` y `rejected` en el outbox del mock (sólo dev)

## Fase 5 — Pruebas

- [X] T17 Unitarias: `outbox-policy` (cada código y etapa, backoff, red), `outbox-boundary` (el outbox no importa IA/pipeline/agenda; nadie reescribe `message.text`), `send-text-failure` adaptada
- [X] T18 Integración `outbound-delivery` (31 casos): reintento íntegro; tres fallos agotados + reenvío manual; permanente; ambiguo (5 formas) + `connect` sí reintenta + rate limit; acuse `failed` asíncrono (reintentable, no reintentable, agotado, acuse tardío del `wamid` viejo); evento y turno duplicados; reinicio (módulos nuevos, trabajador nuevo, huérfano, `queued` sin intento); dos trabajadores; reserva tras reintento y confirmación reintentada sin rebookear; privacidad de logs y BD; inmutabilidad en BD; sandbox
- [X] T19 Integración `outbound-migration` (7 casos): actualización real 0022→0023 con datos, defaults, unicidad, trigger, re-ejecución ×2
- [X] T20 E2E en vivo (`scripts/e2e-selftest.mjs`, `entregaIntegraChecks`; guion `tests/e2e/us-entrega-integra.md`)
- [X] T21 CI: servicio Postgres + paso `integration`

## Fase 6 — Entrega

- [X] T22 `CLAUDE.md`, `specs/README.md`, `.env.example` (variables `OUTBOX_*`, opcionales)
- [X] T23 Cierre pre-despliegue (rev. 2): guard del reenvío manual de ofertas y semántica de `pending` (spec §5.6, `offer-freshness.ts`, `offer-resend-guard.ts`, `message.offer_state`, `offered_slot.shown`); pruebas unitarias (`offer-resend-guard`, `resend-text-guard`), integración (`outbound-offer-guard`, 17 casos, con comprobación de mutación) y E2E
- [X] T24 Contrato v2 de `POST /api/bot/messages` (`contract: 2` + header), `docs/bot-messages-contrato.md` con ejemplo probado, prueba de contrato `bot-send-contract.test.ts` (8 casos, incluida la garantía de no-doble-envío del agente integrado)
- [X] T25 `docs/runbook-024-outbox.md` (previas, respaldo, migración, worker, conteos, humo, métricas, drenado, reversión, compatibilidad) con todas sus consultas ejecutadas contra una base migrada; `/api/health` declara `outbox.worker`; log de arranque del trabajador
- [X] T26 Compatibilidad de la versión anterior probada (migrador antiguo, INSERT/UPDATE previos) en `outbound-migration.test.ts`
- [X] T28 Deuda residual R-1 (rev. 3): la re-oferta de `bookSlot` usa la vía íntegra (spec §5.7): `registerAlternatives:false`, `AgendaTurn.offers` con `shown`, ofertas `pending` hasta que Meta acepta, mismo guard y misma revalidación; `outbound-reoffer.test.ts` (15 casos + 2 mutaciones), `book-slot-reoffer.test.ts`, `booking-race.test.ts`, E2E bloque F
- [ ] T27 Commit / PR / despliegue: **fuera de alcance** (no se hace sin autorización)

## Resultados de las compuertas

Ver el informe de entrega (última corrida): typecheck, lint, unitarias,
integración, E2E y build.
