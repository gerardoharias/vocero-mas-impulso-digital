# 024 — Entrega y reintento íntegro de mensajes salientes de WhatsApp

**Carril**: ciclo completo (Principio VI). Toca el modelo de datos (migración
`0023`) y amplía, de forma aditiva, dos contratos publicados: los `status` del
DTO de mensaje y del evento SSE `message.status`. Artefactos:
[`plan.md`](plan.md), [`data-model.md`](data-model.md), [`tasks.md`](tasks.md).

**No modifica la spec 023** (respuesta estructurada del agente): esa spec trata
de qué hacer cuando *el modelo* no responde con el formato pedido; esta trata de
qué hacer cuando *Meta* no acepta un mensaje ya armado. Se tocan zonas
contiguas de `pipeline.ts` pero con propósitos distintos, y ninguna decisión de
023 cambia (ver §7, D9).

**Estado**: implementada y verificada (§9), con el cierre pre-despliegue (§5.6, contrato del bot y
[runbook](../../docs/runbook-024-outbox.md)).

**Constitution Check** (antes de escribir código): **I Seguridad** — los
identificadores de trazabilidad y códigos de Meta se guardan saneados; ni
token, ni teléfono, ni texto del cliente en logs (§5.4). **II Soberanía** — sin
cola externa ni dependencia nueva: el outbox se apoya en la tabla `message` y en
un temporizador in-process, igual que el sweeper. **III** — la tabla nueva lleva
`organization_id NOT NULL`. **IV Idempotencia** — es el corazón de esta spec:
`dedupe_key` UNIQUE, reclamo atómico del intento, estados monotónicos.
**Sandbox del Laboratorio** — intacto: las conversaciones `is_test` no entran al
outbox ni tocan `graphRequest` (la aserción de `prepareSend` se conserva y se
re-evalúa en cada intento). Sin violaciones.

---

## 1. Incidente y causa raíz demostrada

### 1.1 Lo ocurrido

Un prospecto aceptó agendar. `offer_slots` armó:

```
¡Perfecto! Te comparto los horarios disponibles para tu llamada inicial sin costo.
• lunes, 21 de septiembre a las 09:00
• martes, 22 de septiembre a las 09:00
• miércoles, 23 de septiembre a las 09:00
```

Meta rechazó temporalmente el envío; el CRM mostró «No se entregó. Meta no está
disponible ahora». Después apareció **entregado** otro mensaje: sólo la
introducción. El prospecto no pudo elegir horario.

### 1.2 Reproducción determinista (Fase 1)

`tests/integration/outbound-incident.test.ts`, escrita **antes** de la
corrección y contra Postgres real (BD desechable con las migraciones reales),
sólo con Meta, el proveedor de IA y la disponibilidad simulados. Un inbound
entra por `processMessagesValue` (el mismo camino que el webhook), el primer
envío a Meta responde `503 / code 2` y el segundo acepta. Traza obtenida contra
el código **anterior** (sin datos personales):

| Medida | Valor |
|---|---|
| Ejecuciones del pipeline | **1** |
| Llamadas de IA | **1** |
| Consultas de disponibilidad | **1** |
| Ejecuciones de `offer_slots` | **1** |
| Evento entrante | `wamid.IN.1` (uno) |
| Filas de outbox / intentos | **no existe outbox** |
| Filas `message` salientes | **2**: `failed` (4 líneas, sin `wamid`, error «Meta no está disponible ahora») y `pending` (1 línea, `wamid.OUT.RECOVERED`) |
| Filas `offered_slot` | **8**, escritas antes del envío |
| Handoffs | 0 |
| Intento 1 → Meta | `503/2`, cuerpo de **4 líneas** (mensaje completo) |
| Intento 2 → Meta | `ok`, cuerpo de **1 línea** (sólo la introducción) |
| Log | `[agente] el motor de agenda falló: SendError:meta_unavailable` |

### 1.3 Causa exacta

`src/server/ai/pipeline.ts`, bloque de agenda (antes de esta spec):

```ts
try {
  const turn = action.action === "offer_slots" ? await offerSlots(...) : await bookSlot(...);
  await deliverReply(conversation, turn.text);   // ← el ENVÍO está dentro del try del MOTOR
  ...
  return;
} catch (err) {
  console.error("[agente] el motor de agenda falló: ...");
  action = degradeAction(action);                // offer_slots → { action: "reply", text: action.reply }
}
...
case "reply": await deliverReply(conversation, action.text);   // ← sólo la introducción del modelo
```

