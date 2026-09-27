# 025 — Consultas de disponibilidad del calendario

**Carril**: ciclo completo (Principio VI). Amplía el esquema de acciones que se le
exige al modelo (`agent action`, contrato `specs/001-vocero-core/contracts/ai.md`) y
un contrato publicado (`GET /api/bot/availability`, aditivo más la corrección de un
defecto de valores por defecto). **No hay migración**: se reutilizan
`offered_slot.shown`, `message.offer_state` y el outbox de la
[spec 024](../024-entrega-integra-mensajes-salientes/spec.md).
Artefactos: [`plan.md`](plan.md), [`data-model.md`](data-model.md), [`tasks.md`](tasks.md).

**Relación con otras specs** (ninguna cambia de propósito):
- **[015](../015-motor-agenda-universal/spec.md)** — el motor de disponibilidad
  (`computeAvailability`) es correcto y es la **única fuente de verdad**; esta spec no lo
  modifica, lo consulta de forma directa y completa.
- **[024](../024-entrega-integra-mensajes-salientes/spec.md) §5.6 y §5.7** — todo horario que
  esta spec ofrece viaja **por la misma vía**: se persiste como `pending` junto con el
  mensaje, se activa sólo cuando Meta lo acepta, se revalida antes de un reintento y pasa por
  el mismo guard en el reenvío manual. La corrección R-1 (`registerAlternatives:false`) **no se
  toca ni se debilita**; aquí sólo cambia *qué* alternativas se calculan, nunca cuándo se
  registran (§6).
- **[023](../023-respuesta-estructurada-agente/spec.md)** — la acción nueva entra al mismo
  esquema estricto y a su registro de contrato.

**Estado**: implementada y verificada (§10).

**Constitution Check**: I Seguridad — sin datos nuevos ni logs con contenido. II Soberanía — sin
dependencia nueva. III Multi-tenancy — toda consulta pasa por `computeAvailability`/`scoped`.
IV Idempotencia — sin escrituras nuevas; las ofertas viajan con el mensaje (024). Sandbox del
Laboratorio — intacto (las ofertas del sandbox siguen activándose al instante, como en 024). Sin
violaciones.

---

## 1. Diagnóstico

Reproducido con el motor **real** (horario, zona horaria, duración, aviso mínimo, buffers y
citas), agenda **vacía** de lunes a viernes 09:00-18:00, «ahora» = jueves 17 sep 2026, 12:00
hora de Ciudad de México: `tests/integration/availability-diagnosis.test.ts` (escrito **antes**
de corregir; 2 casos de caracterización verdes y 3 de contrato en **rojo**).

### 1.1 Evidencia

| Medida (agenda vacía) | Valor |
|---|---|
| Horarios libres reales en el horizonte (7 días) | **97** |
| Horarios libres reales el lunes 21 | **18** (09:00 a 17:30, cada 30 min) |
| Horarios que `offer_slots` registra como reservables | **12** (12 % de lo libre) |
| Del lunes 21, registrados | **3** (09:00, 09:30, 10:00) |
| El lunes 21 a las 16:00 | **libre**, dentro de horario, sin cita… y **nunca se ofrece** |
| Texto de `offer_slots` | tres líneas, **sin ninguna señal** de que hay más |
| Alternativas cuando el lunes 16:00 se ocupa | las **3 primeras del horizonte** (jueves por la tarde), no las de las 15:30/16:30 del lunes |
| `GET /api/bot/availability` sin parámetros | **1 día** con agenda (`diasConAgenda: ["2026-09-17"]`) cuando hay **6** |

### 1.2 Causas (el motor **no** es una de ellas)

| # | Causa | Veredicto |
|---|---|---|
| C1 | **No existe una consulta directa.** El agente sólo puede pedir `offer_slots` (sin parámetros) o `book_slot`. Cuando el prospecto dice «¿mañana?», «¿lunes a las 11 o 12?» o «¿cuál es el más tarde?», el modelo **infiere** la respuesta de las primeras opciones mostradas | **Confirmada** |
| C2 | El catálogo se trunca a 3 por día y 12 en total, sin ningún metadato: nadie puede saber que la lista es **parcial** | **Confirmada** |
| C3 | Las alternativas tras un `slot_taken` son las primeras del horizonte, no las cercanas a lo pedido | **Confirmada** |
| C4 | `GET /api/bot/availability`: (a) `clamp(null)` devuelve el **mínimo** (`Number(null)` es `0`, finito) en vez del valor por defecto, así que sin parámetros da 1 hueco y 1 día; (b) `diasConAgenda` se calcula de la lista **truncada**, con un comentario que afirma que «los días que no están aquí no tienen agenda» | **Confirmada** |
| C5 | El prompt no prohíbe afirmar «no hay disponibilidad» ni explica que la lista es una muestra | **Confirmada** |
| — | El motor de disponibilidad (zona horaria, horario, duración, aviso, buffers, citas) | **Descartada**: el lunes da 18 inicios de 09:00 a 17:30, exactos |
| — | Un fallo de entrega (spec 024) | **Descartada**: es anterior al envío |

