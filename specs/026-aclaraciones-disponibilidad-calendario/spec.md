# 026 — Aclaraciones de disponibilidad: expresiones de día, contexto y alternativas

**Carril**: ciclo completo (Principio VI). Amplía el esquema de la acción `check_availability`
(contrato `specs/001-vocero-core/contracts/ai.md`, ya extendido por
[025](../025-consultas-disponibilidad-calendario/spec.md)) y añade estado nuevo en `conversation`
(migración aditiva, sin tocar `message` ni el outbox de [024](../024-entrega-integra-mensajes-salientes/spec.md)).
Artefactos: [`plan.md`](plan.md), [`data-model.md`](data-model.md), [`tasks.md`](tasks.md).

**Relación con otras specs** (ninguna cambia de propósito):
- **[025](../025-consultas-disponibilidad-calendario/spec.md)** — introdujo `check_availability`,
  sus metadatos de completitud (`exhaustive`/`hasMore`/`scopeComplete`) y el guard servidor sobre lo
  que dice el modelo. Esta spec **no** los debilita: añade vocabulario de fechas, un campo de días
  alternativos y memoria de aclaración; el motor (`computeAvailability`) sigue siendo la única fuente
  de verdad.
- **[023](../023-respuesta-estructurada-agente/spec.md)** — precedente directo del mecanismo de
  estado propuesto aquí: `conversation.ai_fail_count` / `ai_fail_kind` / `ai_fail_at` ya cuentan
  fallos técnicos CONSECUTIVOS por conversación, aislados del texto visible, y se resetean al
  primer éxito. §3.3 reutiliza exactamente ese patrón para las aclaraciones de agenda.
- **[024](../024-entrega-integra-mensajes-salientes/spec.md)** — sin cambios: una aclaración sigue
  sin ofertas (`offers: []`), no toca `offer_state` ni el outbox.

**Estado**: **implementada y verificada localmente** (2026-09-22) en la rama
`codex/spec-026-calendar-clarifications`, a partir de `main` (commit `df8ce0f`, NO de la rama ya
fusionada de 024/025). **Sin commit, sin PR, sin despliegue** — el dueño no lo ha pedido. Detalle en
[`tasks.md`](tasks.md) §"Pruebas"/"Cierre"; dos gaps declarados (T21 mutaciones dedicadas, T22
propiedad extendida — ver riesgos §9). La ambigüedad semántica quedó cerrada el 2026-09-21,
confirmada por el dueño (§3.1).

**Constitution Check**: I Seguridad — sin datos nuevos sensibles; el contexto de aclaración que se
persiste es sólo la interpretación parcial de fechas (calificador de semana, días pedidos), nunca
texto libre del cliente re-expuesto como si fuera del sistema. II Soberanía — sin dependencia nueva.
III Multi-tenancy — todo pasa por `computeAvailability`/`scoped`, sin cambios. IV Idempotencia — el
contador nuevo se actualiza con el mismo patrón atómico que `ai_fail_count` (023); no introduce
escritura no idempotente. Sandbox del Laboratorio — intacto. Sin violaciones identificadas; a
reconfirmar en la implementación.

---

## 1. Diagnóstico

Evidencia reportada por el dueño (producción, siete mensajes de un mismo prospecto, en orden):

| # | Mensaje del prospecto | Resultado observado |
|---|---|---|
| 1 | «¿Tienes disponibilidad la semana que viene?» | Pidió aclarar el día — **correcto** (`day` no resuelve un rango de semana sin día: 025 §8 ya lo dejó fuera de alcance) |
| 2 | «Para el jueves o viernes de la próxima semana» | **No comprendido** |
| 3 | «Para el jueves» (tras la aclaración anterior) | **No aprovechó** el contexto de «próxima semana» del mensaje 1 |
| 4 | «Pero el jueves de la próxima semana» | Volvió a producir **la misma** aclaración que el mensaje 2 |
| 5 | — | La aclaración se **repitió de forma idéntica** en varios turnos |
| 6 | «1 de octubre» | **Comprendido**: fuera del horizonte, con la fecha límite correcta |
| 7 | «Para el lunes» | **Resuelto correctamente** como lunes 28 |

Los casos 6 y 7 son control positivo: el motor, la resolución de fechas simples y la respuesta de
«fuera de horizonte» de 025 **funcionan**. El defecto es específico a tres cosas que 025 dejó fuera de
alcance explícitamente (§8) y a un cuarto punto que 025 nunca abordó (la aclaración no varía ni tiene
límite).

