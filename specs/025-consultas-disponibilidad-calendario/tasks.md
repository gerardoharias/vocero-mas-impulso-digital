# 025 — Tareas

## Diagnóstico

- [X] T1 Arnés: `harness.availability.useReal` (motor real) y `fail` (motor caído); `resetData` limpia `calendar_settings`
- [X] T2 `availability-diagnosis.test.ts` con motor real y agenda vacía: 2 casos de caracterización (12 de 97; lunes 16:00 libre y nunca ofrecido) y 3 de contrato **en rojo antes de corregir** (metadatos de `offer_slots`, alternativas cercanas, API del cerebro externo)
- [X] T3 Causas C1-C5 documentadas (spec §1); el motor descartado como causa

## Especificación

- [X] T4 `spec.md`, `plan.md`, `data-model.md` (antes del código)

## Implementación

- [X] T5 `lib/time/day-expressions.ts` (pura): día, hora, «y media/cuarto/menos cuarto», árbitro = horario
- [X] T6 `agenda/alternatives.ts` (pura): `nearestSlots`
- [X] T7 `agenda/availability-query.ts`: `queryAvailability` (1 llamada al motor), `answerQuery` (pura), metadatos, casos límite con causa real, `claimsNoAvailability`
- [X] T8 Acción `check_availability` (sin `reply`) + `degradeAction`; entra al esquema estricto y a su registro de contrato
- [X] T9 `agent.ts`: `checkAvailability`, `AgendaTurn.availability` en `offerSlots`/`bookSlot`
- [X] T10 `pipeline.ts`: la acción viaja por la vía de 024 (`offers` → `sendText`); guard de negaciones; texto fijo si el motor cae
- [X] T11 `service.ts`: `refreshOffer` con `nearestSlots` (**`registerAlternatives` intacto**)
- [X] T12 `prompts.ts`: herramienta + reglas; `ai-mock.ts`: dispara la acción
- [X] T13 `GET /api/bot/availability`: defaults corregidos, `diasConAgenda` completo, metadatos, `day`/`from`/`to`

## Pruebas

- [X] T14 Unitarias: `day-expressions`, `alternatives`, `availability-query` (41 casos, incluida una **prueba de propiedades** sobre 150 agendas/consultas aleatorias contra el filtro real), `check-availability-action`
- [X] T15 Integración `availability-query` (16 casos): las 4 consultas con el motor real, agenda vacía con horarios posteriores, citas/bloqueos/canceladas/de prueba, zona horaria + duración + buffer + aviso configurados, pipeline (pending/active, backoff, stale sólo por lo mostrado, aclaración, motor caído), guard de negaciones, API del cerebro externo
- [X] T16 Actualizadas las alternativas esperadas de `outbound-reoffer.test.ts` (ahora las cercanas); **todas** sus aserciones de R-1 intactas
- [X] T17 E2E en vivo (`disponibilidadDirectaChecks`; guion `tests/e2e/us-disponibilidad.md`)
- [X] T18 Mutaciones: catálogo truncado a 3, alternativas sin cercanía, guard desactivado, R-1 debilitado (`registerAlternatives:true`)

## Cierre

- [X] T19 `CLAUDE.md`, `specs/README.md`, referencias cruzadas 024↔025, `docs/bot-availability-contrato.md`
- [ ] T20 Commit / PR / despliegue: **fuera de alcance**

## Preproducción: prueba real (spec §11)

- [X] T21 Arnés real `tests/live/availability-live.live.test.ts` (5 llamadas máx., candados, dry-run) y carga del perfil vigente (`AI_LIVE_PROFILE_JSON`, `tests/live/profile-json.ts`)
- [X] T22 Corrida real 1 (perfil semilla): 5/5 — **no es evidencia de aprobación**
- [X] T23 Corrida real 2 (perfil de producción, `instruccionesSha=cc7a5a0eac1a`, 18 entradas, `mencionaOfferSlots=true`, US$ 0.0053665): **FALLÓ 3 pruebas** (casos 1, 2 y 5; 3 y 4 pasaron). Documentado en §11.1

## Revisión correctiva (spec §11.4)

- [X] T24 `edge` sólo ante petición explícita de más temprano/más tarde (`explicitEdge`; la compuerta lo quita si no)
- [X] T25 `""`, espacios, `null`, `[]` = ausencia, antes de validar (`normalize` de `chatJson`) y en la compuerta
- [X] T26 Pregunta con expresión temporal ⇒ `check_availability`; expresión no soportada llega al servidor con las palabras del cliente y pide aclaración; `offer_slots` sólo genérico (`guardAgendaAction`, reglas duras del prompt)
- [X] T27 Reglas duras de agenda por encima de instrucciones heredadas (`AGENDA_PRIORITY_CLAUSE`); el perfil no se edita
- [X] T28 Pruebas de regresión con perfil «Usa offer_slots»: unitarias (`query-intent`, `agenda-action-noise`), integración (`availability-guard`, motor real) y E2E (paso 6 de `us-disponibilidad`); aserciones de la prueba real **sin debilitar**
- [X] T29 Compuertas locales tras la corrección (ver §10 de la spec)
- [X] T30 **Repetición REAL** (casos 1-5, `z-ai/glm-5.3-flash`, perfil de producción sin editar): **5/5 aprobados**, 5 llamadas exactas, 30 590 tokens de entrada / 1 374 de salida, US$ 0.0035091, `json_schema`, perfil `cc7a5a0eac1a`, sin fallback/corrección/reintentos/handoff/citas ni horarios inventados (corrida 3, resultado comunicado por el dueño; spec §11.1)

## Resultados de las compuertas

Ver §10 de la [spec](spec.md#10-verificación) (cifras de la revisión correctiva incluidas). La prueba real con el modelo (T30) quedó **5/5** en la corrida 3 tras fallar en la corrida 2. Lo único abierto es T20 (commit / PR / despliegue), fuera de alcance y no hecho.