El defecto real es de **superficie**: el motor sabe la respuesta completa y correcta, pero
al agente y al cerebro externo sólo les llega una muestra sin marcar como muestra. Con una
agenda vacía, «no tengo a las 4» es **ocupación inventada**.

---

## 2. Garantías

| # | Garantía | Cómo se sostiene |
|---|---|---|
| Q1 | Cuando el prospecto indica un **día, una hora o un rango**, se consulta la disponibilidad **directamente**, no se infiere de las primeras opciones | Acción `check_availability`: el servidor evalúa el alcance pedido contra el motor completo |
| Q2 | Se distingue una **lista parcial** de la **disponibilidad completa** | Metadatos `exhaustive`, `hasMore`, `scopeComplete`, `total`, `conveyed` (§4) en `AgendaTurn.availability` y en la API del cerebro externo |
| Q3 | **Nunca** se afirma «no hay disponibilidad» sobre una lista truncada | Sólo se emite una negación cuando `scopeComplete && total = 0`; invariante verificado con una prueba de propiedades contra el motor |
| Q4 | Las alternativas calculadas en `bookSlot` **no** se registran como ofrecidas antes de que Meta acepte el mensaje | Sin cambio: `registerAlternatives:false` de 024 §5.7. Esta spec sólo mejora **cuáles** alternativas (cercanas a lo pedido) |
| Q5 | Los horarios ofrecidos se persisten **sólo con el mensaje** y se activan **sólo al aceptar Meta** | `check_availability` devuelve `AgendaTurn.offers` y va por `sendText({ offers })` (024 §5.6) |
| Q6 | Zona horaria, horario laboral, duración, aviso mínimo, buffers y citas existentes se respetan | Una sola fuente: `computeAvailability`; las horas pedidas se convierten con la zona del negocio; pruebas con el motor real |
| Q7 | El modelo **no redacta** horarios ni la respuesta | La acción no lleva `reply`; el texto lo arma el servidor |
| Q8 | Los casos límite se explican con causa real, sin inventar | Día cerrado, hora fuera de horario, hora fuera de la rejilla, aviso mínimo, día lleno, fuera de horizonte: cada uno con su texto |
| Q9 | Lo que el modelo escriba a mano contra esta garantía se detecta | Guard del `reply`: una negación de agenda sin evidencia se sustituye por una consulta real (§5.4) |
| Q10 | R-1 y el outbox no se debilitan | Las pruebas de 024 siguen intactas y se añaden mutaciones |

---

## 3. La consulta

Acción del modelo (sólo con la agenda encendida), **sin `reply`**:

```json
{ "action": "check_availability",
  "day": "mañana" | "lunes" | "2026-09-21" | "25 de septiembre",
  "times": ["11", "12:00", "4 de la tarde"],
  "from": "3 pm", "to": "5 pm",
  "edge": "earliest" | "latest" }
```

Todos los campos son opcionales y se combinan. El modelo pasa **lo que dijo el prospecto**; el
servidor resuelve las fechas y horas (no hay aritmética de fechas en el modelo):

- **`day`**: ISO `YYYY-MM-DD`; `hoy`; `mañana`; `pasado mañana`; nombre de día (`lunes`…, el
  **próximo** — nunca hoy, para no ofrecer por error el día equivocado; la respuesta nombra
  siempre la fecha completa); `25 de septiembre`, `25 sep`, `25/09`. Sin `day`, el alcance es todo
  el horizonte (`maxDaysAhead`).
- **`times`** y **`from`/`to`**: `HH:MM`, `H`, `H am/pm`, `H de la tarde/mañana/noche`,
  `mediodía`. Una hora sin marca (`4`) se lee como 04:00 y 16:00 y **se queda con la que cae
  dentro del horario del día**; si ambas caen, se responden las dos.
- **`from`/`to`**: rango de **inicio y fin** dentro de la ventana (`fin ≤ to`).

| Consulta del prospecto | Acción | Respuesta (agenda vacía, L-V 09:00-18:00) |
|---|---|---|
| «¿Tienes más horarios mañana?» | `day:"mañana"` | Todos los inicios del día, agrupados en rangos: «de 09:00 a 17:30, cada 30 min» (**exhaustiva**) |
| «¿Lunes a las 11 o 12?» | `day:"lunes", times:["11","12"]` | «el lunes 21 sí tengo libre a las 11:00 y a las 12:00» |
| «¿El lunes a las 4 o 5 de la tarde?» | `day:"lunes", times:["4 de la tarde","5 de la tarde"]` | 16:00 y 17:00 libres |
| «¿Cuál es el horario más tarde?» | `edge:"latest"` (+ `day` si lo dijo) | Por día: el último inicio (17:30); sin `day`, los primeros 3 días con agenda |

Casos límite (todos ciertos, con causa):

