# Guion E2E — Consultas directas de disponibilidad

> Automatizado en `scripts/e2e-selftest.mjs` (`disponibilidadDirectaChecks`, dentro de la
> sección de agenda; con `pnpm dev` + mocks). La lógica fina (zonas horarias, horario partido,
> buffers, propiedades sobre agendas aleatorias, mutaciones) está en
> `tests/unit/availability-query.test.ts` y `tests/integration/availability-query.test.ts`.
> Spec: [`specs/025-consultas-disponibilidad-calendario`](../../specs/025-consultas-disponibilidad-calendario/spec.md).

## El defecto

Con una agenda vacía de lunes a viernes 09:00-18:00, el agente sólo podía ofrecer las 3 primeras
horas de cada día (12 de 97 libres) y, cuando el prospecto preguntaba por «mañana», «el lunes a las
4» o «el más tarde», **infería la respuesta de esas muestras**: «no tengo a las 4» era ocupación
inventada. La API del cerebro externo, además, devolvía 1 hueco y 1 día sin parámetros.

## Cómo se verifica sin mirar dentro del sistema

El `ai-mock` responde `check_availability` con las palabras del prospecto; el servidor consulta el
motor real. **La verdad** se lee de `GET /api/bot/availability?day=…` (usa la *misma* consulta y trae
el texto exacto en `resumen`). Si el mensaje que llegó al prospecto difiere de esa verdad, alguien
está inventando disponibilidad.

## Camino verificado

1. **«¿Tienes más horarios mañana?»**
   ✅ El mensaje es **exactamente** el `resumen` del motor para ese día.
   ✅ Es **exhaustiva** (`exhaustive:true`, `hasMore:false`, `total = slots.length`) y llega hasta el
   **último** horario libre, no a las primeras opciones.
   ✅ No contiene ninguna negación cuando sí hay agenda.
2. **«¿Lunes a las 11 o 12?»**
   ✅ Cada hora se contesta según el motor (libre ⇔ el motor la lista) y se nombra la **fecha
   completa** para que el prospecto corrija si no era ese lunes.
3. **«¿El lunes a las 4 o 5 de la tarde?»** y después «sí, agenda el primero».
   ✅ 16:00 y 17:00 contestadas según el motor.
   ✅ Lo consultado es **seleccionable tras aceptarlo Meta** (los horarios nacen `pending` con el
   mensaje y se activan al aceptar; 024 §5.6): **una cita real**.
4. **«¿Cuál es el horario más tarde el lunes?»**
   ✅ Coincide con el último libre que lista el motor.
5. **API del cerebro externo**
   ✅ Sin parámetros usa los valores por defecto reales (antes, 1 hueco y 1 día).
   ✅ Declara si la lista es parcial (`hasMore ⇔ total > devueltos`); `diasConAgenda` cubre todos los
   días mostrados y todos los días con agenda de la ventana `days` (y `diasConAgendaHorizonte`, los del horizonte).
   ✅ Un día que no se entiende es `422` (nunca una lista vacía que parezca «no hay»).

## Lo que este guion NO cubre (y dónde sí)

| | Dónde |
|---|---|
| Interpretar «mañana», «lunes», «25 de septiembre», «4 de la tarde», «4 y media» | `tests/unit/day-expressions.test.ts` |
| Zona horaria, horario partido, duración, buffer, aviso mínimo, citas | `tests/unit/availability-query.test.ts` |
| «Nunca inventar»: 150 agendas y consultas aleatorias contra el filtro real | ídem (propiedades) |
| Reintento con el mismo texto, `offer_stale` por lo mostrado, motor caído, guard de negaciones | `tests/integration/availability-query.test.ts` |
| Alternativas cercanas tras `slot_taken` y R-1 (`registerAlternatives:false`) | `tests/integration/availability-diagnosis.test.ts`, `outbound-reoffer.test.ts` |
