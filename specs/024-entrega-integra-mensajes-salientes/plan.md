# 024 — Plan de implementación

Spec: [`spec.md`](spec.md) · Datos: [`data-model.md`](data-model.md)

## Arquitectura

```
                       ┌────────────── ANTES ──────────────┐
inbound ─▶ ingest ─▶ pipeline ─▶ offerSlots (escribe offered_slot)
                          │            │ texto final
                          │            ▼
                          │  try { deliverReply ─▶ sendText ─▶ Meta 503 ✗ }
                          │  catch (motor falló) ─▶ degradeAction ─▶ reply(INTRO)
                          │                                        ─▶ sendText ─▶ Meta ✓  ← sólo la introducción
                       └───────────────────────────────────┘

                       ┌───────────── DESPUÉS ─────────────┐
inbound ─▶ ingest ─▶ pipeline ─▶ offerSlots (PURO: texto + huecos, sin escribir)
   (wamid UNIQUE)         │            │
                          │            ▼
                          │  try { motor } catch { degradeAction }      ← sólo el motor
                          │  enqueue(text final + huecos `pending`, dedupe_key)   ← G1, G2
                          │            │  tx: message(queued) + offered_slot(pending)
                          │            ▼
                          │  attempt #1 (inline) ── claim ─▶ sending ─▶ Meta
                          │       ├─ aceptado ─▶ pending ─▶ ofertas `active`
                          │       ├─ transitorio ─▶ retrying(next_attempt_at)  ─┐
                          │       ├─ ambiguo ─▶ delivery_unknown                │
                          │       └─ permanente ─▶ failed                       │
                          ▼                                                     │
                     (el turno termina; NO reintenta nada)                      │
                                                                                │
             outbox worker (in-process, cada 5 s + temporizador) ◀──────────────┘
               claim atómico ─▶ MISMO message.text ─▶ Meta   (sin IA / pipeline / agenda)
```

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Política pura | `src/server/outbox/policy.ts` | clasificación por código+etapa, espera con jitter, constantes |
| Outbox | `src/server/outbox/index.ts` | `enqueueText`, `attemptDelivery`, `runDueDeliveries`, `resendManually`, worker |
| Envío | `src/server/inbox/send.ts` | `sendText` = enqueue + intento inline; `SendError` lleva el detalle de transporte |
| Cliente Meta | `src/lib/meta/client.ts` | `subcode`, `network` (connect/timeout/unknown), `timeoutMs` |
| Estados asíncronos | `src/server/inbox/status.ts` | `failed` con wamid ⇒ política por código |
| Ofertas | `src/server/agenda/offers.ts`, `agent.ts` | `offerSlots` puro; `pending` → `active` al aceptar; `offer_state` por mensaje |
| Vigencia de ofertas | `src/server/agenda/offer-freshness.ts` (sólo BD; lo usa el reintento automático) · `offer-resend-guard.ts` (+ motor de disponibilidad; sólo reenvío manual) | §5.6 |
| Re-oferta de `bookSlot` | `agenda/agent.ts` (`offers` con `shown`) · `agenda/service.ts` (`registerAlternatives`) | §5.7: misma vía que `offer_slots` |
| Despliegue | `docs/runbook-024-outbox.md` · `docs/bot-messages-contrato.md` | cierre pre-despliegue |
| Pipeline | `src/server/ai/pipeline.ts` | el envío sale del `try` del motor; `agent-turn:` dedupe |
| Arranque | `src/instrumentation-node.ts` | `startOutboxWorker()` junto al sweeper |
| UI | `message-thread.tsx`, `lib/types.ts`, ruta `…/resend` | Reintentando / Sin confirmar / Reenviar |

## Fronteras que se respetan

- `server/outbox/` **no importa** `@/lib/ai`, `server/ai/*` ni `server/agenda/agent`
  (G4, G9, G10). Una prueba lo comprueba escaneando los imports.
- `sendMediaMessage`, `sendStructured` y `templates.ts` siguen con `callGraphSend`
  y `persistOutbound` (fuera de alcance, spec §6).
- `prepareSend` (sandbox, ventana, credenciales) se ejecuta **en cada intento**.

## Orden

1. Fase 1 — arnés de integración + reproducción roja (hecho).
2. Esta spec (hecho antes del código).
3. Migración `0023` + esquema.
4. Política pura + pruebas unitarias.
5. Cliente Meta (`network`, `subcode`, timeout) + `SendError.transport`.
6. Outbox + `sendText`.
7. Pipeline (saca el envío del `try`, dedupe) + `offerSlots` puro + ofertas ligadas.
8. Webhook de estado.
9. Worker en el arranque.
10. UI + ruta de reenvío.
11. Pruebas de integración (Fase 5) + E2E + compuertas.

## Verificación

`pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build`
más el E2E de agenda con los mocks (`pnpm test:e2e`), que ejecuta `offer_slots`
contra el wa-mock. CI: se añade un servicio Postgres para `test:integration`.