| Situación | Texto (resumen) |
|---|---|
| Día que no atiende | «el domingo no atiendo» + próximas opciones |
| Hora fuera de horario | «a las 20:00 está fuera de mi horario (09:00 a 18:00)» |
| Hora fuera de la rejilla | «mis horarios inician cada 30 min: a las 11:00 o a las 11:30» |
| Hora ocupada por una cita/bloqueo | «a las 12:00 ya está ocupado» |
| Hora que no alcanza el aviso mínimo | «no alcanzo a agendar a las 13:00 (aviso mínimo de 2 h)» |
| Día completamente lleno | «el martes ya no me quedan horarios libres» (**sólo** con el día evaluado completo) |
| Más allá del horizonte / fecha pasada | «por ahora agendo hasta el jueves 24» / «esa fecha ya pasó» (no es una afirmación de disponibilidad) |
| Día no reconocido | pregunta qué día; **no** ofrece nada ni afirma nada |

Cuando lo pedido no está libre se añaden «algunas opciones cercanas» (`nearestSlots`, mismo día
primero): eso es una **sugerencia** y se marca `hasMore`.

---

## 4. Metadatos de completitud

`AgendaTurn.availability` (y, en la API del cerebro externo, los campos homónimos):

| Campo | Significado |
|---|---|
| `kind` | `suggestions` (`offer_slots`) · `day` · `times` · `range` · `edge` · `overview` · `clarify` · `none` |
| `scopeComplete` | El alcance consultado (día u horizonte) se evaluó **completo** contra el motor. Es la **única** base para afirmar «no hay» |
| `total` | Cuántos horarios cumplen la consulta (completos, no truncados) |
| `conveyed` | Cuántos se le transmitieron al prospecto en el texto |
| `hasMore` | Existen horarios que cumplen y **no** se transmitieron o registraron |
| `exhaustive` | La lista transmitida contiene **todos** los que cumplen (`= scopeComplete ∧ ¬hasMore`) |

Invariantes (probados): `exhaustive ⇔ ¬hasMore ∧ scopeComplete` · una negación en el texto ⇒
`scopeComplete ∧ total = 0` · `offer_slots` es `suggestions` con `exhaustive:false` mientras
`total > conveyed`, y `total` es la cuenta **completa** del horizonte.

---

## 5. Comportamiento

### 5.1 Registro y entrega (integración con 024)

| Paso | Regla |
|---|---|
| Qué se registra | Todos los horarios libres del alcance (tope 60), no sólo los mencionados: el prospecto puede elegir cualquiera. `shown` marca los que el **texto** enseña (los únicos que 024 §5.6 revalida) |
| Cuándo | `check_availability` **no escribe** `offered_slot`: devuelve `offers`; `sendText` los guarda `pending` con el mensaje |
| Activación | `activateOffers` al aceptar Meta; un fallo/ambiguo los deja `pending` (no seleccionables) |
| Reintento | Mismo `checkOfferFreshness` (sólo BD): un horario mostrado que se ocupó ⇒ `offer_stale`; **nunca** se reenvía una respuesta de disponibilidad envejecida |
| Reenvío manual | Mismo guard (ronda posterior, vencido, ocupado, ya no ofrecido) |
| Un solo mensaje visible | Reusa la fila del mensaje lógico |

### 5.2 Alternativas de `bookSlot` (Q4, sin tocar R-1)

`refreshOffer` deja de devolver «las 3 primeras del horizonte»: devuelve las 3 **más cercanas a lo
pedido** (mismo día primero, por cercanía de hora; luego días siguientes), ordenadas
cronológicamente para mostrarlas. **Cuándo** se registran no cambia: `registerAlternatives:false`
para el agente, `true` por omisión para el cerebro externo.

### 5.3 API del cerebro externo (`GET /api/bot/availability`)

- **Corrige** el valor por defecto de `limit`/`perDay`/`days` (antes, sin parámetro, el mínimo).
- `diasConAgenda` se calcula de la disponibilidad **completa** dentro de la ventana `days` pedida, no de
  la lista truncada (lo que su comentario siempre prometió); es un **superconjunto** del valor anterior.
  `diasConAgendaHorizonte` trae los días con agenda de todo el horizonte. Detalle, auditoría de
  consumidores y decisión (sólo documentación, sin versionar) en
  [docs/bot-availability-contrato.md](../../docs/bot-availability-contrato.md).
- Añade `exhaustive`, `hasMore`, `total` (y `horizonDays`).
- Añade `day`, `from`, `to` opcionales: la misma consulta directa y completa (mismas reglas de §3).
- Sigue **registrando `active`** (el cerebro externo muestra la lista por su cuenta; sin mensaje
  del CRM no hay nada que reintentar). Ver 024 §5.7.

### 5.4 Guard de una negación escrita a mano

Si el modelo responde con `reply` una negación de agenda («no tengo horarios», «agenda llena», «sin
disponibilidad…») **con la agenda encendida**, el servidor **no envía ese texto**: ejecuta una
consulta de horizonte y responde con lo que el motor dice de verdad (que puede ser, con evidencia,
que no hay). No cuesta otra llamada de IA. Riesgo declarado (§9): un falso positivo cambia una
frase legítima por la disponibilidad real, nunca por algo falso.

---

## 6. Integración explícita con la spec 024