Un `SendError` de transporte (Meta caído) se **confunde con un fallo del motor
de agenda**. La rama de degradación —pensada para «el motor falló: responde sin
agendar»— convierte `offer_slots` en un `reply` con el texto base de la IA
(`action.reply`, la introducción) y lo envía **en el mismo turno**, inmediatamente
después. No es un reintento: es una **sustitución** del mensaje completo por su
introducción. Meta, ya recuperada, acepta el segundo envío.

Lo que hizo peor el defecto: `offerSlots` registra los huecos en `offered_slot`
**antes** de enviar. Los 8 huecos quedaron «ofrecidos» aunque el prospecto sólo
vio la introducción; el siguiente turno del agente los recibe en su prompt como
si el cliente los hubiera visto.

### 1.4 Hipótesis confirmadas y descartadas

| # | Hipótesis | Veredicto | Evidencia |
|---|---|---|---|
| 1 | Reintento usando únicamente el texto base de la IA | **CONFIRMADA** (como sustitución en el mismo turno, no como reintento programado) | Intento 2 = 1 línea = `action.reply`; log del `catch` del motor |
| 2 | Pérdida del texto enriquecido al persistir el outbox | **DESCARTADA** | No hay outbox; la fila `failed` conservó las 4 líneas. El texto no se perdía: se **descartaba** |
| 3 | Nueva ejecución del mismo inbound | **DESCARTADA** | 1 pipeline, 1 IA, 1 agenda, 1 evento; y un inbound duplicado tampoco re-ejecuta (`outbound-diagnosis.test.ts`) |
| 4 | Disponibilidad marcada como ofrecida antes del envío | **CONFIRMADA** (defecto asociado) | 8 `offered_slot` con el primer envío fallido y sin que el prospecto viera ninguno |
| 5 | Reintento que vuelve a ejecutar `offer_slots` | **DESCARTADA** | `offerSlotsExecutions = 1`, `availabilityQueries = 1` |
| 6 | Tratamiento incorrecto de un callback de estado de Meta | **DESCARTADA** para este incidente | El fallo fue **síncrono** (sin `wamid`); ningún `statuses` intervino. Además, un `failed` asíncrono sólo toca la fila del `wamid` y no dispara al agente (`outbound-diagnosis.test.ts`) |

Sobre «un minuto después»: el código no tiene ningún temporizador entre los dos
envíos (el segundo va inmediatamente tras la excepción del primero), y
`graphRequest` **no tenía timeout**. La demora observada es compatible con un
primer `fetch` lento hasta que Meta respondió 5xx; **no es reproducible de forma
determinista y no se afirma como causa**.

### 1.5 Defectos de la misma clase hallados al auditar

- `book_slot` ya reservada + envío de la confirmación fallido → el mismo `catch`
  degradaba a `reply` con `action.reply` (la confirmación **sin** enlace ni
  fecha). Misma raíz, misma corrección.
- Los mensajes de texto no existían en BD hasta que Graph respondía: un proceso
  que muere durante el envío pierde el mensaje sin rastro.
- `graphRequest` sin timeout: un Meta colgado bloquea el turno indefinidamente.
- Un `200` sin `messages[0].id` se trataba como error definitivo, aunque Meta
  pudo haber aceptado el mensaje (riesgo de duplicado si se reenvía).

---

## 2. Garantías (contrato)

