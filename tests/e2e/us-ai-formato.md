# E2E — Respuesta estructurada y recuperación segura del agente (023)

Guion de comportamiento observable. Automatizado en `aiFormatChecks()` de
`scripts/e2e-selftest.mjs`: con la app viva y los mocks encendidos,
`pnpm test:e2e` lo conduce y sale distinto de cero si algo falla. Spec:
[`specs/023-respuesta-estructurada-agente/spec.md`](../../specs/023-respuesta-estructurada-agente/spec.md).

**Preparación**: app en `localhost` con `OPENROUTER_BASE_URL` → ai-mock, la BD
migrada y el agente in-process encendido (el guion lo enciende y lo apaga solo).
El ai-mock cuenta las llamadas que recibe (`GET/DELETE /api/dev/ai-mock/stats`)
y tiene dos disparadores deterministas en el mensaje del cliente:

| Mensaje del cliente empieza por | El "modelo" responde |
|---|---|
| `prueba:texto-plano` | una respuesta correcta en **texto plano** (el incidente) |
| `prueba:formato-invalido` | JSON válido con una acción que el contrato no admite (ni el intento ni la corrección lo arreglan) |

---

## US1 — El incidente: respuesta correcta en texto plano

1. El cliente escribe algo fuera de alcance (`prueba:texto-plano …`).
2. El proveedor recibe **2** llamadas (el turno + una verificación compacta),
   no 3.
3. La respuesta útil de Max **llega al cliente** (`Solo me enfoco en temas de
   CRM…`).
4. La conversación **no** queda en traspaso: sin `handoffAt`, sin motivo
   `error`, IA activa.

## US2 — Formato inválido aislado: degradación segura

1. El cliente escribe `prueba:formato-invalido`.
2. El proveedor recibe **2** llamadas (el turno + UNA corrección), no 3.
3. El cliente recibe el **mensaje fijo de degradación** (`AI_FALLBACK_MESSAGE`,
   por defecto «Disculpa, no pude procesar bien tu mensaje…»), que **no**
   promete un humano.
4. Sin traspaso, IA activa, y no se agendó nada.

## US3 — El mismo fallo dos turnos seguidos ya no es aislado

El cliente insiste y el turno vuelve a fallar por formato: se aplica
`applyHandoff("error")` y **no** se le manda otro mensaje.

## US3b — El contador vive en la base y un éxito lo reinicia

Fallo → turno normal → fallo: **no** son consecutivos (sin handoff). El estado
está en `conversation.ai_fail_*` (migración 0022), no en el texto de los
mensajes.

## US3c — Diagnóstico del modelo efectivo

`GET /api/settings/ai` incluye `effective` (`agent`/`judge`/`transcribe` con
`model` y `source`) y ninguna credencial.

## US4 — Camino feliz intacto

Un mensaje normal con JSON válido: **1** llamada y respuesta entregada.

---

## Cubierto por pruebas unitarias (sin app viva)

`tests/unit/ai-adapter.test.ts` (petición `response_format`, escalera de
compatibilidad, reintentos por clase, `Retry-After`, timeout, presupuesto de
llamadas, privacidad de logs), `ai-json-schema.test.ts` (Zod → JSON Schema),
`agent-plain-text-recovery.test.ts` (capas de la recuperación),
`pipeline-format-failure.test.ts` (el pipeline real: incidente, acciones
inválidas, política de handoff, matriz del presupuesto de llamadas y circuito
de protección), `ai-rejection.test.ts`, `ai-circuit.test.ts`,
`failure-state.test.ts`, `ai-provider-schemas-contract.test.ts`. Contra
Postgres real: `scripts/verify-ai-fail-state.ts`.
