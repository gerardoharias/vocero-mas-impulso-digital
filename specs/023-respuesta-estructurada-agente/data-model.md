# 023 — Modelo de datos (migración `0022_ia_estado_de_fallos`)

Único cambio de datos de la feature. Aditivo, sin backfill, re-ejecutable.

## `conversation` (3 columnas nuevas)

| Columna | Tipo | Null | Default | Significado |
|---|---|---|---|---|
| `ai_fail_count` | `integer` | NO | `0` | Fallos de **formato** consecutivos de la IA en esta conversación |
| `ai_fail_kind` | `text` | sí | — | Código del último fallo (`AiErrorCode`), o `circuit_open` si el circuito avisó al cliente |
| `ai_fail_at` | `timestamp` | sí | — | Momento del último fallo / aviso |

```sql
SET LOCAL lock_timeout = '3s';
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_kind" text;
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_fail_at" timestamp;
```

## Decisiones

- **Columnas, no tabla nueva.** Es un atributo del hilo, se lee con la fila de
  `conversation` que el turno ya carga (cero consultas extra en el camino
  feliz) y no necesita historial de fallos.
- **Alcance conversación.** Ver spec §3.6. Lo global lo cubre el circuito
  (memoria), no esta tabla.
- **Tenancy (Constitución III).** `organization_id` ya está en `conversation`;
  las escrituras filtran por `id` **y** `organization_id`
  (`server/ai/failure-state.ts`). Verificado: otra organización no puede tocar
  el contador.
- **Idempotencia (IV).** `ADD COLUMN IF NOT EXISTS`; el default `0` es el estado
  correcto de todo lo existente. En PostgreSQL ≥ 11 `ADD COLUMN … DEFAULT
  <constante> NOT NULL` no reescribe la tabla.
- **Atomicidad.** El incremento es una sola sentencia:
  `SET ai_fail_count = CASE WHEN ai_fail_at IS NOT NULL AND ai_fail_at > $cutoff::timestamp THEN ai_fail_count + 1 ELSE 1 END … RETURNING ai_fail_count`.
  El `cutoff` (ahora − 6 h) viaja como ISO + `::timestamp`: un `Date` dentro de
  un `sql` crudo no se codifica en postgres-js.
- **Reinicios.** Un turno exitoso, una recuperación de texto plano, reactivar la
  IA (`patchConversation({reactivate})`) y `/api/bot/reset` ponen `0/null/null`.
- **Retrocompatibilidad / rollback.** El código viejo ignora las columnas; un
  rollback de la app no requiere revertir la migración.

## Seguridad al arrancar el contenedor (verificada)

El contenedor corre `node migrate.mjs && node server.js`: si la migración falla
el servidor **no arranca** (con despliegue rodante, el contenedor viejo sigue
sirviendo). Probado en una base aparte (`vocero_migtest`, PostgreSQL 16.14,
**500 000 conversaciones**, estado previo a 0022):

| Propiedad | Evidencia |
|---|---|
| **Idempotente** | `ADD COLUMN IF NOT EXISTS`; re-ejecutarla no falla. Drizzle no vuelve a aplicarla (compara `created_at` con la última fila del historial) |
| **Sin bloqueo prolongado** | `ACCESS EXCLUSIVE` sostenido **~17 ms** (3 `ALTER` + `COMMIT`) con 500 k filas; `pg_relation_filenode('conversation')` idéntico antes/después (65628): **no reescribe la tabla**; las 500 k filas quedan con `ai_fail_count = 0`. `migrate.mjs` completo: 3.2 s incluyendo arrancar node |
| **Peor caso: transacción larga abierta** | Sin tope, el `ALTER` hace cola y **congela toda consulta a `conversation` ~20 s** (medido 20 303 ms). Con `SET LOCAL lock_timeout = '3s'` (primera sentencia de la migración) el estancamiento máximo medido es **3.8 s**, la migración falla rápido y el bucle de reintentos de `migrate.mjs` (15 x 2 s) la completa al terminar el bloqueador (24.6 s en la prueba) |
| **Versión anterior de la app** | Con el `schema.ts` del commit previo (`git show HEAD:...`): `INSERT` sin las columnas nuevas (el default cubre el `NOT NULL`), `SELECT` y `UPDATE ... RETURNING` (`applyHandoff` viejo) funcionan sobre la base ya migrada; la fila queda `0/null/null`. Rollback de la app sin revertir la migración |
| **Dos instancias a la vez** | 3 pruebas con solapamiento forzado (bloqueador de 2.5 s: ambas quedan en cola en el `ALTER`) + 1 con 6 procesos simultáneos: **0 fallos**, exactamente 3 columnas. drizzle no toma advisory lock: ambas ven "pendiente"; el `ALTER` de la segunda espera al commit de la primera y, gracias a `IF NOT EXISTS`, no falla. Efecto residual **cosmético**: el historial `drizzle.__drizzle_migrations` puede quedar con una fila duplicada de 0022 (no hay `UNIQUE`; sólo se lee la última) |

## Verificación

`pnpm exec tsx --env-file=.env scripts/verify-ai-fail-state.ts` contra Postgres
real: tipos/nulabilidad/default de las 3 columnas, 25 fallos concurrentes →
conteos exactamente 1..25, ventana de 6 h, reinicio, aislamiento por
organización.
