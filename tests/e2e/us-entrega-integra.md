# Guion E2E — Entrega íntegra de un mensaje enriquecido ante un rechazo de Meta

> Automatizado en `scripts/e2e-selftest.mjs` (`entregaIntegraChecks`, dentro de
> la sección de agenda; con `pnpm dev` + mocks). La lógica fina (política por
> código, concurrencia, reinicios, migración) se prueba contra Postgres real en
> `tests/integration/outbound-*.test.ts`. Spec:
> [`specs/024-entrega-integra-mensajes-salientes`](../../specs/024-entrega-integra-mensajes-salientes/spec.md).

## El fallo original

Un prospecto aceptó agendar. `offer_slots` armó una introducción y tres horarios.
Meta rechazó el envío de forma temporal («No se entregó. Meta no está disponible
ahora») y, poco después, al prospecto le **llegó otro mensaje**: sólo la
introducción. No pudo elegir horario.

Causa: el envío estaba dentro del `try` del motor de agenda; el `SendError` se
confundía con «el motor falló» y `degradeAction` reenviaba el texto base de la IA.

## Herramienta del harness

`POST /api/dev/wa-mock/fail-next` guioniza el rechazo de los próximos envíos
(`{ "failures": [{ "status": 503, "code": 2 }] }`); sin `code`, la respuesta no
trae cuerpo de Meta (un 502 de un proxy: resultado ambiguo). El outbox del mock
sólo lista lo que Meta **aceptó**; `GET /api/dev/wa-mock/outbox` expone además
`rejected` con el cuerpo exacto de cada intento rechazado.

## Camino verificado

**A. Fallo temporal (`503` / código 2)**

1. Un prospecto escribe «quiero agendar una cita»; el primer envío se rechaza.
   ✅ Meta recibió **dos** cuerpos y sólo uno se aceptó.
   ✅ El cuerpo del reintento es **idéntico** al del primer intento.
   ✅ Conserva las opciones de horario (no es la introducción sola).
   ✅ En el CRM hay **una** burbuja saliente, ya enviada, sin «No se entregó» +
   reemplazo, y **sin traspaso**.
2. El prospecto responde «sí, agenda el primero».
   ✅ Los horarios siguen siendo seleccionables tras el reintento: **una** cita real.

**B. Error permanente (`131026`)**

3. El mensaje queda `failed`, con el motivo traducido y `(Meta 131026)`.
   ✅ **No** se reintenta (un rechazo, cero aceptados, tras esperar más que el
   primer reintento posible).
   ✅ Conserva el payload completo (con horarios) para reenvío manual.

**C. Resultado ambiguo (`502` sin cuerpo de Meta)**

4. El mensaje queda `delivery_unknown` («Sin confirmar»).
   ✅ **No** se reenvía solo (podría duplicarse).
   ✅ La conversación cuenta como «pendiente de responder».
5. El operador pulsa **Reenviar** (`POST …/messages/:id/resend`).
   ✅ Sale el **mismo** payload persistido, en la **misma** burbuja, con un intento.

**D. Reenvío manual de una oferta (spec §5.6)**

6. Oferta fallida, vigente y sin ronda posterior; **dos operadores** pulsan Reenviar a la vez.
   ✅ Uno recibe `200`, el otro `409 resend_conflict`; sale **un** mensaje con el payload original.
7. Otra oferta fallida; **otro prospecto reserva el primer hueco** mientras estaba sin entregar
   (`pending` no reserva nada).
   ✅ El reenvío se bloquea (`409 offer_stale`, «genera una nueva ronda con la disponibilidad
   actualizada»); no sale nada y no se crea ningún mensaje.
8. El prospecto insiste y el agente arma una ronda **nueva** que Meta acepta.
   ✅ Reenviar la anterior se bloquea (`409 offer_stale`), la ronda vigente no cambia y no hay
   mensajes nuevos.

**E. Contrato v2 de `POST /api/bot/messages`**

9. Un fallo temporal de Meta ya no responde `502`: responde `200 {status:"retrying", contract:2}`
   (con el header `X-Vocero-Send-Contract: 2`).
   ✅ El CRM lo reenvía **solo**, con el mismo cuerpo, y llega **una** vez; el agente integrado no
   genera otro envío.

**F. Re-oferta de `bookSlot` (spec §5.7)**

10. P y R reciben la misma oferta; otro prospecto (Q) reserva antes el primer hueco. P elige ese hueco
    (`slot_taken`) y el agente re-ofrece alternativas; Meta rechaza el primer envío.
    ✅ El reintento manda las **mismas** alternativas (mismo cuerpo), en **una** burbuja, sin cita creada.
11. Con R, Meta rechaza la re-oferta de forma definitiva.
    ✅ Queda `failed` con las alternativas íntegras; no reserva nada (`pending`); sin ronda posterior y con
    las alternativas libres, **Reenviar** funciona (200) y manda el payload original.

## Lo que este guion NO cubre (y dónde sí)

| | Dónde |
|---|---|
| Tabla de códigos de Meta (cada código, cada etapa) | `tests/unit/outbox-policy.test.ts` |
| Tres fallos agotados → `failed` | `tests/integration/outbound-delivery.test.ts` |
| Fallo asíncrono (`statuses.failed`) tras obtener `wamid` | ídem |
| Reinicio del proceso entre intentos, intento huérfano | ídem |
| Dos trabajadores concurrentes | ídem |
| Privacidad de logs | ídem |
| Migración `0023` sobre datos existentes, re-ejecución, trigger, compatibilidad de la versión anterior | `tests/integration/outbound-migration.test.ts` |
| Guard de ofertas: vencido, ocupado, no disponible, otra organización, reserva, sustitución | `tests/integration/outbound-offer-guard.test.ts` y `tests/unit/{offer-resend-guard,resend-text-guard}.test.ts` |
| Re-oferta de `bookSlot`: pending hasta aceptar, revalidación, guard, reinicio, dos operadores, cero IA | `tests/integration/outbound-reoffer.test.ts` y `tests/unit/{book-slot-reoffer,booking-race}.test.ts` |
| Contrato del bot: `retrying`, `delivery_unknown`, `failed`, `409`, sin doble envío | `tests/integration/bot-send-contract.test.ts` |