### 1.1 Causas, confirmadas leyendo el código de 025 (línea por línea; la reproducción con pruebas es
trabajo de implementación, no de este diagnóstico)

| # | Causa | Dónde | Veredicto |
|---|---|---|---|
| D1 | `normalizeExpression` quita `el\|la\|este\|esta\|proximo\|proxima\|para\|del\|dia` como relleno GENÉRICO, sin distinguir "este" (semana actual) de "próximo" (más cercano). «jueves de la próxima semana» queda `"jueves de semana"` (no quita `de`/`que`/`viene`/`semana`) y no matchea nada ⇒ `clarify()`. «jueves que viene» (sin "semana") también falla hoy, porque `que`/`viene` no están en la lista | `src/lib/time/day-expressions.ts:62-71` | Confirmada |
| D2 | No existe ningún concepto de «calificador de semana» distinto entre "este" (semana actual, puede ser un día que ya pasó) y "de la próxima semana" (siempre la semana calendario siguiente). Ambos colapsan hoy al mismo cálculo de "ocurrencia más cercana" | `day-expressions.ts:91-114` | Confirmada |
| D3 | `AvailabilityQuery.day` es un `string` ÚNICO. No hay campo para «jueves **o** viernes» | `availability-query.ts:46-55` | Confirmada |
| D4 | `checkAvailability`/`queryAvailability` son **stateless por turno**: reciben sólo `query` (lo de ESTE turno) y `now`; nunca el historial ni ninguna aclaración previa | `agent.ts:155-171`, `pipeline.ts:467-478` | Confirmada |
| D5 | El prompt instruye "pon las palabras tal cual" del mensaje de este turno; no dice cómo combinar una respuesta parcial («el jueves») con lo dicho ANTES de que el sistema aclarara («la próxima semana») | `src/server/ai/prompts.ts:76,84` | Confirmada; explica el mensaje 3 |
| D6 | `clarify()` devuelve uno de tres textos **fijos**, sin variar ni contar repeticiones | `availability-query.ts:196-251` | Confirmada |
| D7 | No existe ningún mecanismo de anti-repetición de texto saliente ni de conteo de aclaraciones consecutivas (a diferencia de `ai_fail_count` para fallos técnicos, 023) | — | Confirmada (ausencia) |
| — | El motor de disponibilidad, la resolución de fecha exacta y `none()` para fuera de horizonte | `availability-query.ts:201-208` | Descartadas: casos 6 y 7 funcionan |

---

## 2. Regla semántica (confirmada por el dueño, 2026-09-21)

Ya **no** es una decisión abierta: sustituye cualquier supuesto anterior. Once reglas, numeradas para
trazar cada una a su guarantee/AC:

1. «El próximo jueves» y «jueves que viene» = el jueves **futuro más cercano**.
2. Si el jueves de la semana actual **todavía no llegó**, esa es la interpretación (regla 1).
3. Si **hoy es jueves**, «próximo jueves»/«jueves que viene» = el jueves de la **semana siguiente**
   (nunca hoy).
4. «El jueves de la próxima semana» (o «…de la semana que viene/entrante/otra») = **siempre** el
   jueves de la semana calendario `[lunes, domingo]` **siguiente**, exista o no ya haya pasado el
   jueves de esta semana.
5. «Este jueves» = el jueves de la semana calendario **actual**: si es hoy, es hoy; **si ya pasó, NO
   se convierte en silencio a la semana siguiente — se pide aclaración**.
6. «El jueves» a secas (sin calificador) = la ocurrencia más cercana que **no haya pasado** (nunca
   hoy si hoy es jueves — sin cambio de 025 D3).
7. Toda interpretación usa `America/Mexico_City` (zona del negocio de las pruebas; en producción,
   `settings.timezone`).
8. Toda respuesta nombra **día y fecha completa** (sin cambio: ya lo hace `dayName()`/`cap()`).
9. Consultar disponibilidad **nunca reserva**; la cita sólo se crea cuando el prospecto elige un
   horario exacto ya ofrecido (sin cambio: regla de 015/024, `book_slot` exige oferta previa).
10. Si el contexto anterior fue «la próxima semana» y la respuesta siguiente es «para el jueves», el
    calificador de semana se **hereda**.