| # | Garantía | Cómo se sostiene |
|---|---|---|
| G1 | El payload final se construye **una sola vez** | `offerSlots`/`bookSlot` devuelven el texto final; nadie lo reconstruye |
| G2 | El payload definitivo —horarios, enlaces, saltos de línea, todo lo añadido por acciones— se **persiste antes del primer intento** | `enqueue` inserta la fila `queued` con `message.text` **antes** de llamar a Meta |
| G3 | Cada intento usa ese payload persistido e **inmutable** | El intento lee `message.text` de BD; un trigger de BD rechaza cambiar `text` de un saliente |
| G4 | Un reintento de transporte no vuelve a ejecutar modelo, pipeline, `offer_slots`, disponibilidad ni efectos de la acción | El reintento vive en `server/outbox/`, que **no importa** `ai/`, `agenda/agent` ni el pipeline |
| G5 | Un mismo evento entrante no genera dos ejecuciones lógicas | Ingesta: `wa_message_id` UNIQUE. Turno: `dedupe_key = agent-turn:<id del inbound>` UNIQUE + comprobación al inicio del turno |
| G6 | Un mensaje lógico → varios intentos, **una** representación visible | Los intentos son filas de `message_delivery_attempt`; la burbuja es la fila `message` |
| G7 | **Nunca** se sustituye un mensaje fallido por una introducción, resumen o fallback | El envío sale del `try` del motor; un fallo de envío no dispara `degradeAction` |
| G8 | Los horarios ofrecidos quedan vinculados al mensaje lógico y siguen seleccionables tras un reintento exitoso | `offered_slot.message_id` + `state`: `pending` hasta que Meta acepta el mensaje, entonces `active`; `message.offer_state` recuerda si la ronda sigue vigente (§5.6) |
| G9 | Ningún reintento reserva una cita ni repite efectos | El outbox sólo reenvía `message.text`; `bookSlot` corre una sola vez, antes del envío |
| G10 | Errores y reintentos no generan llamadas facturables de IA | El outbox no importa `@/lib/ai`; probado con el contador de llamadas |

---

## 3. Modelo lógico

Un **mensaje lógico** es una fila de `message` (dirección `out`). Su **payload
final** es `message.text`, inmutable desde el `INSERT`. Un **intento** es una
fila de `message_delivery_attempt` (número correlativo, único por mensaje). El
mensaje **es** el outbox: no hay una segunda cola (constitución II y el
principio de ampliar lo existente).

### 3.1 Estados (`message.status`)

Los estados existentes se conservan con su significado; se añaden cuatro.

| Estado | Significado | Equivale a (vocabulario de la spec) |
|---|---|---|
| `queued` *(nuevo)* | Persistido, ningún intento reclamado todavía | queued |
| `sending` *(nuevo)* | Un trabajador reclamó el intento; en vuelo | sending |
| `pending` | Meta aceptó (hay `wamid`), espera acuses | sent/accepted |
| `sent` | Meta confirmó envío | sent |
| `delivered` | Entregado al teléfono | delivered |
| `read` | Leído | read |
| `retrying` *(nuevo)* | Fallo **recuperable**; próximo intento en `next_attempt_at` | retrying |
| `delivery_unknown` *(nuevo)* | Resultado ambiguo: **no** se reenvía solo | delivery_unknown |
| `failed` | Terminal: permanente, agotado o rechazado; payload conservado | failed_final |

`failed` conserva su nombre (lo leen la UI, `pending.ts`, las consultas y los
guiones E2E); se documenta como *failed_final*. Transiciones permitidas:

```
queued ──claim──▶ sending ──accepted──▶ pending ─▶ sent ─▶ delivered ─▶ read
                     │                     │
                     │                     └─ webhook `failed` ─▶ retrying │ failed
                     ├─ transitorio y quedan intentos ─▶ retrying ──claim──▶ sending
                     ├─ transitorio agotado / permanente ─────────────▶ failed
                     └─ ambiguo (timeout, 5xx sin código, sin wamid, crash) ─▶ delivery_unknown
failed | delivery_unknown ──(reenvío MANUAL, un intento)──▶ sending
```

---

## 4. Política de errores (Fase 3)

La clasificación se decide por **código de Meta + etapa + señal de red**, nunca
sólo por HTTP status y **nunca por texto** (los textos de Meta están traducidos
y cambian). Implementación pura en `src/server/outbox/policy.ts`.

### 4.1 Etapas

| Etapa | Cuándo | Consecuencia |
|---|---|---|
| **Síncrona, respuesta con error de Meta** | `POST /messages` responde con `error.code` | Meta **no aceptó** el mensaje: la decisión es segura. Manda el código |
| **Síncrona, sin respuesta útil** | timeout, corte de conexión, `5xx` sin código de Meta, `200` sin `messages[0].id`, el proceso murió con el intento en vuelo | Meta **pudo haberlo aceptado**: ambiguo |
| **Asíncrona** | El envío fue aceptado (hay `wamid`) y luego llega `statuses[].status = failed` con `errors[0].code` | Meta declara que **no entregó**: reenviar es seguro; manda el código |

### 4.2 Clases

