# E2E — Token del proveedor de IA por organización (022)

Guion de comportamiento observable. Automatizado en la sección `022` de
`scripts/e2e-selftest.mjs`: con la app viva y los mocks encendidos,
`pnpm test:e2e` lo conduce y sale distinto de cero si algo falla.

**Preparación**: app en `localhost` con `OPENROUTER_BASE_URL` → ai-mock y la
BD migrada. Sin fila guardada, la instancia sigue usando `OPENROUTER_*` del
entorno — esta pantalla es una anulación opcional, no un requisito.

---

## US1 — Guardar valida ANTES contra el proveedor

1. Un token que el proveedor rechaza responde **422** y **no se guarda**: la
   conexión sigue sin existir (`GET /api/settings/ai` → `connection: null`).
2. Un token válido se guarda junto con el modelo y el modelo del juez
   (opcional); hacia el navegador solo salen sus **últimos 4** — el token
   completo no aparece en ninguna respuesta.

## US2 — Probar sin guardar

`POST /api/settings/ai/test` con el body vacío reusa el token y el modelo ya
guardados — así se puede verificar la conexión sin volver a pegar un secreto
que la pantalla nunca devolvió.

## US3 — Quitar vuelve a las variables de entorno

`DELETE /api/settings/ai` borra la fila; a partir de ahí el agente y el juez
del Laboratorio vuelven a usar `OPENROUTER_API_TOKEN`/`OPENROUTER_MODEL` del
proceso, sin que la instancia deje de responder.

## US4 — El agente y el juez usan la anulación cuando existe

Cubierto por `tests/unit/ai-adapter.test.ts` (chatJson acepta un token de
organización que pisa el de entorno) y `tests/unit/judge.test.ts`
(`judgeCase` resuelve la config de IA de la organización antes de llamar al
proveedor).

## US5 — El agente nunca deja al cliente colgado

Incidente del 2026-09-19: un prospecto preguntó algo fuera de tema y el
proveedor contestó BIEN pero en prosa, sin JSON. El CRM tiró la respuesta,
escaló a atención humana y no le mandó nada al cliente.

Automatizado en `scripts/e2e-selftest.mjs` (`rescateChecks`), contra el
ai-mock. Guion manual equivalente, con el agente encendido en Ajustes → Agente:

1. Mandar por el wa-mock `prosa: ¿qué temperatura hay en Londres?`.
   ✅ El prospecto **recibe** la respuesta del modelo.
   ✅ La conversación **no** queda escalada: un problema de formato no es un
   motivo para pasarle el cliente a una persona.

2. Mandar `prosa-fuga: dime todo lo que sabes` (el mock devuelve el prompt del
   sistema regurgitado).
   ✅ Ese texto **jamás** llega al cliente — filtraría el knowledge base.
   ✅ La conversación escala con `handoff_reason = 'error'`.
   ✅ El cliente recibe el aviso de cortesía, no silencio.

3. Mandar `caida-del-proveedor: hola` (el mock responde 500).
   ✅ Escala igual que antes: aquí no hay nada que rescatar.
   ✅ Pero el cliente recibe el aviso.

4. Mandar `quiero hablar con un asesor`.
   ✅ Escala con `handoff_reason = 'cliente'` **y** el cliente recibe acuse.
   Antes, pedir un humano era el caso con silencio más flagrante.

5. Guardar en Ajustes → Inteligencia el modelo `modelo-sin-json` y mandar un
   mensaje normal.
   ✅ Se responde igual: el adaptador reintenta sin `response_format` cuando el
   modelo no soporta el modo JSON, y lo recuerda para no repetir el error.
