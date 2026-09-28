# `GET /api/bot/availability` — qué cambió (spec 025)

> Para quien conduce la conversación con un cerebro externo. Los cambios son **aditivos**,
> salvo dos correcciones de comportamiento que conviene conocer.

## Correcciones de comportamiento

Hay **dos** cambios que no son aditivos. Ninguno exige versionar el endpoint (ver «Decisión» abajo),
pero conviene conocerlos si tu cerebro externo llama sin parámetros o lee `diasConAgenda`.

### 1. Valores por defecto de `limit`, `perDay` y `days`

| Parámetro | Rango (sin cambio) | **Antes**, sin el parámetro | **Ahora**, sin el parámetro | Explícito |
|---|---|---|---|---|
| `limit` | 1–48 | **1** (el mínimo) | **12** | sin cambio |
| `perDay` | 1–8 | **1** (el mínimo) | **3** | sin cambio |
| `days` | 1–14 | **1** (el mínimo) | **5** | sin cambio |

Causa: `clamp(null)` hacía `Number(null) → 0` (finito) y lo acotaba al mínimo en vez de usar el valor
por defecto. El contrato de la spec 015 siempre documentó 12 / 3 / 5; el código nunca los honró
cuando faltaba el parámetro (también con valor vacío: `limit=`). Si tu integración pasaba los tres
explícitos, **no notas nada**. Para reproducir exactamente el comportamiento anterior sin
parámetros: `limit=1&perDay=1&days=1`.

Efecto de llamar **sin parámetros**: la respuesta trae hasta 12 horarios (antes 1) y **se registran
como ofrecidos** hasta 12 (antes 1): es un catálogo reservable más ancho para
`POST /api/bot/bookings`, no un cambio de reglas.

### 2. Semántica de `diasConAgenda`

| | Antes | Ahora |
|---|---|---|
| Se calcula de… | los días de la lista `slots` **ya truncada** (`limit`/`perDay`) | la disponibilidad **completa** del motor |
| Alcance | los días que tienen algún horario en `slots` | **todos** los días con agenda dentro de la ventana `days` pedida (por defecto 5) |
| ¿Puede incluir un día que no está en `slots`? | no | **sí**: un día con agenda cuyos horarios `limit`/`perDay` dejaron fuera (entonces `hasMore` es `true`) |
| ¿Puede omitir un día con agenda? | **sí** (con la semana libre podía decir que sólo el jueves tenía agenda) | no, dentro de la ventana |
| «Los días ausentes NO tienen agenda» (contrato 015) | **falso** | **cierto**, dentro de la ventana `days` |

Es un **superconjunto** del valor anterior: todo día que antes aparecía sigue apareciendo. Nuevo
campo **`diasConAgendaHorizonte`**: los días con agenda de **todo** el horizonte (lo que ve la
instancia, p. ej. 7 días), por si quieres ofrecer «también tengo la semana siguiente» sin otra llamada.

Si tu código asumía «cada día de `diasConAgenda` tiene al menos un horario en `slots`», deja de
valer: usa `hasMore`/`total` para saber que hay más, o pide ese día con `day=`.

### Quién llama a este endpoint (auditoría de consumidores)

| Consumidor | Parámetros | ¿Afectado? |
|---|---|---|
| Agente integrado (in-process) | no lo llama: usa `offerSlots`/`checkAvailability` directo | No |
| `scripts/e2e-selftest.mjs` | explícitos (`limit=12&perDay=3&days=5`) salvo el bloque de 025, que usa los defaults a propósito | No (el bloque de 025 verifica el comportamiento nuevo) |
| `scripts/qa-simular-prospecto.mjs` | explícitos (`limit=6&perDay=3&days=5`) | No |
| Cerebro externo de la instancia (`BOT_API_KEY`) | **No se conoce ningún consumidor externo activo** (nada en el repositorio ni en la documentación de la instancia lo referencia; el agente que atiende hoy es el integrado) | Sólo un consumidor hipotético que llame sin parámetros o lea `diasConAgenda` (ver arriba). **No bloquea el despliegue** |