| Clase | Reintenta | Estado final si no se recupera | Códigos / señal |
|---|---|---|---|
| `transient` | **sí** | `failed` | `2`, `131016`, `133004`, `131057`; `1` sólo con HTTP ≥ 500; HTTP `503` sin código; fallo de red **antes** de conectar (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) |
| `rate_limit` | **sí** (espera mayor) | `failed` | `4`, `80007`, `130429`, `131056`; HTTP `429` sin código |
| `ambiguous` | **no** (nunca automático) | `delivery_unknown` | timeout; error de red tras conectar / desconocido; HTTP `500`/`502`/`504` sin código de Meta; `200` sin id; intento huérfano por caída del proceso |
| `window_closed` | no | `failed` | `131047`; y la comprobación local de las 24 h |
| `recipient_unavailable` | no | `failed` | `131026`, `131030`, `131021` |
| `auth` | no | `failed` (+ `reconnect_required` en la conexión) | `190`, HTTP `401` |
| `offer_stale` *(no viene de Meta)* | no | `failed` | la oferta ya no es vigente o algún horario mostrado dejó de estar libre (§5.6) |
| `permanent` | no | `failed` | **cualquier otro código de Meta** (incluye `131048`, `131049`, `130472`, `131031`, `132xxx`, `368`, `131000`) y cualquier `4xx` sin código |

La lista de reintentables es **deliberadamente corta y explícita**: un código
desconocido es `permanent`, no reintentable. Ampliarla es una línea en
`policy.ts` y su caso en `tests/unit/outbox-policy.test.ts`.

Un `failed` asíncrono **sin código** es `permanent` (sin evidencia, no se
reenvía).

### 4.3 Parámetros (valores elegidos)

| Parámetro | Valor | Nota |
|---|---|---|
| Intentos máximos | **3** por ciclo automático (1 inicial + 2 reintentos) | «tres fallos temporales agotados» → `failed` |
| Espera tras fallo `transient` nº *n* | `min(60 s, 5 s · 4^(n-1))` → 5 s, 20 s | base `OUTBOX_RETRY_BASE_MS` (defecto 5000), tope `OUTBOX_RETRY_CAP_MS` (60000) |
| Espera tras fallo `rate_limit` nº *n* | `min(300 s, 30 s · 4^(n-1))` → 30 s, 120 s | base = 6 × la anterior |
| Jitter | **equal jitter**: espera efectiva ∈ [½·d, d] uniforme | evita reintentos sincronizados |
| Timeout por intento (HTTP a Meta) | 30 s (`AbortSignal.timeout`) | un timeout es `ambiguous` |
| Arrendamiento (`locked_until`) | 60 s | un `sending` con arrendamiento vencido es un intento huérfano → `delivery_unknown` |
| Barrido | cada 5 s (`OUTBOX_POLL_MS`), más un temporizador puntual por reintento | además de reanudar tras un reinicio |
| Reenvío manual | **un** intento, sin reintentos automáticos posteriores | la decisión de asumir el riesgo de duplicado es del operador |

Peor caso de latencia automática: ≈ 25 s (`transient`) o ≈ 2.5 min
(`rate_limit`), muy por dentro de la ventana de 24 h; la ventana se **vuelve a
comprobar** en cada intento.

### 4.4 Ambiguo: por qué no se reenvía

La Cloud API **no ofrece clave de idempotencia** en `POST /messages`. Si un
timeout ocurrió tras aceptar Meta el mensaje, reenviar entrega dos veces al
prospecto. El estado `delivery_unknown` retiene el mensaje (payload íntegro,
visible como «Sin confirmar») hasta que haya evidencia o decisión humana:
reenvío manual explícito. No existe evidencia automática posible sin `wamid`
(los `statuses` de Meta se identifican por él); esto se declara riesgo residual
en §7.

---

## 5. Comportamiento observable y criterios de aceptación

### 5.1 Envío

- **AC-1** Todo saliente de texto existe en BD (`queued`, con su texto final)
  **antes** del primer intento a Meta.
- **AC-2** Fallo `transient` → la burbuja pasa a **«Reintentando»** y, si el
  siguiente intento acepta, queda como enviado normalmente: **una sola burbuja**
  (mismo `id`) con el `wamid` del intento que tuvo éxito.
- **AC-3** El cuerpo enviado en **todos** los intentos es idéntico y es exactamente
  `message.text`.
