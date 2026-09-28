# 026 — Modelo de datos

**Migración aditiva nueva** (a diferencia de 025, que no tocó el esquema). Sólo `conversation` gana
columnas; `message`, `offered_slot` y el outbox de 024 no se tocan.

## Columnas nuevas en `conversation`

Mismo patrón que `ai_fail_count`/`ai_fail_kind`/`ai_fail_at` (023): estado TÉCNICO de la conversación,
invisible para el cliente, reseteado al primer turno que resuelve.

| Columna | Tipo Drizzle | Default | Uso |
|---|---|---|---|
| `agenda_clarify_count` | `integer("agenda_clarify_count").notNull()` | `0` | Aclaraciones de disponibilidad CONSECUTIVAS sin resolver |
| `agenda_clarify_kind` | `text("agenda_clarify_kind")` | `null` | Última razón sin resolver: `unresolved` \| `already_passed_this_week` \| `too_many_days` \| `unresolved_time` \| `unresolved_range` |
| `agenda_clarify_context` | `text("agenda_clarify_context")` (JSON serializado) | `null` | Lo que ya se entendió antes de faltar una pieza. Hoy sólo `{"weekModifier":"next"\|"same"}`; el tipo se declara abierto (`Record<string, unknown>`) para no forzar otra migración si se necesita un campo más adelante (p. ej. `days` parcial) |

SQL de la migración (borrador, a generar con `pnpm db:generate` cuando se implemente — **no
generado en esta entrega**):

```sql
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_kind" text;
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "agenda_clarify_context" text;
```

Re-ejecutable (Principio IV): `IF NOT EXISTS` + defaults explícitos, mismo estilo que `drizzle/0023_*`.
Sin backfill: toda fila existente nace en `0`/`null`/`null`, equivalente a "sin aclaración pendiente".

## Tipos nuevos (sólo en memoria)

```ts
// day-expressions.ts
type DayFailureReason = "already_passed_this_week";
type DayResolution =
  | { ok: true; dayIso: string }
  | { ok: false; reason?: DayFailureReason };

// availability-query.ts
type AvailabilityQuery = {
  day?: string;
  days?: string[];          // NUEVO — mutuamente excluyente con `day`
  times?: string[];
  from?: string;
  to?: string;
  edge?: "earliest" | "latest";
};
type AvailabilityKind =
  | "suggestions" | "day" | "days" /* NUEVO */ | "times" | "range" | "edge"
  | "overview" | "clarify" | "none";

// agenda-clarify-context.ts (nuevo módulo, puro)
type AgendaClarifyContext = { weekModifier?: "next" | "same" };
type AgendaClarifyState = {
  count: number;
  kind: string | null;
  context: AgendaClarifyContext | null;
};
```

`AvailabilityMeta` (025) no cambia de forma; se extiende su rango de `kind` con `"days"`. Nada de esto
se persiste tal cual — sólo `AgendaClarifyState` tiene contraparte en `conversation` (§ arriba).

## Contrato publicado: `GET /api/bot/availability`

| Campo | Antes (025) | Ahora |
|---|---|---|
| `day` (query) | un día | sigue existiendo; se agrega `altDays` (lista separada por comas, mismas reglas). **No** se llama `days`: ese nombre ya es la ventana numérica de la lista truncada desde 015 (`LIMITS.days`) — hallado y corregido durante la implementación (`pnpm test:integration` lo detectó) |
| `kind` en la respuesta | `suggestions\|day\|times\|range\|edge\|overview\|clarify\|none` | + `"days"` |

Sin cambios de default, sin romper consumidores existentes (aditivo, igual que 025 §5.3).

## Reversión

Revertir el código sin revertir la migración dejaría columnas sin uso (inofensivo: `conversation` no
las lee si el código de 026 no está). Revertir la migración exige antes revertir el código que las
escribe/lee (el orden inverso a 025, que no tenía nada que revertir). A detallar en `plan.md`
cuando se implemente.