### Decisión: sólo documentación, sin versionar y sin bandera de compatibilidad

- Los defaults anteriores eran un **defecto** (contradecían el contrato publicado): mantenerlos tras
  una bandera perpetúa el bug; quien dependa de ellos puede pedirlos explícitos (`limit=1&perDay=1&days=1`).
- `diasConAgenda` sólo **crece** hacia lo que el contrato ya decía; ningún día deja de aparecer.
- Los campos nuevos son aditivos; un cliente que los ignora sigue funcionando.
- Un `/v2` o una bandera temporal añadiría una superficie que mantener sin proteger a ningún
  consumidor conocido. Si algún día aparece un cerebro externo, esta página es su contrato: no hace falta
  confirmar nada antes de desplegar.

## Campos nuevos en la respuesta

| Campo | Significado |
|---|---|
| `exhaustive` | `slots` contiene **todos** los horarios que cumplen la consulta |
| `hasMore` | Hay horarios que cumplen y **no** vienen en `slots` (`total > slots.length`) |
| `total` | Cuántos cumplen la consulta, completos |
| `scopeComplete` | El alcance se evaluó completo contra el motor |
| `horizonDays` | Cuántos días hacia adelante agenda esta instancia |
| `kind` | `suggestions` (lista por defecto) · `day` · `range` · `edge` · `overview`… |

## La regla

**Nunca digas «no hay disponibilidad» basándote en `slots` si `hasMore` es `true` o `exhaustive`
es `false`.** Una lista parcial es una muestra: consulta el día u hora concretos (abajo).

## Consulta directa: `day`, `from`, `to`

`GET /api/bot/availability?conversationId=…&day=mañana` devuelve **todos** los horarios libres de
ese día (`exhaustive:true` si caben en el tope de 60), con las mismas reglas que el agente integrado:
horario del negocio, zona horaria, duración, aviso mínimo, buffers y citas existentes.

- `day`: `hoy`, `mañana`, `pasado mañana`, `lunes`… (el **próximo**), `25 de septiembre`, `2026-09-25`.
- `from` / `to`: rango de inicio y fin, p. ej. `from=2 pm&to=5 pm` (inicio ≥ 14:00 y fin ≤ 17:00).
- `resumen`: el texto exacto que el agente integrado mandaría (útil como referencia o para copiarlo).
- Un `day`/hora que no se entiende responde `422 invalid_query`: **no** una lista vacía.

Como siempre, esta llamada **registra** la oferta (`active`): es lo que habilita `POST /api/bot/bookings`.

## Adenda (spec 026, propuesta — pendiente de commit/despliegue)

Aditivo, sin versionar (mismo criterio que arriba):

- **`day`** entiende ahora el calificador de semana: `este jueves` (semana calendario actual,
  puede ser hoy; si ya pasó, `422` en vez de reinterpretar en silencio) vs `jueves de la próxima
  semana` (siempre la semana calendario siguiente) vs `jueves`/`el próximo jueves`/`jueves que
  viene` (la ocurrencia más cercana, sin cambio de 025).
- **`altDays`** (nuevo, lista separada por comas: `altDays=jueves,viernes`): días alternativos,
  tope 3, evaluados en el **orden dado**. `kind` gana el valor `"days"`. **No se llama `days`**:
  ese nombre ya lo tiene la ventana numérica de arriba (`LIMITS.days`, por defecto 5) — reusarlo
  habría chocado con ese contrato ya publicado; el error se detectó y corrigió con
  `pnpm test:integration` durante la implementación, antes de publicarse.
- Un `day`/`altDays` que no se entiende sigue respondiendo `422 invalid_query`, con el mismo texto
  que vería el prospecto por WhatsApp.