| 024 | Aquí |
|---|---|
| §5.6 `pending` no reserva; revalidación antes del reintento; guard manual | `check_availability` usa `AgendaTurn.offers` con `shown`; sin código nuevo de entrega |
| §5.7 / R-1 `registerAlternatives:false` | **Intacto** (prueba de mutación: forzar `true` rompe las pruebas de 024 y de 025). Sólo se mejora la selección de alternativas |
| `message.offer_state`, `offered_slot.shown` | Se reutilizan; sin migración |
| Outbox: un reintento no llama a IA/pipeline/agenda | La consulta ocurre **antes** de encolar; el reintento sólo reenvía el texto |

---

## 7. Criterios de aceptación

- **AC-1** Con una agenda vacía L-V 09:00-18:00, «¿tienes más horarios mañana?» responde **todos**
  los inicios del día (09:00 a 17:30), `exhaustive:true`, y **no** contiene ninguna negación.
- **AC-2** «¿Lunes a las 11 o 12?» → ambas libres; «¿lunes a las 4 o 5 de la tarde?» → 16:00 y 17:00
  libres, sin inventar ocupación.
- **AC-3** «¿Cuál es el horario más tarde?» → 17:30 (agenda vacía) y, con una cita a las 17:00, 16:30…
  exactamente lo que dice el motor.
- **AC-4** Ninguna respuesta afirma «no hay» salvo `scopeComplete ∧ total = 0` (propiedad verificada
  contra el motor en un barrido de agendas, días y horas).
- **AC-5** `offer_slots` declara `exhaustive:false, hasMore:true, total = 97` en la agenda de la
  evidencia; su texto no cambia.
- **AC-6** Las alternativas de `slot_taken` son las cercanas (mismo día) y siguen **sin** registrarse
  antes de la aceptación de Meta.
- **AC-7** Un horario ofrecido por `check_availability` es `pending` hasta que Meta acepta; un fallo
  temporal se reintenta con el mismo texto; un hueco que se ocupa durante el backoff ⇒ `offer_stale`.
- **AC-8** Zona horaria (incluida una zona distinta a la del servidor), horario partido (mañana y
  tarde), duración, buffer y aviso mínimo cambian los resultados exactamente como en el motor.
- **AC-9** Sin parámetros, la API del cerebro externo devuelve los 12 huecos y los 4 días por
  defecto, `diasConAgenda` incluye los días con agenda de la ventana de 5 días (17, 18 y 21), `diasConAgendaHorizonte` los 6 del horizonte, y declara `hasMore:true`.
- **AC-10** Sin `reply` en la acción: el modelo no puede afirmar nada por esta vía.

---

## 8. Alcance

**Dentro**: la acción `check_availability`, sus metadatos, las alternativas cercanas, la
API del cerebro externo, el guard del `reply`, el prompt, el `ai-mock` y las pruebas.

**Fuera**, con motivo:
- **Calendarios externos** (limitación v1 de 015): el motor sigue sin leerlos; se reflejan con
  bloqueos manuales.
- **Reservar directamente desde la consulta**: `book_slot` sigue exigiendo un horario **ofrecido y
  aceptado**; la consulta sólo lo ofrece (regla de 015, «sólo se reserva lo que se ofreció»).
- **Interpretar lenguaje natural arbitrario de fechas** («la semana que viene», «a fin de mes»): se
  pide aclaración; no se adivina.
- Cambiar el texto de `offer_slots` (lo fijan las pruebas de 024): la parcialidad se declara en
  metadatos y en el prompt (el modelo invita a nombrar día/hora).

## 9. Decisiones y riesgos residuales

- **D1** El modelo no lleva `reply` en `check_availability`. *Por qué*: si redactara, podría
  afirmar lo que no sabe; el servidor es el único que conoce la verdad.
- **D2** El servidor resuelve las expresiones de día/hora. *Por qué*: el modelo falla en aritmética de
  fechas y zonas horarias; una función pura se prueba.
- **D3** «`lunes`» es el **próximo** lunes, nunca hoy. *Por qué*: ofrecer hoy por error es peor que
  pedir una fecha; la respuesta nombra siempre el día completo para que el prospecto corrija.
- **D4** Una hora sin marca se lee dentro del horario del día. *Por qué*: «a las 4» en un negocio de
  09-18 es 16:00; si ambas lecturas caben, se responden las dos.
- **D5** La consulta registra todo el alcance (tope 60), no sólo lo mencionado. *Por qué*: mismo
  criterio de 015 (catálogo más ancho que el menú); sólo lo `shown` se revalida.
- **D6** Un solo `computeAvailability` por consulta. *Por qué*: costo y coherencia (una sola foto).

Riesgos residuales:
- Un falso positivo del guard (§5.4) sustituye una frase legítima («no tengo horarios de tarde en
  tu ciudad», del KB) por la disponibilidad real. Nunca por algo falso; se ajusta la lista de frases.
- Sin `day`, «el más tarde» describe los primeros 3 días con agenda (no el horizonte entero):
  se declara `hasMore` y el texto lo dice.
- El modelo puede no elegir `check_availability` (es un LLM) o rellenar campos de más (`edge`, `""`, `[]`): la
  corrida real 2 lo demostró (§11.1). Desde la revisión correctiva (§11.4) el servidor normaliza los vacíos, quita un
  `edge` que el cliente no pidió y reencamina `offer_slots` cuando el mensaje trae día/hora/expresión temporal, así que
  lo que ve el prospecto sale del motor aunque el modelo se equivoque. La corrida real 3 (5/5, perfil de producción) confirmó
  el comportamiento con el prompt nuevo; sigue siendo una muestra de 5 turnos de un modelo no determinista.