- **AC-4** 3 fallos `transient` seguidos → `failed`, con el payload íntegro
  conservado y **ningún** mensaje alternativo.
- **AC-5** Error `permanent` → 1 intento, `failed`, sin reintento.
- **AC-6** Timeout / resultado ambiguo → `delivery_unknown`, 1 solo envío a Meta.
- **AC-7** `statuses.failed` tras obtener `wamid` → actualiza el **mismo** mensaje
  y aplica la política del código (reintentable → `retrying`; el resto → `failed`).
- **AC-8** Reinicio del proceso entre intentos → el reintento continúa desde lo
  persistido, sin IA, sin pipeline y sin agenda.
- **AC-9** Dos trabajadores concurrentes → un solo envío por intento.
- **AC-10** Un evento entrante duplicado no vuelve a ejecutar agente ni agenda.

### 5.2 Agenda

- **AC-11** Con `offer_slots`, los `offered_slot` nacen `pending`, ligados al
  mensaje. No son seleccionables (`getOffers` sólo lee `active`) hasta que Meta
  acepta el mensaje; entonces pasan a `active` y reemplazan la ronda anterior.
- **AC-12** Tras un reintento exitoso, el prospecto puede elegir uno de los
  horarios y la reserva se crea una vez.
- **AC-13** Ningún reintento invoca `bookSlot`, `offerSlots` ni
  `computeAvailability`.
- **AC-14** Si el envío de la confirmación de `book_slot` falla, la cita ya
  existe y el mensaje se reintenta **íntegro** (con enlace y fecha).

### 5.3 CRM

- **AC-15** `retrying` se muestra como «Reintentando…»; `delivery_unknown` como
  «Sin confirmar: no sabemos si llegó» con acción **Reenviar**; `failed` como «No
  se entregó» con **Reenviar**. Nunca dos burbujas para un mismo mensaje lógico.
- **AC-16** «Pendiente de responder» (`pending.ts`) cuenta `failed` y
  `delivery_unknown` como no respondido.

### 5.4 Privacidad y seguridad

- **AC-17** Los logs del outbox llevan sólo lista blanca: `id` de mensaje, número
  de intento, clase, código de Meta, siguiente intento. Ni token, ni teléfono, ni
  texto de la conversación, ni cuerpos de Meta.
- **AC-18** En BD sólo se guarda `code`, `subcode`, clase, HTTP status y `wamid`
  por intento; **no** el JSON de error de Meta.

---

### 5.6 Ofertas de horarios: reenvío manual y semántica de `pending` (cierre pre-despliegue)

**Semántica, dicha sin ambigüedad.** Un horario `pending` **no reserva
disponibilidad**: es una opción que el prospecto todavía no ha visto. No bloquea a
nadie, no expira por sí sola y no impide que otro prospecto reserve ese hueco (gana
el primero: el índice único de `booking` lo decide, como siempre). No existen
reservas fantasma ni bloqueos indefinidos: una fila `pending` jamás se consulta para
calcular disponibilidad, y desaparece en cuanto cualquier ronda posterior se activa
(`activateOffers`), se registra (`replaceOffers`) o el prospecto reserva (`clearOffers`).

**Qué pasa si otro prospecto ocupa el hueco durante el backoff** (demostrado en
`outbound-offer-guard.test.ts` y en el E2E): como el texto es inmutable (G3) no se
puede «quitar» ese horario, así que el mensaje **no se envía**. Antes de **cada**
reintento automático de un mensaje que mostraba horarios se revalida —sólo contra la
base, sin ejecutar el motor de disponibilidad ni `offer_slots`— lo que el texto
**enseña** (`offered_slot.shown`). Si el sistema ya sabe que algo dejó de estar libre:

1. no sale nada (ni completo ni parcial), y no se llama a IA ni a agenda;
2. el mensaje queda `failed`, clase `offer_stale`, con su payload íntegro;
3. su ronda pasa a `superseded` (obsoleta) y ya no se reenvía ni manual ni automáticamente;
4. el operador ve por qué y qué hacer: *«genera una nueva ronda con la disponibilidad actualizada»*.

Ventana residual, declarada: entre la revalidación y la aceptación de Meta
(milisegundos) otro prospecto podría reservar. Si el prospecto elige ese horario, la
reserva la rechaza el servidor (`slot_taken`) y el agente re-ofrece con datos frescos:
nunca se agenda algo ocupado.

