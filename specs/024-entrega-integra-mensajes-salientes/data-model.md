# 024 — Modelo de datos

Migración **`0023`**. Aditiva y re-ejecutable (Constitución IV): todo `ADD COLUMN`
es nullable o con `DEFAULT` constante (metadatos únicamente en PostgreSQL ≥ 11),
sin backfill —el valor por defecto es el estado correcto de todo lo existente—,
y con el mismo `SET LOCAL lock_timeout = '3s'` que la `0022` para que un
`ALTER` no bloquee la app detrás de una transacción larga.

## `message` (columnas nuevas)

| Columna | Tipo | Nulo | Para qué |
|---|---|---|---|
| `delivery_attempts` | `integer` | NOT NULL, `0` | Intentos de transporte reclamados (incluye el que está en vuelo) |
| `next_attempt_at` | `timestamp` | sí | Cuándo se puede reclamar el siguiente intento (`retrying`) |
| `locked_until` | `timestamp` | sí | Arrendamiento del intento en vuelo (`sending`); vencido ⇒ intento huérfano |
| `error_code` | `integer` | sí | Código de Meta del último fallo |
| `error_subcode` | `integer` | sí | Subcódigo, si vino |
| `error_class` | `text` | sí | `transient` · `rate_limit` · `ambiguous` · `window_closed` · `recipient_unavailable` · `auth` · `permanent` · `offer_stale` |
| `trace_id` | `text` | sí | Correlación interna (`trc_…`), jamás derivada de datos del cliente |
| `dedupe_key` | `text` | sí, **UNIQUE** | `agent-turn:<id del inbound>` — un turno, una respuesta lógica (G5) |
| `offer_state` | `text` | sí | Estado de la ronda de horarios que el mensaje muestra: `pending` · `active` · `superseded` · `consumed`; nulo = no es una oferta (§5.6) |

`status` es `text` (el `enum` es sólo de TypeScript, como hasta ahora), así que
los cuatro estados nuevos —`queued`, `sending`, `retrying`, `delivery_unknown`—
no requieren migración de tipo.

**Inmutabilidad (G3)**: un `TRIGGER BEFORE UPDATE OF text` rechaza cambiar
`text` de un mensaje `out` (`23514`). El código nunca lo hace; el trigger es la
red de seguridad para cualquier ruta futura.

Índice parcial para el barrido: `message_outbox_due_idx (status, next_attempt_at)
WHERE status IN ('queued','retrying','sending')`.

## `message_delivery_attempt` (tabla nueva)

Un intento de transporte de un mensaje lógico.

| Columna | Tipo | Nulo | Notas |
|---|---|---|---|
| `id` | `text` PK | no | prefijo `att`… ver `ids.ts` (`deliveryAttempt: "mda"`) |
| `organization_id` | `text` | no | FK → `organization`, `ON DELETE CASCADE` (Constitución III) |
| `message_id` | `text` | no | FK → `message`, `ON DELETE CASCADE` |
| `attempt_no` | `integer` | no | correlativo desde 1; **UNIQUE (`message_id`, `attempt_no`)** |
| `stage` | `text` | no | `sync` · `async` |
| `outcome` | `text` | no | `started` · `accepted` · `transient_failure` · `rate_limited` · `ambiguous` · `permanent_failure` · `async_failed` · `abandoned` |
| `error_class` | `text` | sí | igual que en `message` |
| `meta_code` | `integer` | sí | |
| `meta_subcode` | `integer` | sí | |
| `http_status` | `integer` | sí | |
| `wamid` | `text` | sí | el `wamid` que Meta devolvió en ese intento |
| `trace_id` | `text` | sí | |
| `started_at` | `timestamp` | no | |
| `finished_at` | `timestamp` | sí | nulo mientras `outcome = 'started'` |

Nunca se guarda el JSON de error de Meta, ni el cuerpo enviado, ni el
destinatario (AC-18). El cuerpo enviado **es** `message.text`, que no cambia.

Índice: `message_delivery_attempt_org_idx (organization_id)`.

## `offered_slot` (columnas nuevas)

| Columna | Tipo | Nulo | Notas |
|---|---|---|---|
| `message_id` | `text` | sí | FK → `message`, `ON DELETE CASCADE`: el mensaje lógico que mostró estos horarios. Nulo = oferta sin mensaje propio del CRM (API del cerebro externo: `/api/bot/availability` y `/api/bot/bookings`); la re-oferta del agente SÍ lleva mensaje (§5.7) |
| `state` | `text` | NOT NULL, `'active'` | `pending` (el mensaje aún no fue aceptado por Meta) · `active` (seleccionable) |
| `shown` | `boolean` | NOT NULL, `true` | El horario aparece en el TEXTO del mensaje (el catálogo registrado es más ancho). Sólo estos se revalidan antes de reenviar |

`getOffers` y `findOffered` **sólo** ven `active`. `pending` **no reserva** disponibilidad (spec §5.6). Las filas existentes quedan
`active` (el valor por defecto): comportamiento idéntico al de antes.

Ciclo de vida:

```
enqueue (tx con el mensaje) ─▶ offered_slot.state = 'pending', message_id = M
Meta acepta M               ─▶ tx: borra el resto de la conversación; M ─▶ 'active'
M queda failed              ─▶ siguen 'pending' (no seleccionables) — el reenvío
                                manual de M las activaría; las reemplaza cualquier
                                ronda posterior (replaceOffers / activateOffers)
```

## Máquina de estados

Ver spec §3.1. Restricciones que la BD/código hacen cumplir:

- **Reclamo atómico**: `UPDATE message SET status='sending', delivery_attempts =
  delivery_attempts + 1, locked_until = $lease WHERE id = $id AND status IN (…) AND
  (next_attempt_at IS NULL OR next_attempt_at <= $now) RETURNING *`. Cero filas ⇒
  otro trabajador lo tiene (AC-9). El número de intento sale de ese mismo
  `RETURNING`; `UNIQUE (message_id, attempt_no)` es la segunda barrera.
- **Estados monotónicos** (IV): los `statuses` de Meta sólo avanzan
  (`pending < sent < delivered < read`); `failed` sólo se aplica una vez.
- **`wa_message_id`** (UNIQUE) sólo cambia al aceptar un intento o al anularlo
  por un `failed` asíncrono reintentable (el `wamid` viejo queda en el intento).

## Rollback

`0023` es aditiva: revertir la app a la versión anterior deja las columnas sin
usar. No hay que deshacerla para volver atrás. Un mensaje en `queued`,
`sending`, `retrying` o `delivery_unknown` **no lo entiende** el código
anterior (`StatusTicks` lo pintaría como fallo): por eso el despliegue debe
drenar el outbox antes de revertir (`SELECT count(*) FROM message WHERE status IN
('queued','sending','retrying')` → 0).