- Un falso positivo de `extractTemporalQuery` («mañana» como parte del día, etc.) sólo hace que el servidor consulte o
  pida aclaración, nunca que afirme algo; un falso negativo deja decidir al modelo.
- Expresiones de fecha no soportadas piden aclaración (un turno extra).

## 10. Verificación

> **Estado:** compuertas locales verdes tras la revisión correctiva **y** prueba real con el modelo de producción
> superada en la corrida 3 (5/5, §11.1). La corrida 2 había fallado y motivó la revisión (§11.4). Falta sólo el
> cierre operativo (commit / PR / despliegue, T20), que no está hecho.

Compuertas locales, revisión correctiva incluida (2026-09-21):

| Compuerta | Resultado |
|---|---|
| typecheck / lint | limpios |
| Unitarias | **1056/1056** (93 archivos; nuevos de la revisión: `query-intent`, `agenda-action-noise`) |
| Integración (Postgres real, motor real) | **126/126** (11 archivos; nuevo: `availability-guard`, con el perfil heredado «Usa offer_slots» inyectado en la BD) |
| E2E completo desde arranque limpio (base nueva `vocero_e2e_clean`, `.next` borrado, mocks) | **291/291** checks, 0 fallos (incluye el paso de perfil heredado y «la semana que viene») |
| `pnpm build` | OK |
| `git diff --check` | sin errores de espacios (sólo avisos LF→CRLF de Windows) |
| Archivos sensibles (`.env*`, `.env.live-profile.json`, `agent-profile.json`, `kb.json`) | ignorados por git; ninguno rastreado ni en el índice; sin claves `sk-or-…` en archivos rastreados ni nuevos |
| Llamadas a OpenRouter en las compuertas locales | **0** (todo contra mocks; `OPENROUTER_BASE_URL` → ai-mock). Las 5 llamadas reales de la corrida 3 son aparte (§11.1) |

Nota de estabilidad: en las dos primeras corridas completas de integración, hechas justo tras arrancar Docker
Desktop, `outbound-delivery` (024, casos 7 y 8: carreras contra el trabajador del outbox) falló 2 pruebas por tiempos;
en aislamiento pasó 31/31 dos veces y la suite completa posterior pasó 126/126. No se tocó código de 024 para esto; es
sensibilidad a la carga de la máquina, a vigilar en CI.

Histórico previo a la revisión (perfil semilla, antes de la corrida 2): 945 unitarias, 105 de integración, E2E 288/288.

**Mutaciones** (cada una rompe pruebas y se restauró): catálogo del día truncado a 3 (7 unitarias +
5 de integración), alternativas «primeras del horizonte» (4 + 1), guard de negaciones desactivado (2),
R-1 debilitado con `registerAlternatives:true` (7 de `outbound-reoffer`).

**Diagnóstico → corrección**: los 3 casos de contrato de `availability-diagnosis.test.ts` fallaron en rojo
contra el código anterior y pasan ahora; los 2 de caracterización siguen ciertos (documentan la evidencia).

## 11. Cierre de preproducción

### 11.1 Prueba real controlada con OpenRouter (`pnpm test:ai-live-025`)

`tests/live/availability-live.live.test.ts`. **No** corre en `pnpm test` ni en CI. Cinco turnos
independientes (uno por mensaje) por el **pipeline real** del agente —prompt real con agenda,
`chatJson` real, validación de la acción, motor de disponibilidad real, envío por el outbox— sobre una
base Postgres desechable con la agenda por defecto (L-V 09:00-18:00, «ahora» = jueves 17 sep 2026,
12:00 Ciudad de México). Sólo Meta está simulado.

Por caso verifica: acción elegida, parámetros exactos (`day`, `times`, `from`, `to`, `edge`), que lo
mostrado coincida con un **oráculo independiente** (`computeAvailability` directo), que ningún horario
registrado falte en el motor, que el texto no niegue disponibilidad que el motor confirma, que el caso 5
(«la semana que viene») pida aclaración sin horas ni negaciones, y que cada turno haga **exactamente una**
llamada HTTP, sin bajar de formato, sin corrección, sin fallback, sin escalamiento y sin cita.

Candados (sin ellos no se hace ninguna llamada): `AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO`,
`AI_LIVE_MODEL=<id exacto>`, `OPENROUTER_API_TOKEN` en `.env.live`, `OPENROUTER_BASE_URL` que sea
openrouter.ai, y un tope duro en `fetch`: sólo `openrouter.ai` y **nunca más de 5 llamadas**. La key no
se imprime ni se registra; se imprimen sólo acción, parámetros, modo, llamadas y tokens.

```bash
# 1. El modelo EXACTO de producción, sin tokens (instancia real, con sesión):
#      GET /api/settings/ai  →  effective.agent.model   (y .source)
# 2. `.env.live` (gitignored):
#      OPENROUTER_API_TOKEN=<key con saldo mínimo>
#      AI_LIVE_MODEL=<el modelo del paso 1>
#      OPENROUTER_BASE_URL=https://openrouter.ai/api
#      AI_RESPONSE_FORMAT=auto          # o el valor de producción
# 3.
AI_LIVE_CONFIRM=SI_CONSUMIR_SALDO pnpm test:ai-live-025
```