**Reenvío manual.** Sólo se permite si se cumplen **todas**; si falla una, se bloquea con
`409 offer_stale` y no cambia nada:

| Regla | Comprobación | Causa (`reason`) |
|---|---|---|
| El mensaje es de la misma organización y conversación | filtro por `organization_id` y `conversation_id` | «no encontrado» |
| El estado admite reenvío | `failed` o `delivery_unknown` | `409 resend_conflict` |
| La ronda no fue sustituida, cancelada, reservada ni marcada obsoleta | `message.offer_state ∈ {pending, active}` | `superseded` |
| No existe una ronda posterior en la conversación | otro mensaje con `offer_state` no nulo y más nuevo | `later_round` |
| Sus horarios existen | filas `shown` ligadas al mensaje | `no_offers` |
| Ninguno venció | `start ≥ ahora + aviso mínimo` | `expired` |
| Ninguno está ocupado | sin cita ni bloqueo activo solapado | `occupied` |
| El motor de disponibilidad de HOY todavía ofrece cada uno | `computeAvailability` (sólo en el manual) | `unavailable` |

El bloqueo es de sólo lectura salvo por marcar **obsoleta esa** ronda cuando la causa es
definitiva (`expired`, `occupied`, `unavailable`): no toca la ronda vigente, no crea
mensajes, no ejecuta IA ni `offer_slots`, y **no envía horarios parciales**. El reenvío
permitido manda exactamente `message.text`. Dos operadores a la vez: el reclamo atómico
del intento deja pasar a uno; el otro recibe `409 resend_conflict`.

Estado de la ronda en el mensaje (`message.offer_state`):

```
(no es oferta) = NULL
pending ──Meta acepta──▶ active ──otra ronda / re-oferta / revalidación──▶ superseded
   │                        └──el prospecto reserva──▶ consumed
   └──otra ronda / re-oferta / revalidación (reintento o reenvío)──▶ superseded
```

### 5.7 Re-ofertas de `bookSlot` (deuda residual R-1, cerrada)

Cuando el horario que el prospecto eligió acaba de ocuparse (`slot_taken`) —o el modelo pidió uno que
nunca se ofreció (`slot_not_offered`)— el agente responde con **alternativas**: es una oferta de horarios
más, y usa **exactamente la misma vía** que `offer_slots` (§5.6). Antes, `createSessionBooking` las
registraba como `active` (`refreshOffer`) **antes** de que existiera el mensaje: si el envío fallaba, el
prospecto no había visto nada y el sistema ya las daba por ofrecidas.

| Requisito | Cómo se cumple |
|---|---|
| No registrar horarios `active` antes de que Meta acepte | `createSessionBooking({ registerAlternatives: false })` (lo pasa `bookSlot`) devuelve las alternativas **sin** escribir `offered_slot`. Por omisión (`true`) el comportamiento es el de siempre: lo necesita el cerebro externo (`/api/bot/bookings`), que las muestra por su cuenta |
| Persistir mensaje y horarios `pending` juntos | `AgendaTurn.offers` (todas las alternativas; `shown` = las 3 que enseña el texto) → `sendText({ offers })` → una transacción: `message(queued, offer_state='pending')` + `offered_slot(pending)` |
| Activar sólo cuando Meta acepta | `activateOffers` al aceptar el intento (igual que `offer_slots`); si no se acepta, siguen `pending` y no seleccionables |
| Revalidar antes de cada reintento automático | mismo `checkOfferFreshness` (sólo BD): una alternativa ocupada/vencida ⇒ no se envía, `failed` `offer_stale`, ronda `superseded` |
| Mismo guard para el reenvío manual | mismo `blockReasonForManualResend`: ronda posterior, horario vencido u ocupado, o ya no ofrecido por el motor de hoy ⇒ `409 offer_stale` |
| No enviar alternativas parciales | el texto es inmutable (G3): sale completo o no sale |
| No volver a ejecutar IA, `bookSlot`, `offer_slots` ni efectos | el reintento/reenvío vive en `server/outbox/` (§2 G4, G9, G10); la reserva nunca se repite |
| Una re-oferta antigua no sustituye una ronda vigente | `offer_state`: si hay una ronda posterior o ya se sustituyó, el reenvío se bloquea; y una ronda `pending` que no llegó **no** reemplaza a la vigente (sólo `activateOffers` sustituye) |
| Una sola representación visible | el mismo mensaje lógico: reintentos y reenvío reutilizan su fila |

