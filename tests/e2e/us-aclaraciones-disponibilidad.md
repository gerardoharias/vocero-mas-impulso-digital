# Guion E2E — Aclaraciones de disponibilidad (calificador de semana, contexto, días alternativos)

> Automatizado en `scripts/e2e-selftest.mjs` (`aclaracionesDisponibilidadChecks`, dentro de la
> sección de agenda; con `pnpm dev` + mocks). A diferencia de las pruebas de integración
> (`tests/integration/agenda-clarify.test.ts`, reloj falseado a "jueves 17 sep 2026"), este
> guion corre a la hora REAL del reloj: cada aserción compara contra un **oráculo**
> (`GET /api/bot/availability` con la misma consulta) en vez de fechas fijas, para no depender
> de en qué día de la semana se ejecute el self-test.
> Spec: [`specs/026-aclaraciones-disponibilidad-calendario`](../../specs/026-aclaraciones-disponibilidad-calendario/spec.md).

## El defecto (evidencia real de producción)

«¿Jueves o viernes de la próxima semana?» no se entendía; «para el jueves», dicho después de
que el sistema preguntara y el prospecto mencionara «la próxima semana», ignoraba ese contexto y
resolvía el jueves más cercano; la aclaración se repetía con el mismo texto sin límite.

## Cómo se verifica sin mirar dentro del sistema

El `ai-mock` responde `check_availability` con las palabras (y calificador de semana) del
prospecto, igual que un modelo real seguiría las reglas del prompt. La verdad se lee de
`GET /api/bot/availability?day=…` (mismas reglas que el agente, texto exacto en `resumen`).

## Camino verificado

1. **«¿Jueves o viernes?»** → el agente describe AMBOS días con datos reales del motor
   (comparado contra el oráculo de cada día por separado), en el orden en que el cliente los
   dijo.
2. **«¿Tienes disponibilidad la semana que viene?»** (sin día) → aclaración pidiendo el día,
   sin horarios inventados. Turno siguiente, **sólo** «para el lunes» (sin repetir "la próxima
   semana") → el servidor **hereda** el calificador: la respuesta coincide con el oráculo de
   la consulta completa («lunes de la próxima semana»), no con el lunes más cercano.
3. **Tres aclaraciones consecutivas sin resolver** (día no reconocible, ninguna palabra clave) →
   la 2.ª nunca repite el texto de la 1.ª; la 3.ª **no vuelve a preguntar**: escala a un humano
   (`handoffReason:"agenda_ambigua"`, `handoffAt` fijado).

## Lo que este guion NO cubre (y dónde sí)

| | Dónde |
|---|---|
| «este jueves» ya pasó (no se reinterpreta en silencio), respuesta corta contextual («sí», «la próxima»), cambio inequívoco de tema, herencia con horizonte estrecho vs ancho | `tests/integration/agenda-clarify.test.ts` (reloj falseado, así que "ya pasó"/"hoy" se pueden fijar con certeza) |
| Las tres rutas de resolución de día, `parseWeekQualifier`, fechas candidatas | `tests/unit/day-expressions.test.ts` |
| Fusión de contexto, respuestas cortas, detección de cambio de tema (funciones puras) | `tests/unit/agenda-clarify-context.test.ts` |
| `days[]`, `AvailabilityKind:"days"`, mezcla dentro/fuera de horizonte | `tests/unit/availability-query.test.ts` |
| Nunca inventar disponibilidad (oráculo independiente) | `tests/integration/agenda-clarify.test.ts` (`computeAvailability` directo) |