> **ESTADO: prueba real SUPERADA (corrida 3, 5/5).** La corrida 2 (perfil de producción) había fallado 3
> pruebas; tras la revisión correctiva (§11.4) la corrida 3, con el mismo modelo y el perfil real de producción,
> aprobó los 5 casos. La corrida 1 (perfil semilla) sigue sin contar como evidencia. Commit, PR y despliegue
> siguen **fuera de alcance** (T20) y no se han hecho.

#### Corrida 1 (2026-09-21) — perfil `seedMasImpulso` (NO es producción)

Modelo efectivo `z-ai/glm-5.3-flash` (verificado en `GET /api/settings/ai → effective.agent.model`, fuente:
configuración guardada en el CRM), 5 llamadas, `json_schema`, 13 195 tokens de entrada + 1 566 de salida
(≈ US$ 0.0028 reportados). Perfil: instrucciones de 1 337 caracteres (`instruccionesSha=7d581aa21877`), 4 entradas de
conocimiento. Resultado en su momento: 5/5 verdes. **Ya no se cita como aprobación** (ver corrida 2).

| # | Frase | Acción | `day` / `times` / `from` / `to` / `edge` | Motor |
|---|---|---|---|---|
| 1 | ¿Tienes más horarios mañana? | `check_availability` | `mañana` / — / — / — / — | 18 de 18 libres del 18 sep, `exhaustive` |
| 2 | ¿Puedes el lunes a las 11 o 12? | `check_availability` | `el lunes` / `["11","12"]` / — / — / — | 11:00 y 12:00 del 21 sep |
| 3 | ¿…el lunes a las 4 o 5 de la tarde? | `check_availability` | `el lunes` / `["4 de la tarde","5 de la tarde"]` / — / — / — | 16:00 y 17:00 |
| 4 | ¿Cuál es el horario más tarde del lunes? | `check_availability` | `el lunes` / — / — / — / `latest` | 17:30 |
| 5 | ¿…disponibilidad la semana que viene? | `check_availability` | `la semana que viene` / `[]` / `""` / `""` / `earliest` | aclaración del servidor (`kind:clarify`) |

Ya entonces el caso 5 mostraba `edge:"earliest"` y cadenas/arreglos vacíos: el servidor los ignoraba **sólo porque
el día no se resolvía** y pedía aclaración antes de mirar el resto. Eran la misma clase de defecto que la corrida 2
expuso en los casos 1 y 2, donde sí importaron.

#### Corrida 2 (2026-09-21) — perfil de PRODUCCIÓN: **FALLÓ (3 pruebas)**

Cinco llamadas reales con `z-ai/glm-5.3-flash`, `AI_LIVE_PROFILE_JSON` con el export vigente (sin editar, sin
recortar): `instruccionesSha=cc7a5a0eac1a`, 7 982 caracteres, 18 entradas de conocimiento y
`mencionaOfferSlots=true` (la regla heredada «Usa offer_slots» viaja intacta). Costo reportado: **US$ 0.0053665**.

| # | Frase | Resultado | Qué pasó |
|---|---|---|---|
| 1 | ¿Tienes más horarios mañana? | ❌ FALLÓ | el modelo agregó `edge:"earliest"` sin que el cliente lo pidiera y el texto mostró **un solo** horario, no el día completo |
| 2 | ¿Puedes el lunes a las 11 o 12? | ❌ FALLÓ | el modelo produjo `from:""` y `to:""` (el modo estricto rellena todos los campos); halló bien 11:00 y 12:00, pero los parámetros no eran ausencia |
| 3 | ¿…el lunes a las 4 o 5 de la tarde? | ✅ pasó | — |
| 4 | ¿Cuál es el horario más tarde del lunes? | ✅ pasó | — |
| 5 | ¿…disponibilidad la semana que viene? | ❌ FALLÓ | el modelo eligió `offer_slots` (obedeciendo la regla heredada del perfil) y ofreció **tres horarios** en lugar de pedir aclaración |

Resultado del archivo de pruebas: **3 fallos**. Causas de raíz (las tres son del contrato entre el modelo y el
servidor, no del motor de disponibilidad):

- **C6** `edge` era un campo de enum más del sobre estricto: un modelo pequeño lo rellena con un valor plausible.
  El servidor lo obedecía aunque el cliente jamás pidió «el primero/el último».
- **C7** El modo estricto obliga a rellenar todas las propiedades: aparecen `""` y `[]`, que no eran ausencia.
- **C8** Con un perfil heredado que dice «Usa offer_slots», el prompt tenía dos mandatos en conflicto y nada del
  lado del servidor impedía que una consulta con día/hora/expresión temporal se atendiera como oferta genérica.

#### Corrida 3 (2026-09-21) — perfil de PRODUCCIÓN tras la revisión correctiva: **5/5 APROBADOS**

