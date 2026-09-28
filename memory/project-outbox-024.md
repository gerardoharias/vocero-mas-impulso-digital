---
name: project-outbox-024
description: Envíos salientes de texto pasan por un outbox (message + message_delivery_attempt); un reintento jamás toca IA/pipeline/agenda; qué hacer ante un fallo de Meta
metadata:
  type: project
---

Spec `024-entrega-integra-mensajes-salientes` (migración 0023). Incidente: `offer_slots`
rechazado por Meta → al prospecto sólo le llegó la introducción. **Causa**: el envío
estaba dentro del `try` del motor de agenda en `pipeline.ts`; el `SendError` caía en
`degradeAction` y reenviaba `action.reply`. Ver [[project-ai-format-policy-023]] (otra
degradación, distinta: formato del modelo).

**Reglas que hay que respetar al tocar el envío**
- `sendText` = persistir (`queued`, con el texto FINAL) → intentar. `message.text` es
  inmutable (trigger de BD). Un reintento sale de `server/outbox/`, que NO importa IA,
  pipeline ni agenda (lo comprueba `tests/unit/outbox-boundary.test.ts`).
- La política es por **código de Meta + etapa + señal de red**, nunca por texto ni sólo
  HTTP (`server/outbox/policy.ts`). Reintentable = lista corta (`2, 131016, 133004,
  131057` + límites `4, 80007, 130429, 131056`); un código desconocido es permanente.
- Timeout / 5xx sin código / `200` sin id ⇒ `delivery_unknown`: **NO se reenvía solo**
  (Cloud API no tiene idempotencia; duplicaría). Sólo reenvío manual (`resendText`).
- `offerSlots` es PURO: los horarios nacen `pending` ligados al mensaje y pasan a
  `active` cuando Meta acepta. `getOffers` sólo lee `active`.
- Una respuesta del agente = una `dedupe_key` (`agent-turn:<inbound>`).

**Gotchas de pruebas**
- `pnpm test:integration` crea/borra bases `vocero_it_*` en el servidor de `DATABASE_URL`
  (Postgres real); las unitarias con BD simulada no ven UNIQUE, triggers ni carreras.
- En el E2E (`scripts/e2e-selftest.mjs`) el ai-mock siempre agenda el PRIMER hueco: un
  bloque que agende antes de la sección de Max le roba el hueco (`slot_taken`, legítimo).
  Y los sufijos de teléfono (`${RUN}NN`) no deben repetirse entre secciones.
- Un barrido del outbox pedido mientras corre otro se REPITE (no se descarta).