Pruebas: `tests/integration/outbound-reoffer.test.ts` (15 casos, con comprobación de mutación),
`tests/unit/book-slot-reoffer.test.ts`, `tests/unit/booking-race.test.ts` y el bloque F del E2E.
Continúa en la [025](../025-consultas-disponibilidad-calendario/spec.md): las consultas directas de
disponibilidad reutilizan esta vía (`offers` → `sendText`, `pending` → `active`) y **no** modifican
`registerAlternatives`; sólo cambia qué alternativas se calculan (las cercanas a lo pedido).
Relación con otras specs: el motor de reserva es el de la [015](../015-motor-agenda-universal/spec.md); la
degradación del turno es la de la [023](../023-respuesta-estructurada-agente/spec.md); esta sección sólo
cambia **cómo viaja** la respuesta, no qué decide el agente.

### 5.5 Contratos publicados afectados (todos aditivos)

| Contrato | Cambio |
|---|---|
| `MessageDto.status` y SSE `message.status` | +`queued`, `sending`, `retrying`, `delivery_unknown` (ver `contracts/sse.md`) |
| `POST /api/conversations/:id/messages`, `POST /api/bot/messages` | La respuesta añade `status` (y el bot, `contract: 2` + header `X-Vocero-Send-Contract`; guía y ejemplo de manejo en [`docs/bot-messages-contrato.md`](../../docs/bot-messages-contrato.md), probados en `bot-send-contract.test.ts`). **Comportamiento**: un fallo RECUPERABLE de Meta (5xx/límite de frecuencia) ya no responde `502/503`: responde `200` con `status: "retrying"` (el mensaje existe y se reenvía solo). Un resultado ambiguo responde `200` con `status: "delivery_unknown"`. Un rechazo definitivo sigue respondiendo error (`422`/`502`) con el mismo `code`. **Un cerebro externo NO debe reenviar por su cuenta un `200`**: duplicaría |
| `POST /api/conversations/:id/messages/:messageId/resend` | Nueva. Reenvío manual de `failed`/`delivery_unknown` (un intento). `409 offer_stale` si la oferta ya no es vigente; `409 resend_conflict` si otro operador ya lo reenvió |
| `GET /api/health` | Añade `outbox: { worker: boolean }` (¿arrancó el trabajador en este proceso?). Aditivo |
| Webhook de estados | Sin cambio de forma; `failed` con `wamid` aplica la política por código |
| `/api/dev/wa-mock/fail-next` y `rejected` en el outbox del mock | Nuevos, sólo dev/test (404 en producción por `mockGuard`) |

## 6. Alcance

**Dentro**: envío de **texto** por WhatsApp Cloud API iniciado por el agente, el
operador (`POST /api/conversations/:id/messages`) o el cerebro externo
(`POST /api/bot/messages`); política de errores; outbox; ofertas de agenda
ligadas al mensaje; UI de estados; reenvío manual.

**Fuera**, con motivo:

- **Adjuntos, ubicaciones y contactos** (`sendMediaMessage`, `sendStructured`):
  su payload incluye un archivo/subida previa y su ruta ya persiste `failed` con
  el activo en disco. Se conservan sin cambio; se migrarán al outbox cuando haya
  un incidente que lo justifique.
- **Plantillas** (`templates.ts`): usan `callGraphSend` directamente. Sin cambio.
- **Instagram y Messenger** (Zernio): sus códigos de error no son los de Meta y
  la tabla de §4 no aplica. Pasan por el mismo «persistir antes de enviar» pero
  **sin reintento automático**: cualquier fallo → `failed` (como hoy).
- **Reanudar un turno del agente que murió** antes de generar respuesta (el
  proceso cae entre la ingesta y el turno): es el coalesce in-process de siempre;
  no es esta spec.

## 7. Decisiones y riesgos residuales

Decisiones (Principio VII; cada una revisable):

- **D1** El outbox es la tabla `message` + `message_delivery_attempt`, no una
  cola nueva. *Por qué*: soberanía (II), cero infraestructura, y la burbuja del
  CRM ya es esa fila.
