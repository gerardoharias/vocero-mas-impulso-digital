# 023 — Plan de implementación

Spec: [`spec.md`](spec.md) · Datos: [`data-model.md`](data-model.md) · Tareas: [`tasks.md`](tasks.md)

## Constitution Check (tras el diseño, rev. 2)

| Principio | Estado |
|---|---|
| I Seguridad | Logs por lista blanca; cuerpos de error del proveedor se leen para clasificar y se descartan; `describeError` sin mensaje; ningún token en logs/`detail`/`effective` (probado) |
| II Soberanía | Sin proveedor ni dependencia nuevos (conversor propio, circuito en memoria, sin colas externas) |
| III Multi-tenancy | Las 3 columnas viven en `conversation` (`organization_id NOT NULL`); escrituras filtradas por id **y** organización; circuito con clave `organización\|modelo` |
| IV Idempotencia | Migración `IF NOT EXISTS`, default correcto; contador atómico; reinicio idempotente |
| VI Specs antes de código | Ciclo completo (hay migración) — este plan, `data-model.md`, `tasks.md` |
| Sandbox del Laboratorio | Intacto: degradación y avisos de circuito en `is_test` se persisten en sandbox, nunca por la API |

Sin violaciones; sin entradas en Complexity Tracking.

## Módulos

| Módulo | Responsabilidad |
|---|---|
| `src/lib/ai/index.ts` | `chatJson` (presupuesto compartido, escalera de formato, corrección ≤ 1), `callProvider`, `transcribeAudio`, `extractJson` |
| `src/lib/ai/budget.ts` | `CallBudget` (I1–I5) |
| `src/lib/ai/rejection.ts` | `classifyRejection`: formato / esquema / modelo / petición |
| `src/lib/ai/config.ts` | `resolveEffectiveModel`, `effectiveAiModels` (fuente única de precedencia) |
| `src/lib/ai/errors.ts`, `log.ts`, `json-schema.ts` | códigos y clases; log por lista blanca; conversor Zod → JSON Schema |
| `src/server/ai/recovery.ts` | recuperación de texto plano (3 capas, presupuesto del turno) |
| `src/server/ai/failure-state.ts` | contador por conversación (SQL atómico) |
| `src/server/ai/circuit.ts` | circuito por organización + modelo |
| `src/server/ai/schemas.ts` | registro de esquemas enviados al proveedor (prueba de contrato) |
| `src/server/ai/pipeline.ts` | `runAgentTurn`: gate del circuito → presupuesto → `handleModelFailure` / `degradeTurn` / `handleCircuitOpen` |

## Orden del turno

`gate del circuito (org|modelo)` → `presupuesto = 3` → `chatJson` →
{ éxito: cierra racha del circuito, reinicia contador } |
{ config/transporte: cuenta en circuito, `markAiError` si 401, handoff `error` } |
{ formato: cierra racha, recuperación si `invalid_json` original y queda
presupuesto, si no `degradeTurn` (contador en base: 1 → mensaje fijo; ≥ 2 →
handoff `error`) }.

## Riesgos de despliegue

1. La migración `0022` se aplica al arrancar el contenedor (aditiva, rápida).
2. Nada cambia en variables obligatorias; `AI_RESPONSE_FORMAT` y
   `AI_FALLBACK_MESSAGE` siguen opcionales.
3. Primer día: vigilar `event=format_fallback` (¿el modelo acepta `json_schema`?)
   y `event=circuit_open`.
