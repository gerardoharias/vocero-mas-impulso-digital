# 026 — Tareas

Implementado en la rama `codex/spec-026-calendar-clarifications` (a partir de `main`, no de la
rama ya fusionada de 024/025). **Sin commit, sin PR, sin despliegue** — el dueño no lo ha pedido.

## Diagnóstico y especificación

- [X] T1 Diagnóstico sobre evidencia real de producción (spec §1), causas confirmadas leyendo el
      código de 025
- [X] T2 Regla semántica confirmada por el dueño (spec §2)
- [X] T3 `spec.md`, `plan.md`, `data-model.md` (antes del código)

## Funciones puras (antes de tocar BD o pipeline)

- [X] T4 `parseWeekQualifier` en `day-expressions.ts`: separa "este/esta" y "de la [próxima] semana
      [que viene/entrante/otra]" de la expresión de día — incluye el caso SUELTO ("la semana que
      viene", sin día pegado, evidencia real mensaje 1). Saca "este"/"esta" de la lista de relleno
      genérico
- [X] T5 Tres rutas de `resolveDayExpression`: sin calificador/"próximo"/"que viene" (sin cambio),
      "este" (semana actual, puede ser hoy, `reason:"already_passed_this_week"` si ya pasó), "de la
      próxima semana" (siempre semana siguiente)
- [X] T6 Pruebas unitarias de las 3 rutas (66 casos en `day-expressions.test.ts`, extendido)
- [~] T7 Fechas candidatas para la regla 14 — **diseño final distinto al planeado**: en vez de
      enumerar 2 fechas por día (riesgo de combinación cartesiana con `days[]`, señalado por el
      dueño), la ambigüedad de semana COMPARTIDA usa la pregunta corta «¿esta semana o la
      próxima?» (`buildDayClarify`, `availability-query.ts`), que nunca excede 2 opciones por
      construcción. `weekdayDatesThisAndNextWeek` (day-expressions.ts) sigue disponible para nombrar
      la fecha concreta que ya pasó en el primer intento
- [X] T8 `agenda-clarify-context.ts` (nuevo, puro): `mergeClarifyContext`, `recordUnresolvedAttempt`,
      `isUnambiguousTopicChange`, `referencesPendingClarify`, `parseWeekChoiceReply`,
      saneo/(de)serialización acotada — 34 pruebas aisladas, sin BD

## Días alternativos

- [X] T9 `AvailabilityQuery.days?: string[]` + `AvailabilityKind:"days"`; `answerQuery` evalúa cada
      día por separado EN EL ORDEN DEL CLIENTE (no cronológico — hallado y corregido durante la
      implementación), agrega metadatos sólo sobre los que caen dentro del horizonte; tope 3
      (`too_many_days`)
- [X] T10 Pruebas unitarias: ambos libres, uno ocupado (se explica, no se omite), uno fuera de
      horizonte, `days` de un solo elemento ≡ `day`, más de 3 días

## Persistencia y memoria de aclaración

- [X] T11 Migración `0024_slim_felicia_hardy.sql`: `agenda_clarify_count`/`kind`/`context` en
      `conversation`, re-ejecutable (`IF NOT EXISTS` + `lock_timeout`), sin backfill — generada con
      `pnpm db:generate` y aplicada limpiamente a una base nueva
- [X] T12 `agenda-clarify-state.ts`: mismo patrón que `failure-state.ts` (023) — lecturas/escrituras
      acotadas por `id` + `organizationId`, escritura guardada con concurrencia optimista
      (`agendaClarifyCount` esperado en el `WHERE`)
- [X] T13 Nuevo motivo de handoff `"agenda_ambigua"` (TS-only); `applyHandoff` limpia el contador
      para CUALQUIER motivo (regla 11 d/e)

## Integración con la acción y el pipeline

- [X] T14 Acción `check_availability`: campo `days` en el esquema Zod + prompt actualizado
      (`days` vs `day`, "este"/"de la próxima semana" tal cual)
- [X] T15 `pipeline.ts`: `customerText`/`clarifyState` se cargan una vez por turno; fusión antes de
      `checkAvailability`; reseteo en éxito/cita creada/acción no-agenda **con** cambio de tema
      inequívoco (nunca sólo por la acción, regla del dueño); reseteo en cualquier handoff (vía
      `applyHandoff`)
- [X] T16 2.ª aclaración consecutiva varía el texto (nunca repite); 3.ª dispara handoff
      `agenda_ambigua` sin volver a preguntar