- **D2** `failed` == failed_final (no se renombra). *Por qué*: contrato con la UI,
  las consultas y los E2E.
- **D3** Un timeout es `ambiguous`, no `transient`. *Por qué*: el usuario pidió no
  arriesgar duplicados; el coste es que un prospecto pueda quedar sin el mensaje
  hasta el reenvío manual.
- **D4** Un `auth` deja fila `failed` (antes, ninguna). *Por qué*: el prospecto no
  recibió nada y el payload se conserva para reenviar tras reconectar.
- **D5** Los pre-vuelos (`window_closed`, `not_connected`, `reconnect_required`,
  `sandbox_violation`) siguen **sin** crear fila: no hubo intento, y cada uno
  tiene su UX (traspaso por ventana, banner, guardrail).
- **D6** Las ofertas de agenda se activan **cuando Meta acepta** el mensaje, no
  cuando el prospecto lo lee. *Por qué*: es la única señal síncrona y fiable.
- **D7** `delivery_unknown` **no** activa las ofertas. *Por qué*: sin evidencia de
  entrega, aceptar una reserva sobre horarios quizá no vistos es peor que
  re-ofrecer.
- **D8** `dedupe_key` sólo en respuestas del agente real (`agent-turn:<inbound>`);
  el Laboratorio (`is_test`) no lo usa.
- **D10** `pending` no reserva disponibilidad (§5.6). *Por qué*: reservar sin evidencia de entrega
  crearía bloqueos fantasma si el mensaje nunca sale; el índice único de `booking` ya arbitra.
- **D11** Ante la duda, una oferta NO se envía: cualquier ronda posterior (aunque también haya fallado)
  bloquea el reenvío de la anterior. *Por qué*: reenviar una ronda vieja es peor que pedir una nueva.
- **D12** El reintento AUTOMÁTICO revalida sólo contra la base (sin motor de disponibilidad); el
  MANUAL, además, contra el motor. *Por qué*: G4 prohíbe que un reintento recalcule la agenda; el
  operador, en cambio, está tomando una decisión y necesita la disponibilidad de hoy.
- **D13** Las alternativas de una re-oferta viajan con el mensaje (`pending`), no las registra el motor de
  reserva. *Por qué*: el registro anticipado era la misma falla que `offer_slots` (horarios «ofrecidos»
  que nadie vio); el motor sigue sirviendo al cerebro externo con `registerAlternatives` por omisión.
- **D9** La spec 023 no cambia. Se añade una referencia cruzada en
  `specs/README.md` y nada más.

Riesgos residuales:

- Un mensaje `delivery_unknown` que en realidad **sí** llegó, y que el operador
  reenvía, se duplica. Es una decisión humana y consciente.
- Un `delivery_unknown` que **no** llegó deja al prospecto sin el mensaje hasta
  que alguien lo vea: mitigado con «pendiente de responder» (AC-16), no eliminado.
- ~~Re-ofertas de `bookSlot` sin guard~~ — **cerrado** en §5.7: usan la misma vía que `offer_slots`.
  Sigue fuera de esta vía la re-oferta del **cerebro externo** (`/api/bot/bookings` registra las alternativas
  `active` y el cerebro las muestra por su cuenta: el CRM no envía ese mensaje, así que no hay nada que reintentar).
- Un proceso que cae **entre** la ingesta y el turno sigue perdiendo ese turno
  (fuera de alcance).
- Sólo hay un intento en vuelo a la vez por mensaje, pero **varias instancias**
  de la app comparten la BD: el reclamo atómico lo cubre; el temporizador
  puntual es por proceso y el barrido de 5 s lo respalda.

## 8. Costos

- **Meta**: los mensajes de servicio dentro de la ventana de 24 h no se
  facturan por mensaje; un reintento tras un rechazo **sin aceptación** no
  genera un mensaje adicional. El único riesgo de sobrecoste/duplicado es el
  reenvío tras aceptación desconocida, que aquí es manual. Peor caso automático:
  3 llamadas HTTP por mensaje, de las cuales a lo sumo una es aceptada.
- **IA**: **cero** llamadas adicionales por reintento (G10); antes, este
  incidente no las generaba tampoco, pero la degradación reenviaba dentro del
  turno. El turno sigue con su presupuesto de ≤ 3 llamadas (023).

## 9. Verificación

Ver [`tasks.md`](tasks.md) para el resultado de cada compuerta.
