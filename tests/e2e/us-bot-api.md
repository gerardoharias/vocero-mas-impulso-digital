# E2E — API de servicio para un cerebro externo (`/api/bot/*`)

Precondición: app corriendo con mocks (`WA_MOCK_ENABLED=true`,
`META_GRAPH_BASE_URL` → wa-mock), organización creada, conexión WhatsApp
guardada y `BOT_API_KEY` configurada (≥16 caracteres).

Esta superficie NO la usa el navegador: la usa un bot propio del operador que
quiere conducir la conversación sin que el token de WhatsApp salga del CRM. El
agente in-process de Vocero puede quedar apagado.

## Autorización

1. `GET /api/bot/media/media123` SIN header `X-API-Key` → **401** `unauthorized`.
2. Lo mismo con una key equivocada → **401** (mismo cuerpo: no filtra si la key
   existe o no).

## Presencia: marcar leído + "escribiendo…"

3. Provocar un inbound (`POST /api/dev/wa-mock/inbound`) y tomar el
   `conversationId` de `GET /api/conversations`.
4. `POST /api/bot/typing {conversationId}` con la key → **200** `{ok: true}`.
5. `GET /api/dev/wa-mock/outbox` → el conteo NO cambió: marcar leído y el
   indicador no son mensajes salientes y no contaminan la bandeja.
6. Pausar la IA de esa conversación (toggle del panel, o
   `PATCH /api/conversations/{id} {aiEnabled:false}`) y repetir typing →
   **200** `{ok:false, reason:"ai_paused"}` y Meta ni se toca: con un humano
   atendiendo, "escribiendo…" le mentiría al cliente.
7. Conversación del Laboratorio (`is_test`) → `{ok:false, reason:"sandbox"}`.

## Media proxy

8. `GET /api/bot/media/media123` con la key → **200**, `content-type: image/*`
   y cuerpo no vacío. El token de WhatsApp nunca viajó al bot.
9. `GET /api/bot/media/media-inexistente` cuando Graph responde 404 → **404**
   `media_meta_failed` (no 500).

## Reinicio de la conversación de pruebas

10. Con la conversación en handoff (`aiEnabled:false`), `POST /api/bot/reset
    {conversationId}` con la key → **200** `{ok:true}`.
11. `GET /api/conversations` → esa conversación vuelve con `aiEnabled: true` y
    sin `handoffAt`; el lead está en la PRIMERA etapa del pipeline.
12. El historial de mensajes del inbox sigue completo: el reset es de estado,
    no borra auditoría.
13. `POST /api/bot/reset` sin key → **401**.

## Perfil del agente y knowledge base

El bot externo no adivina el negocio: lo lee de las mismas dos pantallas que
edita el dueño (Agente y su knowledge base). Este endpoint es el contrato.

14. `GET /api/bot/profile` con la key → **200** con la forma exacta
    `{profile: {name, tone, instructions, escalationRules, greeting}, kb, resources}`.
    Los cinco campos del perfil coinciden con lo guardado en la pantalla Agente;
    los opcionales vacíos viajan como `null`, no como cadena vacía.
15. `kb` es el knowledge base ya renderizado (`P:`/`R:` para las preguntas,
    los bloques tal cual, en el orden de la pantalla). Con el KB vacío viaja
    la cadena canónica `(knowledge base vacío)`, no `null`: el bot puede
    inyectarla en su prompt sin ramificar.
16. `profile.enabled` NO viene, ni con la IA in-process encendida ni apagada:
    ese flag gobierna el agente de Vocero, no al cerebro externo, que se pausa
    por conversación (`aiEnabled` y los handoffs).
17. Editar el tono en la pantalla Agente y volver a pedir el perfil → el cambio
    ya está: la respuesta no se cachea.

## Contexto de la conversación

Lo que solo el CRM sabe: quién es la persona, si un humano tomó el control y si
la ventana de 24 h sigue abierta. El historial de mensajes NO viaja: esa memoria
es del bot.

18. `GET /api/bot/context?conversationId={id}` con la key → **200** con
    `contact` (id, name, waIdentity, phone), `conversation`
    (id, aiEnabled, handoffAt, windowOpen, windowRemainingMs) y `lead`
    (id, stageName).
19. `GET /api/bot/context?waIdentity={identidad}` → la MISMA conversación. Es el
    camino que usa el bot cuando le llega un mensaje y solo tiene el remitente.