11. El contexto de aclaración se **elimina** cuando: (a) la fecha se resuelve correctamente, (b)
    cambia claramente el tema, (c) se crea una cita, (d) interviene una persona (handoff), o (e) se
    alcanza el límite de aclaraciones.
12. «Jueves o viernes» puede consultar **ambos** días y presentarlos por separado, siempre que estén
    dentro del horizonte.
13. Si uno cae dentro del horizonte y el otro fuera, se explica **cada caso por separado**, sin
    inventar disponibilidad del que está fuera.
14. Tras aclaraciones repetidas, el texto **nunca se repite**; **antes del handoff** se ofrecen
    opciones con **fechas concretas** (p. ej. «¿te refieres al jueves 24 o al jueves 1 de octubre?»).
15. El handoff por agenda ambigua ocurre **sólo** tras **tres** intentos razonables sin resolver la
    fecha.

**Nota importante sobre el código actual**: las reglas 1-3 y 6 ya las cumple el algoritmo de
`resolveDayExpression` para un día de semana SIN calificador (`((weekday - todayWeekday + 7) % 7) ||
7`, sin cambio de 025 D3) — incluido el caso "hoy es jueves ⇒ próximo jueves = +7 días". Lo que hoy
está MAL es: (i) "jueves que viene" no se reconoce como equivalente a "jueves" (falla D1); (ii) "este
jueves" hoy se trata IGUAL que "jueves" a secas (mismo cálculo, nunca hoy) — la regla 5 exige lo
contrario: "este jueves" debe poder ser hoy, y si ya pasó, debe aclarar, no reinterpretar.

---

## 3. Diseño propuesto

### 3.1 Vocabulario de fecha (`src/lib/time/day-expressions.ts`)

Tres rutas de resolución distintas para un día de semana, según el calificador detectado ANTES de la
normalización genérica (que hoy trata "este" como relleno — hay que sacarlo de esa lista):

| Calificador detectado | Ejemplos | Algoritmo | Puede ser hoy |
|---|---|---|---|
| Ninguno / «próximo» / «que viene» (sin "semana") | «jueves», «el próximo jueves», «jueves que viene» | Ocurrencia más cercana que no haya pasado (existente, **sin cambio**: reglas 1-3, 6) | No |
| «este»/«esta» | «este jueves» | Jueves de la semana calendario `[lunes, domingo]` que contiene "hoy"; si esa fecha < hoy ⇒ `{ok:false, reason:"already_passed_this_week"}` (regla 5) | Sí |
| «de la próxima semana» / «de la semana que viene/entrante/otra» | «jueves de la próxima semana» | Jueves de la semana calendario siguiente, SIEMPRE (regla 4) | No |

Los tres algoritmos son funciones puras nuevas/ajustadas, con sus propios casos — no se reutiliza el
`diff % 7` existente para las rutas 2 y 3 (calculan sobre el lunes de la semana de referencia, no
sobre "hoy").

`resolveDayExpression` devuelve, en caso de fallo, una **razón** distinguible (no sólo `{ok:false}`
como hoy): `unresolved` (no se reconoce ninguna expresión) o `already_passed_this_week` (regla 5). La
razón alimenta qué texto de aclaración se usa (§3.3) y si conviene ofrecer fechas concretas de una vez
(la razón `already_passed_this_week` ya sabe la fecha "de esta semana" que pasó y puede calcular la de
la próxima semana sin ambigüedad — candidato natural para adelantar la oferta de fechas concretas de
la regla 14 desde el primer intento, no sólo antes del handoff).

### 3.2 Días alternativos (`AvailabilityQuery` / acción `check_availability`)

Campo **opcional** `days?: string[]` (mismo patrón que `times`, aditivo):

```json
{ "action": "check_availability", "days": ["jueves", "viernes"], "times": null, ... }
```

- El modelo lo usa cuando el cliente ofrece explícitamente dos (o tres) días con «o»/«u». `day` y
  `days` son mutuamente excluyentes; si vienen ambos, `days` gana.
- Cada entrada se resuelve con las mismas tres rutas de §3.1; un calificador de semana en la frase
  aplica a **todas** las entradas («jueves o viernes de la próxima semana» ⇒ ambos, semana siguiente).
- Nuevo `AvailabilityKind: "days"`. Reglas 12-13: cada día se evalúa **por separado** contra el motor;
  si uno cae fuera del horizonte, ese día responde con el mismo texto honesto de `none()` (fecha límite
  del horizonte) mientras el otro, si está dentro, responde con datos reales — nunca una negación
  agregada que tape el que sí está disponible. `scopeComplete`/`exhaustive`/`hasMore`/`total`/`conveyed`
  se agregan sólo sobre los días efectivamente evaluados dentro de horizonte.