Validación final con el perfil real, comunicada por la persona dueña del proyecto, que la ejecutó con su
autorización de gasto (esta sesión no la ejecutó ni conserva su salida completa): `pnpm test:ai-live-025` con el
export vigente (`AI_LIVE_PROFILE_JSON`, sin editar ni recortar; la regla heredada «Usa offer_slots» viaja intacta).

| Dato | Valor |
|---|---|
| Casos aprobados | **5/5**: los tres que fallaron en la corrida 2 (1, 2 y 5) y los dos que ya pasaban (3 y 4), repetidos porque el prompt cambió |
| Modelo | `z-ai/glm-5.3-flash` |
| Perfil | producción, `instruccionesSha=cc7a5a0eac1a` (el mismo de la corrida 2) |
| Llamadas facturables | **5 exactas** (una por turno; tope duro de 5 respetado) |
| Tokens | **30 590** de entrada · **1 374** de salida |
| Costo reportado | **US$ 0.0035091** |
| Formato | `json_schema` en los 5 turnos |
| Fallback / corrección / reintentos | ninguno (`fellBack=false`, `corrected=false`, 1 llamada del adaptador por turno) |
| Handoff / citas | ninguno (`handoff=false`, 0 citas, sin `book_slot`) |
| Horarios inventados | **ninguno**: todo lo ofrecido coincidió con el oráculo independiente (`computeAvailability`) y `registradosNoReales=0` |

Estas propiedades no son sólo un dato reportado: son aserciones del propio arnés (`expectCleanTurn`, `expectSupported`
y el caso 6 de presupuesto/logs), de modo que un 5/5 las implica. Referencia: la corrida 2 (mismo modelo y perfil) costó US$ 0.0053665 con 3 pruebas fallidas.

**Perfil vigente (`AI_LIVE_PROFILE_JSON`).** El agente de producción se configura en `/agent` con dos
lecturas autenticadas: `GET /api/agent/profile` (`profile.{name,tone,instructions,escalationRules,greeting}`;
`src/app/api/agent/profile/route.ts`) y `GET /api/kb` (`entries[]`, orden `createdAt` asc, el mismo que usa el
pipeline; `src/app/api/kb/route.ts`). Para exportar SÓLO esos campos, en la consola del navegador de la pestaña
de producción ya autenticada (misma origen: las cookies viajan solas y el código no las lee ni las imprime):

```js
(async () => {
  const [p, k] = await Promise.all([
    fetch('/api/agent/profile').then((r) => r.json()),
    fetch('/api/kb').then((r) => r.json()),
  ]);
  const { name, tone, instructions, escalationRules, greeting } = p.profile;
  const kb = k.entries.map((e) =>
    e.kind === 'qa' ? { kind: 'qa', question: e.question, answer: e.answer } : { kind: 'block', content: e.content });
  const blob = new Blob([JSON.stringify({ name, tone, instructions, escalationRules, greeting, kb }, null, 2)],
    { type: 'application/json' });
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: '.env.live-profile.json' }).click();
})();
```

Guarda el archivo como `.env.live-profile.json` en la raíz del repo (el patrón `.env.*` lo deja fuera de git). Esquema
(`tests/live/profile-json.ts`, estricto): `name` (1-60) · `tone` (≤ 500 o `null`) · `instructions` (≤ 8000, no vacío) ·
`escalationRules` (≤ 4000 o `null`) · `greeting` (≤ 1000 o `null`) · `kb`: lista no vacía de
`{"kind":"qa","question","answer"}` o `{"kind":"block","content"}`. Toda clave es obligatoria (`null` si el perfil no la
tiene), no se admiten claves de más (ni ids ni `organizationId`), y se rechaza un perfil vacío, la semilla disfrazada de
producción y cualquier credencial. Validación local, sin red ni llamadas de IA:
`pnpm test:ai-live-profile-check .env.live-profile.json` (imprime sólo longitudes, huellas y conteos). El arnés vuelve a
validarlo antes de cualquier llamada y **no edita ni recorta nada** (la regla heredada «Usa offer_slots» viaja intacta).

**Ensayo sin costo** (valida el arnés; `fetch` jamás sale): `AI_LIVE_DRY_RUN=SI` (modelo ideal simulado ⇒
6/6 verdes), `MALO` (afirma disponibilidad sin consultar ⇒ **5 fallos**) y `DOBLE` (basura la 1ª vez ⇒
detecta la 2ª llamada). El arnés detecta lo que debe detectar; **no** sustituye la corrida real.

### 11.2 CI

`.github/workflows/ci.yml` tiene un job `integration` propio con Postgres efímero, **sin secretos**:
Meta y OpenRouter apuntan a un puerto cerrado de loopback y `tests/integration/setup.ts` rechaza cualquier
`fetch` a un host que no sea loopback (probado en `network-isolation.test.ts`). Pasos: suites declaradas
(`scripts/ci-integration-suites.mjs coverage`), migraciones de cero y re-ejecutadas sobre una base
temporal (`scripts/ci-migrate-check.mjs`), y —por separado— el grupo 024, el grupo 025 y el de
aislamiento de red, cada uno con reporte JSON verificado (`verify`): una suite que no corre, se omite o
ejecuta 0 pruebas **falla** el pipeline. `gates` (typecheck, lint, unitarias, build; matriz
default/completo) queda intacto. **El E2E de Playwright no corre en CI** (necesita la app viva y sus
mocks): sigue siendo una compuerta local (`pnpm test:e2e`).