20. Tras un entrante reciente, `windowOpen: true` y `windowRemainingMs` > 0.
21. Con la conversación en handoff, `aiEnabled` viene en **false** aunque el
    flag de la fila siga en true: para el bot hay una sola verdad.
22. Una conversación del Laboratorio no se resuelve nunca por `waIdentity`: el
    bot de producción no debe hablarle a un cliente simulado.

## Ficha de calificación

Lo que el bot va descubriendo del lead. Las claves las define el negocio: el
CRM no impone un cuestionario.

23. `PUT /api/bot/ficha {conversationId, ficha}` con la key → **200** con la
    ficha COMPLETA resultante (no solo el parche), y esa misma ficha aparece en
    `contact.ficha` del contexto del siguiente turno.
24. Un segundo PUT con otras claves las **suma**: lo que no viene se conserva.
    Un `null` explícito **borra** esa clave.
25. Valores que el CRM no puede guardar —objetos, arreglos, cadenas vacías,
    números no finitos— se ignoran en silencio y el resto sí se guarda: un 422
    le tiraría al bot datos de calificación que ya costaron una conversación.
26. Conversación inexistente → **404**. Cuerpo sin `ficha` → **422**.

## El bot envía a través del CRM

27. `POST /api/bot/messages {conversationId, text}` con la key → **200**
    `{messageId}`, el mensaje aparece en la bandeja marcado como IA
    (`aiGenerated: true`, `origin: "ai"`) y sale por el canal de WhatsApp. El
    token de Meta nunca viajó al bot.
28. Con la IA pausada (handoff), el mismo envío → **409** `ai_paused` y el
    outbox NO cambia: el rechazo ocurre antes de tocar Meta.
29. Con la ventana de 24 h cerrada → **409** `window_closed`. El bot no puede
    esquivar la regla de Meta; para eso está el envío de plantilla desde la app.
30. En una conversación del Laboratorio → **409** `sandbox_violation`.

## El bot pide un humano

31. `POST /api/bot/handoff {conversationId, reason}` con la key → **200**, la
    conversación queda con `aiEnabled: false`, su `handoffAt` y el motivo. En la
    bandeja se ve al instante, sin recargar (mismo evento que el toggle).
32. Repetirlo es idempotente: no pisa la hora ni el motivo del primero.
33. Un `reason` que no está en el catálogo —o ausente— **no tira el handoff**:
    cae a `modelo` y la IA se pausa igual. Un 422 aquí dejaría al bot
    vendiéndole a alguien que acaba de pedir un humano.
34. Conversación inexistente → **404**.

## Camino infeliz

35. `GET /api/bot/profile` en una instancia sin perfil de agente → **404**
    `no_profile` (condición esperada, no un 500: el bot cae a su brief local).
36. `GET /api/bot/context` sin `waIdentity` ni `conversationId` → **422**;
    con un `conversationId` que no existe → **404**.
37. `POST /api/bot/messages` con texto vacío → **422**.
38. `POST /api/bot/typing` con un `conversationId` inexistente → **404**.
39. Con Meta caído (token `...-invalid` en el mock), typing → **200**
    `{ok:false, reason:"meta_error"}`: es best-effort por contrato, al bot
    jamás le vale reintentarlo.

## Presencia desde el agente in-process (2026-09-21)

`POST /api/bot/typing` ya no implementa la lógica: delega en
`server/whatsapp/presence.ts`, que comparte con el agente in-process. Su
contrato NO cambia (401 / 409 `no_org` / 400 / 404 / 200 `{ok:true}` / 200
`{ok:false,reason}` / 409 `no_connection`), y gana un motivo **aditivo**:
`channel_unsupported`, para conversaciones de Instagram o Messenger — antes
mandaba un id sintético al número de WhatsApp y Meta lo rechazaba.

El agente in-process enciende la señal **desde la ingesta**, en cuanto llega el
mensaje, si de verdad va a responder (IA configurada, conversación sin handoff
y con IA activa, agente encendido en Ajustes). La re-enciende antes de llamar
al modelo si ya pasaron más de 20 s, porque el indicador de Meta expira a los
~25 s.

Automatizado en `scripts/e2e-selftest.mjs`. El self-test mide **cuánto tarda**
la señal, no solo que llegue: el turno también la enciende, así que sin medir
el tiempo el check pasaría en vacío con el enganche de la ingesta desactivado
(verificado con mutante: 6411 ms contra un debounce de 6000 ms).
