# 025 — Modelo de datos

**Sin migración.** Esta spec no agrega tablas ni columnas: reutiliza lo que 024 ya
dejó en la migración `0023`.

| Se reutiliza | De | Para qué aquí |
|---|---|---|
| `offered_slot.shown` | 024 §5.6 | Marca los horarios que el **texto** enseña; sólo esos se revalidan antes de un reintento o reenvío. Una consulta registra **todo** el alcance (tope 60) y marca `shown` lo transmitido |
| `offered_slot.state` (`pending`/`active`) | 024 | Las ofertas de una consulta nacen `pending` con el mensaje y se activan al aceptar Meta |
| `offered_slot.message_id` | 024 | Liga el catálogo consultado al mensaje que lo mostró |
| `message.offer_state` | 024 | Estado de la ronda (`pending` · `active` · `superseded` · `consumed`); gobierna reintento y reenvío manual |

## Tipos nuevos (sólo en memoria)

```ts
AvailabilityQuery  = { day?, times?[], from?, to?, edge?: "earliest"|"latest" }   // lo que dijo el prospecto
AvailabilityMeta   = { kind, scopeComplete, exhaustive, hasMore, total, conveyed }  // §4 de la spec
AvailabilityAnswer = { text, offers: OfferedSlot[], meta, matches, ok, status, checks }
AgendaTurn.availability?: AvailabilityMeta   // también lo llevan offer_slots y la re-oferta de bookSlot
```

`AvailabilityMeta` **no se persiste**: viaja en el `AgendaTurn` y en la respuesta de
`GET /api/bot/availability`. Lo que sí queda en base es lo que ya guarda 024 (el mensaje
con su texto inmutable y sus horarios).

## Contrato publicado: `GET /api/bot/availability`

| Campo | Antes | Ahora |
|---|---|---|
| `slots` | lista truncada (`limit`, `perDay`, `days`) | igual, con **defaults corregidos** (12 / 3 / 5). Antes, sin parámetro, ganaba el mínimo (1 / 1 / 1) |
| `diasConAgenda` | días **de la lista truncada** | días con agenda de **toda la ventana `days`** (superconjunto) |
| `diasConAgendaHorizonte` | — | días con agenda de **todo el horizonte** |
| `exhaustive`, `hasMore`, `total`, `scopeComplete`, `horizonDays`, `kind` | — | nuevos (aditivos) |
| `day`, `from`, `to` (query) | — | nuevos: consulta directa y completa (mismas reglas que el agente). `resumen` trae el texto exacto que el agente mandaría. Un día/hora no reconocido ⇒ `422 invalid_query` |

Sigue registrando la oferta como `active` (el cerebro externo muestra la lista por su cuenta;
el CRM no envía ese mensaje, no hay nada que reintentar — 024 §5.7).

## Reversión

Sin migración no hay nada que deshacer en la base. Volver a la versión anterior devuelve el
comportamiento previo del agente y de la API (incluidos sus defectos, que esta spec documenta).