### 11.3 Compatibilidad del endpoint

Auditoría de consumidores, valores anteriores/nuevos y decisión (sólo documentación, sin versionar) en
[docs/bot-availability-contrato.md](../../docs/bot-availability-contrato.md).

### 11.4 Revisión correctiva (tras la corrida 2)

Respuesta a C6-C8. **No** toca el motor, el outbox ni `offer_slots`; sólo endurece la frontera entre lo que el
modelo dice y lo que el cliente pidió. Todo es puro y determinista (`src/server/agenda/query-intent.ts`).

| # | Requisito | Cómo se cumple | Dónde se prueba |
|---|---|---|---|
| R1 | `edge` sólo ante una petición explícita de horario más temprano/tarde | `explicitEdge(textoDelCliente)`: «el primero», «el más temprano», «el último», «el más tarde»… Si el cliente no lo dijo (o pide los dos extremos), el servidor **quita** `edge` (`edge_removed`) y se lista el día completo. «Más horarios», «qué horarios hay» y «disponibilidad mañana» no llevan `edge` | `query-intent.test.ts` (FALLO 1 y variantes); integración `availability-guard` (18 horarios, no 1); E2E |
| R2 | `""`, espacios, `null`, `[]` y `[""]` son ausencia | `normalizeQueryFields`, aplicado como `normalize` de `chatJson` **antes** de validar el esquema (un `edge:""` ni siquiera pasaría el enum ⇒ evita la llamada correctiva) y de nuevo en la compuerta | `query-intent.test.ts` (FALLO 2), `agenda-action-noise.test.ts` (A: UNA llamada, sin corrección); integración |
| R3 | Una pregunta con expresión temporal usa `check_availability` | Prompt: «OBLIGATORIA» ante día/fecha/hora/rango/expresión de tiempo. Servidor: `guardAgendaAction` reencamina `offer_slots` → `check_availability` si el mensaje del cliente trae algo temporal (`rerouted_offer_slots_to_check_availability`, sin texto del cliente en el log) | `query-intent.test.ts`; integración `availability-guard`; E2E |
| R4 | Lo no soportado llega al servidor para pedir aclaración | `extractTemporalQuery` conserva las PALABRAS del cliente («la semana que viene») en `day`; `answerQuery` no lo resuelve y devuelve `kind:"clarify"`: nunca se adivina, nunca se ofrece nada | `availability-query.test.ts` (`clarify`), `query-intent.test.ts` (FALLO 3), integración `availability-guard` (aclaración, sin horarios ni `offerSlots`), E2E |
| R5 | `offer_slots` sólo para solicitudes genéricas de opciones | Prompt + compuerta: sin día/fecha/hora/rango en el mensaje, `offer_slots` se conserva («quiero agendar» sigue siendo `offer_slots`). `book_slot` nunca se reencamina | `query-intent.test.ts`, integración (`availability-guard`: genérico y `book_slot`) |
| R6 | Las reglas duras de agenda ganan a las instrucciones heredadas | `AGENDA_PRIORITY_CLAUSE`: va **después** de las instrucciones del negocio y **antes** del conocimiento y del contrato de acciones; el perfil NO se edita ni se sanea | `agenda-action-noise.test.ts` (B: la regla viaja palabra por palabra y el orden del prompt) |
| R7 | Regresión con un perfil que dice «Usa offer_slots» | El perfil heredado se inyecta tal cual en la BD y un modelo que lo obedece se corrige en el servidor | integración `availability-guard` (perfil real inyectado, motor real); E2E (`us-disponibilidad`, paso 6: perfil heredado) |
| R8 | El perfil exportado no se modifica y las aserciones no se debilitan | `.env.live-profile.json` no se toca (ni se lee en esta revisión); el arnés real conserva sus aserciones y agrega otras (caso 5 exige que el **modelo** elija `check_availability` —no sólo que el servidor lo corrija—, que `day` conserve «semana» y que el texto pida aclaración) | `tests/live/availability-live.live.test.ts` |

**Qué NO prueban los mocks**: que `glm-5.3-flash` *elija* la acción correcta con el prompt nuevo. Las compuertas del
servidor garantizan lo que ve el prospecto aunque el modelo se equivoque; la aserción del caso 5 exige además la
elección correcta del modelo. Eso lo cubrió la repetición real.

**Repetición real (T30): HECHA — corrida 3, 5/5** (US$ 0.0035091, 5 llamadas, 30 590 tokens de entrada y 1 374 de
salida, mismo modelo, perfil `cc7a5a0eac1a` sin editar; ver §11.1). Repitió los casos 1, 2 y 5 (fallidos) y también el 3 y el 4, porque el prompt había cambiado.
Conserva el tope duro de 5 llamadas. Una muestra de 5 turnos no elimina la variabilidad del modelo: la compuerta del
servidor es la garantía de lo visible; vigilar los logs `action_guard` en producción.