- Tope: 3 días en `days[]` (más que eso, se pide que elija — en la práctica es "resumen de la
  semana", ya cubierto por `offer_slots`/horizonte).

### 3.3 Memoria de aclaración (contexto entre turnos)

Nuevo estado en `conversation` (migración aditiva, **mismo patrón que `ai_fail_count` de 023**, sin
tocar `message`):

| Columna | Tipo | Uso |
|---|---|---|
| `agenda_clarify_count` | `integer not null default 0` | Aclaraciones de disponibilidad CONSECUTIVAS sin resolver |
| `agenda_clarify_kind` | `text`, nullable | Última razón sin resolver: `unresolved`, `already_passed_this_week`, `too_many_days`, `unresolved_time`, `unresolved_range` — decide variación de texto (regla 14) |
| `agenda_clarify_context` | `text` (JSON), nullable | Lo que SÍ se entendió antes de faltar una pieza — hoy sólo `{"weekModifier":"next"\|"same"}`, ampliable. Se fusiona server-side con los campos del turno siguiente ANTES de resolver de nuevo (regla 10) |

**Flujo** (reglas 10, 11, 14, 15): al recibir `check_availability`/`offer_slots` reencaminado, si
`agenda_clarify_context` no es nulo, el servidor combina sus campos con los del turno actual (el turno
actual manda si hay conflicto) antes de resolver. Si vuelve a fallar:

1. Incrementa `agenda_clarify_count`, guarda la nueva razón/contexto.
2. **1.ª vez** con esta razón: aclaración específica de la razón (p. ej. regla 5: "el jueves de esta
   semana [fecha] ya pasó, ¿te refieres a la próxima semana o a otro día?" — ya con UNA fecha
   concreta, porque `already_passed_this_week` la conoce sin ambigüedad).
3. **2.ª vez consecutiva** (misma o distinta razón): se computan hasta 2 fechas candidatas concretas
   (nombradas con día y fecha completa, regla 8) y se ofrecen como elección directa (regla 14):
   «¿te refieres al jueves 24 o al jueves 1 de octubre?». Esto NO registra horarios (`offers`): sólo
   desambigua la fecha, antes de mirar horas.
4. **3.ª vez consecutiva** sin resolver: **no se pregunta de nuevo** (regla 15). Handoff con
   `handoff_reason:"agenda_ambigua"` (valor nuevo, TS-only, mismo patrón que `reprogramacion`).

**Reseteo del contador** (regla 11, los 5 disparadores mapeados a 2 mecanismos):
- (a) fecha resuelta correctamente y (c) cita creada → cualquier turno de agenda con `ok:true` o una
  negación honesta de alcance completo → `count=0, kind=null, context=null`.
- (b) cambia claramente el tema → la acción del modelo en este turno NO es una acción de agenda
  (`offer_slots`/`check_availability`/`book_slot`/`request_reschedule`) → mismo reseteo.
- (d) interviene una persona y (e) límite alcanzado → cualquier escritura que fije `handoff_at` (por
  esta razón o cualquier otra) resetea el contador en la misma transacción — si la IA se reactiva más
  tarde, empieza sin arrastrar aclaraciones viejas.

Este mecanismo es **determinista y no depende de que el modelo coopere** (D5 del diagnóstico): el
servidor recuerda lo que hizo falta la vez anterior aunque el modelo nunca combine turnos por su
cuenta. El único rol del modelo sigue siendo pasar las palabras del cliente de ESTE turno tal cual (sin
cambio a esa regla de 025).

---

## 4. Cambios de contrato

| Superficie | Cambio | Tipo |
|---|---|---|
| Acción `check_availability` (`specs/001-vocero-core/contracts/ai.md`) | Nuevo campo opcional `days?: string[]` | Aditivo |
| `AvailabilityKind` (`availability-query.ts`) | Nuevo valor `"days"` | Aditivo, sólo runtime |
| `DayResolution` (`day-expressions.ts`) | `{ok:false}` gana una `reason?: "already_passed_this_week"` | Aditivo, sólo runtime |
| `conversation` (`src/lib/db/schema.ts` → `pnpm db:generate`) | `agenda_clarify_count`, `agenda_clarify_kind`, `agenda_clarify_context` | **Migración aditiva nueva** en `drizzle/` |
| `conversation.handoff_reason` (enum TS) | Nuevo valor `"agenda_ambigua"` | Aditivo, sin migración (columna `text`, enum sólo TS) |
| `GET /api/bot/availability` (025 §5.3) | Acepta `days`; expone `kind:"days"` | Aditivo |

Nada toca `offer_state`, el outbox, ni `registerAlternatives:false` (R-1 de 024).

---

## 5. Criterios de aceptación

- **AC-1** «jueves de la próxima semana» / «…de la semana que viene» resuelven al jueves de la semana
  calendario siguiente, sin importar si el jueves de esta semana ya pasó (regla 4).
- **AC-2** «este jueves» dicho un día antes de que pase resuelve a ESE jueves (puede ser hoy); dicho
  después de que pasó, pide aclaración con la fecha concreta de "esta semana" ya nombrada, sin
  convertir en silencio a la semana siguiente (regla 5).
- **AC-3** «jueves», «el próximo jueves», «jueves que viene» resuelven igual: la ocurrencia futura más
  cercana, nunca hoy si hoy es jueves (reglas 1, 2, 3, 6) — sin regresión de 025 D3.
- **AC-4** «jueves o viernes de la próxima semana» resuelve como `days:["jueves","viernes"]`, ambos con
  el calificador de la semana siguiente; cada día responde con datos reales del motor por separado
  (reglas 12, 13).
- **AC-5** `days` con un día dentro del horizonte y otro fuera responde cada uno honestamente (el de
  dentro con horarios reales, el de fuera con la fecha límite), nunca una negación agregada.
- **AC-6** Turno 1: «la semana que viene» → aclaración pidiendo el día, `agenda_clarify_context =
  {weekModifier:"next"}`. Turno 2 (mismo prospecto, sólo «el jueves», SIN repetir "próxima semana"):
  resuelve al jueves de la **semana siguiente**, heredando el calificador (regla 10).
- **AC-7** Dos aclaraciones consecutivas por la MISMA razón nunca producen el mismo texto exacto; la
  2.ª consecutiva ofrece dos fechas concretas nombradas para elegir directo (regla 14).
- **AC-8** Una 3.ª aclaración consecutiva sin resolver no vuelve a preguntar: aplica handoff con
  `handoff_reason:"agenda_ambigua"` (regla 15).
- **AC-9** El contador se resetea a `0`/`null`/`null` cuando: el turno resuelve, se crea una cita, el
  modelo responde con una acción no relacionada con agenda, o se dispara cualquier handoff (regla 11).
- **AC-10** «1 de octubre» y «para el lunes» (evidencia real) siguen resolviendo exactamente igual que
  hoy — sin regresión (control positivo).
- **AC-11** Ninguna respuesta nueva afirma disponibilidad fuera de lo que `computeAvailability`
  confirma; propiedad verificada con el mismo barrido de agendas que 025 §7 AC-4, extendido a `days` y
  a las tres rutas de resolución de día (regla 9, invariante de 025 §4 sin relajar).
- **AC-12** Toda prueba de fecha relativa nueva corre con `America/Mexico_City` fijo (regla 7) y al
  menos un caso cruza el límite de semana (viernes/sábado tarde, para que "de la próxima semana" y
  "este jueves ya pasó" se distingan bien del caso "todavía no pasa").
- **AC-13** Toda respuesta (incluidas las de fechas candidatas de la regla 14) nombra día y fecha
  completa, nunca sólo el nombre del día (regla 8) — reutiliza `dayName()`/`cap()`, sin texto nuevo que
  la esquive.

---

## 6. Alcance

**Dentro**: las tres rutas de resolución de día (bare/próximo, este, de la próxima semana), días
alternativos (`days[]`, tope 3), memoria de aclaración por conversación con los 5 disparadores de
reseteo, variación + fechas concretas + límite de 3 + escalamiento de la aclaración, pruebas de zona
horaria explícitas, extensión de `GET /api/bot/availability`.

**Fuera, con motivo**:
- **Rangos de fecha libres** («entre el jueves y el sábado», «cualquier día de la próxima semana» sin
  más día): sigue pidiendo aclaración de día concreto (025 §8; esta spec no lo retoma). «la semana que
  viene» sin día (mensaje 1 de la evidencia) sigue siendo aclaración correcta.
- **Calificadores de mes** («el jueves del próximo mes»): mismo patrón que semana, sin evidencia real
  que lo pida hoy; se deja para una iteración futura si aparece.
- **Más de 3 días alternativos, o combinados con "y"** («lunes, martes o miércoles»): sigue pidiendo
  que elija.
- **El circuito/contador de 023 (`ai_fail_*`)**: sin relación; columnas independientes.

## 7. Decisiones y riesgos

- **D1** El contexto de aclaración vive en `conversation`, no en `message`. *Por qué*: es estado
  TÉCNICO de la conversación, no algo que el cliente vea nunca en el chat — mismo criterio que 023 usó
  para `ai_fail_*`.
- **D2** El servidor fusiona el contexto; nunca se le pide al modelo que lo recuerde. *Por qué*: D5 del
  diagnóstico muestra que confiar en que el modelo combine turnos ya falló dos veces seguidas en
  producción.
- **D3** "Este jueves" puede fallar (regla 5) en vez de siempre resolver. *Por qué*: es la regla
  explícita del dueño — silenciar el error convirtiéndolo a la semana siguiente arriesga ofrecer un
  día que el prospecto no pidió.
- **D4** Fechas candidatas concretas (regla 14) se calculan, no se le piden al modelo. *Por qué*: son
  aritmética de calendario sobre lo que YA se entendió parcialmente (mismo criterio D2 de 025: el
  modelo falla en aritmética de fechas).
- **D5** Límite de 3 aclaraciones consecutivas, con fechas concretas ya en la 2.ª. *Por qué*: la
  evidencia real muestra al menos 2 repeticiones idénticas; ofrecer opciones concretas en la 2.ª da una
  salida antes de frustrar al prospecto, y la 3.ª sin resolver es la señal de que preguntar no está
  funcionando.

Riesgos residuales:
- La migración de `conversation` es nueva (a diferencia de 025, que no tocó el esquema): re-ejecutar el
  checklist de migraciones re-ejecutables (Principio IV) y el gate `scripts/ci-migrate-check.mjs`.
- Un falso positivo del detector de calificador («este» vs «de la próxima semana») sólo puede llevar a
  preguntar o resolver una semana distinta a la esperada — nunca a inventar un horario que el motor no
  confirme (AC-11 es invariante dura).
- El tope de 3 aclaraciones puede escalar de más si un prospecto escribe de forma ambigua por estilo
  propio, no por un defecto del sistema; se documenta como comportamiento aceptado — el humano recibe
  el hilo completo al escalar.
- ~~Las fechas candidatas de la regla 14... hasta 4 fechas en total~~ — **resuelto en la
  implementación**: el dueño confirmó explícitamente "máximo dos fechas en total, nunca cartesiana"
  y "cuando la ambigüedad compartida sea la semana, pregunta «¿esta semana o la próxima?»". La
  ambigüedad de semana (el único caso que antes arriesgaba combinar) usa esa pregunta corta —
  nunca enumera fechas por día, así que nunca hay 4. Sin este riesgo.
- **T21/T22 no hechas** (`tasks.md`): no hay mutaciones dedicadas (romper cada guarantee a propósito)
  ni una extensión del barrido de propiedades de 025 a `days[]`/los calificadores de semana. La
  cobertura real (unitaria + integración contra Postgres + E2E, con regresiones genuinas
  encontradas y corregidas durante la propia verificación) da confianza razonable para código nuevo.
  **Resuelto** (2026-09-22): T21 (10/10 mutaciones, §12) y T22 (barrido de 153 casos, §12) cerrados;
  ver `tasks.md`.

## 10. Verificación

Compuertas locales, corrida final (2026-09-22, rama `codex/spec-026-calendar-clarifications`):

| Compuerta | Resultado |
|---|---|
| `pnpm typecheck` / `pnpm lint` | limpios |
| Unitarias (`pnpm test`) | **1126/1126** (94 archivos, repo completo) |
| Integración, Postgres real (`pnpm test:integration`) | **139/139** (12/12 archivos) |
| E2E (`scripts/e2e-selftest.mjs`, app real + mocks, base `vocero_e2e_clean`) | **297/297, 0 fallos** (confirmado en dos corridas limpias consecutivas) |
| `pnpm build` | limpio |
| `git diff --check` | limpio (sólo avisos LF→CRLF de Windows) |
| Auditoría de secretos en el diff | sin coincidencias (patrones de API key/token/password/clave privada, y teléfonos fuera de los rangos ficticios conocidos) |
| `.env`/secretos | intactos, sin tocar |

**Regresiones reales encontradas y corregidas durante la propia verificación** (no hipotéticas — las
atrapó el gate, no una revisión manual):
1. `GET /api/bot/availability`: el `days` nuevo (lista de nombres) chocaba con el `days` numérico
   YA publicado (ventana de la lista truncada, 015) — renombrado a `altDays` antes de terminar.
2. Un texto de aclaración genérico cambiado sin querer de "el lunes" a "el jueves" al escribir el
   código, rompiendo una prueba fijada de 025 (`availability-guard.test.ts`) — revertido.
3. Arnés de integración (no producto): el reloj falseado de Node y el reloj real de Postgres
   (`created_at` con `defaultNow()`) quedaban desincronizados entre turnos, mezclando el texto del
   cliente de dos turnos distintos — corregido sólo en la prueba nueva.
4. Guion E2E propio: números de teléfono de prueba con un dígito de menos (12 en vez de 13),
   formato MX inválido — corregido.
5. Guion E2E propio: dos de las tres pruebas nuevas usaban frases que el `ai-mock` de prueba
   (regex simple, no un modelo) no reconocía como consulta de disponibilidad («para el lunes» sin
   «horarios»/«a las»; «no sé cuándo» sin ninguna palabra clave) — corregidas con frases que el
   mock ya entendía. No es un defecto del servidor: el prompt real no exige esas palabras.
6. `outbound-delivery.test.ts` (spec 024, ajeno a 026) falló 2 pruebas en una corrida de la suite
   completa por carga de la máquina — en aislamiento pasó 31/31; una corrida limpia posterior de la
   suite completa pasó 139/139. Mismo patrón de sensibilidad ya documentado en 025 §10.

## 11. T21 — Pruebas de mutación (10/10 garantías demostradas)

Cada mutación: código roto → prueba(s) detectora(s) en ROJO → revertido → mismas pruebas en VERDE.
Verificado al final que ningún archivo de `src/` conserva código mutado
(`grep -rn "MUTACIÓN" src/` → 0 coincidencias).

| # | Garantía | Mutación | Detector | Rojo |
|---|---|---|---|---|
| M1 | Reconoce «de la próxima semana» | `NEXT_WEEK_QUALIFIER_RE` → nunca matchea | `day-expressions.test.ts` + `availability-query.test.ts` | 10 pruebas |
| M2 | «jueves que viene» ≠ semana posterior | rama "none" de `parseWeekQualifier` devuelve `"next"` | ídem + barrido T22 | 3 pruebas |
| M3 | «este jueves» ya pasado pide aclaración, no avanza | `resolveWeekday` rama "same" suma 7 días en vez de fallar | `day-expressions.test.ts` (bloque "este día") | 6 pruebas |
| M4 | Conserva contexto ante respuesta corta | `referencesPendingClarify` → siempre `false` | `agenda-clarify-context.test.ts` + integración | 15 + 1 pruebas |
| M5 | Orden de `altDays` = orden del cliente | `scope` se ordena cronológicamente | `availability-query.test.ts` (orden + barrido) | 2 pruebas |
| M6 | Consulta TODOS los días de `days[]` | `dayTokens` se recorta a `.slice(0,1)` | `availability-query.test.ts` (bloque días alternativos) | 5 pruebas |
| M7 | Máx. 2 fechas concretas, nunca cartesiana | `buildDayClarify` enumera también la fecha "próxima" por día | `availability-query.test.ts` ("NUNCA más de 2 fechas") | 1 prueba (4 fechas detectadas) |
| M8a | Limpia al resolver/reservar | se quita el `resetAgendaClarifyState` del camino de éxito | integración ("hereda 'próxima semana'") | 1 prueba |
| M8b | Limpia ante cambio de tema | condición del bloque 11-b con `&& false` | integración ("cambio INEQUÍVOCO de tema") | 1 prueba |
| M8c | Limpia al escalar | `recordUnresolvedAttempt` devuelve `state: prev` en vez de vacío | unitaria pura ("escala... y limpia el estado") | 1 prueba |
| M8d | Limpia en CUALQUIER handoff | `applyHandoff` deja de resetear los 3 campos | integración ("handoff por un motivo AJENO") | 1 prueba |
| M9 | Escala exactamente en el 3.er intento | `CLARIFY_ATTEMPTS_LIMIT` → `999` | integración; **reforzado** con 2 pruebas unitarias que fijan el valor exacto (la original era genérica al límite y no lo detectaba — hallazgo real) | 1 integración + 2 unitarias (tras reforzar) |
| M10 | Nunca comparte contexto entre organizaciones | `writeAgendaClarifyState` sin el filtro `organizationId` | integración ("dos ORGANIZACIONES distintas") | 1 prueba (fuga real demostrada) |

Detalle completo (comandos y salidas) en el registro de la sesión; disponible bajo pedido.

## 12. T22 — Barrido amplio (153 casos, semilla reproducible)

`tests/unit/availability-query.test.ts`, describe `"026 — barrido amplio"`. Reloj **fijo** (9 anclas
ISO, sin `Date.now()`), semilla `20260926` (mulberry32, la misma familia de PRNG que el barrido de
150 agendas de 025).

- **9 anclas**: `2026-09-13`..`19` (domingo→sábado, una vez cada día de la semana como "hoy",
  auto-verificado con una prueba dedicada) + `2026-12-29` (cruza a enero del año siguiente dentro
  del horizonte) + `2028-02-27` (año bisiesto, cruza a marzo).
- **17 variaciones por ancla** (agenda semanal aleatoria, duración/buffer/aviso/horizonte
  aleatorios, citas aleatorias) = **153 ≥ 150** casos.
- Por caso: las 5 formas de «jueves» (`jueves`, `el jueves`, `jueves que viene`, `este jueves`,
  `jueves de la próxima semana`) contra un oráculo aritmético **independiente** (no reutiliza
  `day-expressions.ts`); `días[]` («jueves o viernes» y su variante "de la próxima semana") en
  **ambos órdenes**, verificando que el primer resultado corresponde al primer token pedido; nunca
  un horario fuera de lo que el motor confirma; ninguna negación sin alcance completo.
- Invariantes de no-vacuidad: al menos un caso de "este jueves ya pasado" y al menos un caso de
  verificación de orden en `days[]` (`alreadyPassedCases > 0`, `multiDayOrderChecks > 0`).

## 13. Auditoría adicional

- **Migración y journal**: `0024_slim_felicia_hardy` es la entrada `idx:24` de `_journal.json`,
  justo después de `0023` (`idx:23`); `0024_snapshot.json` existe y su `prevId` coincide con el
  `id` de `0023_snapshot.json` (cadena íntegra); contiene las 3 columnas nuevas.
- **Re-ejecutable, aditiva, no reduce conteos**: el SQL de `0024` se corrió **3 veces seguidas** de
  forma directa (`psql -f`) sobre una base ya migrada — las 3 veces `NOTICE: ... already exists,
  skipping` en las 3 columnas, sin error. El archivo no contiene ningún `DROP`/`TRUNCATE`/`DELETE`
  (verificado con `grep`).
- **`NULL` para conversaciones existentes**: `agenda_clarify_kind` y `agenda_clarify_context` son
  nullable sin default (`NULL` para toda fila existente — confirmado con `\d conversation`).
  `agenda_clarify_count` es `NOT NULL DEFAULT 0` a propósito (mismo criterio que `ai_fail_count` de
  023): toda fila existente queda en `0`, nunca en `NULL`, que es el estado correcto ("sin
  aclaración pendiente").
- **`altDays` no rompe `days`**: prueba nueva y permanente
  (`tests/integration/availability-query.test.ts`, "conviven en la MISMA llamada sin pisarse") que
  llama con `days` (ventana) y `altDays` (días nombrados) a la vez y por separado. 17/17 en el
  archivo, incluida esta.
- **Ningún dato personal en la memoria persistida**: `sanitizeClarifyContext` sólo admite
  `weekModifier` (`"same"|"next"`) y `days` (máx. 3 entradas, máx. 40 caracteres cada una, tope de
  300 caracteres el JSON completo) — cualquier otra clave se descarta (probado). `customerText` (el
  mensaje real del cliente) se usa sólo para DECIDIR (`parseWeekChoiceReply`,
  `referencesPendingClarify`, `isUnambiguousTopicChange`, `mergeClarifyContext`) y **nunca** se
  asigna a ningún campo que se serialice o persista (verificado leyendo cada uso de `customerText`
  en el código). Nunca se guardan mensajes completos, nombres ni teléfonos.
- **024/025 intactas**: la corrida final de `pnpm test:integration` (139/139, 12/12 archivos)
  incluye los archivos de prueba de 024 y 025 sin cambios ni regresiones.
