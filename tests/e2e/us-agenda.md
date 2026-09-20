# E2E — Motor de agenda universal (015)

Guion de comportamiento observable. Automatizado en la sección `015` de
`scripts/e2e-selftest.mjs`: con la app viva y los mocks encendidos,
`pnpm test:e2e` lo conduce y sale distinto de cero si algo falla.

**Preparación**: app en `localhost` con `WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock, `ZOOM_BASE_URL`/`ZOOM_OAUTH_BASE_URL` →
zoom-mock, `BOT_API_KEY` y la BD migrada. La bandera `AGENDA` decide qué mitad
del guion corre: ambas se ejercitan en la matriz de CI.

---

## US1 — La instancia decide si la agenda existe

Con `AGENDA` ausente:

1. `GET /api/calendar/settings`, `/api/calendar/availability` y `/api/bookings`
   responden **404**.
2. `GET /api/bot/availability` responde **404** — antes incluso de mirar la
   llave: el endpoint no existe aquí.
3. La pantalla `/bookings` responde 404 y la navegación no la menciona.
4. `GET /api/agenda/bookings/:id/ics` responde **404** — el .ics público
   tampoco existe en una instancia sin agenda.
5. `GET /cita/:id` (la página de confirmación) responde **404** — igual que el
   `.ics`, ni siquiera para una cita que sí existe.

Con `AGENDA=on`, las mismas rutas responden con normalidad.

## US2 — El negocio define cuándo atiende

1. Una instancia recién encendida devuelve **defaults usables** (cita de 30
   min, conector `enlace-fijo`) con 200, no un 404.
2. Se guarda un horario y una sala fija; la disponibilidad devuelve huecos.
3. Cada hueco trae el **día en palabras** además de la hora — la etiqueta corta
   ya agendó una cita el día equivocado en producción.
4. Una zona horaria inventada se rechaza con **422** en vez de guardarse y
   romper el motor después.

## US3 — Las dos garantías

1. **Solo se reserva lo que se ofreció**: un instante libre y válido, pero
   nunca ofrecido a esa conversación, se rechaza con `409 slot_not_offered` y
   la respuesta trae lo que sí se ofreció.
2. **Camino feliz**: reservar un hueco ofrecido responde **201 Created** (no
   200), con etiqueta, enlace, la URL pública de su `.ics` y la URL de su
   **página de confirmación** (`confirmationUrl`, aditivo: no reemplaza
   `calendarUrl`); el hueco desaparece de la disponibilidad y la cita aparece
   en Citas marcada como agendada por la IA. El mensaje que recibe el
   prospecto incluye la página de confirmación para que guarde la cita en su
   propio calendario. Tanto el `.ics` como la página son públicos (sin
   sesión: el prospecto nunca entra al CRM) y su "credencial" es el propio id
   de la cita, impredecible como un token.
   - La página trae fecha, hora de inicio y fin, zona horaria, descripción y
     el enlace de reunión si existe, más botones para precargar el evento en
     Google Calendar y Outlook — dejando claro que hay que pulsar **Guardar**
     ahí, nada se agenda solo — y conserva la descarga `.ics` para Apple y
     otros calendarios.
   - Si la cita se **cancela**, tanto la página como el `.ics` se leen SIEMPRE
     en vivo: la página dice explícito que se canceló y **deja de ofrecer**
     los botones de Google/Outlook (serían datos viejos), y el `.ics` se
     re-publica con `STATUS:CANCELLED`/`METHOD:CANCEL` bajo el MISMO UID, para
     que un cliente de calendario que ya la había guardado pueda quitarla.
3. **La carrera**: un segundo intento sobre el mismo instante responde `409`
   con el sobre **anidado** y `slots` como **hermano**; en la base queda **una
   sola cita activa** en ese instante.
4. Las alternativas del `409` ya son la oferta vigente: reservar una de ellas
   responde 201 de inmediato.
5. **Reprogramar** por la superficie del bot responde **200**, no 201.
6. **El mensaje que arma el agente in-process cubre más de un día**: si el
   negocio tiene agenda en varios días, el menú de 3 horarios que Max le
   manda al prospecto no puede ser el mismo día repetido tres veces — bug real
   de producción (el negocio tenía jueves, viernes y lunes; el mensaje solo
   traía miércoles) causado por tomar los primeros N de un catálogo ya
   agrupado por día en vez de repartir por variedad de días
   (`pickAcrossDays`, `server/agenda/spread.ts`). Se ejercita el camino
   conversacional real — inbound → pipeline del agente → `offer_slots` — no
   solo el catálogo crudo de `/api/bot/availability`.

## US4 — El operador

1. Cancelar dos veces no falla (idempotente).
2. Reintentar el enlace de una cita que ya lo tiene responde 422.
3. **El proveedor caído no cuesta la conversión**: con el conector externo sin
   credenciales, reservar responde **201 igualmente**, con
   `linkPending: true` y `meetingLink: null`, y la cita se ve como "sin enlace"
   en Citas.

## US5 — Conector Zoom

1. Unas credenciales que el proveedor rechaza responden 422 y **no se
   guardan**: la conexión sigue sin existir.
2. Unas válidas se guardan y hacia el navegador solo salen sus **últimos 4** —
   el secreto no aparece en la respuesta.
3. Agendar crea la reunión: el proveedor la recibe con su tema y su hora, y el
   enlace vuelve en la respuesta.
4. Cancelar la cita **borra** la reunión en el proveedor.

## US6 — Conector Google

Cubierto por la suite de contrato (`tests/unit/connectors.test.ts`), que fija
lo que su mock reproduce: el enlace de Meet **no** viene en la respuesta de
crear el evento —la conferencia es asíncrona—, el conector re-lee, y si sigue
pendiente entrega el evento sin enlace en vez de fallar. Reintentar re-lee ese
mismo evento: **nunca** crea uno duplicado en el calendario del dueño.

## Sandbox del Laboratorio

1. Una conversación de prueba **puede** agendar (201) y la cita queda marcada
   como de prueba.
2. Con un conector externo activo, el estado del mock queda **vacío**: el
   proveedor jamás se entera de una cita de prueba. Se verifica por ausencia, y
   vale igual para crear, reprogramar y cancelar.

## US-cancelada — una cita cancelada deja de existir para el agente

Incidente del 2026-09-19: el dueño agendó una demo con el agente, la canceló
desde la pantalla de Citas, y al volver a escribir el agente respondió *"Te
recuerdo que tienes tu demostración agendada para el lunes a las 09:00"*. El
pipeline no consultaba la tabla `booking`: la única fuente del modelo era su
propio "¡Listo! Te agendé…" del historial.

Automatizado en `scripts/e2e-selftest.mjs`, dentro de `agendaChecks()`. Guion
manual equivalente, con `AGENDA=on` y el agente encendido:

1. Agendar una cita por WhatsApp con el agente.
2. Mandar `estado-cita: ¿qué tengo?`.
   ✅ **Control positivo**: el agente nombra la cita vigente. Sin este paso, el
   punto 5 pasaría en verde aunque el bloque nunca llegara al modelo.
3. Mandar "quiero mover mi cita a otro día" → queda una solicitud de cambio
   pendiente y la conversación escala.
4. Cancelar la cita desde la pantalla de Citas.
5. Mandar `estado-cita: ¿qué tengo?`.
   ✅ El agente **ya no** la menciona.
   ✅ Y lo dice explícito: no hay ninguna cita vigente.
6. Pedir agendar de nuevo.
   ✅ **Funciona**. Antes no: la solicitud de cambio quedaba `pending` para
   siempre y `createSessionBooking` rebotaba con `reschedule_pending`, así que
   el agente no podía volver a agendarle nada a ese contacto nunca.