- [X] T17 `GET /api/bot/availability`: acepta días alternativos — como **`altDays`**, no `days`
      (colisión real con la ventana numérica `LIMITS.days` de 015, detectada por
      `pnpm test:integration` y corregida antes de terminar)

## Pruebas

- [X] T18 Unitarias: 68 (`day-expressions`, +2 discriminadores) + 36 (`agenda-clarify-context`, +2
      del límite exacto) + 58 (`availability-query`, +2 fechas concretas +1 barrido T22) + 28
      (`query-intent`) = **1126/1126** en `pnpm test` (94 archivos, repo completo, sin regresiones)
- [X] T19 Integración (Postgres real, `tests/integration/agenda-clarify.test.ts`, 14 casos): este-
      día-ya-pasado + variación de texto, herencia de calificador (con y sin horizonte suficiente),
      respuesta corta contextual NO limpia, cambio inequívoco de tema SÍ limpia, handoff AJENO a la
      agenda también limpia, `days[]` con datos reales, límite de 3 intentos → handoff, aislamiento
      entre conversaciones y entre organizaciones (2 pruebas nuevas, T21). **139/139** en
      `pnpm test:integration` (12/12 archivos, sin regresiones — ver spec §11 para las 2 regresiones
      reales encontradas y corregidas en el camino, más 1 flake preexistente confirmado no relacionado)
- [X] T20 E2E (`scripts/e2e-selftest.mjs` → `aclaracionesDisponibilidadChecks`,
      `tests/e2e/us-aclaraciones-disponibilidad.md`): días alternativos, herencia de contexto (contra
      un oráculo, sin fechas fijas), límite de 3 aclaraciones → handoff. Corrido contra el servidor
      real con mocks sobre una base limpia (`vocero_e2e_clean`): **297/297, 0 fallos**, confirmado en
      dos corridas limpias consecutivas tras corregir dos bugs propios del guion (teléfono de 12
      dígitos; frases que el mock de prueba no reconocía) — ninguno de producto
- [X] T21 Mutaciones dedicadas: **10/10 garantías demostradas** con ciclo ROJO → revertir → VERDE
      (detalle en spec §12): eliminar «de la próxima semana»; «jueves que viene» mal interpretado;
      «este jueves» ya pasado avanza en silencio; pierde contexto ante respuesta corta; invierte/
      pierde el orden de `altDays`; sólo consulta el primer día de `days[]`; permite >2 fechas
      concretas (cartesiana); no limpia tras resolver/reservar/escalar/cambiar de tema (4 variantes);
      no escala tras el 3.er intento; comparte contexto entre conversaciones/organizaciones. Sin
      residuo de código mutado (`grep -rn "MUTACIÓN" src/` → 0 coincidencias). Un hallazgo real: la
      prueba original de "no escala" era genérica al valor del límite — reforzada con 2 pruebas que
      fijan el 3 exacto
- [X] T22 Propiedad: barrido nuevo y dedicado (`availability-query.test.ts`, "026 — barrido amplio"),
      153 casos reproducibles (9 anclas × 17 variaciones, semilla `20260926`) cubriendo los 7 días de
      la semana como "hoy", un cruce de año (dic→ene) y uno de mes/año bisiesto (feb→mar 2028), las 5
      formas de «jueves», `days[]` en ambos órdenes, y el invariante de nunca inventar — SIN tocar el
      barrido de 150 agendas ya existente de 025

## Cierre

- [X] T23 `CLAUDE.md` — sin cambios necesarios (no describe specs individuales); referencias cruzadas
      025↔026 ya presentes en `spec.md` §0; `specs/README.md` actualizado
- [X] T24 Compuertas locales, TODAS verdes en su corrida final: `pnpm typecheck` ✅ · `pnpm lint` ✅ ·
      `pnpm test` 1126/1126 ✅ · `pnpm test:integration` 139/139 ✅ · `pnpm build` ✅ ·
      `git diff --check` ✅ · E2E 297/297 ✅
- [ ] T25 Commit / PR / despliegue: **fuera de alcance**, no pedir sin autorización explícita del
      dueño — la rama queda local, sin push

## Preproducción (opcional, sólo si el dueño autoriza gasto)

- [ ] T26 Prueba real con el modelo de producción — **no hecha**, requiere autorización expresa de
      gasto que el dueño no ha dado
